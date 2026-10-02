// Codex provider card adapted from upstream OAuthPage; original styles/controls retained.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card } from '../vendor/cpamp/components/ui/Card'
import { Button } from '../vendor/cpamp/components/ui/Button'
import { Input } from '../vendor/cpamp/components/ui/Input'
import { SegmentedTabs } from '../vendor/cpamp/components/ui/SegmentedTabs'
import { copyToClipboard } from '../vendor/cpamp/utils/clipboard'
import iconCodex from '../vendor/cpamp/assets/icons/codex.svg'
import styles from '../vendor/cpamp/features/oauth/OAuthPage.module.scss'
import { api, type Status } from '../api'

export function OAuthPage({ status, refresh, notify }: { status: Status; refresh: () => Promise<void>; notify: (message: string, kind?: string) => void }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'browser' | 'device'>('browser'), [callback, setCallback] = useState(''), [working, setWorking] = useState(false), [error, setError] = useState(''), [callbackDone, setCallbackDone] = useState(false)
  const login = status.login, running = login?.running, success = login?.result === 'success', failed = login?.result === 'error'
  async function action(fn: () => Promise<unknown>) { setWorking(true); setError(''); try { await fn(); await refresh() } catch (e) { setError((e as Error).message) } finally { setWorking(false) } }
  async function copy(text: string) { const ok = await copyToClipboard(text); notify(ok ? '已复制' : '复制失败，请手动复制', ok ? 'success' : 'error') }
  return <div className={`${styles.container} cpamp-page`}><div className={styles.content}><div id="oauth-provider-codex">
    <Card title={<span className={styles.cardTitle}><img src={iconCodex} alt="" className={styles.cardTitleIcon}/>{t('auth_login.codex_oauth_title')}</span>}
      extra={<Button loading={working || running} disabled={working || running || status.busy} onClick={() => void action(async () => { setCallback(''); setCallbackDone(false); await api('account/login', { mode }) })}>{status.account.loggedIn ? '重新登录' : t('auth_login.codex_oauth_button')}</Button>}>
      <div className={styles.cardContent}>
        <div className={styles.cardHint}>{t('auth_login.codex_oauth_hint')}</div>
        <div className={`status-badge ${status.account.loggedIn ? 'success' : ''}`}>{status.account.loggedIn ? `已登录 · ${status.account.loginMethod || 'Codex OAuth'}` : '尚未登录'}</div>
        <SegmentedTabs items={[{ id: 'browser', label: '浏览器 OAuth' }, { id: 'device', label: '设备验证码' }]} activeTab={running ? login?.mode === 'device' ? 'device' : 'browser' : mode} onChange={setMode} ariaLabel="登录方式" disabled={working || running}/>
        {running && login?.url && <div className={styles.authUrlBox}>
          <div className={styles.authUrlLabel}>{t('auth_login.codex_oauth_url_label')}</div><div className={styles.authUrlValue}>{login.url}</div>
          {login.code && <div className={styles.deviceCodeSection}><div className={styles.authUrlLabel}>{t('auth_login.device_code_label')}</div><div className={styles.deviceCodeRow}><span className={styles.deviceCodeValue}>{login.code}</span><Button variant="secondary" size="sm" onClick={() => void copy(login.code!)}>{t('auth_login.device_code_copy')}</Button></div></div>}
          <div className={styles.authUrlActions}><Button variant="secondary" size="sm" onClick={() => void copy(login.url!)}>{t('auth_login.codex_copy_link')}</Button><Button variant="secondary" size="sm" onClick={() => window.open(login.url, '_blank', 'noopener,noreferrer')}>{t('auth_login.codex_open_link')}</Button></div>
        </div>}
        {running && login?.mode !== 'device' && <form className={styles.callbackSection} onSubmit={e => { e.preventDefault(); void action(async () => { await api('account/callback', { url: callback }); setCallback(''); setCallbackDone(true) }) }}>
          <Input label={t('auth_login.oauth_callback_label')} hint={t('auth_login.oauth_callback_hint')} value={callback} onChange={e => { setCallback(e.target.value); setCallbackDone(false) }} placeholder={t('auth_login.oauth_callback_placeholder')} type="url" required/>
          <div className={styles.callbackActions}><Button variant="secondary" size="sm" type="submit" loading={working} disabled={!callback.trim()}>{t('auth_login.oauth_callback_button')}</Button></div>
          {callbackDone && <div className="status-badge success">{t('auth_login.oauth_callback_status_success')}</div>}
        </form>}
        {login && <div className={`status-badge ${success ? 'success' : failed ? 'error' : ''}`} role="status">{running ? t('auth_login.codex_oauth_status_waiting') : login.message}</div>}
        {error && <div className="status-badge error" role="alert">{error}</div>}
        {running && <div className={styles.authUrlActions}><Button variant="secondary" size="sm" disabled={working} onClick={() => void action(() => api('account/cancel', {}))}>取消登录</Button></div>}
        {status.busy && <div className={styles.cardHintSecondary}>等待当前推理完成后可重新登录。</div>}
      </div>
    </Card>
  </div></div></div>
}
