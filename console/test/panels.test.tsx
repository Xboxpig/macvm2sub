import { test, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsPage } from '../src/pages/SettingsPage'
import { OAuthPage } from '../src/pages/OAuthPage'
import { UsageAnalyticsPage } from '../src/vendor/cpamp/features/usage-analytics/UsageAnalyticsPage'
import { ConsoleContext } from '../src/vendor/cpamp/stores'
import { analytics } from '../../src/analytics.mjs'
import type { Status } from '../src/api'

// Canvas rasterization is outside a DOM unit test; preserve and inspect real chart options.
vi.mock('../src/vendor/cpamp/components/charts/EChartsView', () => ({ EChartsView: ({ ariaLabel, option }: { ariaLabel: string; option: unknown }) => <div role="img" aria-label={ariaLabel} data-option={JSON.stringify(option)}/> }))
const settings = { model: 'gpt-5.6-luna', maxSessions: 4, sessionTtlMs: 900000, turnTimeoutMs: 180000, historyLimit: 10000 }
const status: Status = { account: { loggedIn: true, loginMethod: 'ChatGPT OAuth' }, busy: false, sessions: [], requests: [], totals: { requests: 0, inputTokens: 0, outputTokens: 0 }, settings }
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })

test('settings edits require upstream diff confirmation and persist all validated fields', async () => {
  const requests: { url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => { requests.push({ url, body: options?.body ? JSON.parse(String(options.body)) : undefined }); return response(url.endsWith('/models') ? [{ id: 'gpt-5.6-luna' }] : { ok: true }) }))
  render(<SettingsPage settings={settings} refresh={async () => {}} notify={() => {}} dark={false}/>)
  fireEvent.change(screen.getByLabelText('最多保留会话'), { target: { value: '3' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await screen.findByRole('dialog')
  expect(requests.some(r => r.url.endsWith('/settings'))).toBe(false)
  const buttons = screen.getAllByRole('button')
  const confirm = buttons.find(b => /确认.*保存/.test(b.textContent || ''))
  expect(confirm).toBeTruthy()
  fireEvent.click(confirm!)
  await waitFor(() => expect(requests.find(r => r.url.endsWith('/settings'))?.body).toEqual({ ...settings, maxSessions: 3 }))
})

test('OAuth uses official-browser flow, remote callback, device code and cancellation', async () => {
  const requests: { url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => { requests.push({ url, body: options?.body ? JSON.parse(String(options.body)) : undefined }); return response({ ok: true }) }))
  const props = { refresh: async () => {}, notify: () => {} }
  const view = render(<OAuthPage status={status} {...props}/>)
  fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
  await waitFor(() => expect(requests[0]).toEqual({ url: '/api/account/login', body: { mode: 'browser' } }))
  view.rerender(<OAuthPage status={{ ...status, login: { running: true, mode: 'browser', url: 'https://auth.openai.com/authorize?state=fixture' } }} {...props}/>)
  const input = screen.getByPlaceholderText(/localhost:1455/)
  fireEvent.change(input, { target: { value: 'http://localhost:1455/auth/callback?state=fixture&code=test' } })
  fireEvent.click(screen.getByRole('button', { name: '提交回调 URL' }))
  await waitFor(() => expect(requests.some(r => r.url === '/api/account/callback')).toBe(true))
  view.rerender(<OAuthPage status={{ ...status, login: { running: true, mode: 'device', url: 'https://auth.openai.com/device', code: 'ABCD-12345' } }} {...props}/>)
  expect(screen.getByText('ABCD-12345')).toBeTruthy()
  expect(screen.queryByPlaceholderText(/localhost:1455/)).toBeNull()
  await waitFor(() => expect((screen.getByRole('button', { name: '取消登录' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '取消登录' }))
  await waitFor(() => expect(requests.some(r => r.url === '/api/account/cancel')).toBe(true))
})

test('unmodified upstream analytics page renders real adapter data across all six tabs', async () => {
  const now = Date.now()
  const entries = [{ id: 'one', time: now - 100000, model: 'gpt-5.6-luna', status: 200, inputTokens: 100, outputTokens: 20, cachedTokens: 30, durationMs: 1800 }, { id: 'two', time: now - 50000, model: 'gpt-5.6-luna', status: 502, durationMs: 10000 }]
  const calls: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => { const query = JSON.parse(String(options?.body)); calls.push(query); return response(analytics({ entries, totals: { requests: 2 } }, query)) }))
  render(<MemoryRouter initialEntries={['/usage']}><ConsoleContext.Provider value={{ resolvedTheme: 'light', showNotification: () => {} }}><UsageAnalyticsPage/></ConsoleContext.Provider></MemoryRouter>)
  await waitFor(() => expect(calls.length).toBeGreaterThan(0))
  fireEvent.click(screen.getByRole('tab', { name: '模型分析' }))
  await waitFor(() => expect(document.body.textContent).toContain('gpt-5.6-luna'))
  const tabs = screen.getAllByRole('tab')
  expect(tabs).toHaveLength(6)
  for (const tab of tabs) { fireEvent.click(tab); await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true')); await new Promise(resolve => setTimeout(resolve, 10)) }
  expect(calls.some(c => (c.include as Record<string, unknown>).heatmap)).toBe(true)
  expect(screen.getAllByRole('img').length).toBeGreaterThan(0)
  expect(document.body.textContent).not.toContain('usage_analytics.')
  fireEvent.click(screen.getByRole('button', { name: '最近 7 天' }))
  await waitFor(() => expect(calls.some(c => Number(c.to_ms) - Number(c.from_ms) >= 6 * 86400000)).toBe(true))
})
