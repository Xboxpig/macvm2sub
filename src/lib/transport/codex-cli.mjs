/** Native Codex CLI app-server adapter. Tools are returned to the API caller. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { boundProxyUrl, isLocalEgressProxy, localEgressProxyUrl } from '../vm/egress.mjs'
import { assertProxyAllowed } from '../vm/proxy-policy.mjs'

const activeServers = new Set()
export function stopAllCodexCli(vmId = null) {
  for (const server of activeServers) if (!vmId || server.vmId === vmId) server.close()
}

export function useCodexCli(env = process.env, platform = process.platform) {
  return (env.KIN_CODEX_BACKEND || (platform === 'darwin' ? 'cli' : 'kernel')) === 'cli'
}

export function codexCliPaths(exec) {
  const slot = path.dirname(exec.homeDir)
  return {
    home: exec.vm?.runtime?.codex_cli_home || path.join(slot, 'codex-home'),
    cwd: path.join(slot, 'codex-workspace'),
  }
}

function failure(message, code = 'codex_cli_error', status = 502) {
  return Object.assign(new Error(message), { code, status })
}

export function codexCliEnv(exec) {
  assertProxyAllowed(exec.vm?.proxy)
  const proxy = isLocalEgressProxy(exec.vm?.proxy) ? localEgressProxyUrl() : boundProxyUrl(exec.vm?.proxy)
  if (!proxy && !isLocalEgressProxy(exec.vm?.proxy)) {
    throw failure('Codex CLI slot requires a bound proxy or an explicit local exit', 'proxy_required', 503)
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(https?|all|no)_proxy$|^OPENAI_API_KEY$|^CODEX_HOME$/i.test(key)),
  )
  env.CODEX_HOME = codexCliPaths(exec).home
  if (proxy) Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy })
  return env
}

class AppServer {
  constructor(exec, onEvent = () => {}) {
    this.vmId = exec.vmId
    const { home, cwd } = codexCliPaths(exec)
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 })
    this.pending = new Map()
    this.nextId = 0
    this.child = spawn(process.env.KIN_CODEX_CLI_BIN || 'codex', ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: codexCliEnv(exec),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    activeServers.add(this)
    this.child.stderr.resume() // Never put CLI diagnostics (potential credentials) in an API response.
    this.child.stdin.on('error', () => {})
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id != null && !msg.method) {
        const pending = this.pending.get(msg.id)
        if (!pending) return
        this.pending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.error) pending.reject(failure(msg.error.message || 'Codex RPC failed'))
        else pending.resolve(msg.result)
      } else {
        onEvent(msg, this)
      }
    })
    const exited = () => {
      activeServers.delete(this)
      this.dead = true
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(failure('Codex app-server exited', 'codex_cli_unavailable', 503))
      }
      this.pending.clear()
      onEvent({ method: 'adapter/exit' }, this)
    }
    this.child.once('error', exited)
    this.child.once('exit', exited)
  }

  send(message) {
    if (!this.dead && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  call(method, params) {
    if (this.dead) return Promise.reject(failure('Codex app-server exited', 'codex_cli_unavailable', 503))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(failure(`Codex RPC timed out: ${method}`, 'codex_cli_timeout', 504))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params })
    })
  }

  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'vm2api', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    })
    this.send({ method: 'initialized' })
  }

  close() {
    if (this.closing) return
    this.closing = true
    this.child.stdin.end()
    this.child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (!this.dead) this.child.kill('SIGKILL')
    }, 2000)
    timer.unref()
  }
}

export async function codexCliHealth(exec) {
  let rpc
  try {
    rpc = new AppServer(exec)
    await rpc.initialize()
    const result = await rpc.call('account/read', { refreshToken: false })
    const authenticated = !!result.account || result.requiresOpenaiAuth === false
    return { ok: authenticated, status: authenticated ? 200 : 401, source: 'codex-cli', authenticated }
  } catch (error) {
    return { ok: false, status: error.status || 503, source: 'codex-cli', error: error.message }
  } finally {
    rpc?.close()
  }
}

/** Full Responses history goes through inject_items; the final input starts the turn. */
export function codexCliRequest(body = {}) {
  if (body.previous_response_id)
    throw failure(
      'Send full input history; previous_response_id is not supported by the CLI backend',
      'unsupported_parameter',
      400,
    )
  if (body.tool_choice && body.tool_choice !== 'auto')
    throw failure('CLI backend supports tool_choice=auto only', 'unsupported_parameter', 400)
  const custom = new Set()
  const toolNames = new Map(),
    historyNames = new Map()
  const tool = (t, namespace = '') => {
    if (t.type === 'custom') custom.add(t.name)
    if (!['function', 'custom'].includes(t.type))
      throw failure(`Unsupported CLI tool type: ${t.type}`, 'unsupported_tool', 400)
    const key = `${namespace}\0${t.name}`
    const name = `vm2api_${t.name.slice(0, 40)}_${createHash('sha256').update(key).digest('hex').slice(0, 8)}`
    toolNames.set(name, { name: t.name, namespace, custom: t.type === 'custom' })
    historyNames.set(key, name)
    return {
      type: 'function',
      name,
      description: t.description || '',
      inputSchema:
        t.type === 'custom'
          ? {
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
              additionalProperties: false,
            }
          : t.parameters || { type: 'object', properties: {} },
    }
  }
  const dynamicTools = (body.tools || [])
    .filter((t) => t.type !== 'web_search')
    .flatMap((t) => (t.type === 'namespace' ? t.tools.map((nested) => tool(nested, t.name)) : tool(t)))
  const items =
    typeof body.input === 'string'
      ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }]
      : structuredClone(body.input || [])
  if (!Array.isArray(items) || !items.length)
    throw failure('input must contain a user message or tool result', 'invalid_request', 400)
  // App-server history accepts native function calls. Freeform tools use a string schema at its boundary.
  for (const item of items) {
    if (item.type === 'custom_tool_call') {
      item.type = 'function_call'
      item.arguments = JSON.stringify({ input: item.input })
      delete item.input
    } else if (item.type === 'custom_tool_call_output') item.type = 'function_call_output'
    if (item.type === 'function_call') {
      item.name = historyNames.get(`${item.namespace || ''}\0${item.name}`) || item.name
      delete item.namespace
    }
    if (item.role && !item.type) item.type = 'message'
    if (typeof item.content === 'string')
      item.content = [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.content }]
  }
  const last = items.pop()
  let input = []
  if (last.type === 'function_call_output') {
    const call = items.findLast((i) => i.type === 'function_call' && i.call_id === last.call_id)
    if (!call?.name) throw failure('Tool output requires its original call in input history', 'invalid_request', 400)
    // Inject the call/result pair together. A standalone toolOutput creates a new
    // call id in Codex and would replace the original result with "aborted".
    items.push(last)
    input = [{ type: 'text', text: '', text_elements: [] }]
  } else if (last.role === 'user') {
    input = (last.content || []).map((part) => {
      if (part.type === 'input_text') return { type: 'text', text: part.text, text_elements: [] }
      if (part.type === 'input_image') return { type: 'image', url: part.image_url }
      throw failure(`Unsupported input part: ${part.type}`, 'unsupported_input', 400)
    })
  } else throw failure('Last input item must be a user message or tool output', 'invalid_request', 400)
  return { items, input, dynamicTools, custom, toolNames }
}

export async function streamCodexCli({ exec, body, envelope, onEvent = () => {}, signal, timeoutMs = 600000 } = {}) {
  body = envelope?.body || body || {}
  let rpc,
    timer,
    finished = false,
    committed = false,
    started = false,
    sequence = 0,
    usage = null
  const id = `resp_${randomUUID().replaceAll('-', '')}`
  const output = [],
    messages = new Map()
  const response = (status) => ({
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: body.model,
    output,
    usage,
  })
  const emit = (type, fields = {}) => {
    started = true
    onEvent(`data: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n`)
  }
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  const finish = (error = null) => {
    if (finished) return
    finished = true
    if (!error) emit('response.completed', { response: response('completed') })
    else if (started)
      emit('response.failed', {
        response: { ...response('failed'), error: { code: error.code || 'codex_cli_error', message: error.message } },
      })
    resolveDone(
      error
        ? {
            ok: false,
            status: error.status || 502,
            committed,
            body: { error: { code: error.code || 'codex_cli_error', message: error.message } },
            via: 'codex-cli',
            headers: {},
          }
        : { ok: true, status: 200, committed, body: response('completed'), usage, via: 'codex-cli', headers: {} },
    )
  }
  const abort = () => {
    finish(failure('Request cancelled', 'client_cancelled', 499))
    rpc?.close()
  }
  try {
    const request = codexCliRequest(body)
    if (signal?.aborted) throw failure('Request cancelled', 'client_cancelled', 499)
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      finish(failure('Codex turn timed out', 'codex_cli_timeout', 504))
      rpc?.close()
    }, timeoutMs)
    rpc = new AppServer(exec, (msg, client) => {
      if (finished) return
      const p = msg.params || {}
      if (msg.method === 'adapter/exit') return finish(failure('Codex app-server exited', 'codex_cli_unavailable', 503))
      if (msg.method === 'item/tool/call') {
        const original = request.toolNames.get(p.tool)
        if (!original) return finish(failure('CLI requested an unregistered client tool', 'unsupported_tool'))
        const custom = original.custom
        const item = {
          id: p.callId || `fc_${randomUUID()}`,
          type: custom ? 'custom_tool_call' : 'function_call',
          call_id: p.callId,
          name: original.name,
          status: 'completed',
        }
        if (original.namespace) item.namespace = original.namespace
        if (custom) item.input = p.arguments?.input || ''
        else item.arguments = JSON.stringify(p.arguments || {})
        const index = output.push(item) - 1
        committed = true
        emit('response.output_item.added', { output_index: index, item })
        emit('response.output_item.done', { output_index: index, item })
        // Do not answer the server request: the downstream client owns execution.
        finish()
        return
      }
      if (msg.id != null && msg.method) {
        // API requests never authorize server-side commands or filesystem edits.
        client.send({ id: msg.id, error: { code: -32601, message: 'This operation must run on the API client' } })
        return
      }
      if (msg.method === 'item/agentMessage/delta') {
        let entry = messages.get(p.itemId)
        if (!entry) {
          const item = {
            id: p.itemId,
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [{ type: 'output_text', text: '', annotations: [] }],
          }
          entry = { item, index: output.push(item) - 1 }
          messages.set(p.itemId, entry)
          emit('response.output_item.added', { output_index: entry.index, item: structuredClone(item) })
          emit('response.content_part.added', {
            item_id: p.itemId,
            output_index: entry.index,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          })
        }
        committed = true
        entry.item.content[0].text += p.delta
        emit('response.output_text.delta', {
          item_id: p.itemId,
          output_index: entry.index,
          content_index: 0,
          delta: p.delta,
        })
      }
      if (msg.method === 'item/completed' && p.item?.type === 'agentMessage') {
        const entry = messages.get(p.item.id)
        if (entry) {
          entry.item.status = 'completed'
          emit('response.output_text.done', {
            item_id: p.item.id,
            output_index: entry.index,
            content_index: 0,
            text: entry.item.content[0].text,
          })
          emit('response.content_part.done', {
            item_id: p.item.id,
            output_index: entry.index,
            content_index: 0,
            part: entry.item.content[0],
          })
          emit('response.output_item.done', { output_index: entry.index, item: entry.item })
        }
      }
      if (msg.method === 'thread/tokenUsage/updated') {
        const u = p.tokenUsage?.last || p.tokenUsage?.total
        if (u)
          usage = {
            input_tokens: u.inputTokens || 0,
            output_tokens: u.outputTokens || 0,
            total_tokens: u.totalTokens || 0,
            input_tokens_details: { cached_tokens: u.cachedInputTokens || 0 },
            output_tokens_details: { reasoning_tokens: u.reasoningOutputTokens || 0 },
          }
      }
      if (msg.method === 'turn/completed') {
        if (p.turn?.status === 'completed') finish()
        else finish(failure(p.turn?.error?.message || `Codex turn ${p.turn?.status || 'failed'}`))
      }
    })
    await rpc.initialize()
    const thread = await rpc.call('thread/start', {
      model: body.model,
      cwd: codexCliPaths(exec).cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      environments: [],
      dynamicTools: request.dynamicTools,
      ...(body.instructions != null ? { baseInstructions: body.instructions } : {}),
      config: {
        'features.shell_tool': false,
        'features.apply_patch_freeform': false,
        'features.multi_agent': false,
        web_search: body.tools?.some((t) => t.type === 'web_search') ? 'live' : 'disabled',
      },
    })
    const threadId = thread.thread.id
    if (request.items.length) await rpc.call('thread/inject_items', { threadId, items: request.items })
    emit('response.created', { response: response('in_progress') })
    emit('response.in_progress', { response: response('in_progress') })
    await rpc.call('turn/start', {
      threadId,
      input: request.input,
      ...(body.reasoning?.effort ? { effort: body.reasoning.effort } : {}),
      ...(body.text?.format?.type === 'json_schema' ? { outputSchema: body.text.format.schema } : {}),
      ...(body.service_tier ? { serviceTier: body.service_tier } : {}),
    })
    return await done
  } catch (error) {
    finish(error)
    return await done
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    rpc?.close()
  }
}
