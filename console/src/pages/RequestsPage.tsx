import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Card } from '../vendor/cpamp/components/ui/Card'
import { Button } from '../vendor/cpamp/components/ui/Button'
import { api } from '../api'
import type { MonitoringAnalyticsEventsResponse, MonitoringAnalyticsResponse } from '../vendor/cpamp/services/api/usageService'

export function RequestsPage({ search }: { search: string }) {
  const [data, setData] = useState<MonitoringAnalyticsEventsResponse>(), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [cursor, setCursor] = useState<{ before_ms?: number; before_id?: number }>({})
  useEffect(() => {
    const controller = new AbortController(), params = new URLSearchParams(search), now = Date.now(), filters: Record<string, unknown> = {}
    for (const [param, key] of [['model', 'models'], ['provider', 'providers'], ['api_key_hash', 'api_key_hashes'], ['auth_file', 'auth_files'], ['auth_index', 'auth_indices']]) if (params.get(param)) filters[key] = [params.get(param)]
    if (params.get('status') === 'failed') filters.failed_only = true
    if (params.get('status') === 'success') filters.include_failed = false
    if (params.get('min_latency_ms')) filters.min_latency_ms = Number(params.get('min_latency_ms'))
    if (params.get('cache_status')) filters.cache_status = params.get('cache_status')
    setLoading(true); setError('')
    void api<MonitoringAnalyticsResponse>('analytics', { from_ms: Number(params.get('from_ms')) || now - 30 * 86400000, to_ms: Number(params.get('to_ms')) || now, filters, search_query: params.get('search') || '', include: { events_page: { limit: 50, ...cursor } } }, 'POST', controller.signal)
      .then(result => setData(result.events)).catch(e => { if (!controller.signal.aborted) setError(e.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [search, cursor])
  return <Card title="请求记录" extra={<span className="muted">{data?.total_count ?? 0} 条匹配记录</span>}>
    {search && <p className="muted">已应用统计页筛选。<NavLink to="/monitoring">清除筛选</NavLink></p>}
    {error && <div className="error-box" role="alert">{error}</div>}
    <div className="table-scroll"><table><thead><tr><th>时间</th><th>模型</th><th>状态</th><th>耗时</th><th>输入 / 输出</th></tr></thead><tbody>{data?.items.map(r => <tr key={r.request_id}><td>{new Date(r.timestamp_ms).toLocaleString()}</td><td>{r.model}</td><td title={r.fail_summary}><span className={r.failed ? 'failed' : 'success'}>{r.failed ? r.fail_status_code : 200}</span></td><td>{((r.latency_ms || 0) / 1000).toFixed(1)}s</td><td>{r.input_tokens.toLocaleString()} / {r.output_tokens.toLocaleString()}</td></tr>)}</tbody></table></div>
    {!loading && !data?.items.length && <div className="empty">此范围没有请求记录。</div>}
    <div className="actions"><Button variant="secondary" size="sm" disabled={loading} onClick={() => setCursor({})}>首页 / 刷新</Button><Button variant="secondary" size="sm" loading={loading} disabled={!data?.has_more} onClick={() => setCursor({ before_ms: data?.next_before_ms, before_id: data?.next_before_id })}>下一页</Button></div>
  </Card>
}
