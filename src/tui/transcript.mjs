import fs from 'node:fs'
import path from 'node:path'
import { tailTranscriptLines } from '../vendor/jinn/transcript-tailer.mjs'
import { codexTranscriptMarker, CodexTurnMarkers } from '../vendor/jinn/codex-markers.mjs'

function walk(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(file)
  }
  return out
}
function meta(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r'); const bytes = Buffer.alloc(1024 * 1024)
    const n = fs.readSync(fd, bytes, 0, bytes.length, 0)
    return codexTranscriptMarker(bytes.subarray(0, n).toString().split('\n')[0])
  } catch { return null } finally { if (fd != null) fs.closeSync(fd) }
}
export class NativeTranscript {
  constructor({ home, cwd, resumeId, onSession, onTurn, onError }) {
    this.markers = new CodexTurnMarkers(); this.markers.start()
    const root = path.join(home, 'sessions'), before = new Set(walk(root)), started = Date.now()
    const attach = file => {
      const metadata = meta(file)
      onSession(metadata.sessionId)
      this.tailer = tailTranscriptLines(file, resumeId ? fs.statSync(file).size : 0, line => {
        const event = this.markers.accept(codexTranscriptMarker(line))
        if (event) onTurn(event)
      }, { pollMs: 150, onError })
    }
    const find = () => {
      const candidates = walk(root).filter(file => resumeId ? file.includes(resumeId) : !before.has(file))
        .filter(file => { const m = meta(file); return m?.type === 'session' && m.cwd === cwd && (!resumeId || m.sessionId === resumeId) })
      if (candidates.length === 1) { clearInterval(this.timer); attach(candidates[0]); return true }
      if (Date.now() - started > 30000) { clearInterval(this.timer); onError(new Error(candidates.length ? 'Ambiguous native transcript' : 'Native transcript did not appear')) }
      return false
    }
    if (resumeId && find()) return
    this.timer = setInterval(find, 200).unref()
  }
  begin() { this.markers.start() }
  get completed() { return this.markers.completed }
  stop() { clearInterval(this.timer); this.tailer?.stop() }
}
