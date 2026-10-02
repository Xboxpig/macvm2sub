import { fault } from './tui/protocol.mjs'

const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] || 0), 0)
const rate = (a, b) => b ? a / b : 0
const identity = { id: 'codex', auth_index: 'codex', auth_file_snapshot: 'Codex OAuth', source: 'codex', source_hash: 'codex', account_snapshot: 'Codex OAuth', auth_label_snapshot: 'Codex OAuth', auth_provider_snapshot: 'codex' }
function metrics(rows) {
  const calls = rows.length, success = rows.filter(r => r.status < 400).length
  const latency = rows.map(r => r.durationMs).filter(Number.isFinite).sort((a, b) => a - b)
  const input = sum(rows, 'inputTokens'), output = sum(rows, 'outputTokens'), cache = sum(rows, 'cachedTokens')
  return { calls, success_calls: success, failure_calls: calls - success, success_rate: rate(success, calls), input_tokens: input, output_tokens: output,
    cached_tokens: cache, cache_read_tokens: cache, cache_creation_tokens: 0, cache_hit_rate: rate(cache, input), reasoning_tokens: sum(rows, 'reasoningTokens'),
    total_tokens: input + output, cost: 0, average_latency_ms: latency.length ? latency.reduce((a, b) => a + b, 0) / latency.length : null,
    p95_latency_ms: latency.length ? latency[Math.ceil(latency.length * .95) - 1] : null, p95_ttft_ms: null, last_seen_ms: Math.max(0, ...rows.map(r => r.time)) }
}
function group(rows, key) { const map = new Map(); for (const row of rows) { const k = key(row); if (!map.has(k)) map.set(k, []); map.get(k).push(row) } return [...map] }
function summary(rows, from, to, now) {
  const m = metrics(rows), recent = rows.filter(r => r.time >= now - 1800000 && r.time <= now)
  return { ...m, total_calls: m.calls, total_cost: 0, zero_token_calls: rows.filter(r => !r.inputTokens && !r.outputTokens).length,
    rpm_30m: recent.length / 30, tpm_30m: (sum(recent, 'inputTokens') + sum(recent, 'outputTokens')) / 30,
    avg_daily_requests: m.calls / Math.max(1, (to - from) / 86400000), avg_daily_tokens: m.total_tokens / Math.max(1, (to - from) / 86400000),
    approx_tasks: m.calls, approx_task_failures: m.failure_calls, approx_task_success_rate: m.success_rate,
    zero_token_models: [...new Set(rows.filter(r => !r.inputTokens && !r.outputTokens).map(r => r.model))] }
}
function event(r, index) { return { ...identity, id: index, timestamp_ms: r.time, model: r.model, api_key_hash: 'gateway', input_tokens: r.inputTokens || 0,
  output_tokens: r.outputTokens || 0, cached_tokens: r.cachedTokens || 0, cache_read_tokens: r.cachedTokens || 0, cache_creation_tokens: 0,
  reasoning_tokens: r.reasoningTokens || 0, total_tokens: (r.inputTokens || 0) + (r.outputTokens || 0), latency_ms: r.durationMs ?? null,
  failed: r.status >= 400, fail_status_code: r.status >= 400 ? r.status : null, fail_summary: r.error || '', request_id: r.id } }

/** CPA analytics wire adapter. Only gateway-observed requests are counted. */
export function analytics(history, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw fault('Expected analytics request')
  const { from_ms: from, to_ms: to, filters = {}, include = {}, search_query: search = '' } = request
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || from >= to || to - from > 366 * 86400000) throw fault('Choose a time range of at most 366 days')
  if (!filters || typeof filters !== 'object' || !include || typeof include !== 'object' || typeof search !== 'string') throw fault('Invalid analytics filters')
  for (const [key, value] of Object.entries(filters)) {
    if (['include_failed', 'failed_only'].includes(key)) { if (typeof value !== 'boolean') throw fault('Invalid status filter') }
    else if (key === 'min_latency_ms') { if (!Number.isFinite(value) || value < 0) throw fault('Invalid latency filter') }
    else if (key === 'cache_status') { if (!['hit', 'miss'].includes(value)) throw fault('Invalid cache filter') }
    else if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string')) throw fault(`Invalid filter: ${key}`)
  }
  const granularity = include.granularity === 'day' ? 'day' : 'hour'
  const zone = request.time_zone || 'UTC'
  let dateFormat
  try { dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) } catch { throw fault('Invalid time zone') }
  const parts = time => Object.fromEntries(dateFormat.formatToParts(time).map(p => [p.type, p.value]))
  const bucket = time => {
    const p = parts(time)
    if (granularity === 'hour') return time - Number(p.minute) * 60000 - Number(p.second) * 1000 - time % 1000
    const target = Date.UTC(+p.year, +p.month - 1, +p.day)
    let value = target
    for (let i = 0; i < 3; i++) { const z = parts(value); value += target - Date.UTC(+z.year, +z.month - 1, +z.day, +z.hour, +z.minute, +z.second) }
    return value
  }
  const allowed = (key, value) => !filters[key]?.length || filters[key].includes(value)
  const matches = r => allowed('models', r.model) && allowed('providers', 'codex') && allowed('api_key_hashes', 'gateway') &&
    allowed('auth_files', 'Codex OAuth') && allowed('credential_ids', 'codex') && allowed('auth_indices', 'codex') && allowed('accounts', 'Codex OAuth') &&
    allowed('source_hashes', 'codex') && (!filters.failed_only || r.status >= 400) && (filters.include_failed !== false || r.status < 400) &&
    (!filters.min_latency_ms || r.durationMs >= filters.min_latency_ms) && (filters.cache_status !== 'hit' || r.cachedTokens > 0) &&
    (filters.cache_status !== 'miss' || !(r.cachedTokens > 0)) && (!request.search_api_key_hash || request.search_api_key_hash === 'gateway') &&
    (!search || `${r.model} ${r.status} ${r.error || ''} ${r.id} Codex OAuth`.toLowerCase().includes(search.toLowerCase()))
  const all = history.entries.filter(matches), rows = all.filter(r => r.time >= from && r.time < to)
  const sequence = new Map(history.entries.map((r, i) => [r.id, history.totals.requests - history.entries.length + i + 1]))
  const now = Number.isFinite(request.now_ms) ? request.now_ms : Date.now(), m = metrics(rows)
  const models = group(rows, r => r.model).map(([model, rs]) => ({ model, ...metrics(rs) }))
  const asPoint = rs => { const s = metrics(rs); return { ...s, tokens: s.total_tokens, success: s.success_calls, failure: s.failure_calls, failure_rate: rate(s.failure_calls, s.calls) } }
  const timeline = group(rows, r => bucket(r.time)).sort(([a], [b]) => a - b).map(([time, rs]) => ({ bucket_ms: time, bucket_end_ms: granularity === 'day' ? bucket(time + 36 * 3600000) : time + 3600000, label: new Date(time).toISOString(), ...asPoint(rs) }))
  const credential = { ...identity, ...m, models }, key = { id: 'gateway', api_key_hash: 'gateway', ...m, models, contexts: [{ ...identity, ...m, failure_rate: rate(m.failure_calls, m.calls) }] }
  const channel = { ...identity, ...asPoint(rows) }
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const heatmap = group(rows, r => { const p = parts(r.time); return `${weekdays.indexOf(p.weekday)}-${Number(p.hour)}` }).map(([key, rs]) => {
    const [weekday, hour] = key.split('-').map(Number)
    const contributors = getKey => group(rs, getKey).map(([id, items]) => ({ key: id, label: id, ...asPoint(items), share: rate(items.length, rs.length) }))
    return { weekday, hour, ...asPoint(rs), model_contributors: contributors(r => r.model), api_key_contributors: contributors(() => 'gateway'), provider_contributors: contributors(() => 'codex') }
  })
  const oldest = history.entries[0]?.time || 0, dropped = Math.max(0, history.totals.requests - history.entries.length), incomplete = dropped > 0 && from < oldest
  const result = { generated_at_ms: Date.now(), granularity, pricing_available: false,
    coverage: { scope: 'time_range', mode: 'raw', raw_complete: !incomplete, core_aggregate_used: false, raw_event_count: rows.length, raw_deleted_event_count: incomplete ? dropped : 0,
      min_deleted_timestamp_ms: 0, max_deleted_timestamp_ms: incomplete ? oldest : 0, fidelity_limitations: incomplete ? ['只包含仍保留的请求记录'] : [] } }
  const candidates = {
    summary: summary(rows, from, to, now), summary_comparison: { from_ms: from - (to - from), to_ms: from, ...summary(all.filter(r => r.time >= from - (to - from) && r.time < from), from - (to - from), from, now) },
    timeline, model_stats: models, model_share: models.map(r => ({ model: r.model, calls: r.calls, tokens: r.total_tokens, cost: 0 })),
    api_key_stats: rows.length ? [key] : [], credential_stats: rows.length ? [credential] : [], account_stats: rows.length ? [credential] : [], channel_share: rows.length ? [channel] : [],
    credential_timeline: timeline.map(p => ({ ...p, ...identity, bucket_label: p.label })), api_key_timeline: timeline.map(p => ({ ...p, api_key_hash: 'gateway', bucket_label: p.label })),
    heatmap, hourly_distribution: group(rows, r => Number(parts(r.time).hour)).map(([hour, rs]) => ({ hour, ...asPoint(rs) })),
    anomaly_points: timeline.filter(p => p.calls >= 5 && p.failure_rate >= .2).map(p => ({ ...p, metric_keys: ['failureRate'], severity: p.failure_rate >= .5 ? 'high' : 'medium', request_change: 0, cost_change: 0, tokens_per_request_change: 0, cache_hit_rate_change: 0, failure_rate_change: 0, latency_p95_change: 0 })),
    filter_options: { models: models.map(r => r.model), providers: ['codex'], api_key_hashes: ['gateway'], auth_files: ['Codex OAuth'], accounts: ['Codex OAuth'],
      model_stats: models, api_key_stats: rows.length ? [key] : [], account_stats: rows.length ? [credential] : [], channel_share: rows.length ? [channel] : [], account_count: rows.length ? 1 : 0, api_key_count: 1 },
  }
  for (const [name, value] of Object.entries(candidates)) if (include[name] || name === 'filter_options' && include.filter_selectors) result[name] = value
  if (include.drilldown_preview) {
    const d = include.drilldown_preview
    if (!Number.isFinite(d.from_ms) || !Number.isFinite(d.to_ms)) throw fault('Invalid drilldown range')
    const selected = rows.filter(r => r.time >= d.from_ms && r.time < d.to_ms).reverse(), limit = Math.max(1, Math.min(100, Math.floor(d.limit) || 12))
    result.drilldown_preview = { items: selected.slice(0, limit).map(r => event(r, sequence.get(r.id))), next_before_ms: selected[limit - 1]?.time || 0, has_more: selected.length > limit, total_count: selected.length }
  }
  if (include.events_page) {
    const d = include.events_page, limit = Math.max(1, Math.min(100, Math.floor(d.limit) || 50))
    if (d.before_ms != null && !Number.isFinite(d.before_ms) || d.before_id != null && !Number.isFinite(d.before_id)) throw fault('Invalid page cursor')
    const selected = rows.filter(r => !d.before_ms || r.time < d.before_ms || r.time === d.before_ms && sequence.get(r.id) < d.before_id).sort((a, b) => b.time - a.time || sequence.get(b.id) - sequence.get(a.id))
    const page = selected.slice(0, limit), last = page.at(-1)
    result.events = { items: page.map(r => event(r, sequence.get(r.id))), next_before_ms: last?.time || 0, next_before_id: last ? sequence.get(last.id) : 0, has_more: selected.length > limit, total_count: rows.length }
  }
  return result
}
