import { Monitor, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BotEnvironment, EnvironmentOperation } from '@maestrly/host-protocol'
import type { HostTarget } from '../../../shared/types'
import { Button, Checkbox, Input, Select, Surface } from '../../ui'
import { useT } from '../../i18n'
import { ChooseHost } from '../onboarding/ChooseHost'
import { environmentLabel } from '../onboarding/FirstBot'
import { AffectedBots } from '../computers/AffectedBots'
export function EnvironmentsPage({ hosts, connect, refreshHosts, advanced }: { hosts: HostTarget[]; connect: (target: HostTarget) => Promise<void>; refreshHosts: () => Promise<void>; advanced: () => void }) {
  const t = useT()
  const [targetId, setTargetId] = useState(hosts[0]?.id ?? '')
  const [environments, setEnvironments] = useState<BotEnvironment[]>([])
  const [operation, setOperation] = useState<EnvironmentOperation>()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState(t('newEnvironmentName'))
  const [preparing, setPreparing] = useState<BotEnvironment>()
  const [backup, setBackup] = useState(false)
  const [restart, setRestart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [creationKey, setCreationKey] = useState(() => crypto.randomUUID())
  useEffect(() => { void window.bot.status().then(status => { if (status.target) setTargetId(status.target.id) }) }, [])
  useEffect(() => {
    if (!targetId) { setLoading(false); return }
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined
    let pending = false
    setLoading(true); setError('')
    const poll = async () => {
      if (pending) return
      pending = true
      try {
        const [list, operations] = await Promise.all([window.bot.bot({ method: 'environment.list', params: {} }), window.bot.bot({ method: 'environment.operations', params: {} })])
        if (alive) { setEnvironments(list); setLoading(false); setOperation(previous => previous ? operations.find(op => op.id === previous.id) ?? previous : operations.find(op => ['queued', 'running'].includes(op.status))) }
      } catch (error) { if (alive) { setError(String(error)); setLoading(false) } }
      finally { pending = false }
    }
    void (async () => {
      const status = await window.bot.status()
      if (!alive) return
      if (!status.connected || status.target?.id !== targetId) {
        const target = hosts.find(target => target.id === targetId)
        if (!target) return
        await connect(target)
      }
      if (!alive) return
      if ((await window.bot.status()).accountSupport === 'host-outdated') throw new Error(t('accountHostUpdateRequired'))
      await poll(); timer = setInterval(() => void poll(), 1500)
    })().catch(error => { if (alive) { setError(String(error)); setLoading(false) } })
    return () => { alive = false; clearInterval(timer) }
  }, [targetId, reload])
  useEffect(() => {
    if (!operation || ['succeeded', 'failed'].includes(operation.status)) return
    let alive = true
    let polling = false
    const timer = setInterval(() => {
      if (polling) return
      polling = true
      void window.bot.bot({ method: 'environment.operation', params: { operationId: operation.id } }).then(value => { if (alive) setOperation(value) }).catch(error => { if (alive) setError(String(error)) }).finally(() => { polling = false })
    }, 750)
    return () => { alive = false; clearInterval(timer) }
  }, [operation?.id, operation?.status])
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); setReload(value => value + 1) } catch (error) { setError(String(error)) } finally { setBusy(false) } }
  if (!hosts.length) return <ChooseHost connect={connect} refreshHosts={refreshHosts} onChosen={setTargetId} />
  return <section className="settings environments-page">
    <div className="page-heading"><div><h1>{t('environments')}</h1><p>{t('environmentsExplanation')}</p></div><Button disabled={busy || loading} onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />{t('addEnvironment')}</Button></div>
    {hosts.length > 1 && <label>{t('computer')}<Select aria-label={t('computer')} value={targetId} disabled={busy} onValueChange={value => { setTargetId(value); setEnvironments([]); setOperation(undefined) }}>
      {hosts.map(target => <option value={target.id} key={target.id}>{target.displayName}</option>)}
    </Select></label>}
    {loading && <p role="status" className="field-status">{t('loadingEnvironments')}</p>}
    {environments.map(environment => <Surface key={environment.vm.id} className="environment-card">
      <div className="card-heading"><Monitor size={18} aria-hidden="true" /><h2>{environment.vm.name}</h2><span className="badge">{t(environmentLabel(environment.status))}</span></div>
      <p>{environment.inventory.sessions.filter(session => session.state !== 'archived').length} {t('botsInEnvironment')} · {environment.inventory.available} {t('availableWorkspaces')}</p>
      {environment.reason && <p>{environment.reason}</p>}
      {['needs-preparation', 'needs-update', 'needs-migration'].includes(environment.status) && <Button disabled={busy} onClick={() => { setPreparing(environment); setBackup(false); setRestart(false) }}>{t(environment.status === 'needs-update' ? 'updateEnvironment' : environment.status === 'needs-migration' ? 'migrateEnvironment' : 'prepareEnvironment')}</Button>}
      {environment.status === 'stopped' && <Button disabled={busy} onClick={() => void run(async () => { await window.bot.call({ method: 'vm.start', params: { vmId: environment.vm.id, expectedRevision: environment.vm.revision, idempotencyKey: crypto.randomUUID() } }) })}>{t('startEnvironment')}</Button>}
      {environment.operationId && <Button onClick={() => void run(async () => setOperation(await window.bot.bot({ method: 'environment.operation', params: { operationId: environment.operationId } })))}>{t('viewPreparation')}</Button>}
    </Surface>)}
    {operation && <Surface className="environment-progress"><h2>{t('environmentPreparation')}</h2><ol className="setup-steps">{operation.steps.map(step => <li key={step.id} data-state={step.status}><span>{step.label}</span><small>{t(step.status === 'failed' ? 'failed' : step.status)}</small></li>)}</ol>{operation.error && <p role="alert">{operation.error.message}</p>}</Surface>}
    <Button className="text-button" onClick={advanced}>{t('advancedEnvironmentOptions')}</Button>
    {error && <div role="alert"><p>{error}</p><Button onClick={() => setReload(value => value + 1)}>{t('retry')}</Button></div>}
    {creating && <dialog ref={node => { if (node && !node.open) node.showModal() }} aria-labelledby="create-environment-title" onCancel={() => setCreating(false)}>
      <h2 id="create-environment-title">{t('addEnvironment')}</h2><p>{t('createEnvironmentExplanation')}</p><form onSubmit={event => { event.preventDefault(); void run(async () => {
        const result = await window.bot.bot({ method: 'environment.create', params: { idempotencyKey: creationKey, name } }); setOperation(result); setCreationKey(crypto.randomUUID()); setCreating(false)
      }) }}><label>{t('name')}<Input value={name} maxLength={80} required disabled={busy} onChange={event => setName(event.target.value)} /></label><div className="actions"><Button type="button" disabled={busy} onClick={() => setCreating(false)}>{t('cancel')}</Button><Button className="primary" disabled={busy || !name.trim()}>{t(busy ? 'environmentPreparing' : 'addEnvironment')}</Button></div></form>
    </dialog>}
    {preparing && <dialog ref={node => { if (node && !node.open) node.showModal() }} aria-labelledby="prepare-environment-title" onCancel={() => setPreparing(undefined)}>
      <h2 id="prepare-environment-title">{t('prepareEnvironment')} · {preparing.vm.name}</h2><p>{t('prepareEnvironmentExplanation')}</p><AffectedBots vmId={preparing.vm.id} />
      <label className="check"><Checkbox checked={backup} onChange={event => setBackup(event.target.checked)} />{t('prepareExisting')}</label><label className="check"><Checkbox checked={restart} onChange={event => setRestart(event.target.checked)} />{t('restartExisting')}</label>
      <div className="actions"><Button disabled={busy} onClick={() => setPreparing(undefined)}>{t('cancel')}</Button><Button className="primary" disabled={busy || !backup || !restart} onClick={() => void run(async () => {
        if (preparing.status === 'needs-migration') {
          const legacy = preparing.inventory.sessions.filter(session => session.transport === 'legacy' && !session.issue)
          if (legacy.length !== 1) throw new Error(t('migrationNeedsReview'))
          await window.bot.bot({ method: 'bot.runtime.prepare', params: { botId: legacy[0].botId, idempotencyKey: crypto.randomUUID(), confirmBackup: true, confirmRestart: true } })
        } else setOperation(await window.bot.bot({ method: 'environment.prepare', params: { vmId: preparing.vm.id, idempotencyKey: crypto.randomUUID(), confirmBackup: true, confirmRestart: true } }))
        setPreparing(undefined)
      })}>{t('prepareEnvironment')}</Button></div>
    </dialog>}
  </section>
}
