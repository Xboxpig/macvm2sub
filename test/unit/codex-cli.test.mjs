import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexCliRequest, codexCliEnv, useCodexCli, streamCodexCli } from '../../src/lib/transport/codex-cli.mjs'
import { slotHost } from '../../src/lib/vm/slot-host.mjs'

test('macOS selects official CLI and Linux keeps its kernel default', () => {
  assert.equal(useCodexCli({}, 'darwin'), true)
  assert.equal(useCodexCli({}, 'linux'), false)
  assert.equal(useCodexCli({ KIN_CODEX_BACKEND: 'kernel' }, 'darwin'), false)
  assert.equal(useCodexCli({ KIN_CODEX_BACKEND: 'cli' }, 'linux'), true)
})

test('history and tool results retain original pairing without a synthetic prompt', () => {
  const input = [
    { role: 'user', content: 'Check weather' },
    { type: 'function_call', name: 'weather', call_id: 'call_1', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'Sunny' },
  ]
  const req = codexCliRequest({ input })
  assert.equal(req.items[2].call_id, 'call_1')
  assert.equal(req.items[2].output, 'Sunny')
  assert.equal(req.input[0].text, '')
  assert.equal(input[0].type, undefined)
})

test('custom tools and images map into app-server inputs', () => {
  const req = codexCliRequest({
    tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }],
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Inspect' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
    ],
  })
  assert.equal(req.dynamicTools[0].inputSchema.properties.input.type, 'string')
  assert.equal(req.custom.has('apply_patch'), true)
  assert.equal(req.input[1].url, 'data:image/png;base64,AAAA')
})

test('unsupported state references, tools and unpaired outputs fail explicitly', () => {
  for (const body of [
    { input: 'Hi', previous_response_id: 'resp_old' },
    { input: 'Hi', tools: [{ type: 'computer' }] },
    { input: 'Hi', tool_choice: 'required' },
    { input: [{ type: 'function_call_output', call_id: 'missing', output: 'x' }] },
  ])
    assert.throws(
      () => codexCliRequest(body),
      (error) => error.status === 400,
    )
})

test('CLI environment isolates slot auth and uses only its selected proxy', () => {
  const exec = { homeDir: '/tmp/slot/cli-home', vm: { proxy: { url: 'socks5h://127.0.0.1:8877' } } }
  const env = codexCliEnv(exec)
  assert.equal(env.HTTPS_PROXY, 'socks5h://127.0.0.1:8877')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.match(env.CODEX_HOME, /codex-home$/)
  assert.throws(() => codexCliEnv({ ...exec, vm: {} }), /bound proxy/)
})

test('already cancelled input does not start a CLI process', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await streamCodexCli({ body: { input: 'Hi' }, signal: controller.signal })
  assert.equal(result.status, 499)
  assert.equal(result.committed, false)
})

test('native Codex lifecycle does not need Docker', async (t) => {
  const old = process.env.KIN_CODEX_BACKEND
  process.env.KIN_CODEX_BACKEND = 'cli'
  t.after(() => {
    if (old == null) delete process.env.KIN_CODEX_BACKEND
    else process.env.KIN_CODEX_BACKEND = old
  })
  const vm = { id: 'vm-native', platform: 'openai' }
  const host = slotHost(vm)
  assert.equal(host.supports('codex'), true)
  assert.equal((await host.start(vm, '/tmp/unused')).runtime.codex_cli, true)
  assert.equal((await host.stop(vm)).ok, true)
  assert.equal((await host.reload(vm)).ok, true)
})
