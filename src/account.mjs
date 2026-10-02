import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fault } from './tui/protocol.mjs'

export class Account {
  constructor(config) {
    this.config = config; this.cached = { loggedIn: false }; this.checked = 0
    fs.mkdirSync(config.codexHome, { recursive: true, mode: 0o700 })
    const file = path.join(config.codexHome, 'config.toml')
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 })
  }
  env() { const env = { ...process.env, CODEX_HOME: this.config.codexHome }; delete env.OPENAI_API_KEY; return env }
  async status() {
    if (Date.now() - this.checked < 60000) return this.cached
    if (this.checking) return this.checking
    this.checking = new Promise(resolve => {
      const child = spawn(this.config.codexBin, ['login', 'status'], { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''
      const collect = data => { text = (text + data.toString()).slice(-4096) }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      const timer = setTimeout(() => child.kill(), 10000)
      let done = false
      const finish = loggedIn => { if (done) return; done = true; clearTimeout(timer); this.checked = Date.now(); this.cached = { loggedIn, loginMethod: loggedIn ? /ChatGPT/i.test(text) ? 'ChatGPT OAuth' : 'Codex CLI credentials' : undefined }; resolve(this.cached) }
      child.on('error', () => finish(false)); child.on('exit', code => finish(code === 0))
    }).finally(() => { this.checking = null })
    return this.checking
  }
  login(mode) {
    if (this.child) throw fault('A login is already in progress', 409)
    if (!['browser', 'device'].includes(mode)) throw fault('Invalid login mode')
    this.loginState = { running: true, message: mode === 'browser' ? '完成授权后可提交浏览器回调 URL。' : '输入验证码完成设备授权。' }
    const child = spawn(this.config.codexBin, ['login', ...(mode === 'device' ? ['--device-auth'] : [])], { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    let text = ''
    const collect = bytes => {
      text = (text + bytes.toString()).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-16000)
      const urls = text.match(/https:\/\/[^\s<>"']+/g) || []
      this.loginState.url = urls.find(x => { try { return new URL(x).hostname === 'auth.openai.com' } catch { return false } })
      this.loginState.code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0]
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill(), 600000)
    const finish = code => {
      clearTimeout(timer); this.child = null; this.checked = 0
      this.loginState = { running: false, message: code === 0 ? '登录完成' : '登录未完成，请重新尝试或使用设备验证。' }
    }
    child.once('error', () => finish(1)); child.once('exit', finish)
    return this.loginState
  }
  async callback(value) {
    if (!this.child) throw fault('No login is in progress', 409)
    let url
    try { url = new URL(value) } catch { throw fault('Invalid callback URL') }
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '1455' || url.pathname !== '/auth/callback' || url.username || url.password || !url.searchParams.has('state')) throw fault('Expected the official localhost:1455/auth/callback URL')
    const response = await fetch(`http://127.0.0.1:1455/auth/callback${url.search}`, { redirect: 'manual', signal: AbortSignal.timeout(20000) })
    await response.body?.cancel()
    if (response.status >= 400) throw fault(`Official Codex login rejected the callback (${response.status})`)
    return { ok: true }
  }
  models() {
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(this.config.codexHome, 'models_cache.json'), 'utf8'))
      return (cached.models || []).filter(m => m.slug && m.visibility !== 'hide').map(m => ({ id: m.slug, object: 'model', created: 0, owned_by: 'openai' }))
    } catch { return [{ id: this.config.model, object: 'model', created: 0, owned_by: 'openai' }] }
  }
  close() { this.child?.kill() }
}
