import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { configuration, root } from '../src/config.mjs'
import { Account } from '../src/account.mjs'
import { createGateway } from '../src/server.mjs'

if (process.platform !== 'darwin') throw new Error('This launcher requires macOS')
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required')
const command = process.argv[2] || 'start', envFile = path.join(root, '.env.macos')
if (command === 'init' && !fs.existsSync(envFile)) {
  fs.writeFileSync(envFile, `HOST=127.0.0.1\nPORT=8787\nMACVM2SUB_MODEL=gpt-5.6-luna\nMACVM2SUB_ADMIN_USER=admin\nMACVM2SUB_ADMIN_PASSWORD=${randomBytes(24).toString('hex')}\nMACVM2SUB_API_KEY=${randomBytes(24).toString('hex')}\n`, { mode: 0o600, flag: 'wx' })
}
if (!fs.existsSync(envFile)) throw new Error('Run npm run setup:macos first')
process.loadEnvFile(envFile)
const config = configuration(), account = new Account(config)
if (command === 'init') console.log(`Initialized single-account gateway. Credentials: ${envFile}\nNext: npm run login:codex`)
else if (command === 'start') {
  const gateway = await createGateway(config)
  console.log(`macvm2sub listening on http://${config.host}:${config.port}`)
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => gateway.close())
} else if (command === 'status') {
  const status = await account.status(); console.log(JSON.stringify(status)); if (!status.loggedIn) process.exitCode = 1
} else if (command === 'login') {
  const child = spawn(config.codexBin, ['login', ...process.argv.slice(3)], { env: account.env(), stdio: 'inherit' })
  child.on('error', e => { console.error(e.message); process.exitCode = 1 }); child.on('exit', code => { process.exitCode = code || 0 })
} else throw new Error('Usage: node scripts/macos.mjs init|start|login|status')
