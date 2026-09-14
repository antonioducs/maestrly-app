import { useEffect, useState } from 'react'
import type { Bot, ModelCatalogEntry, SharedAccount } from '@maestrly/host-protocol'
import { Button, Select } from '../../ui'
import { useT } from '../../i18n'
import { ModelPicker, recommendedSelection } from './ModelPicker'
/** Completes a retained pre-upgrade creation without allocating another bot or VM. */
export function AttachAccount({ botId, onDone, onAccounts }: { botId: string; onDone: () => void; onAccounts: () => void }) {
  const t = useT()
  const [bot, setBot] = useState<Bot>()
  const [accounts, setAccounts] = useState<SharedAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [models, setModels] = useState<ModelCatalogEntry[]>([])
  const [model, setModel] = useState<Bot['model']>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void Promise.all([window.bot.bot({ method: 'bot.inspect', params: { botId } }), window.bot.bot({ method: 'account.list', params: {} })]).then(([bot, accounts]) => {
      if (!active) return
      const connected = accounts.filter(account => account.status.state === 'connected')
      setBot(bot); setAccounts(connected); setAccountId(bot.accountId ?? connected.find(account => account.isDefault)?.id ?? connected[0]?.id ?? '')
    }).catch(error => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [botId])
  useEffect(() => {
    if (!accountId) return
    let active = true
    void window.bot.bot({ method: 'account.models', params: { accountId } }).then(values => { if (active) { setModels(values); setModel(recommendedSelection(values, bot?.model)) } }).catch(error => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [accountId])
  return <section>
    {accounts.length ? <>
      <label>{t('sharedAccount')}<Select aria-label={t('sharedAccount')} disabled={busy} value={accountId} onValueChange={setAccountId}>{accounts.map(account => <option value={account.id} key={account.id}>{account.status.account?.email ?? account.name}</option>)}</Select></label>
      <ModelPicker models={models} value={model} onChange={setModel} disabled={busy} />
      <Button className="primary" disabled={busy || !model || !bot} onClick={() => {
        setBusy(true); setError('')
        void window.bot.bot({ method: 'bot.update', params: { botId, expectedRevision: bot!.revision, accountId, model } }).then(() => onDone()).catch(async error => { setError(String(error)); setBot(await window.bot.bot({ method: 'bot.inspect', params: { botId } })) }).finally(() => setBusy(false))
      }}>{t('finishCreation')}</Button>
    </> : <p>{t('accountNeeded')}</p>}
    <Button disabled={busy} onClick={onAccounts}>{t('manageAccounts')}</Button>
    {error && <p role="alert">{error}</p>}
  </section>
}
