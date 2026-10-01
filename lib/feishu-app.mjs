// dsh-pocket 飞书应用通道（新增模块）
//
// 与 notify.mjs 的「群机器人 Webhook」并列的第二条通道：
// 用飞书官方 SDK 扫码创建应用，直接以应用身份给「扫码的那个人」发消息。
//
// 为什么能扫码：扫码流程**不是**某个插件自己实现的，而是飞书官方 SDK
// `@larksuiteoapi/node-sdk` 的 `registerApp()`：
//   - 它生成二维码 → 手机飞书扫码 → 自动创建应用 → 自动预填权限 →
//     轮询到用户确认后返回 { client_id, client_secret, user_info }。
//   - 本模块只调用这个官方函数，不复制任何第三方插件代码。
//
// 与 Webhook 通道的区别：
//   Webhook  手动建群 + 粘贴 URL，确定性可用，不需要审批；
//   本通道   扫码即得凭据，体验好，但应用需在飞书完成发布审批后才能发消息。
//
// 依赖说明：`@larksuiteoapi/node-sdk` 是本包的正式运行时依赖，
// 由 package.json 的 dependencies 声明、随包安装，无需手动处理。
// 动态 import 的用意是「按需加载」：只用 Webhook 通道的用户不必承担
// SDK 的加载开销；万一 SDK 缺失，本模块自动降级为「不可用」，
// 绝不影响 Webhook 通道与插件其余功能。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { qrDataUrl } from './service.mjs';

const settingsRel = join('dsh-pocket', 'settings.json');

function settingsPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), settingsRel);
}

function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { /* 无文件/损坏 → 默认 */ }
  return {};
}

function writeSettings(s) {
  try {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch { /* 忽略 */ }
  return s;
}

// ---------- SDK 延迟加载 ----------

let sdkPromise;

/**
 * 延迟加载飞书 SDK。
 * 返回 { registerApp, Client } 或抛出（调用方转成「不可用」状态）。
 */
export function loadLarkSdk() {
  if (sdkPromise === undefined) {
    sdkPromise = import('@larksuiteoapi/node-sdk').catch((error) => {
      const err = new Error(`飞书 SDK 不可用（依赖 @larksuiteoapi/node-sdk 未能加载，请重新安装本插件）: ${error?.message ?? error}`);
      err.code = 'sdk-unavailable';
      throw err;
    });
  }
  return sdkPromise;
}

// ---------- 凭据存储 ----------
// App Secret 是长期凭据：只写本机 0o600 文件，RPC 永不回显。

/** 已绑定的飞书应用凭据（未绑定返回 null）。 */
export function feishuAppCredentials() {
  const s = readSettings();
  const appId = s.feishuAppId;
  const appSecret = s.feishuAppSecret;
  if (typeof appId !== 'string' || appId === '') return null;
  if (typeof appSecret !== 'string' || appSecret === '') return null;
  return {
    appId,
    appSecret,
    openId: typeof s.feishuOpenId === 'string' ? s.feishuOpenId : '',
    name: typeof s.feishuAppName === 'string' ? s.feishuAppName : '',
  };
}

/** 保存扫码得到的凭据（含扫码人 open_id —— 通知就发给他）。 */
export function saveFeishuAppCredentials({ appId, appSecret, openId, name }) {
  const s = readSettings();
  s.feishuAppId = String(appId);
  s.feishuAppSecret = String(appSecret);
  if (openId) s.feishuOpenId = String(openId);
  if (name) s.feishuAppName = String(name);
  writeSettings(s);
  return feishuAppView();
}

/** 解绑（清掉应用凭据）。 */
export function clearFeishuAppCredentials() {
  const s = readSettings();
  for (const k of ['feishuAppId', 'feishuAppSecret', 'feishuOpenId', 'feishuAppName', 'feishuAppDomain']) {
    delete s[k];
  }
  writeSettings(s);
}

/** 脱敏视图：绝不回显 App Secret。 */
export function feishuAppView() {
  const cred = feishuAppCredentials();
  if (cred === null) return { bound: false, appIdMasked: null, name: null, openId: null };
  const id = cred.appId;
  return {
    bound: true,
    // cli_xxxxxxxx••••abcd：够确认是哪个应用，又不泄露完整 App ID
    appIdMasked: id.length > 14 ? `${id.slice(0, 11)}••••${id.slice(-4)}` : `${id.slice(0, 4)}••••`,
    name: cred.name || null,
    // open_id 不是凭据，可回显（用户确认发给谁）
    openId: cred.openId || null,
  };
}

// ---------- 扫码注册 ----------
// 一次只允许一个进行中的注册；重复 start 会取消上一个（与官方 SDK 语义一致）。

let activeRegistration = null;

/**
 * 开始扫码注册。
 * @returns {Promise<{ok:true, url:string, qrDataUrl:string, expireIn:number}>}
 *   url        —— 二维码内容（备用）
 *   qrDataUrl  —— 已渲染好的 PNG data URL，前端直接塞进 <img>
 *   expireIn   —— 有效期（秒）
 */
export async function startFeishuRegistration({ log } = {}) {
  const lark = await loadLarkSdk();

  // 取消上一个未完成的注册，避免两个二维码同时在轮询
  if (activeRegistration) {
    try { activeRegistration.abort.abort(); } catch { /* 忽略 */ }
    activeRegistration = null;
  }

  const abort = new AbortController();
  const run = { abort, done: false };
  activeRegistration = run;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let qrTimer = null;

    // 二维码就绪前可能一直等：给一个上限，避免前端永远转圈
    const qrTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      run.done = true;
      try { abort.abort(); } catch { /* 忽略 */ }
      const err = new Error('等待二维码超时，请检查网络后重试');
      err.code = 'qr-timeout';
      reject(err);
    }, 30000);
    qrTimer = qrTimeout;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(qrTimeout);
      fn(value);
    };

    let registration;
    try {
      registration = lark.registerApp({
        source: 'dsh-pocket',
        signal: abort.signal,
        // 只申请发通知需要的最小权限：以应用身份发消息。
        // 权限越少，飞书的发布审批越简单。
        addons: {
          preset: false,
          scopes: { tenant: ['im:message:send_as_bot'] },
        },
        onQRCodeReady: (info) => {
          log?.info?.(`dsh-pocket: feishu QR ready (expireIn=${info?.expireIn}s) | 飞书二维码已就绪`);
          // 用 Host 侧既有的 qrDataUrl（dsh-pocket 已依赖 qrcode 库）渲染成 PNG，
          // 前端只显示 <img>，不必再引客户端二维码库。
          Promise.resolve()
            .then(() => qrDataUrl(info.url, { width: 220, margin: 1 }))
            .then((dataUrl) => {
              finish(resolve, {
                ok: true,
                url: info.url,
                qrDataUrl: dataUrl,
                expireIn: Number(info.expireIn) || 0,
              });
            })
            .catch((error) => {
              // 渲染失败也把原始 URL 交出去，至少不让整个流程断掉
              log?.warn?.(`dsh-pocket: qr render failed (${error?.message ?? error}) | 二维码渲染失败`);
              finish(resolve, {
                ok: true,
                url: info.url,
                qrDataUrl: null,
                expireIn: Number(info.expireIn) || 0,
              });
            });
        },
        onStatusChange: (info) => {
          // polling / slow_down / domain_switched：仅用于诊断
          if (info?.status === 'slow_down') {
            log?.warn?.('dsh-pocket: feishu registration slow_down | 飞书轮询被限速');
          }
        },
      });
    } catch (error) {
      finish(reject, error);
      return;
    }

    // registerApp 在用户完成扫码并确认后才 resolve
    Promise.resolve(registration).then(async (result) => {
      run.done = true;
      activeRegistration = null;
      const appId = result?.client_id;
      const appSecret = result?.client_secret;
      if (typeof appId !== 'string' || appId === '' || typeof appSecret !== 'string' || appSecret === '') {
        log?.warn?.('dsh-pocket: feishu registration returned invalid credentials | 飞书注册未返回有效凭据');
        finish(reject, new Error('飞书未返回有效凭据，请重新扫码'));
        return;
      }

      // 扫码人的 open_id —— 通知就发给这个人
      const openId = typeof result?.user_info?.open_id === 'string' ? result.user_info.open_id : '';

      // 试读一次机器人名字（失败不影响绑定：可能尚未发布审批）
      let name = '';
      try {
        name = (await verifyFeishuApp({ appId, appSecret }))?.name ?? '';
      } catch (error) {
        log?.warn?.(`dsh-pocket: feishu app verify failed (${error?.message ?? error}) | 飞书应用校验失败（可能尚未发布审批）`);
      }

      try {
        saveFeishuAppCredentials({ appId, appSecret, openId, name });
        log?.info?.(`dsh-pocket: feishu app bound (${name || appId.slice(0, 11)}) | 飞书应用已绑定`);
      } catch (error) {
        finish(reject, error);
        return;
      }

      // 注意：resolve 在二维码阶段就已完成（前端已拿到二维码），
      // 这里不再 resolve，只更新凭据。前端通过轮询 bind 状态感知成功。
    }, (error) => {
      run.done = true;
      activeRegistration = null;
      const code = error?.code ?? error?.name ?? 'registration_failed';
      log?.info?.(`dsh-pocket: feishu registration ended: ${code}`);
      // 若二维码还没交出去就失败了，把错误交给前端；否则前端已拿到二维码，靠轮询察觉
      if (!settled) {
        const err = new Error(
          code === 'abort' ? '已取消扫码'
            : code === 'expired_token' ? '二维码已过期，请重新扫码'
              : `扫码失败：${error?.message ?? code}`,
        );
        err.code = code;
        finish(reject, err);
      }
    });

    // 应用退出/取消时清掉计时器
    run.cleanup = () => clearTimeout(qrTimer);
  });
}

/** 取消进行中的扫码注册。 */
export function cancelFeishuRegistration() {
  if (!activeRegistration) return false;
  try { activeRegistration.abort.abort(); } catch { /* 忽略 */ }
  activeRegistration = null;
  return true;
}

/** 是否有进行中的注册（前端轮询用）。 */
export function feishuRegistrationPending() {
  return activeRegistration !== null;
}

// ---------- 校验应用 ----------

/**
 * 用 App ID/Secret 换 tenant_access_token 并读机器人信息。
 * 同时用于：绑定后确认凭据可用、发送失败时判断是不是权限/审批问题。
 */
export async function verifyFeishuApp({ appId, appSecret, timeoutMs = 12000 } = {}) {
  const cred = appId && appSecret ? { appId, appSecret } : feishuAppCredentials();
  if (cred === null) throw new Error('尚未绑定飞书应用');

  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch { /* 忽略 */ } }, timeoutMs);
  try {
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: cred.appId, app_secret: cred.appSecret }),
      signal: controller.signal,
    });
    const tokenBody = await tokenRes.json().catch(() => null);
    if (!tokenBody || tokenBody.code !== 0 || !tokenBody.tenant_access_token) {
      const err = new Error(feishuErrorHint(tokenBody?.code, tokenBody?.msg));
      err.code = tokenBody?.code ?? 'auth-failed';
      throw err;
    }

    const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info/', {
      headers: { authorization: `Bearer ${tokenBody.tenant_access_token}` },
      signal: controller.signal,
    });
    const botBody = await botRes.json().catch(() => null);
    const bot = botBody?.bot ?? {};
    return {
      name: bot.app_name ?? bot.bot_name ?? null,
      openId: bot.open_id ?? null,
      activated: bot.activate_status ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 把飞书错误码翻成人能看懂的话。 */
function feishuErrorHint(code, msg) {
  const hints = {
    10003: 'App ID 或 App Secret 不正确',
    10014: 'App Secret 不正确',
    99991663: '应用没有发消息权限：请到飞书开放平台给应用加上「以应用身份发消息」权限并发布版本',
    99991672: '应用缺少所需权限：请到飞书开放平台补全权限后发布新版本',
    // 飞书对「机器人不能主动给该用户发消息」的常见返回
    230002: '对方不在机器人的可发送范围内：请先在飞书里给这个机器人发一条消息，再试',
    230013: '机器人对该用户不可用：请确认应用已发布，且你与机器人在同一租户内',
    230020: '发送过于频繁，已被飞书限频，稍后重试',
  };
  const hint = hints[code];
  return hint ? `${hint}（飞书返回 ${code}${msg ? `: ${msg}` : ''}）` : `飞书返回错误 ${code ?? '未知'}${msg ? `: ${msg}` : ''}`;
}

// ---------- 发送消息 ----------

/**
 * 以应用身份给指定用户发一条文本消息。
 * 返回 { sent: true } 或 { sent: false, reason }；**永不抛错**。
 *
 * 常见失败原因（都会被翻成中文提示）：
 *   - 应用尚未完成发布审批 → 权限不足
 *   - 用户没和这个机器人聊过 → 需要先私聊一次（飞书限制）
 */
export async function sendFeishuAppMessage({ title, body }, { log, timeoutMs = 12000 } = {}) {
  const cred = feishuAppCredentials();
  if (cred === null) return { sent: false, reason: 'not-bound' };
  if (!cred.openId) return { sent: false, reason: 'no-target（扫码时未取到 open_id，请重新扫码）' };

  let lark;
  try {
    lark = await loadLarkSdk();
  } catch (error) {
    return { sent: false, reason: error?.message ?? String(error) };
  }

  const text = `${title}\n${body}`;
  let timer = null;
  try {
    const client = new lark.Client({
      appId: cred.appId,
      appSecret: cred.appSecret,
      appType: lark.AppType.SelfBuild,
      // 不传 domain：官方域名由 SDK 自动推导（domain 是枚举 Domain，
      // 传字符串会被当成自定义域名，反而可能拼出错误地址）。
      source: 'dsh-pocket',
      // 只留 error 及以上：SDK 默认会把 "client ready" 之类打到 stdout，吵且无意义
      loggerLevel: lark.LoggerLevel?.error ?? 1,
    });

    const controller = new AbortController();
    timer = setTimeout(() => { try { controller.abort(); } catch { /* 忽略 */ } }, timeoutMs);

    const response = await client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: cred.openId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });

    if (response?.code && response.code !== 0) {
      const reason = feishuErrorHint(response.code, response.msg);
      log?.warn?.(`dsh-pocket: feishu app send failed (${response.code}) | 飞书应用发送失败: ${reason}`);
      return { sent: false, reason };
    }
    return { sent: true };
  } catch (error) {
    const { code, msg } = extractFeishuError(error);
    const reason = code !== undefined
      ? feishuErrorHint(code, msg)
      : `network: ${msg}`;
    log?.warn?.(`dsh-pocket: feishu app send error | 飞书应用发送异常: ${reason}`);
    return { sent: false, reason };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 从 SDK 抛出的错误里挖出飞书错误码。
 *
 * 飞书 SDK 的错误对象形态不稳定：有时挂在 error.code，有时塞在
 * error.response.data，还有的（如换 token 失败）只在 message 文本里
 * 例如 "failed to get tenant_access_token, code: 10003, msg: invalid param"。
 * 三种都试一遍，拿不到就返回 undefined（调用方退化成网络错误提示）。
 */
function extractFeishuError(error) {
  // 1) 显式字段
  const direct = error?.code ?? error?.response?.data?.code;
  if (Number.isFinite(Number(direct)) && Number(direct) !== 0) {
    return {
      code: Number(direct),
      msg: error?.response?.data?.msg ?? error?.msg ?? error?.message ?? '',
    };
  }
  // 2) 从 message 文本里抠 "code: 10003"
  const text = String(error?.message ?? '');
  const m = /code[:：]\s*(\d{3,7})/.exec(text);
  if (m) {
    const msgMatch = /msg[:：]\s*([^,，]+)/.exec(text);
    return { code: Number(m[1]), msg: msgMatch ? msgMatch[1].trim() : text };
  }
  return { code: undefined, msg: text || String(error) };
}

/** 清除飞书应用凭据（恢复出厂设置时调用）。 */
export function clearFeishuAppState() {
  try { cancelFeishuRegistration(); } catch { /* 忽略 */ }
  clearFeishuAppCredentials();
}
