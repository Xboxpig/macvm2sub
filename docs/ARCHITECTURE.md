# Codex TUI gateway

```mermaid
sequenceDiagram
  participant Client as API client
  participant API as Responses HTTP / WS
  participant TUI as Official Codex TUI / PTY
  participant Relay as Loopback HTTP / WS relay
  participant Upstream as Codex upstream
  participant Bridge as Built-in local tool bridge
  Client->>API: prompt + tools
  API->>TUI: first prompt / bracketed paste
  TUI->>Relay: native request + CLI OAuth
  Relay->>Upstream: forwarded request
  Upstream-->>Relay: structured response events
  Relay-->>TUI: native events
  Relay-->>API: mapped response events
  API-->>Client: function_call
  TUI->>Bridge: call client tool, wait
  Client->>API: function_call_output + previous_response_id
  API->>Bridge: real tool output
  Bridge-->>TUI: native MCP tool result
  TUI->>Relay: continue same native conversation
  Relay->>Upstream: native continuation
  Upstream-->>Relay: final answer
  Relay-->>TUI: final answer
  TUI-->>API: transcript task_complete
  API-->>Client: response.completed
```

## Process and protocol ownership

`Sessions` maintains one persistent TUI per conversation, one shared OAuth account,
and a single active API inference. This is conversation state, not an account pool.
The official CLI owns authentication, native instructions, transcript persistence
and its conversation history. `openai_base_url` sends native HTTP and WebSocket
traffic through a loopback proxy. Upstream URLs and credentials are not taken from
public request fields. No application patch, TLS certificate installation or
third-party MCP service is required.

Public response IDs map to gateway conversations; upstream response IDs remain
inside the native connection. Warmups and title/background traffic are forwarded
but do not become API output. Main requests are correlated with the exact submitted
user message or a known native response/tool call ID. Both `tools` and the newer
`input.additional_tools` schema are handled. Completed output is reconstructed
from item events when the native `response.completed.output` array is empty.

Only the session's client-tool namespace is offered to the upstream. Codex's
`features.code_mode.direct_only_tool_namespaces` keeps that namespace directly
callable even for models that default to Code Mode. Native calls retain their
call IDs; the public name/namespace is mapped back to the client's declaration.
Custom tools use a single string `input` field in their internal MCP schema.

The built-in tool bridge is a stdio child process with an ephemeral, authenticated
loopback endpoint. Its approval mode authorizes forwarding a call to the client;
it does not execute a client shell command on the gateway. The client retains its
own execution/approval policy. Arbitrary client tools are not marked read-only.
Unknown native tools fail the session before delivery to the TUI.

## Turn boundaries and recovery

The Jinn-derived transcript tailer combines filesystem watches and polling, handles
partial UTF-8/JSONL writes, and requires a matching `task_started` before accepting
`task_complete` or `turn_aborted`. Transcript discovery checks the unique gateway
working directory, preventing attachment to another Codex process's rollout.

The first prompt is supplied as a native CLI argument, so startup does not depend
on terminal text or a fixed sleep. Later prompts use bracketed paste; the short
paste/Enter separation is terminal input framing, not a turn-completion detector.
Native tool waits remain part of the same TUI turn. The API can finish a tool-call
response while that native turn is still waiting; the final text response waits
for the matching transcript completion marker.

Clean idle sessions checkpoint their native session ID and last public response ID.
After gateway restart, an eligible request launches `codex resume` with that ID.
Active inference and outstanding client tool calls are excluded from recovery:
replaying either could duplicate external work. Full-history matching is in-memory;
after restart, use the last `previous_response_id`. Session expiration is explicit.

## Imported code

- CPA-Manager-Plus: complete analytics page and chart presentation, configuration
  editor/diff controls, OAuth card layout, React primitives and theme sources.
- Jinn: transcript tailer and Codex turn marker parser; warm-process lifecycle and
  `resume` informed the gateway lifecycle. Its Claude request classifier was not
  copied because Codex also sends main requests with no top-level tools.

See [UPSTREAM.md](../UPSTREAM.md) for pinned commits and retained licenses.

## Console data adapter

The console uses cookie-authenticated `/api/status`, `/api/models`,
`/api/settings`, `/api/analytics` and `/api/account/*`. API bearer keys are never
included in the analytics response or browser state. The single key and credential
use display identifiers `gateway` and `codex`.

Analytics maps retained gateway request metadata to the CPA schema, including
time/model/status/cache/latency filters, timezone-aware buckets, cache/reasoning
tokens, model and credential rankings, heatmaps, prior-period comparison and
paginated request drilldown. A bucket with at least five requests and at least
20% failures is marked anomalous (50% is high severity). Cost is unpriced and
shown as `—`; latency is gateway request duration, and TTFT is unavailable.
No prompts, tool arguments, tool results or OAuth tokens are recorded here.

History defaults to 10,000 records (configurable 500–50,000). Lifetime totals
survive record eviction; the analytics coverage field marks incomplete ranges.
Existing historical records contain only previously collected fields, so missing
cache/reasoning counts default to zero. Changing retention cannot recover records
already discarded by older versions.

Settings are validated and written atomically before updating the running config.
Default model affects new sessions; timeouts apply to subsequent turns, while
session limits and idle TTL affect subsequent lifecycle checks. Browser OAuth,
device login, callback forwarding and cancellation are owned by the official CLI.
