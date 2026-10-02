import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { tailTranscriptLines } from '../../src/vendor/jinn/transcript-tailer.mjs'
import { codexTranscriptMarker, CodexTurnMarkers } from '../../src/vendor/jinn/codex-markers.mjs'

test('Jinn turn markers reject late completion from a previous native turn', () => {
  const markers = new CodexTurnMarkers(); markers.start()
  assert.equal(markers.accept({ type: 'task_complete', turnId: 'old' }), null)
  assert.equal(markers.accept({ type: 'task_started', turnId: 'new' }), 'started')
  assert.equal(markers.accept({ type: 'task_complete', turnId: 'old' }), null)
  assert.equal(markers.completed, false)
  assert.equal(markers.accept({ type: 'task_complete', turnId: 'new' }), 'complete')
  markers.start(); assert.equal(markers.completed, false)
  assert.equal(markers.accept({ type: 'task_complete', turnId: 'new' }), null)
  assert.deepEqual(codexTranscriptMarker('{"type":"event_msg","payload":{"type":"task_started","turn_id":"t"}}'), { type: 'task_started', turnId: 't' })
})
test('transcript tailing handles UTF-8 split across writes and file replacement', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-tail-')), file = path.join(root, 'rollout.jsonl'), lines = []
  fs.writeFileSync(file, '')
  const tailer = tailTranscriptLines(file, 0, line => lines.push(line), { pollMs: 10 })
  t.after(() => { tailer.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  const bytes = Buffer.from('第一行\n')
  fs.appendFileSync(file, bytes.subarray(0, 2)); await delay(30)
  assert.equal(lines.length, 0)
  fs.appendFileSync(file, bytes.subarray(2));
  let deadline = Date.now() + 1000; while (!lines.length && Date.now() < deadline) await delay(10)
  assert.deepEqual(lines, ['第一行'])
  fs.renameSync(file, file + '.old'); fs.writeFileSync(file, 'second\n')
  deadline = Date.now() + 1000; while (lines.length < 2 && Date.now() < deadline) await delay(10)
  assert.deepEqual(lines, ['第一行', 'second'])
})
