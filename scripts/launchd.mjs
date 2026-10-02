/** Generate a boot service plist; install with the two commands printed below. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { root } from '../src/config.mjs'
if (process.platform !== 'darwin') throw new Error('launchd requires macOS')
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const dir = path.join(root, '.local'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const file = path.join(dir, 'uk.neppiggy.macvm2sub.plist')
const args = [process.execPath, `--env-file=${path.join(root, '.env.macos')}`, path.join(root, 'src/server.mjs')]
const env = { PATH: process.env.PATH, HOME: os.homedir(), USER: os.userInfo().username }
const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>uk.neppiggy.macvm2sub</string>
<key>UserName</key><string>${escape(os.userInfo().username)}</string>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${escape(a)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v]) => `<key>${k}</key><string>${escape(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${escape(path.join(dir, 'server.log'))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(dir, 'server.log'))}</string>
</dict></plist>\n`
fs.writeFileSync(file, plist, { mode: 0o600 })
console.log(`Generated ${file}\nInstall:\n  sudo install -m 644 '${file}' /Library/LaunchDaemons/uk.neppiggy.macvm2sub.plist\n  sudo launchctl bootstrap system /Library/LaunchDaemons/uk.neppiggy.macvm2sub.plist`)
