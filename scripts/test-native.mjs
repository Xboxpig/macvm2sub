import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['--test', 'test/tui/native.test.mjs'], { env: { ...process.env, TEST_CODEX_TUI: '1' }, stdio: 'inherit' })
child.on('exit', code => { process.exitCode = code || 0 })
child.on('error', e => { console.error(e.message); process.exitCode = 1 })
