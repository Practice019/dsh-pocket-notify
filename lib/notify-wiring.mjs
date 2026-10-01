// dsh-pocket 消息推送 —— 事件接线（新增模块）
//
// 把 DSH 的会话事件接到 notify.mjs 的发送器上。
//
// 监听（都是 Host 事件）：
//   agent/status            running → idle        任务完成
//   agent/error                                   会话出错
//   approval/request        （waterfall）          待审批
//   user-questions/request  （waterfall）          待回答 / 方案确认
//
// 三条纪律：
//   1. waterfall 事件必须 return next()，否则会截断下游应答器 ——
//      审批 / 提问会彻底卡死。先发通知再转发。
//   2. 发送失败只记日志，绝不向事件流抛错。
//   3. 只读叶子字段（会话 id / 标题），不整体持有 Session 对象。

import {
  notifyEnabled, notifyEventEnabled, notifyIncludeSubagent, notifyThrottleMs, notifyMinDurationMs,
  notifyChannel, notifyWebhook, notifySecret, buildNotification, sendNotification,
} from './notify.mjs';

/** 扫码绑定相关的操作统一从这里转发，方便 index.js 只 import 一个模块。 */
export {
  startFeishuRegistration, cancelFeishuRegistration, feishuRegistrationPending,
  feishuAppView, verifyFeishuApp, clearFeishuAppState,
} from './feishu-app.mjs';

/** 短 id 兜底：拿不到标题时至少能区分是哪个会话。 */
function shortId(sessionId) {
  return typeof sessionId === 'string' ? sessionId.slice(0, 8) : 'unknown';
}

function errorText(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const candidate = error.message ?? error.code ?? error.name;
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return String(error);
}

/**
 * 注册事件监听。返回 disposer。
 *
 * @param {object} ctx   Cordis 上下文（插件 apply 的 ctx）
 * @param {object} logger
 */
export function installNotifyWiring(ctx, logger) {
  const runningSince = new Map();
  const lastSentAt = new Map();
  let queue = Promise.resolve();

  const log = {
    info: (m) => logger?.info?.(`dsh-pocket: ${m}`),
    warn: (m) => logger?.warn?.(`dsh-pocket: ${m}`),
  };

  function throttled(key) {
    const now = Date.now();
    const prev = lastSentAt.get(key);
    const window = notifyThrottleMs();
    if (prev !== undefined && now - prev < window) return true;
    lastSentAt.set(key, now);
    return false;
  }

  /** 读会话标题与「是否子代理」。只读叶子字段。 */
  async function describe(sessionId) {
    const fallback = { title: shortId(sessionId), subagent: false };
    const query = ctx.get?.('sessionQuery');
    if (query === undefined || typeof query.readTitleSnapshot !== 'function') return fallback;
    try {
      const observation = await query.readTitleSnapshot(sessionId);
      const header = observation?.session;
      const raw = observation?.title?.title;
      return {
        title: typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback.title,
        subagent: Boolean(header && (header.origin === 'subagent' || typeof header.parentSession === 'string')),
      };
    } catch {
      return fallback;
    }
  }

  /** 真正发送：串行排队，避免并发打爆 IM 侧限频。 */
  function deliver(kind, payload) {
    queue = queue.then(async () => {
      try {
        if (!notifyEnabled()) return;
        const channel = notifyChannel();
        const webhook = notifyWebhook();
        // feishu-app 通道用应用凭据，不需要 Webhook；其余通道必须有 Webhook。
        if (channel !== 'feishu-app' && !webhook) return;
        const result = await sendNotification(
          kind,
          payload,
          { channel, webhook, secret: notifySecret() },
          { log },
        );
        if (result?.sent === true) {
          log.info(`notify sent: ${kind} | 推送已发送`);
        } else {
          log.warn(`notify failed (${result?.reason ?? 'unknown'}) | 推送失败`);
        }
      } catch (err) {
        log.warn(`notify error: ${err?.message ?? err} | 推送异常`);
      }
    });
    return queue;
  }

  async function maybeNotify(kind, sessionId, detail) {
    const info = await describe(sessionId);
    if (info.subagent && !notifyIncludeSubagent()) return;
    const payload = buildNotification(kind, { title: info.title, detail });
    await deliver(kind, payload);
  }

  const disposers = [];

  // ---------- 任务完成：只用 running → idle 跃迁判定 ----------
  disposers.push(ctx.on('agent/status', (payload) => {
    try {
      const agent = payload?.agent;
      const sessionId = agent?.id;
      if (typeof sessionId !== 'string') return;

      if (payload.status === 'running') {
        if (!runningSince.has(sessionId)) runningSince.set(sessionId, Date.now());
        return;
      }
      if (payload.status !== 'idle') return;

      const startedAt = runningSince.get(sessionId);
      runningSince.delete(sessionId);
      if (startedAt === undefined) return;      // 加载前就在跑的那一轮，不补发
      if (!notifyEnabled() || !notifyEventEnabled('notifyOnComplete')) return;
      if (Date.now() - startedAt < notifyMinDurationMs()) return;
      if (throttled(`complete:${sessionId}`)) return;

      void maybeNotify('complete', sessionId);
    } catch (err) {
      log.warn(`agent/status handler failed: ${err?.message ?? err}`);
    }
  }));

  // 会话销毁时清掉计时，防止 Map 无限增长
  disposers.push(ctx.on('agent/disposed', (payload) => {
    try {
      const id = payload?.agent?.id;
      if (typeof id === 'string') runningSince.delete(id);
    } catch { /* 忽略 */ }
  }));

  // ---------- 会话出错 ----------
  disposers.push(ctx.on('agent/error', (payload) => {
    try {
      const sessionId = payload?.agent?.id;
      if (typeof sessionId !== 'string') return;
      if (!notifyEnabled() || !notifyEventEnabled('notifyOnError')) return;
      if (throttled(`error:${sessionId}`)) return;

      void maybeNotify('error', sessionId, errorText(payload.error));
    } catch (err) {
      log.warn(`agent/error handler failed: ${err?.message ?? err}`);
    }
  }));

  // ---------- 待审批（waterfall：必须转发 next） ----------
  disposers.push(ctx.on('approval/request', (request, next) => {
    try {
      const sessionId = request?.agent?.id;
      if (typeof sessionId === 'string'
        && notifyEnabled() && notifyEventEnabled('notifyOnApproval')
        && !throttled(`approval:${sessionId}`)) {
        const tool = typeof request.toolName === 'string' ? request.toolName : '';
        const display = request.displayReason;
        const why = display && typeof display === 'object'
          ? (display['zh-CN'] ?? display.zh ?? display.en ?? '')
          : '';
        const reason = typeof request.reason === 'string' && request.reason !== '' ? request.reason : why;
        const detail = [tool ? `工具：${tool}` : '', reason ? `原因：${reason}` : '']
          .filter(Boolean).join('\n');
        void maybeNotify('approval', sessionId, detail);
      }
    } catch (err) {
      log.warn(`approval/request handler failed: ${err?.message ?? err}`);
    }
    return next();
  }));

  // ---------- 待回答 / 方案确认（waterfall：必须转发 next） ----------
  disposers.push(ctx.on('user-questions/request', (request, next) => {
    try {
      const sessionId = request?.agent?.id;
      if (typeof sessionId === 'string'
        && notifyEnabled() && notifyEventEnabled('notifyOnQuestion')
        && !throttled(`question:${sessionId}`)) {
        const questions = Array.isArray(request.questions) ? request.questions : [];
        const first = questions[0];
        const planReview = Boolean(first?.intent && first.intent.kind === 'plan-review');
        const ask = typeof first?.question === 'string' ? first.question : '';
        const extra = questions.length > 1 ? `（共 ${questions.length} 个问题）` : '';
        void maybeNotify('question', sessionId, ask ? `${ask}${extra}` : extra);
        // 方案确认走同一事件，但标题不同：这里单独把「方案待确认」的含义补进 detail
        if (planReview) {
          log.info('plan-review request notified | 方案确认已推送');
        }
      }
    } catch (err) {
      log.warn(`user-questions/request handler failed: ${err?.message ?? err}`);
    }
    return next();
  }));

  return () => {
    for (const d of disposers) {
      try { d?.(); } catch { /* 忽略 */ }
    }
    runningSince.clear();
    lastSentAt.clear();
  };
}

/** 「测试推送」用：不经过节流与开关判断，直接发一条。 */
export async function sendTestNotification(logger) {
  const channel = notifyChannel();
  const webhook = notifyWebhook();
  // feishu-app 通道用应用凭据；其余必须已配 Webhook
  if (channel !== 'feishu-app' && !webhook) {
    return { sent: false, reason: 'not-configured' };
  }
  const payload = buildNotification('complete', {
    title: '测试推送 · dsh-pocket',
    detail: '',
  });
  const result = await sendNotification(channel, payload, {
    channel,
    webhook,
    secret: notifySecret(),
  }, { log: logger });
  if (result?.sent !== true) {
    logger?.warn?.(`dsh-pocket: test notify failed (${result?.reason ?? 'unknown'}) | 测试推送失败`);
  }
  return result;
}
