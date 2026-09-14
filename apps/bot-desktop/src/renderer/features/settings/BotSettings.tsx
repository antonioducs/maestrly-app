import { Button, Select } from '../../ui'
import { useEffect, useState } from 'react'
import type { Bot, ModelCatalogEntry, SharedAccount } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
import { ModelPicker, recommendedSelection } from '../accounts/ModelPicker'
export function BotSettings({ bot, onUpdate }: { bot: Bot; onUpdate: (bot: Bot) => void }) {
  const t = useT()
  const [models, setModels] = useState<ModelCatalogEntry[]>([])
  const [accounts, setAccounts] = useState<SharedAccount[]>([])
  const [accountId, setAccountId] = useState(bot.accountId)
  const [model, setModel] = useState(bot.model)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void window.bot.bot({ method: 'account.list', params: {} }).then(values => { if (active) setAccounts(values.filter(value => value.status.state === 'connected')) }).catch(error => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [bot.id])
  useEffect(() => {
    let active = true
    setModels([]); setError('')
    const request = accountId ? window.bot.bot({ method: 'account.models', params: { accountId } }) : window.bot.bot({ method: 'bot.models.list', params: { botId: bot.id } })
    void request.then(values => { if (active) { setModels(values); setModel(previous => recommendedSelection(values, previous)) } }).catch(error => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [bot.id, accountId])
  return <section>
    {bot.accountId && accounts.length > 1 && <label>{t('account')}<Select aria-label={t('account')} disabled={busy || !!bot.activeTurnId} value={accountId ?? ''} onValueChange={value => setAccountId(value)}>
      {accounts.map(account => <option value={account.id} key={account.id}>{account.status.account?.email ?? account.name}</option>)}
    </Select></label>}
    <ModelPicker models={models} value={model} onChange={setModel} disabled={busy || !!bot.activeTurnId} />
    <Button disabled={busy || !model || !models.length || !!bot.activeTurnId} onClick={() => {
      setBusy(true); setError('')
      void window.bot.bot({ method: 'bot.update', params: { botId: bot.id, expectedRevision: bot.revision, ...(accountId ? { accountId } : {}), model } }).then(onUpdate).catch(error => setError(String(error))).finally(() => setBusy(false))
    }}>{t('save')}</Button>
    {error && <p role="alert">{error}</p>}
  </section>
}
