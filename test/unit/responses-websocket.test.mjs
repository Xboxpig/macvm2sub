import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createResponsesWebSocket } from '../../src/lib/transport/responses-websocket.mjs'

async function fixture(t) {
  const requests = []
  let aborted = false
  const requireAuth = (req, res) => {
    if (req.headers.authorization === 'Bearer test-key') return true
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Invalid key' } }))
    return false
  }
  const server = http.createServer(async (req, res) => {
    if (!requireAuth(req, res)) return
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)))
    requests.push(body)
    if (body.model === 'error') {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'quota', message: 'Quota reached' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (body.model === 'slow') {
      res.write('data: {"type":"response.created"}\n\n')
      res.on('close', () => {
        aborted = true
      })
      return
    }
    const response = {
      id: `resp_${requests.length}`,
      status: 'completed',
      output:
        body.model === 'tool'
          ? [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' }]
          : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
    }
    // UTF-8 characters and JSON split across transport chunks must remain intact.
    const delta = Buffer.from('data: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\n')
    res.write(delta.subarray(0, delta.length - 8))
    res.write(delta.subarray(delta.length - 8))
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
  })
  const transport = createResponsesWebSocket({
    requireAuth,
    getTarget: () => `http://127.0.0.1:${server.address().port}/v1/responses`,
  })
  server.on('upgrade', (req, socket, head) => transport.handleUpgrade(req, socket, head))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    transport.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return { url: `ws://127.0.0.1:${server.address().port}/v1/responses`, requests, aborted: () => aborted }
}

async function client(t, url) {
  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer test-key' } })
  const pending = [],
    events = []
  ws.on('message', (data) => {
    const event = JSON.parse(data)
    const waiter = pending.shift()
    if (waiter) waiter(event)
    else events.push(event)
  })
  await once(ws, 'open')
  t.after(() => ws.terminate())
  return {
    ws,
    send: (event) => ws.send(typeof event === 'string' ? event : JSON.stringify(event)),
    next: () => (events.length ? Promise.resolve(events.shift()) : new Promise((resolve) => pending.push(resolve))),
    async done() {
      const all = []
      for (;;) {
        const event = await this.next()
        all.push(event)
        if (['response.completed', 'error'].includes(event.type)) return all
      }
    },
  }
}

test('Responses WS: authentication, warmup, incremental tools, isolation and errors', { timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const bad = new WebSocket(f.url)
  bad.on('error', () => {})
  const [, rejection] = await once(bad, 'unexpected-response')
  assert.equal(rejection.statusCode, 401)
  rejection.resume()
  bad.terminate()
  const c = await client(t, f.url)
  c.send({ type: 'response.create', model: 'tool', generate: false, input: 'Find Shanghai' })
  const warmup = (await c.done()).at(-1).response
  assert.equal(f.requests.length, 0, 'warmup must not spend upstream tokens')
  assert.deepEqual(warmup.output, [])
  c.send({ type: 'response.create', model: 'tool', previous_response_id: warmup.id, input: [], stream_id: 'main' })
  const toolEvents = await c.done()
  assert.ok(toolEvents.every((event) => event.stream_id === 'main'))
  assert.equal(toolEvents[0].delta, '你好')
  const call = toolEvents.at(-1).response
  assert.equal(f.requests[0].input[0].content, 'Find Shanghai')
  assert.equal(f.requests[0].previous_response_id, undefined)
  c.send({
    type: 'response.create',
    model: 'text',
    previous_response_id: call.id,
    input: [{ type: 'function_call_output', call_id: 'call_1', output: 'Sunny' }],
  })
  await c.done()
  assert.deepEqual(
    f.requests[1].input.map((item) => item.type || item.role),
    ['user', 'function_call', 'function_call_output'],
  )
  const other = await client(t, f.url)
  other.send({ type: 'response.create', model: 'text', previous_response_id: call.id, input: [] })
  assert.equal((await other.done()).at(-1).error.code, 'previous_response_not_found')
  c.send('{')
  assert.equal((await c.next()).error.code, 'invalid_json')
  c.send({ type: 'response.create', model: 'error', input: 'Fail' })
  const error = (await c.done()).at(-1)
  assert.equal(error.status, 429)
  assert.equal(error.error.code, 'quota')
  c.send({ type: 'response.create', model: 'text', input: 'Recover' })
  assert.equal((await c.done()).at(-1).type, 'response.completed')
})

test('Responses WS: disconnect cancels the upstream HTTP request', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const c = await client(t, f.url)
  c.send({ type: 'response.create', model: 'slow', input: 'Wait' })
  assert.equal((await c.next()).type, 'response.created')
  c.ws.terminate()
  for (let n = 0; n < 100 && !f.aborted(); n++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.aborted(), true)
})

test('Responses WS: bounded history and FIFO requests on one connection', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const c = await client(t, f.url)
  c.send({ type: 'response.create', model: 'text', generate: false, input: 'First' })
  const first = (await c.done()).at(-1).response.id
  for (let i = 0; i < 8; i++) {
    c.send({ type: 'response.create', model: 'text', generate: false, input: `Warmup ${i}` })
    await c.done()
  }
  c.send({ type: 'response.create', model: 'text', previous_response_id: first, input: [] })
  assert.equal((await c.done()).at(-1).error.code, 'previous_response_not_found')
  c.send({ type: 'response.create', model: 'text', input: 'A' })
  c.send({ type: 'response.create', model: 'text', input: 'B' })
  assert.equal((await c.done()).at(-1).type, 'response.completed')
  assert.equal((await c.done()).at(-1).type, 'response.completed')
  assert.deepEqual(
    f.requests.map((r) => r.input[0].content),
    ['A', 'B'],
  )
})
