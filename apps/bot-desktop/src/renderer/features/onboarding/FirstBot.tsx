import { ArrowLeft, Monitor, ArrowRight } from 'lucide-react'
import { Button, Input, Textarea, Select } from '../../ui'
import { useEffect, useRef, useState } from 'react'
import type { Bot, BotEnvironment, ModelCatalogEntry, SharedAccount } from '@maestrly/host-protocol'
import type { HostTarget, OnboardingDraft } from '../../../shared/types'
import { useT } from '../../i18n'
import { SetupProgress } from './SetupProgress'
import { OnboardingSteps } from './OnboardingSteps'
import { ChooseHost } from './ChooseHost'
import { ModelPicker, recommendedSelection } from '../accounts/ModelPicker'
export function FirstBot({ hosts, initialDraft, connect, onReady, refreshHosts, onDraft, onAccounts, onEnvironments }: {
  hosts: HostTarget[]; initialDraft: OnboardingDraft | null; onDraft: (draft: OnboardingDraft | null) => void;
  connect: (target: HostTarget) => Promise<void>; onReady: (bot: Bot) => void; refreshHosts: () => Promise<void>;
  onAccounts: () => void; onEnvironments: () => void;
}) {
  const t = useT()
  const [draft, setDraft] = useState<OnboardingDraft>(() => initialDraft ?? { name: t('suggestion'), purpose: '', instructions: '', step: 0, updatedAt: new Date().toISOString() })
  const [targetId, setTargetId] = useState(initialDraft?.targetId ?? [...hosts].sort((a, b) => (b.lastConnectedAt ?? '').localeCompare(a.lastConnectedAt ?? ''))[0]?.id ?? '')
  const [environments, setEnvironments] = useState<BotEnvironment[]>([])
  const [accounts, setAccounts] = useState<SharedAccount[]>([])
  const [models, setModels] = useState<ModelCatalogEntry[]>([])
  const [loadingEnvironment, setLoadingEnvironment] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [environmentError, setEnvironmentError] = useState('')
  const [accountError, setAccountError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [recovering, setRecovering] = useState(!!initialDraft?.previewId && !initialDraft.operationId)
  const [reload, setReload] = useState(0)
  const writes = useRef<Promise<void>>(Promise.resolve())
  const latest = useRef(draft)
  latest.current = draft
  const step = draft.step ?? (initialDraft?.previewId ? 2 : 0)
  const environment = environments.find(environment => environment.vm.id === draft.sharedVmId)
  const account = accounts.find(account => account.id === draft.accountId)
  const connectedAccounts = accounts.filter(account => account.status.state === 'connected')
  const save = (value: OnboardingDraft | null) => {
    onDraft(value)
    const pending = writes.current.catch(() => {}).then(() => window.bot.saveDraft(value))
    writes.current = pending
    return pending
  }
  const persist = async (value: OnboardingDraft) => { await save(value); setDraft(value) }
  const patch = (value: Partial<OnboardingDraft>) => setDraft(previous => ({ ...previous, ...value, updatedAt: new Date().toISOString() }))
  useEffect(() => {
    if (!draft.operationId) void save({ ...draft, targetId }).catch(error => setError(String(error)))
  }, [draft.name, draft.purpose, draft.instructions, draft.step, draft.sharedVmId, draft.accountId, draft.model, targetId])
  useEffect(() => {
    if (!targetId || draft.operationId || recovering) return
    let alive = true
    let polling = false
    let timer: ReturnType<typeof setInterval> | undefined
    setLoadingEnvironment(true); setEnvironmentError(''); setAccountError('')
    const loadEnvironments = async () => {
      if (polling) return
      polling = true
      try {
        const values = await window.bot.bot({ method: 'environment.list', params: {} })
        if (!alive) return
        setEnvironments(values)
        setEnvironmentError('')
        const available = values.filter(value => value.status === 'ready')
        setDraft(previous => previous.sharedVmId || available.length !== 1 ? previous : { ...previous, sharedVmId: available[0].vm.id })
      } catch (error) { if (alive) setEnvironmentError(String(error)) }
      finally { polling = false; if (alive) setLoadingEnvironment(false) }
    }
    void (async () => {
      const status = await window.bot.status()
      if (!alive) return
      if (!status.connected || status.target?.id !== targetId) {
        const target = hosts.find(target => target.id === targetId)
        if (!target) throw new Error(t('chooseComputer'))
        await connect(target)
      }
      if (!alive) return
      if ((await window.bot.status()).accountSupport === 'host-outdated') throw new Error(t('accountHostUpdateRequired'))
      void loadEnvironments()
      timer = setInterval(() => void loadEnvironments(), 2000)
      // Accounts and environments are independent; neither field waits for the other.
      void window.bot.bot({ method: 'account.list', params: {} }).then(values => {
        if (!alive) return
        setAccounts(values)
        const connected = values.filter(value => value.status.state === 'connected')
        const selected = connected.find(value => value.isDefault) ?? connected[0]
        if (selected) setDraft(previous => previous.accountId ? previous : { ...previous, accountId: selected.id })
      }).catch(error => { if (alive) setAccountError(String(error)) })
    })().catch(error => { if (alive) { setEnvironmentError(String(error)); setLoadingEnvironment(false) } })
    return () => { alive = false; clearInterval(timer) }
  }, [targetId, recovering, reload, draft.operationId])
  useEffect(() => {
    if (!draft.accountId || draft.operationId) { setModels([]); return }
    let alive = true
    setLoadingModels(true); setAccountError('')
    void window.bot.bot({ method: 'account.models', params: { accountId: draft.accountId } }).then(values => {
      if (!alive) return
      setModels(values)
      setDraft(previous => ({ ...previous, model: recommendedSelection(values, previous.model) }))
    }).catch(error => { if (alive) { setModels([]); setAccountError(String(error)) } }).finally(() => { if (alive) setLoadingModels(false) })
    return () => { alive = false }
  }, [draft.accountId, reload, draft.operationId])
  useEffect(() => {
    if (!recovering || !initialDraft?.previewId) return
    let alive = true
    void (async () => {
      const target = hosts.find(target => target.id === initialDraft.targetId)
      const status = await window.bot.status()
      if (target && (!status.connected || status.target?.id !== target.id)) await connect(target)
      const key = initialDraft.idempotencyKey ?? localStorage.getItem(`setup-key:${initialDraft.previewId}`)
      if (!key) throw new Error(t('setupMissing'))
      const operation = await window.bot.bot({ method: 'bot.operation.lookup', params: { idempotencyKey: key } })
      if (!alive) return
      if (operation) await persist({ ...initialDraft, operationId: operation.id, botId: operation.botId })
      else await persist({ ...initialDraft, previewId: undefined, inventoryRevision: undefined, idempotencyKey: undefined, step: 2 })
      if (alive) setRecovering(false)
    })().catch(error => { if (alive) setError(String(error)) })
    return () => { alive = false }
  }, [recovering, reload])
  const leave = async (destination: () => void) => { await persist({ ...latest.current, targetId }); destination() }
  const start = async () => {
    if (busy || !environment || environment.status !== 'ready' || !draft.accountId || !draft.model) return
    setBusy(true); setError('')
    let intent = { ...draft, targetId, step: 2 }
    try {
      if (intent.idempotencyKey) {
        const existing = await window.bot.bot({ method: 'bot.operation.lookup', params: { idempotencyKey: intent.idempotencyKey } })
        if (existing) { await persist({ ...intent, operationId: existing.id, botId: existing.botId }); return }
      }
      const preview = await window.bot.bot({ method: 'bot.setup.preview', params: { destination: { kind: 'shared-vm', vmId: environment.vm.id } } })
      if (!preview.feasible) throw new Error(preview.blockers.map(blocker => blocker.message).join(' '))
      intent = { ...intent, previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, idempotencyKey: intent.idempotencyKey ?? crypto.randomUUID() }
      await persist(intent)
      const operation = await window.bot.bot({ method: 'bot.setup.start', params: {
        idempotencyKey: intent.idempotencyKey, previewId: preview.previewId, inventoryRevision: preview.inventoryRevision,
        name: intent.name.trim(), purpose: intent.purpose, instructions: intent.instructions ?? '', accountId: intent.accountId, model: intent.model,
        confirmations: { destination: true, permissions: true },
      } })
      await persist({ ...intent, operationId: operation.id, botId: operation.botId })
    } catch (error) { setError(String(error)); setReload(value => value + 1) }
    finally { setBusy(false) }
  }
  if (draft.operationId) return <SetupProgress draft={draft} onReady={onReady} onAccounts={() => void leave(onAccounts)} startOver={() => {
    const value = { name: draft.name, purpose: draft.purpose, instructions: draft.instructions, targetId, sharedVmId: draft.sharedVmId, accountId: draft.accountId, model: draft.model, step: 0, updatedAt: new Date().toISOString() }
    void persist(value).catch(error => setError(String(error)))
  }} />
  if (recovering) return <section className="onboarding"><h1>{t('resumeCreation')}</h1><p role="status">{error || t('recoveringCreation')}</p>{error && <Button onClick={() => setReload(value => value + 1)}>{t('retry')}</Button>}</section>
  if (!hosts.length) return <ChooseHost connect={connect} refreshHosts={refreshHosts} onChosen={setTargetId} />
  return <section className="onboarding direct-onboarding">
    <OnboardingSteps current={step} />
    <h1>{t(step === 0 ? 'helpTitle' : step === 1 ? 'destination' : 'chooseIntelligence')}</h1>
    <form onSubmit={event => { event.preventDefault(); if (step < 2) patch({ step: step + 1 }); else void start() }}>
      {step === 0 ? <>
        <label>{t('name')}<Input value={draft.name} maxLength={80} required onChange={event => patch({ name: event.target.value })} /></label>
        <label>{t('instructions')}<Textarea aria-label={t('instructions')} value={draft.instructions ?? draft.purpose} maxLength={16000} placeholder={t('botInstructionsPlaceholder')} onChange={event => patch({ instructions: event.target.value })} /></label>
      </> : step === 1 ? <>
        {hosts.length > 1 && <label>{t('computer')}<Select aria-label={t('computer')} value={targetId} onValueChange={value => { setTargetId(value); setEnvironments([]); patch({ sharedVmId: undefined }) }}>
          {hosts.map(target => <option key={target.id} value={target.id}>{target.displayName}</option>)}
        </Select></label>}
        <label>{t('environment')}<Select aria-label={t('environment')} value={draft.sharedVmId ?? ''} onValueChange={value => patch({ sharedVmId: value })}>
          <option value="">{t('chooseEnvironment')}</option>
          {environments.map(value => <option key={value.vm.id} value={value.vm.id} disabled={value.status !== 'ready'}>{value.vm.name}{value.status === 'ready' ? '' : ` · ${t(environmentLabel(value.status))}`}</option>)}
        </Select></label>
        {loadingEnvironment && <p className="field-status" role="status">{t('loadingEnvironments')}</p>}
        {environmentError && <div className="field-error" role="alert"><p>{environmentError}</p><Button type="button" onClick={() => setReload(value => value + 1)}>{t('retry')}</Button></div>}
        {environment?.status === 'ready' && <p className="field-note"><Monitor size={16} aria-hidden="true" />{t('privateWorkspaceNote')}</p>}
        {!loadingEnvironment && !environments.some(value => value.status === 'ready') && <p>{t('noReadyEnvironment')}</p>}
        <Button type="button" className="text-button" onClick={() => void leave(onEnvironments)}>{t('manageEnvironments')}</Button>
      </> : <>
        {account ? <p className="account-reference">{t('sharedAccount')} · <strong>{account.status.account?.email ?? account.name}</strong></p> : <p>{t('accountNeeded')}</p>}
        {connectedAccounts.length > 1 && <label>{t('account')}<Select aria-label={t('account')} disabled={busy} value={draft.accountId ?? ''} onValueChange={value => patch({ accountId: value, model: undefined })}>
          {connectedAccounts.map(account => <option key={account.id} value={account.id}>{account.status.account?.email ?? account.name}{account.isDefault ? ` · ${t('defaultAccount')}` : ''}</option>)}
        </Select></label>}
        <ModelPicker models={models} value={draft.model} onChange={model => patch({ model })} disabled={busy} />
        {loadingModels && <p className="field-status" role="status">{t('loadingModels')}</p>}
        {accountError && <div role="alert" className="field-error"><p>{accountError}</p><Button type="button" onClick={() => setReload(value => value + 1)}>{t('retry')}</Button></div>}
        <Button type="button" className="text-button" onClick={() => void leave(onAccounts)}>{t('manageAccounts')}</Button>
        <p className="creation-summary">{draft.name} · {environment?.vm.name ?? t('chooseEnvironment')}</p>
      </>}
      {error && <p role="alert">{error}</p>}
      <div className="onboarding-actions">
        {step > 0 && <Button type="button" disabled={busy} onClick={() => patch({ step: step - 1 })}><ArrowLeft size={16} aria-hidden="true" />{t('previousStep')}</Button>}
        <Button className="primary" disabled={busy || (step === 0 ? !draft.name.trim() : step === 1 ? environment?.status !== 'ready' : !draft.accountId || !draft.model || !models.length || environment?.status !== 'ready')}>
          {t(busy ? 'creatingBot' : step === 2 ? 'createBot' : 'next')}<ArrowRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </form>
  </section>
}
export function environmentLabel(status: BotEnvironment['status']) {
  return ({ ready: 'environmentReady', stopped: 'environmentStopped', full: 'environmentFull', 'needs-preparation': 'environmentNeedsPreparation', 'needs-update': 'environmentNeedsUpdate', 'needs-migration': 'environmentNeedsMigration', preparing: 'environmentPreparing', unavailable: 'environmentUnavailable' } as const)[status]
}
