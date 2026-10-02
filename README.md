# macvm2sub

面向 macOS x64 的订阅转 API 服务，优先支持官方 Codex CLI。

项目由 [Xboxpig](https://github.com/Xboxpig) 独立维护，继承自 [dofastted/vm2api](https://github.com/dofastted/vm2api)。保留上游 Git 提交历史、版权声明与 [原始许可证](LICENSE)；来源和适配范围见 [UPSTREAM.md](UPSTREAM.md)。

## 当前能力

- macOS 原生 Node.js 控制面，内部通过官方 `codex app-server` 执行推理。
- `POST /v1/responses`，支持普通响应和 SSE 流式输出。
- 每个槽位使用独立的 `CODEX_HOME`，支持浏览器 OAuth 回调与 device code 登录。
- 支持客户端工具调用、工具结果回传和完整会话历史。
- 管理控制台、账号调度与存储沿用上游实现。

已在 Intel macOS 15.7.8、Node.js 24.21.0、Codex CLI 0.160.0 上验证。登录后已实测 `gpt-6-sol` 的普通和流式请求；具体模型可用性以账号为准。

## 快速开始

安装 Node.js 24+ 和官方 Codex CLI，然后：

```sh
git clone https://github.com/Xboxpig/macvm2sub.git
cd macvm2sub
npm ci --ignore-scripts
npm run setup:macos
npm run login:codex
npm run start:macos
```

`login:codex` 默认使用浏览器 OAuth 登录。需要 device code 登录时执行：

```sh
npm run login:codex -- --device-auth
```

- API：`http://127.0.0.1:8787/v1`
- 控制台：`http://127.0.0.1:8787/console`
- 健康检查：`http://127.0.0.1:8787/health`
- API key、管理员密码及数据库密钥：初始化生成在 `.env.macos`。

远程浏览器回调、Codex CLI 客户端配置和代理设置见 [macOS 部署说明](docs/MACOS.md)。

## 适配范围

当前原生适配覆盖 Codex 路径。Claude 槽位和 Linux 容器运行时仍使用上游部署方式。

支持 Responses HTTP/SSE 和 WebSocket。WebSocket 支持预热、同一连接内的 `previous_response_id` 增量续接及客户端工具结果回传；网关恢复完整历史后交给官方 CLI。连接断开后需重发完整历史，暂不支持 `/v1/responses/compact`。管理台原有 OAuth 导入入口尚未接入 CLI 登录，请使用 `npm run login:codex`。官方 CLI 会进行自身的指令和上下文处理。

## 验证

```sh
node --test test/unit/codex-cli.test.mjs
VM2API_TEST_CODEX_CLI=1 node --test test/e2e/codex-cli-native.e2e.test.mjs
```

集成测试使用真实官方 CLI 和本地 fixture provider，覆盖流式响应、工具调用、结果回传以及 Codex CLI 客户端经由服务完成工具循环。

## 来源与许可

- 上游：[dofastted/vm2api](https://github.com/dofastted/vm2api)
- 来源说明：[UPSTREAM.md](UPSTREAM.md)
- 许可证：[LICENSE](LICENSE)

个人学习、研究与非商用自建遵循上游许可证；商用须先取得版权所有者的书面授权。独立维护不会改变原始代码的许可条款。
