import { Component, Suspense, lazy, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, NavLink, useLocation } from 'react-router-dom'
import { Button } from './vendor/cpamp/components/ui/Button'
import { Card } from './vendor/cpamp/components/ui/Card'
import { Input } from './vendor/cpamp/components/ui/Input'
import { LoadingSpinner } from './vendor/cpamp/components/ui/LoadingSpinner'
import { ConsoleContext } from './vendor/cpamp/stores'
import { IconSettings, IconTrendingUp, IconFileText, IconKey } from './vendor/cpamp/components/ui/icons'
import { OAuthPage } from './pages/OAuthPage'
import { RequestsPage } from './pages/RequestsPage'
import { api, type Status } from './api'
import './vendor/cpamp/i18n'
import './style.scss'

const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })))
const UsageAnalyticsPage = lazy(() => import('./vendor/cpamp/features/usage-analytics/UsageAnalyticsPage').then(m => ({ default: m.UsageAnalyticsPage })))
const pages = [{ path: '/', title: '概览', icon: IconTrendingUp }, { path: '/usage', title: '使用统计', icon: IconTrendingUp }, { path: '/monitoring', title: '请求记录', icon: IconFileText }, { path: '/oauth', title: 'OAuth 登录', icon: IconKey }, { path: '/settings', title: '配置管理', icon: IconSettings }]
const stateName: Record<string, string> = { starting: '启动中', idle: '等待输入', running: '推理中', waiting_tools: '等待客户端工具', suspended: '可恢复', closed: '已关闭' }
const number = (n: number) => new Intl.NumberFormat('zh-CN').format(n)
class PageBoundary extends Component<{children: ReactNode}, {error: string}> {
  state = { error: '' }
  static getDerivedStateFromError(error: Error) { return { error: error.message } }
  render() { return this.state.error ? <div role="alert" className="error-box">页面加载失败：{this.state.error}<Button variant="secondary" onClick={() => location.reload()}>重新加载</Button></div> : this.props.children }
}
function App() {
  const route = useLocation(), page = pages.find(p => p.path === route.pathname) || pages[0]
  const [status, setStatus] = useState<Status>(), [authed, setAuthed] = useState<boolean>(), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('theme', dark ? 'dark' : 'light') }, [dark])
  const refresh = useCallback(async () => {
    try { const data = await api<Status>('status'); setStatus(data); setAuthed(true) }
    catch (e) { if ((e as {status?: number}).status === 401) { setAuthed(false); setStatus(undefined) } else setError((e as Error).message) }
  }, [])
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer) }, [refresh])
  useEffect(() => { setNotice(''); setError('') }, [route.pathname])
  const notify = useCallback((message: string, kind?: string) => { if (kind === 'error') setError(message); else setNotice(message) }, [])
  async function action(fn: () => Promise<unknown>, message = '') {
    setBusy(true); setError(''); setNotice('')
    try { await fn(); if (message) setNotice(message); await refresh() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const login = (e: FormEvent) => { e.preventDefault(); void action(async () => { await api('login', { username, password }); setPassword('') }) }
  if (authed === undefined) return <div className="loading"><LoadingSpinner size={28}/><span>连接 macvm2sub…</span>{error && <p role="alert">{error}</p>}</div>
  if (!authed) return <main className="login-wrap"><Card className="login-card"><div className="brand-mark">m</div><h1>macvm2sub</h1><p className="muted">登录你的 Codex API 控制台</p><form onSubmit={login}><Input label="用户名" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required/><Input label="密码" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required/>{error && <p className="error-box" role="alert">{error}</p>}<Button type="submit" fullWidth loading={busy}>登录</Button></form><small>UI based on CPA-Manager-Plus</small></Card></main>
  return <ConsoleContext.Provider value={{ resolvedTheme: dark ? 'dark' : 'light', showNotification: notify }}><div className="shell"><aside className="app-sidebar">
    <a href="/console/" className="brand"><span className="brand-mark">m</span><span>macvm2sub<small>Codex API Console</small></span></a>
    <nav className="app-nav" aria-label="主导航">{pages.map(p => <NavLink key={p.path} to={p.path} end={p.path === '/'}><p.icon size={18}/>{p.title}</NavLink>)}</nav>
    <div className="sidebar-footer"><span className="dot"/> 单账号 · macOS x64<a href="https://github.com/seakee/CPA-Manager-Plus" target="_blank" rel="noreferrer">UI based on CPA-Manager-Plus ↗</a></div>
  </aside><div className="workspace"><header className="app-header"><span>{page.title}</span><div><Button variant="ghost" size="sm" onClick={() => setDark(!dark)}>{dark ? '浅色' : '深色'}</Button><Button variant="ghost" size="sm" onClick={() => void action(async () => { await api('logout', {}); setAuthed(false) })}>退出</Button></div></header>
    <main><div className="page-heading"><div><h1>{page.title}</h1><p className="muted">{page.path === '/usage' ? '请求、Token 用量、模型和凭证分析。' : page.path === '/settings' ? '管理 Codex 模型、会话与统计配置。' : page.path === '/oauth' ? '管理官方 Codex 授权与登录状态。' : page.path === '/monitoring' ? '查看保留的请求记录，不保存 prompt 或工具内容。' : '查看 API 状态、用量和会话。'}</p></div><span className={`status-pill ${status?.busy ? 'working' : ''}`}><span className="dot"/>{status?.busy ? '正在推理' : '服务就绪'}</span></div>
    {error && <div className="error-box" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
    <PageBoundary key={route.pathname}><Suspense fallback={<div className="page-loading"><LoadingSpinner size={24}/> 加载面板…</div>}>
    {status && page.path === '/' && <><div className="stats">{[['累计请求', status.totals.requests], ['输入 tokens', status.totals.inputTokens], ['输出 tokens', status.totals.outputTokens], ['活跃会话', status.sessions.filter(s => s.state !== 'closed').length]].map(([label, value]) => <Card key={label}><span className="muted">{label}</span><strong>{number(Number(value))}</strong></Card>)}</div><Card title="连接信息"><dl><dt>API 地址</dt><dd><code>{location.origin}/v1</code></dd><dt>默认模型</dt><dd>{status.settings.model}</dd><dt>Codex 账号</dt><dd>{status.account.loggedIn ? '已登录' : '尚未登录'}</dd></dl></Card><Card title="会话" extra={<span className="muted">自动保留 {Math.round(status.settings.sessionTtlMs / 60000)} 分钟</span>}>{status.sessions.length ? <div className="table-scroll"><table><thead><tr><th>会话</th><th>模型</th><th>状态</th><th>最近活动</th><th/></tr></thead><tbody>{status.sessions.map(s => <tr key={s.id}><td><code>{s.id.slice(0, 8)}</code></td><td>{s.model}</td><td>{stateName[s.state] || s.state}</td><td>{new Date(s.touched).toLocaleTimeString()}</td><td><Button size="xs" variant="ghost" disabled={busy || s.state === 'closed'} onClick={() => void action(() => api(`sessions/${s.id}`, {}, 'DELETE'), '会话已关闭')}>关闭</Button></td></tr>)}</tbody></table></div> : <div className="empty">首次 API 请求会创建会话。</div>}</Card></>}
    {status && page.path === '/monitoring' && <RequestsPage key={route.search} search={route.search}/>}
    {status && page.path === '/usage' && <div className="cpamp-page"><div className="analytics-note">统计基于保留的请求记录；订阅费用未计价，费用字段不代表账单。</div><UsageAnalyticsPage/></div>}
    {status && page.path === '/oauth' && <OAuthPage status={status} refresh={refresh} notify={notify}/>}
    {status && page.path === '/settings' && <SettingsPage settings={status.settings} refresh={refresh} notify={notify} dark={dark}/>}
    </Suspense></PageBoundary></main><footer className="app-footer">macvm2sub · Derived from vm2api · Frontend from CPA-Manager-Plus</footer>
  </div></div></ConsoleContext.Provider>
}
createRoot(document.getElementById('root')!).render(<HashRouter><App/></HashRouter>)
