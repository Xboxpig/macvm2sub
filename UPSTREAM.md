# 来源与继承关系

`macvm2sub` 由 [Xboxpig](https://github.com/Xboxpig) 独立维护，源自
[dofastted/vm2api](https://github.com/dofastted/vm2api)，并继承其代码与 Git 提交历史。

## 继承基线

- 上游项目：`dofastted/vm2api`
- 适配起点：[`fe643cd7e54befd395537ba06d2f25df8c6101fb`](https://github.com/dofastted/vm2api/commit/fe643cd7e54befd395537ba06d2f25df8c6101fb)
- 首次 macOS/Codex 适配提交：`6c89796e3bc55a240cef6fb404bf730f7f4047d7`
- 独立维护开始日期：2026-10-02

## 本项目的改动

- 增加 macOS x64 原生启动、初始化与官方 Codex CLI 登录入口。
- 通过官方 CLI app-server 承担 Codex 推理与认证。
- 将 Responses 请求、SSE 输出和客户端工具调用接入已有调度流程。
- 增加 macOS 部署文档、协议单元测试与真实 CLI 集成测试。

上游贡献者继续拥有其贡献的版权。原始 [LICENSE](LICENSE) 完整保留，
其非商用条件及商用授权要求仍然适用。仓库独立和名称变更不构成重新授权。

历史文档、环境变量、运行目录、二进制名和 Linux 部署脚本中仍有 `vm2api`
或 `kin` 标识；这些属于继承实现及其兼容接口。macOS 使用说明以
[README.md](README.md) 和 [docs/MACOS.md](docs/MACOS.md) 为准。

后续吸收上游改动时，保留原提交作者及来源信息。
