import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { configuration, saveSettings } from './config.mjs'
import { Auth } from './auth.mjs'
import { Account } from './account.mjs'
import { History } from './history.mjs'
import { Sessions } from './tui/session.mjs'
import { readBody } from './tui/relay.mjs'
import { fault } from './tui/protocol.mjs'
import { attachWebSocket } from './websocket.mjs'

export async function createGateway(config, dependencies = {}) {
  const auth = new Auth(config), sessions = dependencies.sessions || new Sessions(config), account = dependencies.account || new Account(config), history = new History(config)
  async function run(body, emit, signal) {
    const started = Date.now(), entry = { id: randomUUID(), time: started, model: body.model || config.model, inputTokens: 0, outputTokens: 0 }
    try {
      const response = await sessions.run(body, emit, signal)
      history.add({ ...entry, model: response.model, status: 200, durationMs: Date.now() - started, inputTokens: response.usage?.input_tokens || 0, outputTokens: response.usage?.output_tokens || 0 })
      return response
    } catch (error) {
      history.add({ ...entry, status: error.status || 502, durationMs: Date.now() - started, error: error.code || 'gateway_error' })
      throw error
    }
  }
  const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)) }
  const bodyOf = async req => { try { return JSON.parse(await readBody(req)) } catch (err) { if (err.status) throw err; throw fault('Invalid JSON body') } }
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer')
    try {
      const url = new URL(req.url, 'http://localhost'), route = url.pathname
      if (route === '/health') { json(res, { ok: true, service: 'macvm2sub' }); return }
      if (route.startsWith('/v1/')) {
        if (!auth.api(req)) throw fault('Invalid API key', 401)
        if (req.method === 'GET' && route === '/v1/models') { json(res, { object: 'list', data: account.models() }); return }
        if (req.method !== 'POST' || route !== '/v1/responses') throw fault('Use POST /v1/responses', 404)
        const body = await bodyOf(req), controller = new AbortController()
        res.on('close', () => { if (!res.writableEnded) controller.abort() })
        let started = false, heartbeat
        const emit = body.stream ? event => {
          if (!started) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' }); started = true
            heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n') }, 15000)
          }
          if (!res.destroyed) {
            if (res.writableLength > 8 * 1024 * 1024) { controller.abort(); res.destroy(); return }
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          }
        } : () => {}
        try {
          const response = await run(body, emit, controller.signal)
          if (body.stream) res.end(); else json(res, response)
        } catch (error) {
          if (started) { res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { code: error.code || 'gateway_error', message: error.message } })}\n\n`) }
          else throw error
        } finally { clearInterval(heartbeat) }
        return
      }
      if (route.startsWith('/api/')) {
        if (req.method !== 'GET') auth.sameOrigin(req)
        if (route === '/api/login' && req.method === 'POST') { json(res, auth.login(req, await bodyOf(req), res)); return }
        if (!auth.console(req)) throw fault('Console login required', 401)
        if (route === '/api/logout' && req.method === 'POST') { json(res, auth.logout(req, res)); return }
        if (route === '/api/status' && req.method === 'GET') {
          json(res, { account: await account.status(), login: account.loginState, busy: sessions.busy, sessions: sessions.status(), requests: history.recent(), totals: history.totals, settings: { model: config.model, sessionTtlMs: config.sessionTtlMs, maxSessions: config.maxSessions } }); return
        }
        if (route === '/api/settings' && req.method === 'POST') { try { saveSettings(config, await bodyOf(req)) } catch (e) { throw fault(e.message) }; json(res, { ok: true }); return }
        if (route === '/api/account/login' && req.method === 'POST') {
          if (sessions.busy) throw fault('Wait for the current inference to finish before logging in', 409)
          for (const s of sessions.sessions.values()) s.close()
          sessions.persist()
          json(res, account.login((await bodyOf(req)).mode)); return
        }
        if (route === '/api/account/callback' && req.method === 'POST') { json(res, await account.callback((await bodyOf(req)).url)); return }
        if (route.startsWith('/api/sessions/') && req.method === 'DELETE') {
          const session = sessions.sessions.get(route.slice('/api/sessions/'.length))
          if (!session) throw fault('Session not found', 404)
          session.close(); sessions.persist(); json(res, { ok: true }); return
        }
        throw fault('Not found', 404)
      }
      if (req.method === 'GET' && (route === '/' || route === '/console')) { res.writeHead(302, { location: '/console/' }).end(); return }
      if (req.method === 'GET' && route.startsWith('/console/')) {
        const relative = decodeURIComponent(route.slice('/console/'.length)) || 'index.html'
        const file = path.resolve(config.webDir, relative)
        if (!file.startsWith(path.resolve(config.webDir) + path.sep)) throw fault('Not found', 404)
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw fault('Console not built; run npm run build:web', 404)
        res.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
        res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' })
        fs.createReadStream(file).pipe(res); return
      }
      throw fault('Not found', 404)
    } catch (e) { if (!res.headersSent) json(res, { error: { type: e.status >= 500 ? 'server_error' : 'invalid_request_error', code: e.code || 'gateway_error', message: e.message } }, e.status || 500); else res.end() }
  })
  server.requestTimeout = 30000
  const sockets = attachWebSocket(server, { auth, run })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve) })
  return { server, sessions, account, close() { sessions.close(); account.close(); sockets.close(); server.closeAllConnections(); server.close() } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required')
  const config = configuration(), gateway = await createGateway(config)
  console.log(`macvm2sub listening on http://${config.host}:${config.port}`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { gateway.close(); process.exitCode = 0 })
}
