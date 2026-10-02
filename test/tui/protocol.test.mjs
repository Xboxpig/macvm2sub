import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promptFor, toolRegistry, isMainRequest, ResponseEvents } from '../../src/tui/protocol.mjs'

test('main conversation matching excludes title tasks and warmups', () => {
  const state = { prompt: 'Remember violet', nativeIds: new Set(['native1']), callIds: new Set(['call1']) }
  assert.equal(isMainRequest({ input: [{ role: 'user', content: 'Remember violet' }] }, state), true)
  assert.equal(isMainRequest({ input: [{ role: 'user', content: 'Generate title: Remember violet' }] }, state), false)
  assert.equal(isMainRequest({ generate: false, previous_response_id: 'native1' }, state), false)
  assert.equal(isMainRequest({ previous_response_id: 'native1' }, state), true)
  assert.equal(isMainRequest({ input: [{ type: 'function_call_output', call_id: 'call1' }] }, state), true)
})
test('output_item.done is retained when native completed output is empty', () => {
  const events = [], calls = []
  const registry = toolRegistry([{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }])
  const response = new ResponseEvents({ model: 'test', registry, emit: e => events.push(e), onTool: c => calls.push(c) })
  const tool = { type: 'function_call', id: 'fc1', call_id: 'call1', name: [...registry.keys()][0], namespace: 'mcp__client', arguments: '{"cmd":"pwd"}' }
  response.accept({ type: 'response.created', response: { id: 'native', output: [] } })
  response.accept({ type: 'response.output_item.done', output_index: 0, item: tool })
  const result = response.accept({ type: 'response.completed', response: { id: 'native', status: 'completed', output: [] } })
  assert.equal(result.output[0].name, 'exec_command')
  assert.equal(result.output[0].namespace, undefined)
  assert.equal(calls[0].call_id, 'call1')
  assert.notEqual(result.id, 'native')
  assert.equal(events[0].response.id, result.id)
  assert.throws(() => response.accept({ type: 'response.output_item.added', item: { ...tool, namespace: 'functions' } }), /Unexpected/)
})
test('custom tools return their exact string input', () => {
  const registry = toolRegistry([{ type: 'custom', name: 'apply_patch' }]), events = []
  const response = new ResponseEvents({ registry, emit: e => events.push(e), onTool() {} })
  response.accept({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'call', namespace: 'mcp__client', name: [...registry.keys()][0], arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }) } })
  assert.equal(events.at(-1).item.type, 'custom_tool_call')
  assert.equal(events[0].delta, '*** Begin Patch\n*** End Patch')
})
test('terminal escapes and unsupported content cannot be injected', () => {
  assert.throws(() => promptFor({ input: 'text\x1b[201~\r/quit' }), /control/)
  assert.throws(() => promptFor({ input: [{ role: 'user', content: [{ type: 'input_image' }] }] }), /text input/)
  assert.equal(promptFor({ input: 'hello\nworld' }), 'hello\nworld')
})
