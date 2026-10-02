# macOS x64 / official Codex CLI

macvm2sub derives from vm2api and adds a native Codex backend for macOS.
See [UPSTREAM.md](../UPSTREAM.md) for provenance. The inference path is:

```text
Codex CLI or Responses client → macvm2sub /v1/responses
  → official codex app-server (stdio) → configured Codex provider
```

Tested on Intel macOS 15.7.8, Node.js 24.21.0 and official Codex CLI 0.160.0.
This backend uses the installed official CLI for inference and authentication.
It does not require the bundled Linux kernels, Docker, iptables, Rust or Go.
Claude slots and the Linux container runtime still require their existing Linux deployment.

## Install and start

Use Node.js 24+ and put `codex` on PATH. The app-server API is experimental;
0.160.0 is the tested CLI version (`npm install -g @openai/codex@0.160.0`).

```sh
git clone https://github.com/Xboxpig/macvm2sub.git
cd macvm2sub
npm ci --ignore-scripts
npm run setup:macos
npm run login:codex
npm run start:macos
```

Initialization preserves existing files. It creates:

- `.env.macos`: random API key, admin password and DB secret, mode 0600; loopback port 8787.
- `vms/vm-codex-01.json`: one Codex slot with concurrency 1 and an explicit local exit.
- `vms/vm-codex-01/codex-home/`: isolated CLI configuration and authentication.

Login uses the official CLI in that slot's `CODEX_HOME`. It does not modify
`~/.codex`. `npm run status:codex` checks authentication through app-server and
updates the slot's scheduling credential flag. Use this after logging out or
changing the slot's CLI authentication outside the launcher.

The default login opens the browser OAuth flow and receives the localhost
callback on port 1455. When the CLI runs on a remote Mac, forward that port from
the browser machine with `ssh -L 1455:localhost:1455 user@your-mac`, then run
`npm run login:codex` in the SSH session and open the printed URL locally.
Device code login is available with `npm run login:codex -- --device-auth`.

Check `http://127.0.0.1:8787/health`; the bundled console is at `/console`.
Read the generated credentials locally from `.env.macos`. For remote access,
forward port 8787 over SSH or configure the listen address explicitly.

`KIN_CODEX_CLI_BIN` can select an absolute executable path. `VM2API_CODEX_SLOT`
selects another slot for setup/login/status. Each slot has a separate CLI home.
An administrator can set `runtime.codex_cli_home` to an absolute existing CLI
home in a slot record. Use official CLI login for this backend; the old panel
OAuth import writes the Linux kernel credential file, not the CLI home.

The slot's configured SOCKS proxy is passed to the CLI as proxy environment
variables. A local exit uses the deployment's `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`
when present, otherwise the host route. Put any deployment proxy in `.env.macos`.
The adapter removes inherited API keys and proxy exceptions from the CLI process.

## Codex CLI client configuration

In the **client's** Codex configuration, add a custom provider:

```toml
model_provider = "vm2api"
# Set model to an exact model ID available to the upstream account.

[model_providers.vm2api]
name = "vm2api"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
env_key = "VM2API_API_KEY"
requires_openai_auth = false
supports_websockets = true
```

Export the generated `VM2API_API_KEY` in the client shell. Keep this client
provider configuration separate from the upstream slot's CLI home to avoid
routing the upstream CLI back into vm2api.

## Protocol behavior

- Text and image inputs, full conversation history, text SSE, final Responses
  objects, reasoning effort and JSON Schema output are mapped to app-server.
- Function, namespace and custom tools are exposed as dynamic tools. Internal
  aliases avoid collisions with Codex's built-in names such as `exec_command`.
  Returned calls restore the client's original name and namespace. Custom tools
  use a string `input` argument internally; custom grammar validation is not provided.
- Each request starts an ephemeral CLI thread. On an external tool request,
  vm2api returns one call and closes that CLI process. The caller executes it and
  sends the full call/result history on the next request. Tools run on the client;
  the adapter disables the upstream shell and uses a read-only sandbox.
- Authentication and refresh belong to the official CLI. Usage is included when
  app-server reports it. CLI instructions and context processing remain active;
  this is not a byte-for-byte proxy of the caller's upstream request.
- `/v1/responses` supports authenticated WebSocket connections, `response.create`,
  `generate: false` warmups, and incremental input through `previous_response_id`.
  Response events are JSON text frames. Inference uses the same authentication,
  scheduling, usage logging and official CLI backend as HTTP/SSE.
- WebSocket history lives only on that connection (up to 8 responses and 32 MiB).
  After reconnecting or cache eviction, resend full history without a previous ID;
  missing IDs return `previous_response_not_found`. Requests on a connection are
  processed sequentially, including named streams; mid-turn steering is not implemented.
  Closing the connection cancels the active request and discards its queued turns.
- HTTP/SSE still requires full history. Non-auto `tool_choice`, unsupported
  input/tool types and `/v1/responses/compact` are not implemented. Long-context
  workflows that require server-side compaction need further work.

macOS defaults to `KIN_CODEX_BACKEND=cli`. Linux retains the bundled kernel
default; setting `KIN_CODEX_BACKEND=cli` opts into this adapter there as well.

## Verification

```sh
node --test test/unit/codex-cli.test.mjs
VM2API_TEST_CODEX_CLI=1 node --test test/e2e/codex-cli-native.e2e.test.mjs
```

The integration test runs real official CLI processes against a loopback fixture
provider. It checks text streaming, usage, function/custom tools, tool-result
history, the gateway HTTP endpoint, and an official Codex CLI client completing
a command/tool-result cycle through the gateway. It needs no login or paid API.
It does not establish that a particular ChatGPT subscription can complete live
requests; verify that after official CLI login.

A live authenticated check on 2026-10-02 also completed ordinary and SSE
`/v1/responses` requests with `gpt-6-sol`. The inherited `/v1/models` catalogue
contains preset entries; it is not a guarantee that the logged-in account can
use every listed model.

The upstream unit suite contains Linux/Docker assumptions. In the supplied macOS
environment, seven pre-existing failures reproduce in the unchanged upstream
source (egress, Docker Rust supervisor and OAuth binary checks).

Official references: [app-server](https://developers.openai.com/codex/app-server/)
and [custom provider settings](https://developers.openai.com/codex/config-reference/).
