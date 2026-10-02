import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Sessions } from '../../src/tui/session.mjs'
import { readBody } from '../../src/tui/relay.mjs'

test('real TUI: persistent memory, external write tool, result continuation, title isolation', { skip: process.env.TEST_CODEX_TUI !== '1', timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'macvm2sub-tui-'))
  let count = 0; const requests = []
  const server = http.createServer(async (req, res) => {
    if (!req.url.includes('/responses')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}'); return }
    const body = JSON.parse(await readBody(req)); requests.push(body)
    const input = JSON.stringify(body.input), title = input.includes('Generate a concise, single-line task title')
    const result = input.includes('CLIENT_WRITE_OK')
    const toolMode = input.includes('TUI_TOOL_TEST')
    const tool = body.tools?.find(x => x.name === 'mcp__client')?.tools?.[0]
    const n = ++count
    const item = toolMode && !result && !title && tool ? { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, namespace: 'mcp__client', name: tool.name, arguments: '{"file":"example.txt"}', status: 'completed' } : { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: title ? 'BACKGROUND_TITLE' : result ? 'TOOL_DONE' : input.includes('SECOND_TURN') ? 'REMEMBERED' : 'FIRST_REPLY', annotations: [] }] }
    const response = { id: `native_${n}`, status: 'in_progress', model: body.model, output: [] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, fields) => res.write(`data: ${JSON.stringify({ type, ...fields })}\n\n`)
    emit('response.created', { response })
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } })
    if (item.type === 'message') emit('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text })
    emit('response.output_item.done', { output_index: 0, item })
    emit('response.completed', { response: { ...response, status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })
    res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const home = path.join(root, 'home'); fs.mkdirSync(home)
  const sessions = new Sessions({ codexBin: process.env.CODEX_BIN || 'codex', pythonBin: '/usr/bin/python3', codexHome: home, dataDir: root, upstream: `http://127.0.0.1:${server.address().port}`, fixture: true, model: 'gpt-5.4', turnTimeoutMs: 25000, sessionTtlMs: 60000, maxSessions: 3 })
  t.after(() => { sessions.close(); server.closeAllConnections(); server.close(); /* TUI cleanup owns its live cwd until exit. */ })
  const events = []
  const a = await sessions.run({ input: 'FIRST_TURN remember this conversation' }, e => events.push(e))
  assert.equal(a.output[0].content[0].text, 'FIRST_REPLY')
  const pid = sessions.status()[0].pid
  const b = await sessions.run({ previous_response_id: a.id, input: 'SECOND_TURN what did I say?' }, e => events.push(e))
  assert.equal(b.output[0].content[0].text, 'REMEMBERED')
  assert.equal(sessions.status()[0].pid, pid)
  const warmSession = [...sessions.sessions.values()][0]
  assert.ok(warmSession.nativeSessionId)
  assert.equal(warmSession.transcript.completed, true)
  assert.ok(requests.some(r => JSON.stringify(r.input).includes('SECOND_TURN') && JSON.stringify(r.input).includes('FIRST_REPLY') && JSON.stringify(r.input).includes('FIRST_TURN')))
  assert.equal(JSON.stringify(events).includes('BACKGROUND_TITLE'), false)
  const tools = [{ type: 'function', name: 'write_file', description: 'Write a file in the client workspace', parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } }]
  const c = await sessions.run({ input: 'TUI_TOOL_TEST use write_file', tools })
  assert.equal(c.output[0].type, 'function_call')
  assert.equal(c.output[0].name, 'write_file')
  const d = await sessions.run({ previous_response_id: c.id, input: [{ type: 'function_call_output', call_id: c.output[0].call_id, output: 'CLIENT_WRITE_OK' }] })
  assert.equal(d.output[0].content[0].text, 'TOOL_DONE')
  assert.ok(requests.some(r => r.input?.some(i => i.type === 'function_call_output' && i.call_id === c.output[0].call_id && JSON.stringify(i.output).includes('CLIENT_WRITE_OK'))))
  await assert.rejects(() => sessions.run({ previous_response_id: a.id, input: 'branch' }), /cannot branch/)
  sessions.close()
  const restored = new Sessions(sessions.config)
  t.after(() => restored.close())
  assert.equal(restored.status().length, 2)
  assert.ok(restored.status().every(s => s.state === 'suspended'))
  const resumed = await restored.run({ previous_response_id: b.id, input: 'THIRD_TURN after a service restart, retain the first two turns' })
  assert.equal(resumed.output[0].content[0].text, 'REMEMBERED')
  assert.notEqual(restored.status()[0].pid, pid)
  assert.equal([...restored.sessions.values()][0].nativeSessionId, warmSession.nativeSessionId)
})
