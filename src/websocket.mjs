import { WebSocket, WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { fault, items } from './tui/protocol.mjs'

export function attachWebSocket(server, { auth, run }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    if (req.url.split('?')[0] !== '/v1/responses' || !auth.api(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })
  wss.on('connection', ws => {
    let active, alive = true, queued = 0, chain = Promise.resolve()
    const warmups = new Map()
    const send = (event, streamId) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const data = JSON.stringify({ ...event, ...(streamId == null ? {} : { stream_id: streamId }) })
      if (ws.bufferedAmount + data.length > 8 * 1024 * 1024) { ws.terminate(); return }
      ws.send(data)
    }
    ws.on('pong', () => { alive = true })
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping() } }, 30000).unref()
    ws.on('message', data => {
      if (++queued > 8) { ws.close(1008, 'Too many queued requests'); return }
      chain = chain.then(async () => {
        let event = {}
        try {
          if (ws.readyState !== WebSocket.OPEN) return
          try { event = JSON.parse(data) } catch { throw fault('Invalid JSON') }
          if (event.type !== 'response.create') throw fault('Expected response.create')
          if (event.generate === false) {
            const id = `resp_warmup_${randomUUID().replaceAll('-', '')}`
            const response = { id, object: 'response', status: 'completed', model: event.model, output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }
            warmups.set(id, event); if (warmups.size > 4) warmups.delete(warmups.keys().next().value)
            send({ type: 'response.created', response: { ...response, status: 'in_progress' }, sequence_number: 0 }, event.stream_id)
            send({ type: 'response.completed', response, sequence_number: 1 }, event.stream_id); return
          }
          let body = { ...event }
          if (warmups.has(body.previous_response_id)) {
            const warm = warmups.get(body.previous_response_id)
            body = { ...warm, ...body, previous_response_id: warm.previous_response_id, input: [...items(warm.input), ...items(body.input)] }
          }
          for (const k of ['type', 'event_id', 'stream_id', 'generate']) delete body[k]
          active = new AbortController()
          await run(body, e => send(e, event.stream_id), active.signal)
        } catch (e) { send({ type: 'error', status: e.status || 502, error: { type: e.status >= 500 ? 'server_error' : 'invalid_request_error', code: e.code || 'gateway_error', message: e.message }, ...(event.event_id ? { event_id: event.event_id } : {}) }, event.stream_id) }
        finally { active = null; queued-- }
      }).catch(() => ws.terminate())
    })
    ws.on('error', () => active?.abort())
    ws.on('close', () => { clearInterval(heartbeat); active?.abort() })
  })
  return { close() { for (const ws of wss.clients) ws.terminate(); wss.close() } }
}
