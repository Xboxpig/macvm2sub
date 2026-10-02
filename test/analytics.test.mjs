import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analytics } from '../src/analytics.mjs'
import { configuration, saveSettings } from '../src/config.mjs'
import { History } from '../src/history.mjs'

const start = Date.parse('2026-10-01T00:00:00Z')
const entries = [
  { id: 'a', time: start + 1000, model: 'gpt-5.6-luna', status: 200, inputTokens: 100, outputTokens: 20, cachedTokens: 40, durationMs: 1000 },
  { id: 'b', time: start + 2000, model: 'gpt-5.6-luna', status: 502, inputTokens: 0, outputTokens: 0, durationMs: 9000, error: 'upstream_error' },
  { id: 'c', time: start + 3600000, model: 'other', status: 200, inputTokens: 50, outputTokens: 10, durationMs: 2000 },
  { id: 'outside', time: start - 1000, model: 'gpt-5.6-luna', status: 200, inputTokens: 9, outputTokens: 1, durationMs: 500 },
].sort((a, b) => a.time - b.time)
const history = { entries, totals: { requests: 4 } }
const request = { from_ms: start, to_ms: start + 86400000, now_ms: start + 7200000, time_zone: 'Asia/Shanghai', include: { summary: true, summary_comparison: true, timeline: true, heatmap: true, credential_stats: true, api_key_stats: true, model_stats: true, filter_selectors: true, granularity: 'hour' } }

test('CPA analytics preserves real totals, percentiles, model groups, cache and local heatmap hour', () => {
  const data = analytics(history, request)
  assert.equal(data.summary.total_calls, 3)
  assert.equal(data.summary.total_tokens, 180)
  assert.equal(data.summary.success_rate, 2 / 3)
  assert.equal(data.summary.p95_latency_ms, 9000)
  assert.equal(data.summary.cached_tokens, 40)
  assert.equal(data.summary_comparison.total_calls, 1)
  assert.equal(data.timeline.length, 2)
  assert.equal(data.heatmap.find(p => p.hour === 8).calls, 2)
  assert.equal(data.credential_stats[0].calls, 3)
  assert.equal(data.model_stats.find(m => m.model === 'other').total_tokens, 60)
  assert.equal(data.pricing_available, false)
  assert.equal(data.coverage.raw_complete, true)
})

test('request detail pagination retains records sharing a timestamp and daily buckets respect timezone', () => {
  const same = Array.from({ length: 4 }, (_, n) => ({ ...entries[1], id: `same-${n}`, time: start + 1000 }))
  const h = { entries: same, totals: { requests: 1004 } }
  const first = analytics(h, { ...request, include: { events_page: { limit: 2 } } }).events
  const second = analytics(h, { ...request, include: { events_page: { limit: 2, before_ms: first.next_before_ms, before_id: first.next_before_id } } }).events
  assert.deepEqual([...first.items, ...second.items].map(r => r.request_id), ['same-3', 'same-2', 'same-1', 'same-0'])
  assert.equal(second.has_more, false)
  assert.equal(analytics(history, { ...request, include: { timeline: true, granularity: 'day' } }).timeline[0].bucket_ms, start - 8 * 3600000)
})

test('CPA filters, drilldowns, deleted history coverage and invalid inputs', () => {
  const data = analytics(history, { ...request, filters: { models: ['gpt-5.6-luna'], failed_only: true, min_latency_ms: 3000 }, include: { ...request.include, drilldown_preview: { from_ms: start, to_ms: start + 3600000 } } })
  assert.equal(data.summary.total_calls, 1)
  assert.equal(data.drilldown_preview.items[0].fail_status_code, 502)
  assert.equal(analytics(history, { ...request, filters: { cache_status: 'hit' } }).summary.total_calls, 1)
  assert.equal(analytics(history, { ...request, filters: { api_key_hashes: ['missing'] } }).summary.total_calls, 0)
  assert.equal(analytics({ entries: entries.slice(-2), totals: { requests: 1000 } }, request).coverage.raw_complete, false)
  for (const patch of [{ from_ms: 0 }, { to_ms: start + 367 * 86400000 }, { time_zone: 'Invalid/Zone' }, { filters: { models: 'bad' } }]) assert.throws(() => analytics(history, { ...request, ...patch }), e => e.status === 400)
})

test('settings validate atomically, survive restart, and history retention preserves lifetime totals', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macvm2sub-settings-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { MACVM2SUB_DATA_DIR: dir }, config = configuration(env)
  saveSettings(config, { maxSessions: 2, sessionTtlMs: 120000, historyLimit: 500 })
  assert.equal(configuration(env).maxSessions, 2)
  assert.equal(configuration(env).sessionTtlMs, 120000)
  assert.throws(() => saveSettings(config, { model: 'valid', maxSessions: 0 }))
  assert.throws(() => saveSettings(config, { apiKey: 'no' }))
  assert.equal(config.model, 'gpt-5.6-luna')
  const log = new History(config)
  for (let n = 0; n < 502; n++) log.add({ ...entries[0], id: String(n), time: start + n })
  const restored = new History(configuration(env))
  assert.equal(restored.entries.length, 500)
  assert.equal(restored.totals.requests, 502)
  assert.equal(restored.entries[0].id, '2')
})
