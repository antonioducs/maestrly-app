import { Plus, UserRound, Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Bot, SharedAccount, BotResult } from '@maestrly/host-protocol'
import { Button, Surface } from '../../ui'
import { useT } from '../../i18n'
import { AccountLogin } from './AccountLogin'
export function AccountsPage({ onEnvironments }: { onEnvironments: () => void }) {
  const t = useT()
  const [accounts, setAccounts] = useState<SharedAccount[]>([])
  const [legacy, setLegacy] = useState<Bot[]>([])
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [disconnect, setDisconnect] = useState<SharedAccount>()
  const [impact, setImpact] = useState<BotResult<'account.impact'>>()
  const [syncMessage, setSyncMessage] = useState('')
  const createKey = useRef(crypto.randomUUID())
  const alive = useRef(true)
  const refresh = async () => {
    const status = await window.bot.status()
    if (!alive.current) return
    setConnected(status.connected && status.accountSupport !== 'host-outdated')
    if (status.accountSupport === 'host-outdated') { setLoading(false); setError(t('accountHostUpdateRequired')); return }
    if (!status.connected) { setLoading(false); return }
    const [values, bots] = await Promise.all([window.bot.bot({ method: 'account.list', params: {} }), window.bot.bot({ method: 'bot.list', params: {} })])
    if (!alive.current) return
    setAccounts(values); setLegacy(bots.filter(bot => !bot.accountId && ['connected', 'expired'].includes(bot.accountState))); setLoading(false)
  }
  useEffect(() => {
    alive.current = true
    void refresh().catch(error => { if (alive.current) { setError(String(error)); setLoading(false) } })
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    if (!disconnect) { setImpact(undefined); return }
    let active = true
    let pending = false
    const poll = async () => {
      if (pending) return
      pending = true
      try { const value = await window.bot.bot({ method: 'account.impact', params: { accountId: disconnect.id } }); if (active) setImpact(value) }
      catch (error) { if (active) setError(String(error)) }
      finally { pending = false }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1500)
    return () => { active = false; clearInterval(timer) }
  }, [disconnect?.id])
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work(); await refresh() } catch (error) { if (alive.current) setError(String(error)) }
    finally { if (alive.current) setBusy(false) }
  }
  const complete = async (id: string) => {
    const account = await window.bot.bot({ method: 'account.inspect', params: { accountId: id } })
    if (!alive.current) return
    setAccounts(values => values.map(value => value.id === id ? account : value))
    if (account.status.state === 'connected') {
      setSelected(undefined)
      const result = await window.bot.syncAccounts()
      if (alive.current) setSyncMessage(result.unavailableHosts.length ? `${t('accountSyncPending')} ${result.unavailableHosts.join(', ')}` : '')
    }
  }
  return <section className="settings accounts-page">
    <div className="page-heading"><div><h1>{t('accounts')}</h1><p>{t('globalAccountExplanation')}</p></div>
      {connected && <Button disabled={busy} onClick={() => void run(async () => {
        const account = await window.bot.bot({ method: 'account.create', params: { idempotencyKey: createKey.current, name: t('newAccountName') } })
        createKey.current = crypto.randomUUID(); setSelected(account.id)
      })}><Plus size={16} aria-hidden="true" />{t('addAccount')}</Button>}
    </div>
    {!connected && !loading && <div>{!error && <p>{t('accountChooseHost')}</p>}<Button onClick={onEnvironments}>{t('manageEnvironments')}</Button></div>}
    {loading && <p className="field-status" role="status">{t('loadingAccounts')}</p>}
    {accounts.map(account => <Surface className="account-card" key={account.id}>
      <div className="card-heading"><UserRound size={18} aria-hidden="true" /><h2>{account.status.account?.email ?? account.name}</h2>{account.isDefault && <span className="badge"><Check size={12} aria-hidden="true" />{t('defaultAccount')}</span>}</div>
      <p>{account.status.state === 'connected' ? `${t('accountConnected')}${account.status.account?.plan ? ` · ${account.status.account.plan}` : ''}` : t('accountDisconnected')}</p>
      {!account.available && <p role="status">{account.issue ?? t('accountUnavailable')}</p>}
      <div className="actions">
        {account.status.state === 'connected' ? <>
          {!account.isDefault && <Button disabled={busy} onClick={() => void run(async () => { await window.bot.bot({ method: 'account.default', params: { accountId: account.id } }) })}>{t('makeDefault')}</Button>}
          <Button disabled={busy} onClick={() => { setImpact(undefined); setDisconnect(account) }}>{t('logout')}</Button>
        </> : <Button disabled={busy} onClick={() => setSelected(account.id)}>{t('connectAccount')}</Button>}
      </div>
      {selected === account.id && <AccountLogin accountId={account.id} onConnected={() => void complete(account.id).catch(error => setError(String(error)))} />}
    </Surface>)}
    {legacy.length > 0 && <Surface className="account-card"><h2>{t('existingAccounts')}</h2><p>{t('migrateAccountExplanation')}</p>
      {legacy.map(bot => <div key={bot.id} className="legacy-account"><span>{bot.name}</span><Button disabled={busy || !!bot.activeTurnId} onClick={() => void run(async () => {
        const account = await window.bot.bot({ method: 'account.migrate', params: { botId: bot.id, idempotencyKey: `account-migration:${bot.id}` } })
        await complete(account.id)
      })}>{t('useAsSharedAccount')}</Button></div>)}
    </Surface>}
    {accounts.some(account => account.status.state === 'connected') && <Button disabled={busy} onClick={() => void run(async () => {
      const result = await window.bot.syncAccounts()
      setSyncMessage(result.unavailableHosts.length ? `${t('accountSyncPending')} ${result.unavailableHosts.join(', ')}` : t('accountsSynced'))
    })}>{t('syncAccounts')}</Button>}
    {syncMessage && <p role="status">{syncMessage}</p>}
    {error && <p role="alert">{error}</p>}
    {disconnect && <dialog ref={node => { if (node && !node.open) node.showModal() }} aria-labelledby="disconnect-account-title" onCancel={() => setDisconnect(undefined)}>
      <h2 id="disconnect-account-title">{t('disconnectSharedAccount')}</h2><p>{t('disconnectSharedExplanation')}</p>
      {impact ? <><ul>{impact.bots.map(bot => <li key={`${bot.hostId}:${bot.botId}`}>{bot.name}{bot.active ? ` · ${t('working')}` : ''}</li>)}</ul>
        {(impact.activeLeases > 0 || impact.bots.some(bot => bot.active)) && <p role="status">{t('stopBeforeDisconnect')}</p>}</> : <p role="status">{t('loadingAccounts')}</p>}
      <div className="actions"><Button disabled={busy} onClick={() => setDisconnect(undefined)}>{t('cancel')}</Button><Button className="danger" disabled={busy || !impact || impact.activeLeases > 0 || impact.bots.some(bot => bot.active)} onClick={() => void run(async () => {
        await window.bot.bot({ method: 'account.logout', params: { accountId: disconnect.id } }); setDisconnect(undefined)
      })}>{t('logout')}</Button></div>
    </dialog>}
  </section>
}
