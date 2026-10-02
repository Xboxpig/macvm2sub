import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function configuration(env = process.env) {
  const dataDir = path.resolve(env.MACVM2SUB_DATA_DIR || path.join(root, 'data'))
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) } catch {}
  const bounded = (value, fallback, min, max) => { const n = Number(value ?? fallback); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Configuration value must be an integer between ${min} and ${max}`); return n }
  return {
    host: env.HOST || '127.0.0.1', port: bounded(env.PORT, 8787, 1, 65535), dataDir,
    codexHome: path.resolve(env.MACVM2SUB_CODEX_HOME || path.join(dataDir, 'codex')),
    codexBin: env.MACVM2SUB_CODEX_BIN || env.KIN_CODEX_CLI_BIN || 'codex',
    pythonBin: env.MACVM2SUB_PYTHON_BIN || '/usr/bin/python3',
    model: saved.model || env.MACVM2SUB_MODEL || 'gpt-5.6-luna',
    turnTimeoutMs: bounded(saved.turnTimeoutMs ?? env.MACVM2SUB_TURN_TIMEOUT_MS, 180000, 1000, 900000),
    sessionTtlMs: bounded(saved.sessionTtlMs ?? env.MACVM2SUB_SESSION_TTL_MS, 900000, 60000, 86400000),
    maxSessions: bounded(saved.maxSessions ?? env.MACVM2SUB_MAX_SESSIONS, 4, 1, 16),
    historyLimit: bounded(saved.historyLimit ?? env.MACVM2SUB_HISTORY_LIMIT, 10000, 500, 50000),
    upstream: 'https://chatgpt.com',
    apiKey: env.MACVM2SUB_API_KEY || env.VM2API_API_KEY,
    adminUser: env.MACVM2SUB_ADMIN_USER || env.VM2API_ADMIN_USER || 'admin',
    adminPassword: env.MACVM2SUB_ADMIN_PASSWORD || env.VM2API_ADMIN_PASSWORD,
    webDir: path.join(root, 'console', 'dist'),
  }
}

export function saveSettings(config, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected settings object')
  const next = Object.fromEntries(['model', 'turnTimeoutMs', 'sessionTtlMs', 'maxSessions', 'historyLimit'].map(key => [key, config[key]]))
  const limits = { turnTimeoutMs: [1000, 900000], sessionTtlMs: [60000, 86400000], maxSessions: [1, 16], historyLimit: [500, 50000] }
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(next, key)) throw new Error(`Unsupported setting: ${key}`)
    if (key === 'model') { if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(value)) throw new Error('Invalid model identifier') }
    else { const [min, max] = limits[key]; if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`) }
    next[key] = value
  }
  const file = path.join(config.dataDir, 'settings.json')
  fs.writeFileSync(file + '.tmp', JSON.stringify(next) + '\n', { mode: 0o600 })
  fs.renameSync(file + '.tmp', file); Object.assign(config, next)
}
