import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Bot, ChevronLeft, ChevronRight, Copy, Plus, Sparkles, Trash2, Users, X } from 'lucide-react'
import { CandidateFields } from './subagent-profiles/CandidateFields'
import type {
  MaestroConfigPayload,
  MaestroConfigV1,
  MaestroResourceV1,
  MaestroStrategy,
  MaestroToStandardError,
  MaestroToStandardResult,
  SubagentProfileCandidate,
} from '../../../preload'
import { cloneMaestroConfig } from '../../../shared/maestro'
import { CHAT_SUBSCRIPTION_PROVIDER_KINDS, type ChatConfig } from '../../../shared/chat'
import { notifyMaestroConfigChanged, subscribeMaestroConfigChanged } from '@/lib/maestro-config-events'
import { cn } from '@/lib/utils'

type Translate = (key: string, options?: Record<string, unknown>) => string

const STRATEGIES: MaestroStrategy[] = ['balanced', 'best-quality', 'fast', 'economy']

type HealthLevel = 'healthy' | 'warning' | 'checking'

export function maestroConfigIdIssues(value: MaestroConfigV1, t: Translate): string[] {
  const issues: string[] = []
  const counts = new Map<string, number>()
  for (const resource of value.pool) {
    const id = resource.id.trim()
    if (!id) {
      if (!issues.includes(t('maestro.errors.emptyId'))) issues.push(t('maestro.errors.emptyId'))
      continue
    }
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  for (const [id, count] of counts) {
    if (count > 1) issues.push(t('maestro.errors.duplicateId', { id }))
  }
  return issues
}

export function createMaestroResource(index: number, t: Translate): MaestroResourceV1 {
  return {
    id: `agent-${Date.now().toString(36)}-${index}`,
    label: t('maestro.newResourceLabel'),
    enabled: true,
    description: t('maestro.newResourceDescription'),
    capability: 'worker',
    specialties: ['general'],
    candidates: [],
  }
}

/** Reads the live catalog/meta of every candidate so the Pool exposes the same health execution will see. */
function useCandidateHealth(
  candidates: SubagentProfileCandidate[],
  catalogRevision: number,
  t: Translate
): { level: HealthLevel; message: string } {
  const [state, setState] = useState<{ level: HealthLevel; message: string }>({
    level: 'checking',
    message: t('maestro.health.checking'),
  })
  const signature = JSON.stringify(candidates)

  useEffect(() => {
    let alive = true
    const list: SubagentProfileCandidate[] = JSON.parse(signature)
    if (list.length === 0) {
      setState({ level: 'healthy', message: t('maestro.health.inherited') })
      return
    }

    setState({ level: 'checking', message: t('maestro.health.checking') })
    void Promise.all(
      list.map(async (candidate) => {
        try {
          const [catalog, metadata] = await Promise.all([
            window.api.chatSubagentProfilesModelCatalog(candidate.providerId),
            window.api.chatSubagentProfilesModelMeta(candidate.providerId, candidate.modelId),
          ])
          if (catalog.status !== 'available') {
            return t('maestro.health.providerUnavailable', { provider: candidate.providerId })
          }
          if (!catalog.models.includes(candidate.modelId)) {
            return t('maestro.health.modelWarning', { model: candidate.modelId })
          }
          if (candidate.fastMode && metadata.status === 'available' && metadata.meta?.fastModeCapability !== true) {
            return t('maestro.health.fastUnsupported', { model: candidate.modelId })
          }
          return null
        } catch {
          return t('maestro.health.providerUnavailable', { provider: candidate.providerId })
        }
      })
    ).then((issues) => {
      if (!alive) return
      const visible = issues.filter((issue): issue is string => Boolean(issue))
      setState({
        level: visible.length ? 'warning' : 'healthy',
        message: visible.length ? visible.join(' · ') : t('maestro.health.healthy'),
      })
    })
    return () => {
      alive = false
    }
  }, [signature, catalogRevision, t])

  return state
}

function PoolRow({
  resource,
  catalogRevision,
  readOnly = false,
  onSelect,
  onToggle,
  onDuplicate,
  onRemove,
}: {
  resource: MaestroResourceV1
  catalogRevision: number
  readOnly?: boolean
  onSelect: () => void
  onToggle: (enabled: boolean) => void
  onDuplicate: () => void
  onRemove?: () => void
}) {
  const { t } = useTranslation('chat')
  const health = useCandidateHealth(resource.candidates, catalogRevision, t)
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-lg border border-white/[0.07] px-3 py-2.5 hover:bg-white/[0.03]',
        !resource.enabled && 'opacity-60'
      )}
    >
      <input
        type="checkbox"
        checked={resource.enabled}
        disabled={readOnly}
        aria-label={t('maestro.enableResource', { label: resource.label })}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <button
        type="button"
        onClick={onSelect}
        aria-label={t('maestro.selectResource', { label: resource.label })}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{resource.label}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {resource.specialties.join(' · ') || t('maestro.specialtiesFallback')}
          </span>
        </span>
        <span className="shrink-0 rounded bg-white/[0.05] px-2 py-1 text-xs text-muted-foreground">
          {t(`maestro.capabilities.${resource.capability}`)}
        </span>
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            health.level === 'checking'
              ? 'animate-pulse bg-muted-foreground'
              : health.level === 'warning'
                ? 'bg-amber-400'
                : 'bg-emerald-400'
          )}
          title={health.message}
        />
      </button>
      {!readOnly && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onDuplicate()
          }}
          title={t('maestro.duplicateResource')}
          aria-label={t('maestro.duplicateResource')}
          className="shrink-0 p-1 text-muted-foreground hover:text-foreground"
        >
          <Copy className="size-3.5" />
        </button>
      )}
      {!readOnly && onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
          title={t('maestro.removeResource')}
          aria-label={t('maestro.removeResource')}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function ResourceDetail({
  resource,
  config,
  catalogRevision,
  readOnly = false,
  onChange,
}: {
  resource: MaestroResourceV1
  config: ChatConfig
  catalogRevision: number
  readOnly?: boolean
  onChange: (resource: MaestroResourceV1) => void
}) {
  const { t } = useTranslation('chat')
  const health = useCandidateHealth(resource.candidates, catalogRevision, t)
  const updateCandidate = (index: number, candidate: SubagentProfileCandidate) => {
    const candidates = [...resource.candidates]
    candidates[index] = candidate
    onChange({ ...resource, candidates })
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-sm text-muted-foreground">
          {t('maestro.resourceName')}
          <input
            value={resource.label}
            disabled={readOnly}
            onChange={(event) => onChange({ ...resource, label: event.target.value })}
            className="mt-1.5 h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground"
          />
        </label>
        <label className="text-sm text-muted-foreground">
          {t('maestro.resourceId')}
          <input
            value={resource.id}
            disabled={readOnly}
            onChange={(event) => onChange({ ...resource, id: event.target.value })}
            className="mt-1.5 h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground"
          />
        </label>
      </div>
      <label className="block text-sm text-muted-foreground">
        {t('maestro.resourceDescription')}
        <input
          value={resource.description}
          disabled={readOnly}
          onChange={(event) => onChange({ ...resource, description: event.target.value })}
          className="mt-1.5 h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground"
        />
      </label>
      <label className="block text-sm text-muted-foreground">
        {t('maestro.resourceInstructions')}
        <textarea
          value={resource.instructions ?? ''}
          disabled={readOnly}
          placeholder={t('maestro.resourceInstructionsPlaceholder')}
          rows={3}
          onChange={(event) =>
            onChange({ ...resource, instructions: event.target.value.trim() ? event.target.value : undefined })
          }
          className="mt-1.5 w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-sm text-foreground"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-sm text-muted-foreground">
          {t('maestro.capability')}
          <OptionSelect
            value={resource.capability}
            disabled={readOnly}
            onValueChange={(selectedValue) =>
              onChange({ ...resource, capability: selectedValue as MaestroResourceV1['capability'] })
            }
            className="mt-1.5 h-9 text-xs"
          >
            <SelectOption value="worker">{t('maestro.capabilities.worker')}</SelectOption>
            <SelectOption value="read-only">{t('maestro.capabilities.read-only')}</SelectOption>
          </OptionSelect>
        </label>
        <label className="text-sm text-muted-foreground">
          {t('maestro.specialties')}
          <input
            value={resource.specialties.join(', ')}
            disabled={readOnly}
            placeholder={t('maestro.specialtiesPlaceholder')}
            onChange={(event) =>
              onChange({
                ...resource,
                specialties: event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
            className="mt-1.5 h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground"
          />
        </label>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">{t('maestro.candidates')}</span>
          {!readOnly && (
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...resource,
                  candidates: [...resource.candidates, { providerId: '', modelId: '', effort: '' }],
                })
              }
              className="inline-flex items-center gap-1 text-sm text-primary"
            >
              <Plus className="size-3" /> {t('maestro.addCandidate')}
            </button>
          )}
        </div>
        <p className={cn('text-xs', health.level === 'warning' ? 'text-amber-300' : 'text-muted-foreground')}>
          {health.message}
        </p>
        {resource.candidates.length === 0 && (
          <p className="rounded bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/80">
            {t('maestro.candidatesInherit')}
          </p>
        )}
        {resource.candidates.map((candidate, index) => (
          <div key={index} className="flex items-start gap-1">
            <CandidateFields
              key={`${candidate.providerId}\0${candidate.modelId}`}
              candidate={candidate}
              config={config}
              catalogRevision={catalogRevision}
              readOnly={readOnly}
              density="comfortable"
              allowOff
              onChange={(value) => updateCandidate(index, value)}
            />
            {!readOnly && (
              <button
                type="button"
                title={t('maestro.removeCandidate')}
                aria-label={t('maestro.removeCandidate')}
                onClick={() =>
                  onChange({
                    ...resource,
                    candidates: resource.candidates.filter((_, candidateIndex) => candidateIndex !== index),
                  })
                }
                className="rounded p-1 text-red-300/80 hover:bg-red-500/10"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Controlled, scope-neutral Maestro config editor shared by conversation UI and global Settings. */
export function MaestroConfigEditor({
  value,
  onChange,
  config,
  catalogRevision,
  onImportAgents,
  orchestratorSlot,
  readOnly = false,
  savedRevision = 0,
  className,
}: {
  value: MaestroConfigV1
  onChange: (value: MaestroConfigV1) => void
  config: ChatConfig
  catalogRevision: number
  onImportAgents?: () => void

  orchestratorSlot?: ReactNode
  readOnly?: boolean

  savedRevision?: number
  className?: string
}) {
  const { t } = useTranslation('chat')

  const [editingTarget, setEditingTarget] = useState<'orchestrator' | number | null>(null)
  const editingResource = typeof editingTarget === 'number' ? value.pool[editingTarget] : undefined

  const editing =
    typeof editingTarget === 'number' && editingResource
      ? { kind: 'resource' as const, index: editingTarget, resource: editingResource }
      : editingTarget === 'orchestrator'
        ? { kind: 'orchestrator' as const }
        : null

  useEffect(() => {
    if (savedRevision) setEditingTarget(null)
  }, [savedRevision])

  const updateResource = (index: number, resource: MaestroResourceV1) => {
    const pool = [...value.pool]
    pool[index] = resource
    onChange({ ...value, pool })
  }

  const removeResource = (index: number) => {
    if (value.pool.length <= 1) return
    const resource = value.pool[index]
    if (!resource || !window.confirm(t('maestro.confirmRemoveResource', { label: resource.label }))) return
    onChange({ ...value, pool: value.pool.filter((_, resourceIndex) => resourceIndex !== index) })
    setEditingTarget(null)
  }

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden', className)}>
      {editing ? (
        <>
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <button
              type="button"
              onClick={() => setEditingTarget(null)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
            >
              <ChevronLeft className="size-4" /> {t('maestro.backToPool')}
            </button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {editing.kind === 'orchestrator' ? t('maestro.orchestratorProfile') : editing.resource.label}
            </span>
            <button
              type="button"
              onClick={() => setEditingTarget(null)}
              title={t('maestro.close')}
              aria-label={t('maestro.close')}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {editing.kind === 'orchestrator' ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-medium text-foreground">{t('maestro.orchestratorProfile')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('maestro.orchestratorHint')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-white/[0.02] p-3">
                  {orchestratorSlot ?? (
                    <p className="text-sm text-muted-foreground">{t('maestro.orchestratorInherited')}</p>
                  )}
                </div>
              </div>
            ) : (
              <ResourceDetail
                key={`${editing.index}-${editing.resource.id}`}
                resource={editing.resource}
                config={config}
                catalogRevision={catalogRevision}
                readOnly={readOnly}
                onChange={(resource) => updateResource(editing.index, resource)}
              />
            )}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <section>
            <p className="mb-2 text-sm font-medium text-foreground">{t('maestro.strategy')}</p>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
              {STRATEGIES.map((strategy) => (
                <button
                  key={strategy}
                  type="button"
                  disabled={readOnly}
                  onClick={() => onChange({ ...value, strategy })}
                  aria-pressed={value.strategy === strategy}
                  className={cn(
                    'rounded-md border px-2 py-2 text-sm',
                    value.strategy === strategy
                      ? 'border-primary/60 bg-primary/10 text-foreground'
                      : 'border-white/[0.07] text-muted-foreground hover:bg-white/[0.04]'
                  )}
                >
                  {t(`maestro.strategies.${strategy}`)}
                </button>
              ))}
            </div>
          </section>

          <section>
            <p className="mb-1.5 text-sm font-medium text-foreground">{t('maestro.principalAgent')}</p>
            <button
              type="button"
              onClick={() => setEditingTarget('orchestrator')}
              className="flex w-full items-center gap-2.5 rounded-lg border border-amber-400/20 bg-amber-400/[0.04] px-3 py-2.5 text-left hover:bg-amber-400/[0.08]"
            >
              <Sparkles className="size-4 shrink-0 text-amber-300" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{t('maestro.orchestratorProfile')}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t('maestro.orchestratorHint')}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </section>

          <section className="flex min-h-0 flex-col">
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">{t('maestro.pool')}</p>
              <div className="flex gap-2">
                {!readOnly && onImportAgents && (
                  <button
                    type="button"
                    onClick={onImportAgents}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t('maestro.importAgents')}
                  </button>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => {
                      onChange({ ...value, pool: [...value.pool, createMaestroResource(value.pool.length, t)] })
                      setEditingTarget(value.pool.length)
                    }}
                    className="inline-flex items-center gap-1 text-xs text-primary"
                  >
                    <Plus className="size-3" /> {t('maestro.newResource')}
                  </button>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              {value.pool.map((resource, index) => (
                <PoolRow
                  key={`${resource.id}-${index}`}
                  resource={resource}
                  catalogRevision={catalogRevision}
                  readOnly={readOnly}
                  onSelect={() => setEditingTarget(index)}
                  onToggle={(enabled) => updateResource(index, { ...resource, enabled })}
                  onDuplicate={() =>
                    onChange({
                      ...value,
                      pool: [
                        ...value.pool.slice(0, index + 1),
                        {
                          ...resource,
                          id: `${resource.id}-${t('maestro.copySuffix')}`,
                          label: `${resource.label} ${t('maestro.copySuffix')}`,
                          specialties: [...resource.specialties],
                          candidates: resource.candidates.map((candidate) => ({ ...candidate })),
                        },
                        ...value.pool.slice(index + 1),
                      ],
                    })
                  }
                  onRemove={value.pool.length > 1 ? () => removeResource(index) : undefined}
                />
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export function MaestroControl({
  conversationId,
  panelHostId,
  orchestratorSlot,
  onChanged,
  onConvertToStandard,
  convertToStandardDisabled = false,
  directModelId,
}: {
  conversationId: string
  panelHostId: string
  orchestratorSlot?: ReactNode
  onChanged?: () => void
  onConvertToStandard?: () => Promise<MaestroToStandardResult>
  convertToStandardDisabled?: boolean
  directModelId?: string | null
}) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const [payload, setPayload] = useState<MaestroConfigPayload | null>(null)
  const [draft, setDraft] = useState<MaestroConfigV1 | null>(null)
  const [config, setConfig] = useState<ChatConfig | null>(null)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  const [savedRevision, setSavedRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const reload = useCallback(async () => {
    const next = await window.api.chatMaestroGetConversation(conversationId)
    setPayload(next)
    setDraft(cloneMaestroConfig(next.config))
    return next
  }, [conversationId])

  useEffect(() => {
    void reload()
  }, [reload])
  useEffect(
    () =>
      subscribeMaestroConfigChanged(() => {
        // External global saves refresh the chip while closed, but never overwrite an open local draft.
        if (!open) void reload()
      }),
    [reload, open]
  )
  useEffect(() => {
    let alive = true
    void window.api.chatConfig().then((next) => alive && setConfig(next))
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    const unsubscribes = CHAT_SUBSCRIPTION_PROVIDER_KINDS.map((provider) =>
      window.api.onChatSubscriptionStatus(provider, () => setCatalogRevision((revision) => revision + 1))
    )
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [])

  const enabledCount = useMemo(() => draft?.pool.filter((resource) => resource.enabled).length ?? 0, [draft])
  const dirty = useMemo(
    () => (draft && payload ? JSON.stringify(draft) !== JSON.stringify(payload.config) : false),
    [draft, payload]
  )
  const idIssues = useMemo(() => {
    return draft ? maestroConfigIdIssues(draft, t) : []
  }, [draft, t])

  const discard = () => {
    if (payload) setDraft(cloneMaestroConfig(payload.config))
    setError(null)
  }

  const requestClose = () => {
    if (dirty && !window.confirm(t('maestro.confirmDiscard'))) return
    discard()
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const save = async (target: 'conversation' | 'global') => {
    if (!draft) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const result =
        target === 'global'
          ? await window.api.chatMaestroSetGlobal(draft)
          : await window.api.chatMaestroSetConversation(conversationId, draft)
      if (!result.ok) {
        throw new Error(result.errors?.map((item) => item.message).join(' ') || t('maestro.errors.invalidConfig'))
      }
      await reload()
      setSaved(true)
      setSavedRevision((revision) => revision + 1)
      setTimeout(() => setSaved(false), 1500)
      notifyMaestroConfigChanged()
      onChanged?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const clearOverride = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.chatMaestroSetConversation(conversationId, null)
      if (!result.ok) {
        setError(result.errors?.map((item) => item.message).join(' ') || t('maestro.errors.clearOverride'))
        return
      }
      await reload()
      notifyMaestroConfigChanged()
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  const convertError = (code: MaestroToStandardError): string => {
    const keys: Record<MaestroToStandardError, string> = {
      'invalid-conversation': 'maestro.convertErrors.invalidConversation',
      'not-maestro': 'maestro.convertErrors.notMaestro',
      'conversation-busy': 'maestro.convertErrors.busy',
      'conversation-reserved': 'maestro.convertErrors.reserved',
      'conversation-migrating': 'maestro.convertErrors.migrating',
    }
    return t(keys[code])
  }

  const convertToStandard = async () => {
    if (!onConvertToStandard) return
    const model = directModelId || t('maestro.selectedModel')
    const confirmation = dirty ? 'maestro.confirmDirectModelUnsaved' : 'maestro.confirmDirectModel'
    if (!window.confirm(t(confirmation, { model }))) return
    setBusy(true)
    setError(null)
    try {
      const result = await onConvertToStandard()
      if (!result.ok) {
        setError(convertError(result.error))
        return
      }
      setOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const importAgents = async () => {
    if (!draft) return
    const catalog = await window.api.chatSubagentProfilesCatalog(conversationId)
    const ids = new Set(draft.pool.map((resource) => resource.id))
    const imported = catalog.agents
      .filter((agent) => !ids.has(agent.name))
      .map(
        (agent, index): MaestroResourceV1 => ({
          ...createMaestroResource(draft.pool.length + index, t),
          id: agent.name,
          label: agent.name,
          description: agent.description,
          agentName: agent.name,
          capability: agent.name === 'explore' ? 'read-only' : 'worker',
          specialties: [agent.category ?? 'general'],
        })
      )
    setDraft({ ...draft, pool: [...draft.pool, ...imported] })
  }

  const panelHost = open ? document.getElementById(panelHostId) : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-400/20 bg-amber-400/[0.06] px-2 text-[11px] font-medium text-amber-100 hover:bg-amber-400/[0.1]"
        aria-label={t('maestro.openControls')}
      >
        <Sparkles className="size-3.5 text-amber-300" />
        {t('maestro.chip', {
          strategy: t(`maestro.strategies.${draft?.strategy ?? 'balanced'}`),
          count: enabledCount,
        })}
      </button>
      {open &&
        draft &&
        payload &&
        config &&
        panelHost &&
        createPortal(
          <div
            data-maestro-panel
            role="region"
            aria-label={t('maestro.title')}
            tabIndex={-1}
            className="absolute inset-0 z-30 flex min-h-0 flex-col overflow-hidden bg-[#0d0d10]"
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              if (event.currentTarget.querySelector('[data-search-select] [aria-expanded="true"]')) return
              requestClose()
            }}
          >
            <div className="flex items-center gap-3 border-b border-white/[0.08] px-5 py-4">
              <Sparkles className="size-5 text-amber-300" />
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-foreground">{t('maestro.title')}</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {payload.hasConversationOverride ? t('maestro.sourceConversation') : t('maestro.sourceGlobal')} ·{' '}
                  {t('maestro.frozenHint')}
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.05] px-2.5 py-1.5 text-xs text-muted-foreground">
                <Users className="size-3.5" /> {t('maestro.enabledAgents', { count: enabledCount })}
              </span>
              <button
                type="button"
                onClick={requestClose}
                title={t('maestro.close')}
                aria-label={t('maestro.close')}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <MaestroConfigEditor
              value={draft}
              onChange={setDraft}
              config={config}
              catalogRevision={catalogRevision}
              onImportAgents={() => void importAgents()}
              orchestratorSlot={orchestratorSlot}
              savedRevision={savedRevision}
              className="min-h-0 flex-1"
            />

            {(payload.diagnostics.length > 0 || idIssues.length > 0 || error) && (
              <div className="space-y-1 border-t border-white/[0.08] px-4 py-2">
                {payload.diagnostics.length > 0 && (
                  <p className="rounded border border-amber-500/20 bg-amber-500/[0.06] p-2 text-xs text-amber-200">
                    {payload.diagnostics.map((item) => item.message).join(' ')}
                  </p>
                )}
                {idIssues.map((issue) => (
                  <p
                    key={issue}
                    className="rounded border border-red-500/20 bg-red-500/[0.08] p-2 text-xs text-red-300"
                  >
                    {issue}
                  </p>
                ))}
                {error && (
                  <p
                    role="alert"
                    className="rounded border border-red-500/20 bg-red-500/[0.08] p-2 text-xs text-red-300"
                  >
                    {error}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.08] px-4 py-2.5">
              {onConvertToStandard && (
                <button
                  type="button"
                  disabled={busy || convertToStandardDisabled}
                  onClick={() => void convertToStandard()}
                  title={convertToStandardDisabled ? t('maestro.directModelBusyHint') : t('maestro.directModelHint')}
                  className="inline-flex items-center gap-1.5 rounded-md border border-indigo-400/20 bg-indigo-400/[0.06] px-2.5 py-1.5 text-sm text-indigo-200 hover:bg-indigo-400/[0.1] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Bot className="size-3.5" />
                  {t('maestro.useDirectModel')}
                </button>
              )}
              {payload.hasConversationOverride && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void clearOverride()}
                  className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  {t('maestro.useGlobal')}
                </button>
              )}
              {dirty && (
                <>
                  <span className="text-sm text-amber-300">{t('maestro.unsaved')}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={discard}
                    className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    {t('maestro.discard')}
                  </button>
                </>
              )}
              {saved && !dirty && <span className="text-sm text-emerald-300">{t('maestro.saved')}</span>}
              <span className="flex-1" />
              <button
                type="button"
                disabled={busy || idIssues.length > 0}
                onClick={() => void save('global')}
                className="rounded-md border border-white/[0.1] px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                {t('maestro.saveGlobal')}
              </button>
              <button
                type="button"
                disabled={busy || idIssues.length > 0}
                onClick={() => void save('conversation')}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
              >
                {t('maestro.saveConversation')}
              </button>
            </div>
          </div>,
          panelHost
        )}
    </>
  )
}
