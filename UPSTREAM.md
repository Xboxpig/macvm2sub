# 来源与继承关系

`macvm2sub` 由 [Xboxpig](https://github.com/Xboxpig) 独立维护，源自 [dofastted/vm2api](https://github.com/dofastted/vm2api)，继承其代码与 Git 提交历史。

- vm2api 继承起点：`fe643cd7e54befd395537ba06d2f25df8c6101fb`
- 首次 macOS 适配：`6c89796e3bc55a240cef6fb404bf730f7f4047d7`
- 独立维护开始：2026-10-02
- 精简前的 Responses WebSocket 检查点：`acf1bb8`

当前分支改为单账号、持久官方 Codex TUI 与 HTTP/WS 代理；精简前的实现可从 Git 历史恢复。

前端组件与主题引入自 [CPA-Manager-Plus](https://github.com/seakee/CPA-Manager-Plus)，固定版本 `05ebb7f275dbe575211cb886436d4b99936c1cd9`，改造范围和 MIT 许可见 [前端来源说明](console/src/vendor/cpamp/UPSTREAM.md)。

原生 transcript tailer、轮次 marker 解析与生命周期参考来自 [Jinn](https://github.com/hristo2612/jinn)，固定版本 `3ae6465715b6195db057d4c23156b696c71dc179`。模块改编范围和 MIT 许可见 [Jinn 来源说明](src/vendor/jinn/UPSTREAM.md)。

原贡献者继续拥有各自贡献的版权。原始 [LICENSE](LICENSE) 完整保留，其非商用条件及商用授权要求仍然适用。仓库独立和名称变更不构成重新授权；引入 MIT 模块也不改变其他继承代码的许可条件。
