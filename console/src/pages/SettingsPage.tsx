// Adapted from CPA-Manager-Plus ConfigPage/VisualConfigEditor at the pinned revision.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Input } from '../vendor/cpamp/components/ui/Input'
import { SegmentedTabs } from '../vendor/cpamp/components/ui/SegmentedTabs'
import { ConfigSection } from '../vendor/cpamp/components/config/ConfigSection'
import { DiffModal } from '../vendor/cpamp/components/config/DiffModal'
import ConfigSourceEditor from '../vendor/cpamp/components/config/ConfigSourceEditor'
import { IconSettings, IconTimer, IconTrendingUp, IconCheck, IconRefreshCw, IconSearch } from '../vendor/cpamp/components/ui/icons'
import { openSearchPanel } from '@codemirror/search'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { api, type Settings } from '../api'
import styles from '../vendor/cpamp/features/config/ConfigPage.module.scss'
import visual from '../vendor/cpamp/components/config/VisualConfigEditor.module.scss'

const stringify = (value: Settings) => JSON.stringify(value, null, 2)
const sections = [
  { id: 'model', title: '模型与连接', description: '默认模型和 API 地址', icon: IconSettings },
  { id: 'sessions', title: '会话管理', description: '上下文保留与请求超时', icon: IconTimer },
  { id: 'usage', title: '请求统计', description: '请求记录保留数量', icon: IconTrendingUp },
]
export function SettingsPage({ settings, refresh, notify, dark }: { settings: Settings; refresh: () => Promise<void>; notify: (message: string, kind?: string) => void; dark: boolean }) {
  const { t } = useTranslation()
  const [saved, setSaved] = useState(settings), [draft, setDraft] = useState(settings), [source, setSource] = useState(stringify(settings))
  const [tab, setTab] = useState<'visual' | 'source'>('visual'), [section, setSection] = useState('model'), [error, setError] = useState(''), [saving, setSaving] = useState(false), [diff, setDiff] = useState(false)
  const [models, setModels] = useState<{ id: string }[]>([])
  const editor = useRef<ReactCodeMirrorRef>(null)
  const dirty = source !== stringify(saved)
  useEffect(() => { void api<{ id: string }[]>('models').then(setModels).catch(e => setError(e.message)) }, [])
  useEffect(() => { if (!dirty) { setSaved(settings); setDraft(settings); setSource(stringify(settings)) } }, [settings])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault() }
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  function edit(patch: Partial<Settings>) { const next = { ...draft, ...patch }; setDraft(next); setSource(stringify(next)); setError('') }
  function parse(): Settings {
    const next = JSON.parse(source)
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('配置必须是 JSON 对象')
    const keys = Object.keys(settings)
    if (Object.keys(next).some(k => !keys.includes(k)) || keys.some(k => !(k in next))) throw new Error('配置字段与当前服务不匹配')
    if (typeof next.model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(next.model)) throw new Error('请输入有效的模型名称')
    for (const [key, min, max] of [['maxSessions', 1, 16], ['sessionTtlMs', 60000, 86400000], ['turnTimeoutMs', 1000, 900000], ['historyLimit', 500, 50000]] as const) {
      if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) throw new Error(`${key} 必须为 ${min}–${max} 之间的整数`)
    }
    return next
  }
  function changeTab(next: 'visual' | 'source') {
    try { if (next === 'visual') setDraft(parse()); setTab(next); setError('') } catch (e) { setError((e as Error).message) }
  }
  function preview() { try { setDraft(parse()); setDiff(true); setError('') } catch (e) { setError((e as Error).message) } }
  async function save() {
    setSaving(true)
    try { await api('settings', draft); setSaved(draft); setSource(stringify(draft)); setDiff(false); await refresh(); notify('配置已保存', 'success') }
    catch (e) { setError((e as Error).message); setDiff(false) } finally { setSaving(false) }
  }
  function reload() { setSaved(settings); setDraft(settings); setSource(stringify(settings)); setError(''); void refresh() }
  function jump(id: string) { setSection(id); document.getElementById(`setting-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  const statusText = error ? '配置错误' : dirty ? '未保存的更改' : '配置已同步'
  return <div className={`${styles.container} cpamp-page`}>
    <div className={styles.pageMeta}>
      <SegmentedTabs items={[{ id: 'visual', label: '可视化编辑' }, { id: 'source', label: '源代码' }]} activeTab={tab} onChange={changeTab} ariaLabel="配置编辑模式" disabled={saving}/>
      <div className={`${styles.statusBadge} ${error ? styles.error : dirty ? styles.modified : styles.saved}`}>{statusText}</div>
    </div>
    {error && <div className="error-box" role="alert">{error}</div>}
    <div className={styles.workspaceShell}><div className={styles.content}>
      {tab === 'visual' ? <div className={visual.visualEditor}><div className={visual.workspace}>
        <div className="config-section-nav"><div className={visual.navList}>{sections.map(s => <button key={s.id} type="button" className={`${visual.navButton} ${section === s.id ? visual.navButtonActive : ''}`} onClick={() => jump(s.id)}><span className={visual.navIcon}><s.icon size={14}/></span><span className={visual.navMain}><span className={visual.navHeadingRow}><span className={visual.navLabelWrap}><span className={visual.navLabel}>{s.title}</span></span></span><span className={visual.navDescription}>{s.description}</span></span></button>)}</div></div>
        <div className={visual.sections}>
          <ConfigSection id="setting-model" icon={<IconSettings size={16}/>} title="模型与连接" description="默认模型用于新会话，已有会话保留原模型。">
            <div className={visual.sectionGrid}><Input label="默认模型" list="codex-models" value={draft.model} disabled={saving} onChange={e => edit({ model: e.target.value })}/><datalist id="codex-models">{models.map(m => <option key={m.id} value={m.id}/>)}</datalist><Input label="API 地址" readOnly value={`${location.origin}/v1`} hint="HTTP SSE 与 WebSocket 使用同一地址。"/></div>
          </ConfigSection>
          <ConfigSection id="setting-sessions" icon={<IconTimer size={16}/>} title="会话管理" description="每个会话保留独立的 Codex TUI 上下文，同一时刻执行一个请求。">
            <div className={visual.sectionGrid}>
              <Input label="最多保留会话" type="number" min={1} max={16} value={draft.maxSessions} disabled={saving} onChange={e => edit({ maxSessions: Number(e.target.value) })} hint="1–16 个；影响后续会话创建。"/>
              <Input label="空闲会话保留时间（分钟）" type="number" min={1} max={1440} value={draft.sessionTtlMs / 60000} disabled={saving} onChange={e => edit({ sessionTtlMs: Math.round(Number(e.target.value) * 60000) })}/>
              <Input label="单轮请求超时（秒）" type="number" min={1} max={900} value={draft.turnTimeoutMs / 1000} disabled={saving} onChange={e => edit({ turnTimeoutMs: Number(e.target.value) * 1000 })} hint="1–900 秒；下一轮请求生效。"/>
            </div>
          </ConfigSection>
          <ConfigSection id="setting-usage" icon={<IconTrendingUp size={16}/>} title="请求统计" description="图表基于保留的请求记录，累计 token 总数单独保存。">
            <div className={visual.sectionGrid}><Input label="最多保留请求记录" type="number" min={500} max={50000} step={500} value={draft.historyLimit} disabled={saving} onChange={e => edit({ historyLimit: Number(e.target.value) })} hint="500–50,000 条；调低后在下一次写入时裁剪旧记录。"/></div>
          </ConfigSection>
        </div>
      </div></div> : <div className={styles.sourceWorkspace}>
        <div className={styles.sourceToolbar}><span className="muted">settings.json</span><button className={styles.searchButton} aria-label="搜索配置" onClick={() => { if (editor.current?.view) openSearchPanel(editor.current.view) }}><IconSearch size={16}/></button></div>
        <div className={styles.editorWrapper}><ConfigSourceEditor editorRef={editor} value={source} onChange={setSource} theme={dark ? 'dark' : 'light'} editable={!saving} placeholder="JSON 配置"/></div>
      </div>}
    </div></div>
    {createPortal(<div className={styles.floatingActionContainer}><div className={styles.floatingActionList}>
      <div className={`${styles.floatingStatus} ${dirty ? styles.modified : styles.saved}`}>{statusText}</div>
      <button className={styles.floatingActionButton} aria-label={t('config_management.reload')} title={t('config_management.reload')} onClick={reload} disabled={saving}><IconRefreshCw size={16}/></button>
      <button className={styles.floatingActionButton} aria-label={t('config_management.save')} title={t('config_management.save')} onClick={preview} disabled={!dirty || saving}><IconCheck size={16}/></button>
    </div></div>, document.body)}
    <DiffModal open={diff} original={stringify(saved)} modified={stringify(draft)} onConfirm={() => void save()} onCancel={() => setDiff(false)} loading={saving}/>
  </div>
}
