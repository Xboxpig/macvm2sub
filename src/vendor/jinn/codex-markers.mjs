// Adapted from Jinn codex-interactive.ts; MIT, Copyright (c) 2026 Jinn Contributors.
export function codexTranscriptMarker(line) {
  let msg
  try { msg = JSON.parse(line.trim()) } catch { return null }
  const payload = msg.payload
  if (msg.type === 'session_meta' && typeof payload?.id === 'string') return { type: 'session', sessionId: payload.id, cwd: payload.cwd }
  if (msg.type !== 'event_msg' || !['task_started', 'task_complete', 'turn_aborted'].includes(payload?.type)) return null
  return { type: payload.type, turnId: typeof payload.turn_id === 'string' ? payload.turn_id : undefined }
}
export class CodexTurnMarkers {
  start() { this.sawStart = false; this.turnId = undefined; this.completed = false }
  accept(marker) {
    if (marker?.type === 'task_started') { this.sawStart = true; this.turnId = marker.turnId; return 'started' }
    if (!['task_complete', 'turn_aborted'].includes(marker?.type)) return null
    if (!this.sawStart || marker.turnId && this.turnId && marker.turnId !== this.turnId) return null
    if (marker.type === 'task_complete') { this.completed = true; return 'complete' }
    return 'aborted'
  }
}
