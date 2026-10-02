import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createGateway } from '../src/server.mjs'

test('HTTP/WS gateway: authentication, console session, SSE, warmup, native continuation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'macvm2sub-server-'))
  const requests = [], observed = []
  let counter = 0, saved = 0, closed = false
  const sessions = { sessions: new Map([['test-session', { close() { closed = true } }]]), persist() { saved++ }, busy: false, status: () => [], close() {}, async run(body, emit) {
    requests.push(body)
    const response = { id: `resp_${++counter}`, object: 'response', model: 'fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 3, output_tokens: 1 } }
    emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
    emit({ type: 'response.completed', response }); return response
  } }
  const account = { status: async () => ({ loggedIn: true }), models: () => [{ id: 'fixture' }], close() {} }
  const config = { host: '127.0.0.1', port: 0, dataDir: root, webDir: root, apiKey: 'test-api-key', adminUser: 'owner', adminPassword: 'test-password', model: 'fixture', maxSessions: 4, sessionTtlMs: 60000 }
  const gateway = await createGateway(config, { sessions, account })
  t.after(() => { gateway.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${gateway.server.address().port}`
  const apiHeaders = { authorization: 'Bearer test-api-key', 'content-type': 'application/json' }
  assert.equal((await fetch(base + '/v1/models')).status, 401)
  assert.equal((await fetch(base + '/v1/models', { headers: apiHeaders })).status, 200)
  assert.equal((await fetch(base + '/api/status')).status, 401)
  assert.equal((await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ username: 'owner', password: 'test-password' }) })).status, 403)
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  assert.equal((await fetch(base + '/api/status', { headers: { cookie } })).status, 200)
  const reply = await fetch(base + '/v1/responses', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ input: 'private text', stream: true }) })
  const text = await reply.text(); assert.match(text, /response.completed/)
  assert.equal(fs.readFileSync(path.join(root, 'requests.jsonl'), 'utf8').includes('private text'), false)
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses', { headers: apiHeaders })
  t.after(() => ws.terminate())
  ws.on('message', data => observed.push(JSON.parse(data)))
  await once(ws, 'open')
  const complete = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS timeout')), 3000)
    const listener = data => { const event = JSON.parse(data); if (event.type === 'response.completed') { clearTimeout(timeout); ws.off('message', listener); resolve(event.response) } }
    ws.on('message', listener)
  })
  let next = complete(); ws.send(JSON.stringify({ type: 'response.create', generate: false, model: 'fixture', input: [] })); const warm = await next
  assert.equal(requests.length, 1)
  next = complete(); ws.send(JSON.stringify({ type: 'response.create', previous_response_id: warm.id, input: 'hello', stream_id: 's1' })); const a = await next
  assert.equal(requests.at(-1).previous_response_id, undefined)
  next = complete(); ws.send(JSON.stringify({ type: 'response.create', previous_response_id: a.id, input: 'second', stream_id: 's2' })); await next
  assert.equal(requests.at(-1).previous_response_id, a.id)
  assert.equal(requests.at(-1).input, 'second')
  assert.equal(observed.at(-1).stream_id, 's2')
  assert.equal((await fetch(base + '/api/sessions/test-session', { method: 'DELETE', headers: { cookie } })).status, 200)
  assert.equal(closed, true); assert.equal(saved, 1)
  await fetch(base + '/api/logout', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
  assert.equal((await fetch(base + '/api/status', { headers: { cookie } })).status, 401)
})
