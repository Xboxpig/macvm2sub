/** Responses WebSocket transport. Inference still uses the gateway's HTTP pipeline. */
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status })
const inputItems = (input) => {
  if (input == null) return []
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (Array.isArray(input)) return input
  throw fail('invalid_request', 'input must be a string or array')
}

export function createResponsesWebSocket({
  requireAuth,
  getTarget,
  isRestoring = () => false,
  maxPayload = 32 * 1024 * 1024,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false })
  const sessions = new Set()

  function connect(ws, req) {
    const cache = new Map()
    const queue = []
    let queuedBytes = 0,
      cacheBytes = 0,
      running = false,
      active = null,
      closed = false
    const send = (event, streamId) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const data = JSON.stringify(streamId == null ? event : { ...event, stream_id: streamId })
      if (ws.bufferedAmount + Buffer.byteLength(data) > maxPayload) {
        ws.terminate()
        return
      }
      ws.send(data)
    }
    const error = (err, event = {}) =>
      send(
        {
          type: 'error',
          status: err.status || 500,
          error: {
            type: err.status >= 500 ? 'server_error' : 'invalid_request_error',
            code: err.code || 'websocket_error',
            message: err.message,
          },
          ...(event.event_id ? { event_id: event.event_id } : {}),
        },
        event.stream_id,
      )
    const remember = (id, input) => {
      if (!id) return
      const size = Buffer.byteLength(JSON.stringify(input))
      if (size > maxPayload) return
      if (cache.has(id)) {
        cacheBytes -= cache.get(id).size
        cache.delete(id)
      }
      cache.set(id, { input, size })
      cacheBytes += size
      while (cache.size > 8 || cacheBytes > maxPayload) {
        const first = cache.keys().next().value
        cacheBytes -= cache.get(first).size
        cache.delete(first)
      }
    }
    const headers = { ...req.headers }
    // Re-enter the local HTTP handler with the original credentials and routing headers.
    for (const key of Object.keys(headers)) {
      if (
        /^(host|connection|upgrade|content-length|content-encoding|transfer-encoding|accept-encoding|expect)$/.test(
          key,
        ) ||
        key.startsWith('sec-websocket-')
      )
        delete headers[key]
    }
    headers['content-type'] = 'application/json'
    headers.accept = 'text/event-stream'
    headers['x-forwarded-for'] ||= req.socket.remoteAddress || ''

    async function run(event) {
      if (isRestoring()) throw fail('restore_in_progress', 'Gateway is restoring from backup', 503)
      const body = { ...event }
      const parent = body.previous_response_id
      let input = inputItems(body.input)
      if (parent) {
        const prior = cache.get(parent)
        if (!prior)
          throw fail(
            'previous_response_not_found',
            'Previous response is not available on this connection. Resend the full input.',
          )
        input = [...prior.input, ...input]
      }
      for (const key of ['type', 'event_id', 'stream_id', 'generate', 'previous_response_id']) delete body[key]
      body.input = input
      body.stream = true
      if (body.background) throw fail('invalid_request', 'background is not supported over WebSocket')
      if (Buffer.byteLength(JSON.stringify(body)) > maxPayload)
        throw fail('context_too_large', 'Expanded conversation exceeds the request limit', 413)
      if (event.generate === false) {
        // Warmups create connection-local context without starting a model request.
        let status = 401,
          authBody = ''
        const authRes = {
          writeHead(code) {
            status = code
          },
          end(data) {
            authBody = String(data || '')
          },
          setHeader() {},
        }
        if (!requireAuth(req, authRes)) {
          let detail
          try {
            detail = JSON.parse(authBody).error
          } catch {}
          throw fail(detail?.code || 'unauthorized', detail?.message || 'Invalid credentials', status)
        }
        const response = {
          id: `resp_${randomUUID().replaceAll('-', '')}`,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: body.model,
          status: 'completed',
          output: [],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        }
        remember(response.id, input)
        send(
          { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress' } },
          event.stream_id,
        )
        send({ type: 'response.completed', sequence_number: 1, response }, event.stream_id)
        return
      }
      const controller = new AbortController()
      active = controller
      let terminal = false
      try {
        const response = await fetch(getTarget(), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        })
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw fail(
            payload.error?.code || 'upstream_error',
            payload.error?.message || `HTTP ${response.status}`,
            response.status,
          )
        }
        if (!response.headers.get('content-type')?.includes('text/event-stream'))
          throw fail('invalid_upstream_response', 'Expected an SSE response', 502)
        let buffer = ''
        const decoder = new TextDecoder()
        const line = (raw) => {
          if (!raw.startsWith('data:')) return
          const data = raw.slice(5).trim()
          if (!data || data === '[DONE]') return
          const message = JSON.parse(data)
          if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(message.type))
            terminal = true
          if (message.type === 'response.completed')
            remember(message.response?.id, [...input, ...(message.response?.output || [])])
          send(message, event.stream_id)
        }
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true })
          let end
          while ((end = buffer.indexOf('\n')) >= 0) {
            line(buffer.slice(0, end).replace(/\r$/, ''))
            buffer = buffer.slice(end + 1)
          }
          if (Buffer.byteLength(buffer) > maxPayload)
            throw fail('response_too_large', 'Upstream event exceeds the response limit', 502)
        }
        buffer += decoder.decode()
        if (buffer.trim()) line(buffer)
        if (!terminal) throw fail('incomplete_stream', 'Upstream closed before a terminal response event', 502)
      } finally {
        controller.abort()
        active = null
      }
    }

    async function drain() {
      if (running || closed) return
      running = true
      try {
        while (queue.length && !closed) {
          const { event, bytes } = queue.shift()
          queuedBytes -= bytes
          try {
            await run(event)
          } catch (err) {
            if (!closed) error(err, event)
          }
        }
      } finally {
        running = false
      }
    }
    ws.on('message', (data, binary) => {
      let event
      try {
        if (binary) throw fail('invalid_request', 'Send JSON text frames')
        try {
          event = JSON.parse(data.toString())
        } catch {
          throw fail('invalid_json', 'Invalid JSON')
        }
        if (!event || typeof event !== 'object' || Array.isArray(event) || event.type !== 'response.create')
          throw fail('unsupported_event', 'Expected response.create')
        if (event.stream_id != null && (typeof event.stream_id !== 'string' || event.stream_id.length > 128))
          throw fail('invalid_request', 'Invalid stream_id')
        if (queue.length >= 8 || queuedBytes + data.length > maxPayload)
          throw fail('queue_full', 'Connection request queue is full', 429)
        queue.push({ event, bytes: data.length })
        queuedBytes += data.length
        void drain()
      } catch (err) {
        error(err, event || {})
      }
    })
    let alive = true
    ws.on('pong', () => {
      alive = true
    })
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, 30000)
    heartbeat.unref()
    const lifetime = setTimeout(() => ws.close(1000, 'Reconnect to continue'), 60 * 60 * 1000)
    lifetime.unref()
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      clearTimeout(lifetime)
      active?.abort()
      queue.length = 0
      cache.clear()
      sessions.delete(ws)
    }
    ws.on('close', cleanup)
    ws.on('error', () => {
      cleanup()
      ws.terminate()
    })
    sessions.add(ws)
  }

  return {
    handleUpgrade(req, socket, head) {
      if (!['/v1/responses', '/responses'].includes((req.url || '').split('?')[0])) return false
      let status = 401,
        body = ''
      const res = {
        writeHead(code) {
          status = code
        },
        end(data) {
          body = String(data || '')
        },
        setHeader() {},
      }
      if (!requireAuth(req, res)) {
        socket.end(
          `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        )
        return true
      }
      if (isRestoring() || sessions.size >= 64) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return true
      }
      wss.handleUpgrade(req, socket, head, (ws) => connect(ws, req))
      return true
    },
    close() {
      for (const ws of sessions) ws.terminate()
      wss.close()
    },
  }
}
