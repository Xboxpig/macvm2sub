# macvm2sub

在 macOS x64 上运行的单账号 Codex API gateway，独立维护并继承 [vm2api](https://github.com/dofastted/vm2api)。

网关启动官方 Codex TUI，用 PTY 提交 prompt，在本机代理中同步转发并读取原生 HTTP/WS 响应。一个客户端会话对应一个持久 TUI；默认同时进行一次推理。控制台使用 CPA-Manager-Plus 的 React 组件和主题，提供概览、请求记录、Codex 登录和模型设置。

## 启动

验证环境：macOS 15.7 x64、Node.js 24、Python 3、官方 Codex CLI 0.160.0。

```sh
npm ci
npm --prefix console ci
npm run build:web
npm run setup:macos
npm run login:codex
npm run start:macos
```

初始化把随机 API key 和控制台密码写入权限为 `0600` 的 `.env.macos`。控制台：`http://127.0.0.1:8787/console/`。部署前按需修改 `HOST`；环境变量见 [.env.example](.env.example)。已有部署的 `VM2API_API_KEY`、`VM2API_ADMIN_USER`、`VM2API_ADMIN_PASSWORD` 和 `KIN_CODEX_CLI_BIN` 可继续使用。

`MACVM2SUB_CODEX_HOME` 可指向已经 OAuth 登录的 Codex home。认证和 token 刷新由官方 CLI 完成。控制台支持发起浏览器 OAuth、设备验证码登录，以及提交远程浏览器无法访问的 `localhost:1455/auth/callback` URL。

## API 与会话

- `POST /v1/responses`：JSON 或 SSE。
- `GET /v1/responses` 的 WebSocket Upgrade：`response.create`、`generate:false` warmup 和连续响应。
- `GET /v1/models`：官方 CLI 缓存的模型目录；尚未生成目录时返回配置的默认模型。
- API 请求使用 `Authorization: Bearer <API key>`；控制台使用独立的登录 cookie。

后续请求优先带 `previous_response_id`。网关把它关联到原 TUI；连续 HTTP 和 WS 请求可以共用该 ID。完整历史在内存中精确匹配时也可续接。旧 ID 分叉、过期会话、模型或工具定义变更会返回明确错误。空闲会话默认保留 15 分钟，最多 4 个；一次推理期间的其他请求返回 `429 gateway_busy`。

工具由真实 API 客户端执行。网关自带的 stdio MCP 工具桥在本机等待结果，无需安装或连接外部 MCP 服务。客户端收到 `function_call` / `custom_tool_call` 后，在下一次请求中回传相同 `call_id` 的 output；结果进入原 TUI 的工具记录。并行工具调用需要一次返回全部结果。

当前输入支持文本；支持 function、namespace 和以字符串包装的 custom 工具。初始历史和 instructions 作为 TUI 用户 prompt 提交，不提供独立于 Codex 原生指令的 system-role 替换。初次启动/恢复的 prompt 上限为 96 KiB。暂不提供 Chat Completions、图片输入、background Responses 或任意响应分叉；custom 工具的 grammar 不由网关校验。

## 原生轮次与恢复

轮次控制改编自 MIT 项目 [Jinn](https://github.com/hristo2612/jinn)：读取原生 transcript，要求本轮 `task_started` 与 `task_complete` 匹配。首轮 prompt 随 TUI 启动，后续使用 bracketed paste。API 工具调用边界会先返回给客户端，TUI 继续等待工具结果；最终文本完成后再等待原生轮次结束。

已完成的空闲会话保存原生 session ID，服务重启后通过 `codex resume` 恢复；TTL 内可继续使用最后的 `previous_response_id`。推理中或等待工具结果的会话不会在重启后自动重放。网关请求日志只保存状态、耗时和用量；Codex 自己会在其 home 下保存原生 transcript。

## 验证与服务

```sh
npm test
npm run test:native     # macOS 上的真实 TUI + 本地 fixture，不调用付费上游
npm run build:web
node scripts/launchd.mjs # 生成开机服务配置并打印安装命令
```

真实 API 客户端验收（会调用配置模型）：

```sh
MACVM2SUB_TEST_API_KEY=... MACVM2SUB_TEST_MODEL=gpt-5.6-luna \
  node scripts/verify-client.mjs https://your-host:3038
```

脚本使用独立 `CODEX_HOME`、临时工作目录和 `workspace-write` sandbox 启动官方 Codex 客户端，要求通过 `apply_patch` 创建示例代码，再用 shell 运行 3 项 unittest。脚本还会独立重跑测试并输出 JSON 报告；工作目录保留以供检查。

运行架构和来源说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [UPSTREAM.md](UPSTREAM.md)。原 vm2api 的 [非商用许可证](LICENSE) 保留；CPAMP 和 Jinn 代码分别保留各自 MIT 声明。
