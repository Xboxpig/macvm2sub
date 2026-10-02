# Jinn source attribution

Project: https://github.com/hristo2612/jinn
Commit: `3ae6465715b6195db057d4c23156b696c71dc179`
License: MIT; original notice is in `LICENSE`.

`transcript-tailer.mjs` is adapted from
`packages/jinn/src/engines/transcript-tailer.ts`: TypeScript types and Jinn logging
dependencies removed; bounded reads and file rotation/truncation handling added.

`codex-markers.mjs` extracts and adapts the session/turn marker parsing and the
matching-start-before-completion rule from
`packages/jinn/src/engines/codex-interactive.ts`.

Our session lifecycle applies Jinn's warm-process reuse and native `codex resume`
approach. It uses the macOS standard-library PTY driver and gateway-specific
capacity/timeouts. The Claude-specific `sse-pty-proxy.ts` was reviewed as a design
reference; its tool-presence classifier is not used for Codex Responses traffic.
