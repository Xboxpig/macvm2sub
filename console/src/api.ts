export async function api<T = unknown>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, { method, signal, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data.error?.message || '请求失败'), { status: response.status })
  return data
}
export type Settings = { model: string; sessionTtlMs: number; maxSessions: number; turnTimeoutMs: number; historyLimit: number }
export type LoginState = { running: boolean; mode?: string; result?: 'success' | 'error' | 'cancelled'; url?: string; code?: string; message?: string }
export type Status = { account: { loggedIn: boolean; loginMethod?: string }; busy: boolean; sessions: { id: string; model: string; state: string; touched: number; pendingTools: number }[]; requests: RequestEntry[]; totals: { requests: number; inputTokens: number; outputTokens: number }; settings: Settings; login?: LoginState }
export type RequestEntry = { id: string; time: number; model: string; status: number; durationMs: number; inputTokens: number; outputTokens: number; error?: string }
