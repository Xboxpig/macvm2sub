import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { fault } from './tui/protocol.mjs'
const hash = value => createHash('sha256').update(String(value || '')).digest()
export const equals = (a, b) => timingSafeEqual(hash(a), hash(b))
export class Auth {
  constructor(config) {
    this.config = config; this.cookies = new Map(); this.attempts = new Map()
    if (!config.apiKey || !config.adminPassword) throw new Error('API key and console password must be configured')
  }
  api(req) {
    return equals(req.headers.authorization, `Bearer ${this.config.apiKey}`) || equals(req.headers['x-api-key'], this.config.apiKey)
  }
  console(req) {
    const token = req.headers.cookie?.match(/(?:^|;\s*)macvm2sub_session=([a-f0-9]{64})(?:;|$)/)?.[1]
    const until = this.cookies.get(token)
    if (!until || until < Date.now()) { this.cookies.delete(token); return false }
    return true
  }
  sameOrigin(req) {
    const origin = req.headers.origin
    if (req.headers['sec-fetch-site'] === 'cross-site') throw fault('Cross-site request rejected', 403)
    if (origin) { let url; try { url = new URL(origin) } catch { throw fault('Invalid Origin', 403) }; if (url.host !== req.headers.host) throw fault('Cross-origin request rejected', 403) }
  }
  login(req, body, res) {
    this.sameOrigin(req)
    const now = Date.now(), key = req.socket.remoteAddress
    for (const [k, v] of this.attempts) if (v.until < now) this.attempts.delete(k)
    const attempt = this.attempts.get(key) || { count: 0, until: now + 60000 }
    if (attempt.count >= 8) throw fault('Too many login attempts; wait one minute', 429)
    attempt.count++; this.attempts.set(key, attempt)
    if (!equals(body.username, this.config.adminUser) || !equals(body.password, this.config.adminPassword)) throw fault('用户名或密码不正确', 401)
    this.attempts.delete(key)
    for (const [k,v] of this.cookies) if (v < now) this.cookies.delete(k)
    if (this.cookies.size >= 100) this.cookies.delete(this.cookies.keys().next().value)
    const token = randomBytes(32).toString('hex'); this.cookies.set(token, now + 86400000)
    res.setHeader('set-cookie', `macvm2sub_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`)
    return { ok: true }
  }
  logout(req, res) {
    const token = req.headers.cookie?.match(/macvm2sub_session=([a-f0-9]{64})/)?.[1]; this.cookies.delete(token)
    res.setHeader('set-cookie', 'macvm2sub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
    return { ok: true }
  }
}
