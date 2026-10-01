# dsh-pocket-notify

> **这是 [`dsh-pocket`](https://github.com/shaobeichen/dsh-pocket) 的 fork。**
> 在「手机扫码访问 DSH」之上，加了**消息推送**：任务完成、出错、待审批、待回答时推到你的手机。

[![License: GPL-2.0](https://img.shields.io/badge/License-GPL--2.0-blue.svg)](./LICENSE)

---

## 这是什么

原版 dsh-pocket 解决的是「**在外面也能用手机操作电脑上的 DSH**」—— 扫码即开，实时同屏。

但它缺一件事：**任务在电脑上跑完了，手机上没有任何提示**。你得反复切回页面看。

这个 fork 补上这块。网页关掉、手机锁屏也能收到。

## 新增功能

| 功能 | 说明 |
|---|---|
| 🔔 **消息推送** | 任务完成 / 出错 / 待审批 / 待回答，四类事件独立开关 |
| 📱 **飞书扫码创建机器人** | 点「生成二维码」→ 手机飞书扫码 → 自动创建应用并预填权限，**不用手动建群、不用复制 URL** |
| 🔗 **群机器人 Webhook** | 备选通道：粘一个 URL 即可，**不需要飞书审批** |
| ⚙️ **事件级开关** | 每类事件单独开关；子任务默认静音，避免一个主任务刷几十条 |
| 🛡️ **凭据不外泄** | App Secret / Webhook URL 只存本机（`0600`），界面只回显脱敏摘要 |

### 支持的推送渠道

| 渠道 | 形态 |
|---|---|
| **飞书机器人** | 扫码创建（推荐，体验最好） |
| 飞书群机器人 Webhook | 粘 URL |
| 企业微信群机器人 | 粘 URL |
| 钉钉群机器人 | 粘 URL（支持加签） |
| Server酱 / PushPlus | 粘 URL（消息进微信） |
| ntfy | 粘 URL（可自建） |
| 任意自定义 Webhook | 粘 URL，POST 一个 JSON |

## 安装

```bash
dsh plugin --profile web add github:Practice019/dsh-pocket-notify
```

或本地路径：

```bash
dsh plugin --profile web add /path/to/dsh-pocket-notify
```

装完重启 `dsh web`。

> ⚠️ 不要和官方 `dsh-pocket` 同时安装 —— 两者包名相同，会冲突。

## 用法

### 一、手机访问（原版功能）

设置 → 手机访问 → 局域网二维码 / 点「开启公网访问」。

### 二、消息推送（本 fork 新增）

设置 → 手机访问 → 拉到底部「🔔 消息推送」：

**方式 A：飞书扫码（推荐）**

1. 渠道选「飞书机器人（扫码创建）」
2. 点「生成二维码」
3. 手机飞书扫码 → 按提示创建应用
4. **去飞书开放平台发布一个版本**（见下方说明）
5. 回来点「测试推送」

**方式 B：群机器人 Webhook（不需要审批）**

1. 在飞书里建一个只有自己的群
2. 群设置 → 群机器人 → 添加机器人 → **自定义机器人**
3. 复制 Webhook 地址
4. 回到设置页，渠道选「飞书群机器人 Webhook」，粘贴 → 保存 → 测试推送

## ⚠️ 关于飞书的「发布审批」

扫码能**自动完成**的事：创建应用、预填权限、订阅事件、回传凭据。

但**「发布版本」这一步必须你手动点** —— 它在飞书自己的网页上，飞书没有提供 API，任何第三方程序都无法代按。这不是本项目的限制。

好消息是本 fork 只申请**一个权限**：

```
im:message:send_as_bot    # 以应用身份发消息
```

（做完整聊天机器人的方案通常要申请 9 类权限，审批复杂得多。）

个人版租户通常可自助发布；企业版需要管理员审批。

**如果审批卡住**：切到方式 B（群机器人 Webhook），它不需要任何审批。

## 推送内容

只带**会话标题 + 事件短语**，不含会话正文、不含代码：

```
✅ 任务完成
修复登录页样式
```

## 设计取舍

- **完成判定用状态跃迁**：只在 `running → idle` 时推送，所以 DSH 重启不会把上次的旧任务补发一堆「已完成」。
- **子任务默认静音**：子代理完成默认不推，否则一个主任务可能刷出几十条。可在设置里打开。
- **节流 + 串行队列**：同一会话同一事件有最小间隔，且发送串行排队，不会打爆 IM 侧限频。
- **推送失败绝不影响会话**：所有发送错误只记日志，不向事件流抛错。
- **waterfall 事件必须转发 `next()`**：`approval/request` 与 `user-questions/request` 是 waterfall 模式，漏了 `next()` 会把审批 / 提问彻底卡死。

## 安全

| 项 | 处理 |
|---|---|
| App Secret | 只存本机 `~/.dsh/dsh-pocket/settings.json`（`0600`），RPC 永不回显 |
| Webhook URL | 同上，界面只显示 host，不显示 path 里的 token |
| 发送目标 | 用扫码人的 `open_id`，不额外存储用户标识 |

「恢复出厂设置」会一并清除上述凭据。

## 从源码构建

```bash
npm install
npm run build:client   # 改 client/ 后重新打包
```

改 `lib/` 不需要构建；改 `client/index.jsx` 后必须跑 `build:client`。

## 相对上游改了什么

基于 upstream `2.10.6`：

**新增文件**

| 文件 | 作用 |
|---|---|
| `lib/notify.mjs` | 推送配置、文案、各渠道发送器 |
| `lib/notify-wiring.mjs` | 把 DSH 事件接到发送器 |
| `lib/feishu-app.mjs` | 飞书扫码注册、凭据存储、应用发消息 |

**修改文件**

| 文件 | 改动 |
|---|---|
| `lib/index.js` | 挂载事件接线、注册推送 RPC、恢复出厂时清凭据 |
| `lib/web-rpc.js` | 新增 `notify.*` 与 `feishu.*` 端点 |
| `client/api.js` | 端点常量 |
| `client/index.jsx` | 「消息推送」设置区块 + 扫码 UI |
| `client/pocket-locales.js` | 中英文案 |
| `client/client.js` | 重新打包的产物 |

## 上游与致谢

- **原作者**：[shaobeichen](https://github.com/shaobeichen) —— [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)
- 移动端适配移植自 [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（MIT）
- 公网隧道基于 [cloudflared](https://github.com/cloudflare/cloudflared)
- 飞书扫码基于 [@larksuiteoapi/node-sdk](https://github.com/larksuite/node-sdk)

原版说明见 [README.upstream.md](./README.upstream.md)。

## License

**GPL-2.0**，与原版一致。

本仓库包含 dsh-pocket 的修改版源码，作为衍生作品整体以 GPL-2.0 分发。详见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。
