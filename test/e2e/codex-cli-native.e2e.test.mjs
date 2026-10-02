/** Opt-in test: real official CLI, loopback fixture provider, no paid requests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { startGateway, api } from '../harness.mjs'
import { zstdDecompressSync, gunzipSync } from 'node:zlib'
import { streamCodexCli, codexCliHealth } from '../../src/lib/transport/codex-cli.mjs'

test('official Codex app-server: text, external tool call and tool output', {
  skip: process.env.VM2API_TEST_CODEX_CLI !== '1',
  timeout: 90000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const requests = []
  let toolTurn = false
  let toolName = 'lookup_city'
  let clientToolMode = false
  let customMode = false
  const server = http.createServer(async (req, res) => {
    if (!req.url.includes('/responses')) {
      res.writeHead(404).end()
      return
    }
    let bytes = Buffer.concat(await Array.fromAsync(req))
    if (req.headers['content-encoding'] === 'zstd') bytes = zstdDecompressSync(bytes)
    if (req.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes)
    const body = JSON.parse(bytes)
    requests.push(body)
    const clientCall = clientToolMode && !JSON.stringify(body.input).includes('VM2API_TOOL_OK')
    const emitTool = toolTurn || clientCall
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'fixture' })
    let seq = 0
    const emit = (type, fields) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...fields })}\n\n`)
    const response = { id: 'resp_fixture', object: 'response', model: body.model, status: 'in_progress', output: [] }
    emit('response.created', { response })
    const item = emitTool
      ? {
          id: 'fc_fixture',
          type: 'function_call',
          call_id: 'call_fixture',
          name:
            body.tools.find((t) => t.name?.startsWith(`vm2api_${clientCall ? 'exec_command' : toolName}_`))?.name ||
            toolName,
          arguments: clientCall
            ? '{"cmd":"printf VM2API_TOOL_OK","max_output_tokens":32}'
            : customMode
              ? '{"input":"*** Begin Patch\\n*** End Patch"}'
              : '{"city":"Shanghai"}',
          status: 'completed',
        }
      : {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'macOS CLI OK', annotations: [] }],
        }
    emit('response.output_item.added', {
      output_index: 0,
      item: { ...item, status: 'in_progress', ...(emitTool ? { arguments: '' } : { content: [] }) },
    })
    if (emitTool) {
      emit('response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: item.arguments })
      emit('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: item.arguments })
    } else {
      emit('response.content_part.added', {
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      })
      emit('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: 'macOS CLI OK' })
      emit('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text: 'macOS CLI OK' })
      emit('response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] })
    }
    emit('response.output_item.done', { output_index: 0, item })
    emit('response.completed', {
      response: {
        ...response,
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 20,
          output_tokens: 4,
          total_tokens: 24,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const home = path.join(root, 'codex-home')
  fs.mkdirSync(home)
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `model_provider = "fixture"\nmodel = "gpt-5.4"\n[model_providers.fixture]\nname = "Loopback fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`,
  )
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(https?|all|no)_proxy$/i.test(k)))
  for (const k of Object.keys(saved)) delete process.env[k]
  t.after(() => Object.assign(process.env, saved))
  const exec = {
    vmId: 'vm-cli',
    homeDir: path.join(root, 'cli-home'),
    vm: { id: 'vm-cli', proxy: { scheme: 'local', host: 'local' } },
  }
  const health = await codexCliHealth(exec)
  assert.equal(health.ok, true, JSON.stringify(health))
  const events = []
  const text = await streamCodexCli({
    exec,
    body: { model: 'gpt-5.4', input: 'Reply OK' },
    onEvent: (line) => events.push(JSON.parse(line.slice(5))),
  })
  assert.equal(text.ok, true, JSON.stringify(text))
  assert.equal(text.body.output[0]?.content[0]?.text, 'macOS CLI OK')
  assert.ok(events.some((e) => e.type === 'response.output_text.delta'))
  assert.equal(text.usage?.input_tokens, 20)
  const nativeTools = requests[0].tools || []
  assert.ok(
    !JSON.stringify(nativeTools).match(/"name":"(exec_command|shell|apply_patch)"/),
    JSON.stringify(nativeTools),
  )
  const tools = [
    {
      type: 'function',
      name: 'lookup_city',
      description: 'Read city weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  ]
  toolTurn = true
  const tool = await streamCodexCli({ exec, body: { model: 'gpt-5.4', tools, input: 'Look up Shanghai' } })
  assert.equal(tool.ok, true, JSON.stringify(tool))
  const call = tool.body.output.find((i) => i.type === 'function_call')
  assert.equal(call?.name, 'lookup_city')
  assert.equal(call?.call_id, 'call_fixture')
  toolTurn = false
  const next = await streamCodexCli({
    exec,
    body: {
      model: 'gpt-5.4',
      tools,
      input: [
        { role: 'user', content: 'Look up Shanghai' },
        call,
        { type: 'function_call_output', call_id: call.call_id, output: 'Sunny' },
      ],
    },
  })
  assert.equal(next.ok, true, JSON.stringify(next))
  const history = requests.at(-1).input
  const original = history.find((i) => i.type === 'function_call' && i.call_id === call.call_id)
  const result = history.find((i) => i.type === 'function_call_output' && i.call_id === call.call_id)
  assert.ok(original, JSON.stringify(history))
  assert.ok(result, JSON.stringify(history))
  assert.equal(result.output, 'Sunny')
  toolTurn = true
  toolName = 'exec_command'
  const command = await streamCodexCli({
    exec,
    timeoutMs: 5000,
    body: { model: 'gpt-5.4', input: 'Call the client tool', tools: [{ ...tools[0], name: toolName }] },
  })
  assert.equal(command.ok, true, JSON.stringify(command))
  assert.equal(command.body.output[0].name, toolName)
  assert.ok(JSON.stringify(requests.at(-1).tools).includes('exec_command'))
  toolName = 'apply_patch'
  customMode = true
  const patch = await streamCodexCli({
    exec,
    timeoutMs: 5000,
    body: {
      model: 'gpt-5.4',
      input: 'Call the client patch tool',
      tools: [{ type: 'custom', name: toolName, description: 'Apply a patch' }],
    },
  })
  assert.equal(patch.ok, true, JSON.stringify(patch))
  assert.equal(patch.body.output[0].type, 'custom_tool_call')
  assert.equal(patch.body.output[0].input, '*** Begin Patch\n*** End Patch')
  customMode = false
  toolTurn = false
  toolName = 'lookup_city'
  const project = path.join(root, 'gateway')
  fs.mkdirSync(path.join(project, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(project, 'vms', 'active.json'), JSON.stringify({ active_vm: 'vm-cli' }))
  fs.writeFileSync(
    path.join(project, 'vms', 'vm-cli.json'),
    JSON.stringify({
      ...exec.vm,
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      codex: { has_access: true },
      runtime: { codex_cli_home: home },
      policy: { maxConcurrency: 1 },
    }),
  )
  const gateway = await startGateway({ project, env: { KIN_CRS_MOCK: '0', KIN_CODEX_BACKEND: 'cli' } })
  t.after(() => gateway.stop())
  const httpResponse = await api(gateway, 'POST', '/v1/responses', {
    body: { model: 'gpt-5.4', stream: false, input: 'Reply OK' },
  })
  assert.equal(httpResponse.status, 200, httpResponse.text)
  assert.equal(httpResponse.json.output[0].content[0].text, 'macOS CLI OK')
  const clientHome = path.join(root, 'client-home')
  fs.mkdirSync(clientHome)
  fs.writeFileSync(
    path.join(clientHome, 'config.toml'),
    `model_provider = "vm2api"\nmodel = "gpt-5.4"\n[model_providers.vm2api]\nname = "vm2api"\nbase_url = "${gateway.baseUrl}/v1"\nwire_api = "responses"\nenv_key = "VM2API_FIXTURE_KEY"\nsupports_websockets = false\n`,
  )
  clientToolMode = true
  const client = spawn(
    process.env.KIN_CODEX_CLI_BIN || 'codex',
    ['exec', '--json', '--skip-git-repo-check', 'Reply OK'],
    {
      cwd: root,
      env: { ...process.env, CODEX_HOME: clientHome, VM2API_FIXTURE_KEY: gateway.apiKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = '',
    stderr = ''
  client.stdout.on('data', (b) => {
    stdout += b
  })
  client.stderr.on('data', (b) => {
    stderr += b
  })
  const timeout = setTimeout(() => client.kill('SIGKILL'), 30000)
  const code = await new Promise((resolve, reject) => {
    client.once('exit', resolve)
    client.once('error', reject)
  })
  clearTimeout(timeout)
  assert.equal(code, 0, stdout + stderr)
  assert.match(stdout, /macOS CLI OK/)
  assert.ok(
    JSON.stringify(requests.at(-1).input).includes('VM2API_TOOL_OK'),
    'client command result returns through gateway into official CLI',
  )
})
