import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomBytes, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createRelay } from './relay.mjs'
import { NativeTranscript } from './transcript.mjs'
import { fault, items, promptFor, toolRegistry, isMainRequest, ResponseEvents, canonicalInput } from './protocol.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
export class TuiSession {
  constructor(config, body) {
    this.config = config; this.model = body.model || config.model
    this.id = randomUUID(); this.registry = toolRegistry(body.tools)
    this.tools = JSON.stringify(body.tools || []); this.instructions = body.instructions || ''
    this.nativeIds = new Set(); this.callIds = new Set(); this.calls = new Map()
    this.created = this.touched = Date.now(); this.state = 'starting'
  }
  async start(prompt) {
    if (Buffer.byteLength(prompt) > 96 * 1024) throw fault('Initial/resume prompt exceeds the 96 KiB native TUI argument limit', 413)
    const token = randomBytes(32).toString('hex')
    const cwd = path.join(this.config.dataDir, 'sessions', this.id)
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 })
    this.relay = await createRelay({ upstream: this.config.upstream, token,
      onRequest: body => {
        const onlyClient = tools => tools.filter(t => t.type === 'namespace' && t.name === 'mcp__client')
        if (body.tools) { body.tools = onlyClient(body.tools); if (body.tools.length) this.nativeTools = body.tools }
        for (const item of body.input || []) if (item.type === 'additional_tools') {
          item.tools = onlyClient(item.tools || [])
          if (item.tools.length) this.nativeTools = item.tools
        }
        const main = isMainRequest(body, this)
        if (main) {
          // The client owns execution. Only its MCP tools may be offered to the model.
          if (this.active?.toolChoice) {
            body.tool_choice = this.active.toolChoice
            if (this.active.toolChoice === 'required') body.tools = this.nativeTools || []
          }
          if (this.active?.reasoning) body.reasoning = { ...body.reasoning, ...this.active.reasoning }
          if (this.active?.text) body.text = { ...body.text, ...this.active.text }
          return this.active
        }
      },
      onEvent: (event, active) => {
        if (!active || active !== this.active) return
        if (event.type === 'response.created' && event.response?.id) this.nativeIds.add(event.response.id)
        if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) { this.fail(fault(event.response?.error?.message || event.error?.message || 'Native response failed', 502)); return }
        try {
          const result = active.events.accept(event)
          if (result) {
            active.result = result
            this.finishTurn()
          }
        } catch (error) { this.fail(error) }
      },
      onError: error => this.fail(error),
      onModels: models => { this.config.onModels?.(models) },
      toolRequest: async (route, params) => {
        if (route === 'list') return { tools: [...this.registry.values()].map(t => t.mcp) }
        if (route !== 'call') throw fault('Unknown tool endpoint', 404)
        const call = [...this.calls.values()].find(c => !c.claimed && c.item.name === params.name && isDeepStrictEqual(JSON.parse(c.item.arguments || '{}'), params.arguments || {}))
        if (!call) throw fault('No matching upstream tool call', 409)
        call.claimed = true
        const output = await call.promise
        this.calls.delete(call.item.call_id)
        return { content: Array.isArray(output) ? output.map(p => p.type === 'input_text' ? { type: 'text', text: p.text } : p) : [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }] }
      },
    })
    if (this.state === 'closed') { this.relay.close(); return }
    const cfg = {
      openai_base_url: `${this.relay.url}/backend-api/codex`,
      'features.shell_tool': false,
      'features.multi_agent': false, 'features.apps': false,
      'features.code_mode': { enabled: false, direct_only_tool_namespaces: ['mcp__client'] },
      web_search: 'disabled', check_for_update_on_startup: false,
      [`projects.${JSON.stringify(cwd)}.trust_level`]: 'trusted',
      mcp_servers: { client: { command: process.execPath, args: [path.join(directory, 'mcp-relay.mjs'), `${this.relay.url}/tools`], env_vars: ['MACVM2SUB_TOOL_TOKEN'], required: true, tool_timeout_sec: 900, default_tools_approval_mode: 'approve' } },
      ...this.config.cliOverrides,
    }
    if (this.config.fixture) {
      cfg.model_provider = 'fixture'
      cfg['model_providers.fixture'] = { name: 'Test fixture', base_url: `${this.relay.url}/backend-api/codex`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false }
    }
    const toml = value => {
      if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
      if (value && typeof value === 'object') return `{${Object.entries(value).map(([k,v]) => `${JSON.stringify(k)}=${toml(v)}`).join(',')}}`
      return JSON.stringify(value)
    }
    const args = [this.config.codexBin, '--no-daemon', '--no-alt-screen', '-C', cwd, '--sandbox', 'read-only', '-a', 'never', '-m', this.model]
    for (const [key, value] of Object.entries(cfg)) args.push('-c', `${key}=${toml(value)}`)
    if (this.nativeSessionId) args.push('resume', '--', this.nativeSessionId, prompt)
    else args.push('--', prompt)
    this.transcript = new NativeTranscript({ home: this.config.codexHome, cwd, resumeId: this.nativeSessionId,
      onSession: id => { this.nativeSessionId = id },
      onTurn: event => { if (event === 'aborted') this.fail(fault('Native Codex turn was interrupted', 502, 'turn_aborted')); else if (event === 'complete') this.finishTurn() },
      onError: error => this.fail(fault(error.message, 502, 'transcript_error')),
    })
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL'].includes(k))), CODEX_HOME: this.config.codexHome, TERM: 'xterm-256color', MACVM2SUB_TOOL_TOKEN: token }
    this.driver = spawn(this.config.pythonBin, [path.join(directory, 'pty-driver.py'), JSON.stringify(args)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.driver.on('error', e => this.fail(e))
    this.driver.stdin.on('error', e => this.fail(e))
    const driver = this.driver
    this.driver.on('exit', () => {
      if (this.driver !== driver || this.state === 'closed') return
      if (!this.active && !this.calls.size && this.nativeSessionId) this.suspend()
      else this.fail(fault('Codex TUI exited during an active turn', 502, 'tui_exited'))
    })
    createInterface({ input: this.driver.stdout }).on('line', line => {
      try { const e = JSON.parse(line); if (e.event === 'pid') this.pid = e.pid } catch {}
    })
    this.driver.stderr.resume()
  }
  finishTurn() {
    const active = this.active
    if (!active?.result || !this.calls.size && !this.transcript?.completed) return
    this.active = null; this.state = this.calls.size ? 'waiting_tools' : 'idle'; this.touched = Date.now()
    if (active.completedEvent) active.emit(active.completedEvent)
    active.resolve(active.result)
  }
  registerTool(item) {
    if (this.calls.has(item.call_id)) return
    this.callIds.add(item.call_id)
    let resolve
    const promise = new Promise(r => { resolve = r })
    this.calls.set(item.call_id, { item, promise, resolve, claimed: false })
  }
  async run(body, input, emit, signal) {
    if (this.state === 'closed') throw fault('Conversation expired; start a new conversation', 409, 'conversation_expired')
    if (this.active) throw fault('Conversation already has an active turn', 409)
    const outputs = input.filter(i => i.type === 'function_call_output' || i.type === 'custom_tool_call_output')
    if (this.calls.size) {
      if (outputs.length !== this.calls.size || outputs.some(i => !this.calls.has(i.call_id)) || new Set(outputs.map(i => i.call_id)).size !== outputs.length || input.length !== outputs.length) throw fault('Return exactly one result for every pending tool call before sending another prompt')
    } else if (outputs.length) throw fault('No matching pending tool calls', 409)
    let toolChoice
    if (body.tool_choice === 'none' || body.tool_choice === 'auto' || body.tool_choice === 'required') toolChoice = body.tool_choice
    else if (body.tool_choice != null) throw fault('Only auto, none and required tool_choice are supported')
    if (body.reasoning?.effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(body.reasoning.effort)) throw fault('Invalid reasoning effort')
    const prompt = outputs.length ? null : promptFor(body, input)
    this.touched = Date.now(); this.state = 'running'
    let timer, abort
    try {
      return await new Promise((resolve, reject) => {
        const active = { resolve, reject, toolChoice, reasoning: body.reasoning, text: body.text, emit }
        active.events = new ResponseEvents({ model: this.model, registry: this.registry,
          emit: event => { if (event.type === 'response.completed') active.completedEvent = event; else emit(event) },
          onTool: item => this.registerTool(item),
        })
        this.active = active
        timer = setTimeout(() => this.fail(fault('Codex TUI response timed out', 504, 'tui_timeout')), this.config.turnTimeoutMs)
        abort = () => this.fail(fault('Client disconnected', 499, 'cancelled'))
        if (signal?.aborted) { abort(); return }
        signal?.addEventListener('abort', abort, { once: true })
        if (outputs.length) for (const item of outputs) this.calls.get(item.call_id).resolve(item.output)
        else {
          this.prompt = prompt
          this.transcript?.begin()
          if (!this.driver) this.start(prompt).catch(error => this.fail(error))
          else this.driver.stdin.write(JSON.stringify({ event: 'submit', text: prompt }) + '\n')
        }
      })
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  fail(error) {
    this.active?.reject(error); this.active = null; this.close()
  }
  releaseProcess() {
    this.relay?.close(); this.transcript?.stop()
    if (this.driver?.stdin.writable) this.driver.stdin.end('{"event":"stop"}\n')
    const driver = this.driver; this.driver = null; this.pid = undefined
    if (driver) { const timer = setTimeout(() => driver.kill('SIGKILL'), 4000); timer.unref(); driver.once('exit', () => clearTimeout(timer)) }
  }
  suspend() {
    if (this.active || this.calls.size) throw fault('Cannot suspend an active tool loop', 409)
    this.state = 'suspended'; this.releaseProcess()
  }
  close() {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.active?.reject(fault('Conversation closed', 503)); this.active = null
    for (const c of this.calls.values()) c.resolve('Client disconnected; tool execution cancelled.')
    this.calls.clear(); this.releaseProcess()
  }
}

export class Sessions {
  constructor(config) {
    this.config = config; this.sessions = new Map(); this.responses = new Map(); this.busy = false
    this.checkpoint = path.join(config.dataDir, 'sessions.json')
    try {
      for (const saved of JSON.parse(fs.readFileSync(this.checkpoint, 'utf8'))) {
        if (!/^[a-f0-9-]{36}$/.test(saved.id) || !/^[a-f0-9-]{36}$/.test(saved.nativeSessionId) || Date.now() - saved.touched > config.sessionTtlMs) continue
        const session = new TuiSession(config, { model: saved.model, tools: JSON.parse(saved.tools) })
        Object.assign(session, saved, { state: 'suspended' }); this.sessions.set(session.id, session)
        this.responses.set(session.lastResponseId, { session })
      }
    } catch {}
    this.cleanup = setInterval(() => {
      for (const [id, s] of this.sessions) if (s.state === 'closed' || !s.active && Date.now() - s.touched > config.sessionTtlMs) { s.close(); this.sessions.delete(id) }
      for (const [id, value] of this.responses) if (!this.sessions.has(value.session.id)) this.responses.delete(id)
      this.persist()
    }, 30000).unref()
  }
  async run(body, emit = () => {}, signal) {
    if (this.busy) throw fault('Single-account inference is busy; retry shortly', 429, 'gateway_busy')
    if (!body || typeof body !== 'object' || (body.input != null && typeof body.input !== 'string' && !Array.isArray(body.input))) throw fault('Invalid Responses request')
    const embeddedTools = items(body.input).filter(i => i.type === 'additional_tools')
    if (embeddedTools.length) body = { ...body, tools: body.tools || embeddedTools.flatMap(i => i.tools || []), input: items(body.input).filter(i => i.type !== 'additional_tools') }
    if (body.background) throw fault('background requests are not supported')
    let session, input = items(body.input), prior
    if (body.previous_response_id) {
      prior = this.responses.get(body.previous_response_id)
      if (!prior) throw fault('Previous response expired or unknown', 409, 'previous_response_not_found')
      session = prior.session
      if (session.lastResponseId !== body.previous_response_id) throw fault('TUI conversations cannot branch from an older response', 409)
    } else {
      const canonical = canonicalInput(input)
      const matches = [...this.sessions.values()].filter(s => s.state !== 'closed' && s.history?.length && canonical.length > s.history.length && isDeepStrictEqual(canonical.slice(0, s.history.length), s.history))
      if (matches.length > 1) throw fault('Ambiguous history; supply previous_response_id', 409)
      if (matches.length === 1) { session = matches[0]; input = input.slice(session.history.length) }
    }
    if (session && (body.model && body.model !== session.model || body.tools && JSON.stringify(body.tools) !== session.tools)) throw fault('Model and tools must remain unchanged in a TUI conversation', 409)
    this.busy = true
    try {
      if (!session) {
        promptFor(body, input)
        const live = [...this.sessions.values()].filter(s => s.state !== 'closed')
        if (live.length >= this.config.maxSessions) throw fault('Session limit reached; close or wait for an idle session to expire', 429)
        session = new TuiSession(this.config, body); this.sessions.set(session.id, session)
      }
      session.recoverable = false; this.persist()
      const response = await session.run(body, input, emit, signal)
      session.history = [...(session.history || []), ...canonicalInput(input), ...canonicalInput(response.output || [])]
      if (JSON.stringify(session.history).length > 8 * 1024 * 1024) session.history = []
      session.lastResponseId = response.id
      session.recoverable = session.state === 'idle'; this.persist()
      this.responses.set(response.id, { session })
      if (this.responses.size > 1024) this.responses.delete(this.responses.keys().next().value)
      return response
    } finally { this.busy = false }
  }
  status() { return [...this.sessions.values()].map(s => ({ id: s.id, model: s.model, state: s.state, pid: s.pid, created: s.created, touched: s.touched, pendingTools: s.calls.size })) }
  persist() {
    const saved = [...this.sessions.values()].filter(s => s.recoverable && s.nativeSessionId && !s.calls.size && ['idle', 'suspended'].includes(s.state))
      .map(s => ({ id: s.id, nativeSessionId: s.nativeSessionId, model: s.model, tools: s.tools, lastResponseId: s.lastResponseId, created: s.created, touched: s.touched, recoverable: true }))
    fs.writeFileSync(this.checkpoint + '.tmp', JSON.stringify(saved), { mode: 0o600 }); fs.renameSync(this.checkpoint + '.tmp', this.checkpoint)
  }
  close() { if (this.closed) return; this.closed = true; clearInterval(this.cleanup); this.persist(); for (const s of this.sessions.values()) s.close() }
}
