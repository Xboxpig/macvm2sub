import { randomUUID } from 'node:crypto'

export const fault = (message, status = 400, code = 'invalid_request_error') => Object.assign(new Error(message), { status, code })
export const items = input => typeof input === 'string' ? [{ role: 'user', content: input }] : Array.isArray(input) ? input : []
export const messageText = item => typeof item?.content === 'string' ? item.content : (item?.content || []).map(p => p.text || '').join('\n')

export function promptFor(body, input = items(body.input)) {
  const parts = []
  if (body.instructions) parts.push(`Instructions supplied by the client:\n${body.instructions}`)
  for (const item of input) {
    if (!['user', 'assistant', 'system', 'developer'].includes(item.role)) throw fault(`Unsupported input item: ${item.type || item.role}`)
    if (Array.isArray(item.content) && item.content.some(p => !['input_text', 'output_text', 'text'].includes(p.type))) throw fault('This TUI gateway currently accepts text input only')
    const text = messageText(item)
    parts.push(input.length === 1 && item.role === 'user' ? text : `[${item.role}]\n${text}`)
  }
  let prompt = parts.join('\n\n').replaceAll('\r\n', '\n')
  if (!prompt.trim()) throw fault('A non-empty text prompt is required')
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(prompt)) throw fault('Prompt contains terminal control characters')
  if (/^\s*\//.test(prompt)) prompt = `User request:\n${prompt}`
  return prompt
}

export function canonicalInput(input) {
  return input.map(i => {
    if (i.role) return { role: i.role, text: messageText(i) }
    if (i.type === 'function_call') return { type: i.type, call_id: i.call_id, name: i.name, namespace: i.namespace, arguments: i.arguments }
    if (i.type === 'custom_tool_call') return { type: i.type, call_id: i.call_id, name: i.name, namespace: i.namespace, input: i.input }
    if (i.type === 'function_call_output' || i.type === 'custom_tool_call_output') return { type: i.type, call_id: i.call_id, output: i.output }
    return i
  })
}

export function toolRegistry(tools = []) {
  const flat = tools.flatMap(t => t.type === 'namespace' ? t.tools.map(x => ({ ...x, namespace: t.name })) : [t])
  const registry = new Map()
  flat.forEach((t, i) => {
    if (!['function', 'custom'].includes(t.type) || !t.name) throw fault('Only function, custom and namespace tools are supported')
    const name = `client_${i}_${t.name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 35)}`
    registry.set(name, { ...t, mcp: { name, description: `${t.namespace ? t.namespace + '.' : ''}${t.name}: ${t.description || ''}`, inputSchema: t.type === 'custom' ? { type: 'object', properties: { input: { type: 'string', description: 'Exact tool input' } }, required: ['input'], additionalProperties: false } : t.parameters || { type: 'object', properties: {} } } })
  })
  return registry
}

export function publicItem(item, registry) {
  if (item.type !== 'function_call') return item
  const tool = registry.get(item.name)
  if (!tool || item.namespace !== 'mcp__client') throw fault('Codex attempted a tool outside the client tool registry', 502, 'unexpected_tool')
  const result = { ...item, name: tool.name }
  delete result.namespace
  if (tool.namespace) result.namespace = tool.namespace
  if (tool.type === 'custom') {
    result.type = 'custom_tool_call'
    try { result.input = JSON.parse(item.arguments || '{}').input || '' } catch { throw fault('Invalid custom tool arguments', 502) }
    delete result.arguments
  }
  return result
}

// A main turn is identified by an exact submitted message or a known continuation.
// Background title requests merely quoting a prompt must never become API output.
export function isMainRequest(body, state) {
  if (body.generate === false) return false
  if (body.previous_response_id && state.nativeIds.has(body.previous_response_id)) return true
  const input = items(body.input)
  const lastUser = input.filter(i => i.role === 'user').at(-1)
  if (state.prompt && messageText(lastUser) === state.prompt) return true
  return input.some(i => i.type === 'function_call_output' && state.callIds.has(i.call_id))
}

export class ResponseEvents {
  constructor({ model, registry, emit, onTool }) {
    this.id = `resp_${randomUUID().replaceAll('-', '')}`
    this.model = model; this.registry = registry; this.emit = emit; this.onTool = onTool
    this.output = new Map(); this.custom = new Set(); this.sequence = 0
  }
  send(event) { this.emit({ ...event, sequence_number: this.sequence++ }) }
  accept(event) {
    const e = structuredClone(event)
    if (e.response) e.response.id = this.id
    if (e.response_id) e.response_id = this.id
    if (e.item?.type === 'function_call') {
      const tool = this.registry.get(e.item.name)
      if (!tool || e.item.namespace !== 'mcp__client') throw fault('Unexpected native tool', 502, 'unexpected_tool')
      if (tool.type === 'custom') this.custom.add(e.item.id)
      if (e.type === 'response.output_item.done') this.onTool(e.item)
      e.item = publicItem(e.item, this.registry)
    }
    if (this.custom.has(e.item_id) && e.type.startsWith('response.function_call_arguments.')) return
    if (e.type === 'response.output_item.done') {
      this.output.set(e.output_index, e.item)
      if (e.item.type === 'custom_tool_call') {
        this.send({ type: 'response.custom_tool_call_input.delta', item_id: e.item.id, output_index: e.output_index, delta: e.item.input })
        this.send({ type: 'response.custom_tool_call_input.done', item_id: e.item.id, output_index: e.output_index, input: e.item.input })
      }
    }
    if (e.type === 'response.completed') {
      for (const [index, item] of (event.response?.output || []).entries()) {
        if (!this.output.has(index)) {
          if (item.type === 'function_call') this.onTool(item)
          this.output.set(index, publicItem(item, this.registry))
        }
      }
      e.response = { ...e.response, id: this.id, object: 'response', model: this.model, output: [...this.output.entries()].sort((a,b) => a[0]-b[0]).map(([,i]) => i) }
      this.completed = e.response
    }
    this.send(e)
    return this.completed
  }
}
