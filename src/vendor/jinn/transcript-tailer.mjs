// Adapted from Jinn; MIT, Copyright (c) 2026 Jinn Contributors. See LICENSE/UPSTREAM.md.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

export function tailTranscriptLines(filePath, startOffset, onLine, opts = {}) {
  let offset = startOffset, buf = '', stopped = false, fh, reading = false, pending = false, inode
  let decoder = new StringDecoder('utf8')
  const readNew = async () => {
    if (stopped) return
    if (reading) { pending = true; return }
    reading = true
    try {
      do {
        pending = false
        let stat
        try { stat = await fsp.stat(filePath) } catch { return }
        if (stat.size < offset || inode != null && stat.ino !== inode) {
          await fh?.close(); fh = undefined; offset = 0; buf = ''; decoder = new StringDecoder('utf8')
        }
        inode = stat.ino
        if (stat.size <= offset) return
        if (!fh) {
          let opened
          try { opened = await fsp.open(filePath, 'r') } catch { return }
          if (stopped) { await opened.close(); return }
          fh = opened
        }
        if (stopped) return
        const chunk = Buffer.alloc(Math.min(stat.size - offset, 1024 * 1024))
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, offset)
        offset += bytesRead
        buf += decoder.write(chunk.subarray(0, bytesRead))
        if (buf.length > 16 * 1024 * 1024) throw new Error('Native transcript line exceeds the size limit')
        const lines = buf.split('\n'); buf = lines.pop() || ''
        for (const line of lines) { if (stopped) break; onLine(line) }
        if (bytesRead && offset < stat.size) pending = true
      } while (pending && !stopped)
    } catch (error) {
      if (!stopped) opts.onError?.(error)
      try { await fh?.close() } catch {}
      fh = undefined
    } finally { reading = false }
  }
  let watcher
  try { watcher = fs.watch(filePath, () => { void readNew() }) } catch {}
  const poll = setInterval(() => { void readNew() }, opts.pollMs || 250).unref()
  void readNew()
  return { stop() { stopped = true; watcher?.close(); clearInterval(poll); void fh?.close().catch(() => {}); fh = undefined } }
}
