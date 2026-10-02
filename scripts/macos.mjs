/** Native macOS setup/start/login. Run from the repository, without sudo. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { atomicWriteJson } from '../src/lib/vm/vm-file.mjs'
import { codexCliHealth, codexCliEnv, codexCliPaths } from '../src/lib/transport/codex-cli.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
if (process.platform !== 'darwin') throw new Error('This launcher requires macOS')
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 or newer')
const configFile = path.join(root, '.env.macos')
const command = process.argv[2] || 'start'
const id = process.env.VM2API_CODEX_SLOT || 'vm-codex-01'
if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid VM2API_CODEX_SLOT')
const vmFile = path.join(root, 'vms', `${id}.json`)

if (command === 'init') {
  fs.mkdirSync(path.dirname(vmFile), { recursive: true, mode: 0o700 })
  if (!fs.existsSync(configFile)) {
    const secret = () => randomBytes(24).toString('hex')
    fs.writeFileSync(
      configFile,
      `HOST=127.0.0.1\nPORT=8787\nKIN_CODEX_BACKEND=cli\nVM2API_ADMIN_USER=admin\nVM2API_ADMIN_PASSWORD=${secret()}\nVM2API_API_KEY=${secret()}\nVM2API_DB_SECRET=${secret()}\n`,
      { mode: 0o600, flag: 'wx' },
    )
  }
  if (!fs.existsSync(vmFile))
    atomicWriteJson(
      vmFile,
      {
        id,
        name: 'macOS Codex CLI',
        platform: 'openai',
        family: 'codex',
        status: 'stopped',
        schedulable: true,
        proxy: { id: 'px-local', scheme: 'local', host: 'local', port: 0 },
        policy: { maxConcurrency: 1 },
        codex: { has_access: false },
      },
      { mode: 0o600 },
    )
  const activeFile = path.join(root, 'vms', 'active.json')
  if (!fs.existsSync(activeFile)) atomicWriteJson(activeFile, { active_vm: id }, { mode: 0o600 })
  const { home } = codexCliPaths({ homeDir: path.join(root, 'vms', id, 'cli-home') })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const cliConfig = path.join(home, 'config.toml')
  if (!fs.existsSync(cliConfig))
    fs.writeFileSync(cliConfig, 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: 'wx' })
  console.log(`Initialized ${id}. Secrets: ${configFile}\nNext: npm run login:codex`)
} else {
  if (!fs.existsSync(configFile)) throw new Error('Run npm run setup:macos first')
  process.loadEnvFile(configFile)
  process.env.KIN_CODEX_BACKEND = 'cli'
  if (command === 'start') await import('../src/server.mjs')
  else if (command === 'login' || command === 'status') {
    const vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
    const exec = { vmId: id, vm, homeDir: path.join(root, 'vms', id, 'cli-home') }
    const cliEnv = codexCliEnv(exec)
    if (command === 'login') {
      const args = ['login', ...process.argv.slice(3)]
      const result = spawnSync(process.env.KIN_CODEX_CLI_BIN || 'codex', args, { env: cliEnv, stdio: 'inherit' })
      if (result.error || result.status !== 0)
        throw new Error('Codex login failed; check KIN_CODEX_CLI_BIN and proxy settings')
    }
    const health = await codexCliHealth(exec)
    vm.codex = { ...vm.codex, has_access: health.ok }
    atomicWriteJson(vmFile, vm, { mode: 0o600 })
    console.log(JSON.stringify(health))
    if (!health.ok) process.exitCode = 1
  } else throw new Error('Usage: node scripts/macos.mjs init|login|status|start')
}
