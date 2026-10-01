// dsh-pocket 消息推送（新增模块）
//
// 作用：把 DSH 会话的关键事件推到手机端 IM 的「群自定义机器人」Webhook。
// 不依赖任何第三方插件、不需要应用审核、不需要回调：在群里加一个自定义机器人，
// 复制一条 URL 填进来即可。
//
// 为什么不用 Web Push：
//   - 安卓 Chrome 的 Web Push 走 Google FCM，国内直连不可用；
//   - 群机器人 Webhook 由 IM 厂商自己的推送通道送达，国内稳定；
//   - 且切到后台/锁屏都能收到，不受页面生命周期的限制。
//
// 支持渠道（都是「粘贴一个 URL」形态）：
//   feishu   飞书群自定义机器人
//   wecom    企业微信群机器人
//   dingtalk 钉钉群自定义机器人（可选加签密钥）
//   serverchan / pushplus  公众号中转（消息进微信）
//   ntfy     自托管或公共 ntfy 主题
//   generic  任意自定义 Webhook（POST 一个 JSON）
//
// 安全：Webhook URL 是长期凭据，等同「谁拿到谁就能往你群里发消息」。
// 本模块只把它写进 $DSH_HOME/dsh-pocket/settings.json（0o600），
// 并且**永不经 RPC 回显**——设置页只回显「是否已配置」与脱敏摘要。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ---------- 设置读写（与 settings.mjs 同一文件，保持字段独立） ----------

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

// ---------- 渠道定义 ----------
//
// 两类通道：
//   'feishu-app' —— 飞书官方 SDK 扫码建应用，以应用身份发给扫码人（体验最好）
//   其余          —— 群自定义机器人 Webhook（手动粘 URL，不需要飞书审批）
export const NOTIFY_CHANNELS = ['feishu-app', 'feishu', 'wecom', 'dingtalk', 'serverchan', 'pushplus', 'ntfy', 'generic'];

/** 需要 Webhook URL 的渠道（feishu-app 用应用凭据，不需要 URL）。 */
export function channelNeedsWebhook(channel) {
  return channel !== 'feishu-app';
}

const CHANNEL_HOSTS = {
  feishu: ['open.feishu.cn', 'open.larksuite.com'],
  wecom: ['qyapi.weixin.qq.com'],
  dingtalk: ['oapi.dingtalk.com'],
  serverchan: ['sctapi.ftqq.com', 'push.ft07.com'],
  pushplus: ['www.pushplus.plus'],
  ntfy: [], // 允许自建，不限制主机
  generic: [],
};

/** 该渠道是否必须 HTTPS（除自建 ntfy/generic 外都强制）。 */
function requiresHttps(channel) {
  return channel !== 'ntfy' && channel !== 'generic';
}

/**
 * 校验 Webhook URL。
 * 只接受 http/https，拒绝其它 scheme（防 file:// 之类被当成 URL 用）。
 * 已知渠道限制主机白名单，避免用户把私有内网地址误填进来。
 */
export function validateWebhookUrl(channel, rawUrl) {
  const value = String(rawUrl ?? '').trim();
  if (!value) throw new Error('Webhook 地址不能为空 | webhook URL is required');
  if (value.length > 2048) throw new Error('Webhook 地址过长 | webhook URL is too long');

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Webhook 地址不是合法 URL | webhook URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Webhook 地址必须是 http/https | webhook URL must be http(s)');
  }
  if (requiresHttps(channel) && url.protocol !== 'https:') {
    throw new Error('该渠道要求 HTTPS | this channel requires HTTPS');
  }
  const allowed = CHANNEL_HOSTS[channel];
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(url.hostname.toLowerCase())) {
    throw new Error(`该渠道的地址主机应为 ${allowed.join(' / ')} | wrong host for this channel`);
  }
  if (value !== rawUrl && String(rawUrl ?? '') !== value) {
    // 仅规范化前后空白，不静默改写 URL 本体
  }
  return url.toString();
}

// ---------- 设置项：读取 ----------

/** 推送总开关（默认关闭——用户不填 URL 就不该发任何东西）。 */
export function notifyEnabled() {
  return readSettings().notifyEnabled === true;
}

/** 当前渠道（默认 feishu-app —— 扫码即用，体验最好）。 */
export function notifyChannel() {
  const v = readSettings().notifyChannel;
  return NOTIFY_CHANNELS.includes(v) ? v : 'feishu-app';
}

/** Webhook 地址（未配置返回空字符串）。**不要经 RPC 回显。** */
export function notifyWebhook() {
  const v = readSettings().notifyWebhook;
  return typeof v === 'string' ? v : '';
}

/** 钉钉加签密钥（未配置返回空字符串）。 */
export function notifySecret() {
  const v = readSettings().notifySecret;
  return typeof v === 'string' ? v : '';
}

const EVENT_KEYS = ['notifyOnComplete', 'notifyOnError', 'notifyOnApproval', 'notifyOnQuestion'];

/** 某类事件是否开启。默认：完成=开，其余=开。 */
export function notifyEventEnabled(key) {
  if (!EVENT_KEYS.includes(key)) return false;
  const v = readSettings()[key];
  return v !== false;
}

/** 子代理完成是否也推（默认否，避免一个主任务刷几十条）。 */
export function notifyIncludeSubagent() {
  return readSettings().notifyIncludeSubagent === true;
}

/** 同会话同事件的最短间隔（毫秒，默认 5000）。 */
export function notifyThrottleMs() {
  const v = Number(readSettings().notifyThrottleMs);
  return Number.isFinite(v) && v >= 0 && v <= 300000 ? v : 5000;
}

/** 只推长于该时长的任务（毫秒，默认 0 = 全推）。 */
export function notifyMinDurationMs() {
  const v = Number(readSettings().notifyMinDurationMs);
  return Number.isFinite(v) && v >= 0 && v <= 3600000 ? v : 0;
}

// ---------- 设置项：写入 ----------

/** setNotifyConfig 接受的键（白名单）。 */
const PATCH_KEYS = new Set([
  'enabled', 'channel', 'webhook', 'secret', 'includeSubagent', 'throttleMs', 'minDurationMs',
  ...EVENT_KEYS,
]);

/**
 * 写入推送配置（全部字段可选；undefined 表示不改）。
 *
 * 未知键**抛错**而不是静默忽略：早先版本忽略了未知键，
 * 结果前端把 `notifyOnComplete` 写成 `onComplete` 时点了开关毫无反应、
 * 也不报错，排查成本极高。宁可在这里响亮地失败。
 */
export function setNotifyConfig(patch = {}) {
  const s = readSettings();

  const unknown = Object.keys(patch).filter((k) => !PATCH_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`未知的推送配置项：${unknown.join(', ')} | unknown notify config key(s)`);
  }

  if (patch.enabled !== undefined) s.notifyEnabled = patch.enabled === true;

  if (patch.channel !== undefined) {
    const c = String(patch.channel ?? '');
    if (!NOTIFY_CHANNELS.includes(c)) throw new Error('未知推送渠道 | unknown notify channel');
    s.notifyChannel = c;
  }

  // 渠道决定后才知道 URL 该怎么校验
  const effectiveChannel = NOTIFY_CHANNELS.includes(s.notifyChannel) ? s.notifyChannel : 'feishu-app';

  if (patch.webhook !== undefined) {
    const raw = String(patch.webhook ?? '').trim();
    if (raw === '') delete s.notifyWebhook;
    else s.notifyWebhook = validateWebhookUrl(effectiveChannel, raw);
  }

  if (patch.secret !== undefined) {
    const raw = String(patch.secret ?? '').trim();
    if (raw === '') delete s.notifySecret;
    else s.notifySecret = raw;
  }

  for (const key of EVENT_KEYS) {
    if (patch[key] !== undefined) s[key] = patch[key] === true;
  }
  if (patch.includeSubagent !== undefined) s.notifyIncludeSubagent = patch.includeSubagent === true;

  if (patch.throttleMs !== undefined) {
    const v = Number(patch.throttleMs);
    s.notifyThrottleMs = Number.isFinite(v) && v >= 0 && v <= 300000 ? v : 5000;
  }
  if (patch.minDurationMs !== undefined) {
    const v = Number(patch.minDurationMs);
    s.notifyMinDurationMs = Number.isFinite(v) && v >= 0 && v <= 3600000 ? v : 0;
  }

  writeSettings(s);
  return notifyView();
}

/** 清除推送配置（恢复出厂设置时调用）。 */
export function clearNotifyConfig() {
  const s = readSettings();
  for (const k of ['notifyEnabled', 'notifyChannel', 'notifyWebhook', 'notifySecret',
    'notifyOnComplete', 'notifyOnError', 'notifyOnApproval', 'notifyOnQuestion',
    'notifyIncludeSubagent', 'notifyThrottleMs', 'notifyMinDurationMs',
    // 飞书应用凭据（扫码通道）一并清除，避免「恢复出厂」后凭据仍在
    'feishuAppId', 'feishuAppSecret', 'feishuOpenId', 'feishuAppName', 'feishuAppDomain']) {
    delete s[k];
  }
  writeSettings(s);
}

/**
 * 给设置页/前端的脱敏视图。
 * **绝不包含 Webhook 原文、加签密钥与 App Secret**，只说明是否已配置。
 *
 * `configured` = 「当前渠道是否已可用」：feishu-app 看有没有绑定应用，
 * 其余渠道看有没有 Webhook。
 */
export function notifyView() {
  const webhook = notifyWebhook();
  const secret = notifySecret();
  const channel = notifyChannel();
  const s = readSettings();

  let app = { bound: false, appIdMasked: null, name: null, openId: null };
  if (typeof s.feishuAppId === 'string' && s.feishuAppId !== ''
    && typeof s.feishuAppSecret === 'string' && s.feishuAppSecret !== '') {
    const id = s.feishuAppId;
    app = {
      bound: true,
      appIdMasked: id.length > 14 ? `${id.slice(0, 11)}••••${id.slice(-4)}` : `${id.slice(0, 4)}••••`,
      name: typeof s.feishuAppName === 'string' && s.feishuAppName !== '' ? s.feishuAppName : null,
      openId: typeof s.feishuOpenId === 'string' && s.feishuOpenId !== '' ? s.feishuOpenId : null,
    };
  }

  return {
    enabled: notifyEnabled(),
    channel,
    // 通道类型：'app' 走飞书应用（扫码），'webhook' 走群机器人
    channelKind: channel === 'feishu-app' ? 'app' : 'webhook',
    configured: channel === 'feishu-app' ? app.bound : webhook !== '',
    webhookConfigured: webhook !== '',
    // 只暴露 host，够用户确认"填的是哪个群"又不泄露 path 里的 token
    host: webhook === '' ? null : safeHost(webhook),
    secretConfigured: secret !== '',
    app,
    onComplete: notifyEventEnabled('notifyOnComplete'),
    onError: notifyEventEnabled('notifyOnError'),
    onApproval: notifyEventEnabled('notifyOnApproval'),
    onQuestion: notifyEventEnabled('notifyOnQuestion'),
    includeSubagent: notifyIncludeSubagent(),
    throttleMs: notifyThrottleMs(),
    minDurationMs: notifyMinDurationMs(),
  };
}

function safeHost(raw) {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

// ---------- 文案 ----------

/** 截断到 max 个字符（按码点，避免切碎 emoji）。 */
function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/**
 * 组装一条通知的标题与正文。
 * 设计：**只带会话标题 + 事件短语**，不带会话正文（用户明确选择）。
 */
export function buildNotification(kind, { title, detail }) {
  const name = clip(title, 48);
  switch (kind) {
    case 'complete':
      return { title: '✅ 任务完成', body: name };
    case 'error':
      return { title: '❌ 会话出错', body: detail ? `${name}\n${clip(detail, 120)}` : name };
    case 'approval':
      return { title: '⚠️ 需要你的审批', body: detail ? `${name}\n${clip(detail, 100)}` : name };
    case 'question':
      return { title: '❓ 需要你回答', body: detail ? `${name}\n${clip(detail, 120)}` : name };
    default:
      return { title: '📣 DSH', body: name };
  }
}

// ---------- 发送 ----------

/**
 * 构造各渠道的请求体。
 * 飞书/企微/钉钉都用各自的简单文本消息格式；serverchan/pushplus/ntfy/generic 用通用形态。
 */
function buildRequest(channel, { title, body }, { webhook, secret }) {
  const text = `${title}\n${body}`;

  if (channel === 'feishu') {
    // 飞书群自定义机器人：交互式卡片文案最稳，纯 text 亦可
    return {
      url: webhook,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text } }),
      },
    };
  }

  if (channel === 'wecom') {
    return {
      url: webhook,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      },
    };
  }

  if (channel === 'dingtalk') {
    // 钉钉加签：sign = base64(HMAC-SHA256(timestamp + "\n" + secret, secret))
    // 需要 node:crypto；这里延后到发送时用动态 import，避免模块顶层耦合。
    return { dingtalk: true, webhook, secret, text };
  }

  if (channel === 'serverchan') {
    // Server酱：POST { title, desp }（title 必填，desp 支持 Markdown）
    return {
      url: webhook,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, desp: body }),
      },
    };
  }

  if (channel === 'pushplus') {
    // PushPlus：单接口在 URL path 里带 token，POST { title, content }
    return {
      url: webhook,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, content: text, template: 'txt' }),
      },
    };
  }

  if (channel === 'ntfy') {
    // ntfy：纯文本 body + Title 头即可（无需 JSON）
    return {
      url: webhook,
      init: {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', Title: encodeHeader(title) },
        body: text,
      },
    };
  }

  // generic：POST 一个结构化 JSON，方便用户自己接
  return {
    url: webhook,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, body, text, source: 'dsh-pocket' }),
    },
  };
}

/** HTTP 头里不能出现非 ASCII（ntfy 的 Title 用得到）。 */
function encodeHeader(text) {
  try {
    return encodeURIComponent(String(text ?? ''));
  } catch {
    return 'DSH';
  }
}

/**
 * 判定「平台是否接受了这条消息」。
 * 各家的成功码不一致，且 HTTP 200 也可能带业务错误码，必须分别判。
 */
function platformAccepted(channel, status, text) {
  if (status < 200 || status >= 300) return false;
  if (channel === 'feishu') {
    // { code: 0, msg: "success" }；老接口可能没有 code 字段
    try {
      const j = JSON.parse(text);
      if (j && typeof j.code === 'number' && j.code !== 0) return false;
      if (j && typeof j.StatusCode === 'number' && j.StatusCode !== 0) return false;
    } catch { /* 非 JSON 当作成功（部分自建网关） */ }
    return true;
  }
  if (channel === 'wecom' || channel === 'dingtalk') {
    try {
      const j = JSON.parse(text);
      if (j && typeof j.errcode === 'number' && j.errcode !== 0) return false;
      if (j && typeof j.code === 'number' && j.code !== 0) return false;
    } catch { /* 非 JSON 当作成功 */ }
    return true;
  }
  if (channel === 'serverchan' || channel === 'pushplus') {
    try {
      const j = JSON.parse(text);
      if (j && typeof j.code === 'number' && j.code !== 0 && j.code !== 200) return false;
    } catch { /* 忽略 */ }
    return true;
  }
  // ntfy / generic：HTTP 2xx 即算成功
  return true;
}

/**
 * 发送一条通知。
 * 返回 { sent: true } 或 { sent: false, reason }。
 * **永不抛错**——通知失败绝不能影响会话本身。
 *
 * feishu-app 渠道走飞书官方 SDK（应用身份），在 feishu-app.mjs 里实现；
 * 其余渠道走 Webhook POST。
 */
export async function sendNotification(kind, payload, { channel, webhook, secret }, { timeoutMs = 10000, log } = {}) {
  // 飞书应用通道：不用 Webhook，走 SDK 发送
  if (channel === 'feishu-app') {
    try {
      const { sendFeishuAppMessage } = await import('./feishu-app.mjs');
      return await sendFeishuAppMessage(payload, { log, timeoutMs });
    } catch (err) {
      return { sent: false, reason: `feishu-app: ${err?.message ?? err}` };
    }
  }

  if (!webhook) return { sent: false, reason: 'not-configured' };

  let request;
  try {
    request = buildRequest(channel, payload, { webhook, secret });
  } catch (err) {
    return { sent: false, reason: `build-failed: ${err?.message ?? err}` };
  }

  // 钉钉加签需要 node:crypto，单独处理
  let url = request.url;
  try {
    if (request.dingtalk) {
      const { createHmac } = await import('node:crypto');
      const timestamp = Date.now();
      const stringToSign = `${timestamp}\n${secret}`;
      const sign = secret
        ? createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64')
        : '';
      const u = new URL(request.webhook);
      u.searchParams.set('timestamp', String(timestamp));
      if (sign) u.searchParams.set('sign', sign);
      url = u.toString();
      request = {
        url,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: request.text } }),
        },
      };
    }
  } catch (err) {
    return { sent: false, reason: `sign-failed: ${err?.message ?? err}` };
  }

  let timer = null;
  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) {
      timer = setTimeout(() => { try { controller.abort(); } catch { /* 忽略 */ } }, timeoutMs);
    }
    const init = controller ? { ...request.init, signal: controller.signal } : request.init;
    const res = await fetch(url, init);
    const text = await res.text().catch(() => '');
    if (!platformAccepted(channel, res.status, text)) {
      return { sent: false, reason: `http-${res.status}${text ? `: ${clip(text, 120)}` : ''}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err?.name === 'AbortError' ? 'timeout' : `network: ${err?.message ?? err}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
