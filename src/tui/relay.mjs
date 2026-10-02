import http from 'node:http'
import https from 'node:https'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { WebSocket, WebSocketServer } from 'ws'
import { fault } from './protocol.mjs'

export async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw fault('Request too large', 413)
    chunks.push(chunk)
  }
  let bytes = Buffer.concat(chunks)
  if (req.headers['content-encoding'] === 'zstd') bytes = zstdDecompressSync(bytes, { maxOutputLength: limit })
  else if (req.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes, { maxOutputLength: limit })
  if (bytes.length > limit) throw fault('Request too large', 413)
  return bytes
}
export function headersFor(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(host|connection|upgrade|content-length|content-encoding|transfer-encoding|accept-encoding|sec-websocket-.*)$/i.test(k)))
}

export async function createRelay({ upstream, onRequest, onEvent, onError, toolRequest, token, onModels }) {
  const peers = new Set(), requests = new Set()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false })
  const target = uri => new URL(upstream.replace(/\/$/, '') + uri)
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/tools/')) {
        if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
        const result = await toolRequest(req.url.slice(7), JSON.parse((await readBody(req)).toString()))
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result)); return
      }
      if (!req.url.startsWith('/backend-api/codex/')) { res.writeHead(404).end(); return }
      let bytes = await readBody(req), context
      if (req.method === 'POST' && req.url.split('?')[0].endsWith('/responses')) {
        const body = JSON.parse(bytes); context = onRequest(body)
        bytes = Buffer.from(JSON.stringify(body))
      }
      const url = target(req.url)
      const transport = url.protocol === 'https:' ? https : http
      const up = transport.request(url, { method: req.method, headers: headersFor(req.headers) }, reply => {
        res.writeHead(reply.statusCode, headersFor(reply.headers))
        let pending = '', modelBytes = 0, modelBody = ''
        reply.on('data', chunk => {
          if (req.url.includes('/models') && modelBytes < 4 * 1024 * 1024) { modelBytes += chunk.length; modelBody += chunk.toString() }
          if (!context) { res.write(chunk); return }
          pending += chunk.toString()
          if (pending.length > 16 * 1024 * 1024) { up.destroy(); onError(fault('Upstream event too large', 502)); return }
          let end
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1)
            if (line.startsWith('data:')) {
              try { const e = JSON.parse(line.slice(5)); onEvent(e, context) } catch (error) { if (error instanceof SyntaxError) continue; onError(error) }
            }
          }
          if (!res.destroyed) res.write(chunk)
        })
        reply.on('end', () => { res.end(); if (modelBody) { try { onModels(JSON.parse(modelBody)) } catch {} } })
        reply.on('error', onError)
        if (reply.statusCode >= 400 && context) onError(fault(`Codex upstream returned HTTP ${reply.statusCode}`, 502, 'upstream_error'))
      })
      requests.add(up)
      up.on('close', () => requests.delete(up))
      up.on('error', e => { if (!res.headersSent) res.writeHead(502); res.end(); if (context) onError(e) })
      res.on('close', () => { if (!res.writableEnded) up.destroy() })
      up.end(bytes)
    } catch (err) { if (!res.headersSent) res.writeHead(err.status || 500); res.end(); onError(err) }
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/backend-api/codex/responses') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return }
    const url = target(req.url); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const up = new WebSocket(url, { headers: headersFor(req.headers), perMessageDeflate: false, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 20000 })
    peers.add(up)
    const contexts = new Map(), queues = new Map()
    let downstream
    up.once('open', () => wss.handleUpgrade(req, socket, head, ws => {
      downstream = ws; peers.add(ws)
      ws.on('message', data => {
        try {
          const body = JSON.parse(data)
          if (body.type === 'response.create') {
            const key = body.stream_id || ''
            if (!queues.has(key)) queues.set(key, [])
            queues.get(key).push(onRequest(body) || null)
          }
          if (up.bufferedAmount > 16 * 1024 * 1024) throw fault('Upstream backpressure limit', 502)
          up.send(JSON.stringify(body))
        } catch (e) { onError(e); ws.close(1011); up.terminate() }
      })
      ws.on('close', () => { up.terminate(); peers.delete(ws) })
      ws.on('error', () => up.terminate())
    }))
    up.on('message', (data, binary) => {
      try {
        const e = JSON.parse(data), key = e.stream_id || ''
        if (e.type === 'response.created') contexts.set(key, queues.get(key)?.shift() || null)
        const context = contexts.get(key)
        if (context) onEvent(e, context)
        if (e.type === 'error') onError(fault(e.error?.message || 'Upstream WebSocket error', 502, e.error?.code))
        if (['response.completed', 'response.failed', 'response.incomplete'].includes(e.type)) contexts.delete(key)
        if (downstream?.readyState === WebSocket.OPEN) {
          if (downstream.bufferedAmount > 16 * 1024 * 1024) throw fault('TUI backpressure limit', 502)
          downstream.send(data, { binary })
        }
      } catch (e) { onError(e); up.terminate() }
    })
    up.on('unexpected-response', (_, response) => {
      socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      response.resume(); up.terminate()
    })
    up.on('error', e => { socket.destroy(); if (contexts.size) onError(e) })
    up.on('close', () => { downstream?.close(); peers.delete(up) })
    socket.on('error', () => up.terminate())
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${server.address().port}`, close() { for (const p of peers) p.terminate(); for (const r of requests) r.destroy(); wss.close(); server.closeAllConnections(); server.close() } }
}
