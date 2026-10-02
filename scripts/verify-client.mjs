/** Opt-in live test: isolated official Codex client -> gateway -> native TUI. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const base = process.argv[2] || 'http://127.0.0.1:8787'
const apiKey = process.env.MACVM2SUB_TEST_API_KEY || process.env.MACVM2SUB_API_KEY || process.env.VM2API_API_KEY
if (!apiKey) throw new Error('Set MACVM2SUB_TEST_API_KEY; no account credentials are copied into the client')
const model = process.env.MACVM2SUB_TEST_MODEL || 'gpt-5.6-luna'
const codexBin = process.env.MACVM2SUB_CODEX_BIN || 'codex'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macvm2sub-isolated-client-'))
fs.chmodSync(dir, 0o700)
const home = path.join(dir, 'codex-home'), work = path.join(dir, 'workspace')
fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(work, { mode: 0o700 })
const q = JSON.stringify
fs.writeFileSync(path.join(home, 'config.toml'), `model=${q(model)}\nmodel_provider="gateway"\n[model_providers.gateway]\nname="macvm2sub live verification"\nbase_url=${q(base.replace(/\/$/, '') + '/v1')}\nwire_api="responses"\nenv_key="MACVM2SUB_TEST_API_KEY"\nsupports_websockets=true\n[projects.${q(work)}]\ntrust_level="trusted"\n`, { mode: 0o600 })
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL'].includes(k))), CODEX_HOME: home, MACVM2SUB_TEST_API_KEY: apiKey }
const prompt = `Work only in this empty workspace. This is an API tool integration test.
1. Use the apply_patch tool, not shell redirection, to create calculator.py implementing sum_squares(numbers).
2. Use apply_patch to create test_calculator.py with Python unittest tests for [1,2,3] -> 14, [] -> 0, and [-1,-2] -> 5.
3. Use the shell execution tool to run python3 -m unittest -v. Read the actual tool output and fix any failure.
4. Use the shell execution tool to run pwd and list the two files.
After successful execution, reply with CLIENT_API_E2E_OK and the actual number of tests passed. Do not claim success without running the commands.`
const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', work, prompt]
console.log(JSON.stringify({ phase: 'start', endpoint: base, model, workspace: work, codexHome: home, sandbox: 'workspace-write' }))
async function run(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', d => { stdout = (stdout + d.toString()).slice(-4 * 1024 * 1024) })
  child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-16384) })
  const timer = setTimeout(() => child.kill('SIGTERM'), 240000)
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }).finally(() => clearTimeout(timer))
  return { code, stdout, stderr }
}
const started = Date.now(), client = await run(codexBin, args, { cwd: work, env })
const events = client.stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
const changes = events.filter(e => e.type === 'item.completed' && e.item?.type === 'file_change').map(e => e.item)
const commands = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').map(e => ({ command: e.item.command, exitCode: e.item.exit_code, output: e.item.aggregated_output }))
const answers = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text)
const files = ['calculator.py', 'test_calculator.py'].map(name => {
  const file = path.join(work, name)
  return { name, exists: fs.existsSync(file), sha256: fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null }
})
const independent = files.every(f => f.exists) ? await run('python3', ['-m', 'unittest', '-v'], { cwd: work, env: Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'MACVM2SUB_TEST_API_KEY')) }) : { code: 1, stdout: '', stderr: 'Generated files missing' }
const passed = client.code === 0 && changes.length > 0 && commands.some(c => c.exitCode === 0 && /unittest/.test(c.command) && /Ran 3 tests/.test(c.output)) && files.every(f => f.exists) && independent.code === 0 && /Ran 3 tests/.test(independent.stdout + independent.stderr) && answers.some(a => a.includes('CLIENT_API_E2E_OK'))
const report = { passed, endpoint: base, model, workspace: work, codexHome: home, sandbox: 'workspace-write', elapsedMs: Date.now() - started, clientExitCode: client.code, fileChanges: changes, commands, answers, files, independentTest: independent, ...(client.code ? { stderr: client.stderr } : {}) }
const reportFile = path.join(dir, 'report.json')
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ ...report, reportFile }))
if (!passed) process.exitCode = 1
