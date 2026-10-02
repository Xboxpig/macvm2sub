import fs from 'node:fs'
import path from 'node:path'
export class History {
  constructor(config) {
    this.config = config
    this.file = path.join(config.dataDir, 'requests.jsonl'); this.entries = []; this.totals = { requests: 0, inputTokens: 0, outputTokens: 0 }
    this.totalsFile = path.join(config.dataDir, 'usage.json')
    try { this.entries = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).slice(-(config.historyLimit || 10000)).map(line => JSON.parse(line)) } catch {}
    for (const e of this.entries) this.addTotals(e)
    try { this.totals = JSON.parse(fs.readFileSync(this.totalsFile, 'utf8')) } catch {}
  }
  addTotals(e) { this.totals.requests++; this.totals.inputTokens += e.inputTokens || 0; this.totals.outputTokens += e.outputTokens || 0 }
  add(entry) {
    this.addTotals(entry); this.entries.push(entry); this.entries = this.entries.slice(-(this.config.historyLimit || 10000))
    fs.writeFileSync(this.file + '.tmp', this.entries.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
    fs.renameSync(this.file + '.tmp', this.file)
    fs.writeFileSync(this.totalsFile + '.tmp', JSON.stringify(this.totals) + '\n', { mode: 0o600 })
    fs.renameSync(this.totalsFile + '.tmp', this.totalsFile)
  }
  recent() { return this.entries.slice(-500).reverse() }
}
