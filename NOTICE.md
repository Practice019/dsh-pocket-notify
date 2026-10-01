# NOTICE

## 本项目的性质

`dsh-pocket-notify` 是 **[dsh-pocket](https://github.com/shaobeichen/dsh-pocket)** 的 fork（衍生作品）。

它**包含 dsh-pocket 的修改版源码**，不是仅通过 API 调用的独立程序。

## 上游信息

| 项 | 值 |
|---|---|
| 原始项目 | dsh-pocket |
| 原作者 | [shaobeichen](https://github.com/shaobeichen) |
| 上游仓库 | https://github.com/shaobeichen/dsh-pocket |
| 本 fork 基于的版本 | `2.10.6` |
| 上游许可证 | GPL-2.0 |

## 许可证义务与履行

dsh-pocket 以 **GNU General Public License v2.0** 发布。该许可证是 copyleft 的，分发衍生作品时需要满足以下条件，本仓库逐一履行：

| GPL-2.0 要求 | 本仓库如何满足 |
|---|---|
| 衍生作品整体以 GPL-2.0 分发 | 本仓库根目录 [`LICENSE`](./LICENSE)，为上游原始许可证全文，未修改 |
| 保留原始版权声明 | `LICENSE` 文件完整保留；本 NOTICE 明确记录来源与作者 |
| 提供完整对应源码 | 本仓库即完整源码（含 `client/`、`lib/`、`bin/`），修改处见下文 |
| 标注修改内容与日期 | 见下方「本 fork 的修改」 |
| 不得附加限制 | 未对上游代码施加任何额外许可限制 |

## 本 fork 的修改

相对上游 `2.10.6`，修改如下（首次发布：2026-09-30）：

### 新增文件

| 文件 | 内容 | 性质 |
|---|---|---|
| `lib/notify.mjs` | 推送配置读写、通知文案、各渠道 Webhook 发送器 | 原创 |
| `lib/notify-wiring.mjs` | 把 DSH 的 agent 事件接到发送器 | 原创 |
| `lib/feishu-app.mjs` | 飞书扫码注册、凭据存储、以应用身份发消息 | 原创 |

### 修改文件

| 文件 | 修改内容 |
|---|---|
| `lib/index.js` | 引入并挂载上述模块；注册推送相关 RPC；恢复出厂设置时清除推送凭据 |
| `lib/web-rpc.js` | 新增 `notify.get` / `notify.set` / `notify.test` 与 `feishu.*` 端点 |
| `client/api.js` | 新增端点常量 |
| `client/index.jsx` | 新增「消息推送」设置区块与飞书扫码 UI |
| `client/pocket-locales.js` | 新增中英文案 |
| `client/client.js` | 由 `client/index.jsx` 重新打包生成（esbuild 产物） |
| `package.json` | 包描述、版本号、依赖（新增 `@larksuiteoapi/node-sdk`）、仓库地址 |

### 未修改

- `bin/dsh-pocket.mjs`
- `cordis.patch.yml`
- `LICENSE`

## 第三方依赖

| 依赖 | 许可证 | 用途 |
|---|---|---|
| [@larksuiteoapi/node-sdk](https://github.com/larksuite/node-sdk) | MIT | 飞书扫码注册与消息发送 |
| [qrcode](https://github.com/soldair/node-qrcode) | MIT | 渲染二维码（上游已有） |
| [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) | MIT | 终端二维码（上游已有） |

上游项目另有第三方致谢，见 [README.upstream.md](./README.upstream.md)：

- 移动端适配移植自 [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（MIT）
- 公网隧道基于 [cloudflared](https://github.com/cloudflare/cloudflared)

## 商标与归属

本项目与「DeepSeek」「DeepSeek Harness」「飞书 / Lark」的官方主体无隶属关系，也未获其背书。相关名称为各自所有者的商标。

## 免责声明

本软件按「原样」提供，不附带任何明示或暗示的担保。启用公网访问会将你的本机 DSH 暴露到互联网，请阅读 README 的安全说明并自行评估风险。
