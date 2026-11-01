import { useChatOwnerWindow } from '@/lib/chat-window-context'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import {
  CHAT_SUBSCRIPTION_PROVIDER_KINDS,
  DEFAULT_REASONING_EFFORTS,
  type ChatConfig,
  type ChatModelMeta,
  type ChatModelRef,
  type ChatReasoningEffort,
} from '../../../shared/chat'
import type {
  MaestroConfigPayload,
  MaestroConfigV1,
  MaestroOrchestratorProfileV1,
  MaestroResourceV1,
  MaestroStrategy,
  MaestroStrategyProfileCatalog,
  MaestroStrategyProfileCatalogItem,
} from '../../../shared/maestro'
import { GLOBAL_MAESTRO_STRATEGY_PROFILE_ID, cloneMaestroConfig } from '../../../shared/maestro'
import {
  MAESTRO_PROPOSAL_STRATEGY_UNIT,
  applyMaestroProposalUnits,
  hashMaestroConfig,
  maestroProposalUnits,
  prepareMaestroConfiguratorDraft,
  type MaestroConfiguratorProposal,
  type MaestroConfiguratorThreadEvent,
  type MaestroProposalUnit,
  type MaestroSettingsDraftSession,
} from '../../../shared/maestro-configurator'
import { useHostApi } from '@/lib/hosts/host-context'
import { notifyMaestroConfigChanged } from '@/lib/maestro-config-events'
import { cn } from '@/lib/utils'
import { createMaestroResource, maestroConfigIdIssues } from './MaestroControl'
import { MaestroPoolEditor } from './MaestroPoolEditor'
import { MaestroConfigurator } from './MaestroConfigurator'
import { ChatModelChip } from './ChatModelChip'
import { ChatReasoningPicker } from './ChatReasoningPicker'
import { FastModeChip } from './ChatFastModeToggle'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  maestroStrategyProfileLabel,
  maestroStrategyProfileSummary,
  mergeMaestroOrchestratorModelMeta,
} from '@/lib/maestro-strategy-profiles'

const STRATEGIES: MaestroStrategy[] = ['balanced', 'best-quality', 'fast', 'economy']

const ASSISTANT_OPEN_KEY = 'chat.maestroSettings.assistantOpen'
const ASSISTANT_WIDTH_KEY = 'chat.maestroSettings.assistantWidth'
const ASSISTANT_MIN_WIDTH = 320
const ASSISTANT_DEFAULT_WIDTH = 400
const ASSISTANT_MAX_WIDTH = 720
/** The Pool keeps at least this much beside the assistant; below it the assistant opens over the Pool. */
const POOL_MIN_WIDTH = 440

function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}
function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {}
}

/** A kept session is restored only when it holds work its saved strategy does not; otherwise the saved one wins. */
function hasUnsavedSessionWork(session: MaestroSettingsDraftSession, item: MaestroStrategyProfileCatalogItem): boolean {
  if (item.source === 'builtin') return false
  if (hashMaestroConfig(session.draft) !== session.savedHash) return true
  return (
    item.source === 'custom' &&
    (session.profileName !== item.name || JSON.stringify(session.orchestrator) !== JSON.stringify(item.orchestrator))
  )
}

interface ReviewState {
  proposal: MaestroConfiguratorProposal
  /** The prepared draft the proposal was made from. */
  base: MaestroConfigV1
  units: MaestroProposalUnit[]
  selected: Set<string>
}

/** The Global default's orchestrator is the Maestrly Chat default and saves at once; a custom one saves with it. */
function OrchestratorProfileEditor({
  value,
  persistGlobal,
  disabled = false,
  onChange,
}: {
  value: MaestroOrchestratorProfileV1 | null
  persistGlobal: boolean
  disabled?: boolean
  onChange(value: MaestroOrchestratorProfileV1): void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [meta, setMeta] = useState<ChatModelMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selection: ChatModelRef | null = value ? { providerId: value.providerId, modelId: value.modelId } : null

  useEffect(() => {
    let alive = true
    setMeta(null)
    if (!selection) return
    void Promise.all([
      api.chatModelMeta(selection.modelId, selection.providerId).catch(() => null),
      api.chatSubagentProfilesModelMeta(selection.providerId, selection.modelId).catch(() => ({
        status: 'unavailable' as const,
        meta: null,
      })),
    ])
      .then(([chatMeta, executionMeta]) => {
        if (!alive) return
        setMeta(mergeMaestroOrchestratorModelMeta(chatMeta, executionMeta))
      })
      .catch(() => alive && setMeta(null))
    return () => {
      alive = false
    }
  }, [selection?.modelId, selection?.providerId, api])

  const efforts = meta?.reasoningEfforts?.length ? meta.reasoningEfforts : [...DEFAULT_REASONING_EFFORTS]
  const hint = persistGlobal ? t('maestro.orchestratorInherited') : t('maestro.strategyProfiles.orchestratorSaved')

  const commit = async (next: MaestroOrchestratorProfileV1) => {
    if (persistGlobal) {
      const result = await api.chatSetDefault(next)
      if (!result.ok) {
        setError(t('maestro.errors.orchestratorProfile'))
        return false
      }
    }
    setError(null)
    onChange(next)
    return true
  }

  return (
    // A disabled fieldset disables every chip trigger inside it, so nothing changes while a proposal is reviewed.
    <fieldset
      disabled={disabled}
      aria-label={t('maestro.orchestratorProfile')}
      aria-describedby="maestro-orchestrator-hint"
      className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 disabled:opacity-60"
    >
      <span className="text-xs text-muted-foreground" title={hint}>
        {t('maestro.orchestrator')}
      </span>
      <span id="maestro-orchestrator-hint" className="sr-only">
        {hint}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {value && selection && meta?.reasoning && (
          <ChatReasoningPicker
            value={value.reasoning as ChatReasoningEffort}
            efforts={efforts}
            allowUltra={false}
            avoidOverflow
            onChange={(nextReasoning) => {
              void commit({ ...value, reasoning: nextReasoning })
            }}
          />
        )}
        <ChatModelChip
          value={selection}
          avoidOverflow
          onSelect={(nextSelection) => {
            void commit({ ...nextSelection, reasoning: 'off', fastMode: false })
          }}
        />
        {value && meta?.fastModeCapability === true && (
          <FastModeChip
            enabled={value.fastMode}
            onToggle={() => void commit({ ...value, fastMode: !value.fastMode })}
          />
        )}
      </span>
      {error && (
        <p role="alert" className="basis-full text-xs text-red-300">
          {error}
        </p>
      )}
    </fieldset>
  )
}

function AssistantSplitter({
  width,
  min,
  max,
  onChange,
}: {
  width: number
  min: number
  max: number
  onChange(width: number): void
}) {
  const { t } = useTranslation('chat')
  const [dragging, setDragging] = useState(false)
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)))
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = width
    setDragging(true)
    const move = (moveEvent: PointerEvent) => onChange(clamp(startWidth - (moveEvent.clientX - startX)))
    const end = () => {
      setDragging(false)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('maestro.configurator.resize')}
      aria-controls="maestro-configurator-panel"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title={t('maestro.configurator.resizeHint')}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(clamp(ASSISTANT_DEFAULT_WIDTH))}
      onKeyDown={(event) => {
        const next = { ArrowLeft: width + 24, ArrowRight: width - 24, Home: max, End: min }[event.key]
        if (next === undefined) return
        event.preventDefault()
        onChange(clamp(next))
      }}
      className="group relative z-[1] -mx-1 w-2 shrink-0 cursor-col-resize touch-none outline-none"
    >
      <span
        className={cn(
          'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-white/20 group-focus-visible:bg-white/30',
          dragging && 'bg-white/30'
        )}
      />
      <span
        className={cn(
          'absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/70 opacity-0 transition-opacity group-hover:opacity-90 group-focus-visible:opacity-90',
          dragging && 'opacity-90'
        )}
      />
    </div>
  )
}

export function MaestroSettings({ config }: { config: ChatConfig }) {
  const ownerWindow = useChatOwnerWindow()
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [payload, setPayload] = useState<MaestroConfigPayload | null>(null)
  const [draft, setDraft] = useState<MaestroConfigV1 | null>(null)
  const [profileCatalog, setProfileCatalog] = useState<MaestroStrategyProfileCatalog | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState<string>(GLOBAL_MAESTRO_STRATEGY_PROFILE_ID)
  const [profileName, setProfileName] = useState('')
  const [orchestratorDraft, setOrchestratorDraft] = useState<MaestroOrchestratorProfileV1 | null>(null)
  const [catalogRevision, setCatalogRevision] = useState(0)

  const [assistantOpen, setAssistantOpen] = useState(() => readStored(ASSISTANT_OPEN_KEY) === 'true')
  const [assistantWidth, setAssistantWidth] = useState(() => {
    const stored = Number(readStored(ASSISTANT_WIDTH_KEY))
    return Number.isFinite(stored) && stored >= ASSISTANT_MIN_WIDTH ? stored : ASSISTANT_DEFAULT_WIDTH
  })
  // Over the Pool, the assistant steps aside while a proposal is reviewed so the whole Pool shows.
  const [assistantHidden, setAssistantHidden] = useState(false)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const [workspaceWidth, setWorkspaceWidth] = useState(0)
  const [reviewBarHeight, setReviewBarHeight] = useState(0)

  const [review, setReview] = useState<ReviewState | null>(null)
  const [nameDialog, setNameDialog] = useState<{
    mode: 'create' | 'rename'
    value: string
    error: string | null
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  // The working state is mirrored to the host only after the first load, so the empty initial state never
  // overwrites unsaved work kept from a previous visit.
  const [hydrated, setHydrated] = useState(false)

  const [savedRevision, setSavedRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const recordEvent = (event: MaestroConfiguratorThreadEvent) => {
    void api.chatMaestroConfiguratorRecordEvent(event).catch(() => undefined)
  }

  const loadProfile = (selected: MaestroStrategyProfileCatalogItem) => {
    setSelectedProfileId(selected.id)
    setDraft(cloneMaestroConfig(selected.config))
    setOrchestratorDraft(selected.orchestrator ? { ...selected.orchestrator } : null)
    setProfileName(selected.source === 'custom' ? selected.name : '')
    setError(null)
  }

  const refresh = async () => {
    const [next, strategies, session] = await Promise.all([
      api.chatMaestroGetGlobal(),
      api.chatMaestroStrategyProfilesList(),
      api.chatMaestroSettingsDraftGet().catch(() => null),
    ])
    setPayload(next)
    setProfileCatalog(strategies)
    // Built-in strategies are the Global default with another strategy: here the strategy is a field of the draft.
    const editable = strategies.items.filter((item) => item.source !== 'builtin')
    const kept = session ? editable.find((item) => item.id === session.profileId) : undefined
    const selected = kept ?? editable.find((item) => item.id === selectedProfileId) ?? editable[0]
    if (session && kept && hasUnsavedSessionWork(session, kept)) {
      setSelectedProfileId(kept.id)
      setDraft(cloneMaestroConfig(session.draft))
      setOrchestratorDraft(session.orchestrator ? { ...session.orchestrator } : null)
      setProfileName(session.profileName)
    } else if (selected) {
      loadProfile(selected)
    } else {
      setDraft(cloneMaestroConfig(next.config))
    }
    setHydrated(true)
  }

  useEffect(() => {
    void refresh()
  }, [])
  useEffect(() => {
    const unsubscribes = CHAT_SUBSCRIPTION_PROVIDER_KINDS.map((provider) =>
      api.onChatSubscriptionStatus(provider, () => setCatalogRevision((revision) => revision + 1))
    )
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [api])

  useLayoutEffect(() => {
    const element = workspaceRef.current
    if (!element) return
    setWorkspaceWidth(element.clientWidth)
    const observer = new ResizeObserver(() => setWorkspaceWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [payload, draft === null])

  useEffect(() => writeStored(ASSISTANT_OPEN_KEY, String(assistantOpen)), [assistantOpen])
  useEffect(() => writeStored(ASSISTANT_WIDTH_KEY, String(assistantWidth)), [assistantWidth])

  const overlay = workspaceWidth > 0 && workspaceWidth < ASSISTANT_MIN_WIDTH + POOL_MIN_WIDTH
  const maxAssistantWidth = Math.max(
    ASSISTANT_MIN_WIDTH,
    Math.min(ASSISTANT_MAX_WIDTH, workspaceWidth - POOL_MIN_WIDTH)
  )
  const shownAssistantWidth = Math.min(maxAssistantWidth, Math.max(ASSISTANT_MIN_WIDTH, assistantWidth))
  const assistantVisible = assistantOpen && !(overlay && assistantHidden)

  useLayoutEffect(() => {
    const bar = workspaceRef.current?.querySelector<HTMLElement>('[data-maestro-review-bar]')
    if (!bar) {
      setReviewBarHeight(0)
      return
    }
    setReviewBarHeight(bar.offsetHeight)
    const observer = new ResizeObserver(() => setReviewBarHeight(bar.offsetHeight))
    observer.observe(bar)
    return () => observer.disconnect()
  }, [review !== null])

  const editableProfiles = useMemo(
    () => profileCatalog?.items.filter((item) => item.source !== 'builtin') ?? [],
    [profileCatalog?.items]
  )
  const selectedProfile = editableProfiles.find((item) => item.id === selectedProfileId) ?? null
  const savedHash = useMemo(() => (selectedProfile ? hashMaestroConfig(selectedProfile.config) : ''), [selectedProfile])
  const scopeLabel = selectedProfile ? maestroStrategyProfileLabel(selectedProfile, t) : ''

  useEffect(() => {
    if (!hydrated || !draft || !selectedProfile) return
    void api
      .chatMaestroSettingsDraftSet({
        profileId: selectedProfile.id,
        profileName,
        draft,
        orchestrator: orchestratorDraft,
        savedHash,
      })
      .catch(() => undefined)
  }, [api, hydrated, draft, selectedProfile, profileName, orchestratorDraft, savedHash])

  const savedConfig = selectedProfile?.source === 'global' ? payload?.config : selectedProfile?.config
  const dirty = useMemo(() => {
    if (!draft || !savedConfig || !selectedProfile) return false
    if (JSON.stringify(draft) !== JSON.stringify(savedConfig)) return true
    return (
      selectedProfile.source === 'custom' &&
      (profileName.trim() !== selectedProfile.name ||
        JSON.stringify(orchestratorDraft) !== JSON.stringify(selectedProfile.orchestrator))
    )
  }, [draft, orchestratorDraft, profileName, savedConfig, selectedProfile])
  const changeCount = useMemo(() => {
    if (!dirty || !draft || !savedConfig || !selectedProfile) return 0
    const prepared = prepareMaestroConfiguratorDraft(draft)
    const poolChanges = prepared.ok ? maestroProposalUnits(savedConfig, prepared.value.config).length : 0
    if (selectedProfile.source !== 'custom') return poolChanges
    return (
      poolChanges +
      (profileName.trim() !== selectedProfile.name ? 1 : 0) +
      (JSON.stringify(orchestratorDraft) !== JSON.stringify(selectedProfile.orchestrator) ? 1 : 0)
    )
  }, [dirty, draft, orchestratorDraft, profileName, savedConfig, selectedProfile])
  const idIssues = useMemo(() => (draft ? maestroConfigIdIssues(draft, t) : []), [draft, t])

  const importAgents = async () => {
    if (!draft) return
    const catalog = await api.chatSubagentProfilesCatalog()
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

  const selectProfile = (id: string) => {
    const selected = editableProfiles.find((item) => item.id === id)
    if (!selected || id === selectedProfileId) return
    if (dirty && !ownerWindow.confirm(t('maestro.confirmDiscard'))) return
    loadProfile(selected)
    recordEvent({
      kind: 'profile-selected',
      profileId: selected.id,
      profileName: maestroStrategyProfileLabel(selected, t),
      source: selected.source,
    })
  }

  const discardChanges = () => {
    if (!selectedProfile || !ownerWindow.confirm(t('maestro.confirmDiscard'))) return
    loadProfile(selectedProfile)
    recordEvent({ kind: 'draft-discarded', profileName: maestroStrategyProfileLabel(selectedProfile, t) })
  }

  /** The proposal opens over the Pool; nothing changes until the user applies the parts they keep. */
  const startReview = (proposal: MaestroConfiguratorProposal) => {
    if (!draft || review) return
    const prepared = prepareMaestroConfiguratorDraft(draft)
    if (!prepared.ok || prepared.value.baseHash !== proposal.baseHash) return
    const units = maestroProposalUnits(prepared.value.config, proposal.config)
    setReview({
      proposal,
      base: prepared.value.config,
      units,
      selected: new Set(units.map((unit) => unit.key)),
    })
    setAssistantHidden(true)
  }

  const endReview = () => {
    setReview(null)
    setAssistantHidden(false)
  }

  const applyReview = () => {
    if (!review || !draft) return
    setDraft(
      applyMaestroProposalUnits({
        draft,
        base: review.base,
        proposed: review.proposal.config,
        selected: review.selected,
      })
    )
    const skipped = review.units.filter((unit) => !review.selected.has(unit.key)).map((unit) => unit.key)
    recordEvent({ kind: 'proposal-applied', proposalId: review.proposal.id, ...(skipped.length ? { skipped } : {}) })
    endReview()
  }

  const dismissReview = () => {
    if (!review) return
    recordEvent({ kind: 'proposal-dismissed', proposalId: review.proposal.id })
    endReview()
  }

  const toggleUnit = (key: string, included: boolean) =>
    setReview((current) => {
      if (!current) return current
      const selected = new Set(current.selected)
      if (included) selected.add(key)
      else selected.delete(key)
      return { ...current, selected }
    })

  const markSaved = () => {
    setSaved(true)
    setSavedRevision((revision) => revision + 1)
    setTimeout(() => setSaved(false), 1500)
  }

  const saveGlobal = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const result = await api.chatMaestroSetGlobal(draft)
      if (!result.ok || !result.value) {
        throw new Error(result.errors?.map((item) => item.message).join(' ') || t('maestro.errors.invalidConfig'))
      }
      setPayload(result.value)
      setDraft(cloneMaestroConfig(result.value.config))
      markSaved()
      notifyMaestroConfigChanged()
      recordEvent({ kind: 'saved', target: 'global', profileName: t('maestro.strategyProfiles.global') })
      const strategies = await api.chatMaestroStrategyProfilesList()
      setProfileCatalog(strategies)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const createProfile = async (name: string): Promise<string | null> => {
    if (!draft || !orchestratorDraft) return t('maestro.strategyProfiles.needsOrchestrator')
    setBusy(true)
    setError(null)
    try {
      const result = await api.chatMaestroStrategyProfilesCreate({
        name,
        config: draft,
        orchestrator: orchestratorDraft,
      })
      if (!result.ok) return profileError(result.error)
      setProfileCatalog(result.catalog)
      setSelectedProfileId(result.profile.id)
      setProfileName(result.profile.name)
      setDraft(cloneMaestroConfig(result.profile.config))
      setOrchestratorDraft({ ...result.profile.orchestrator })
      markSaved()
      recordEvent({ kind: 'saved', target: 'new-custom', profileName: result.profile.name })
      return null
    } catch (reason) {
      return reason instanceof Error ? reason.message : String(reason)
    } finally {
      setBusy(false)
    }
  }

  const profileError = (code: string) =>
    code === 'maestro-strategy-profile-name-duplicate'
      ? t('maestro.strategyProfiles.nameDuplicate')
      : code === 'maestro-strategy-profile-name-required'
        ? t('maestro.strategyProfiles.nameRequired')
        : code

  const updateProfile = async () => {
    if (!draft || !orchestratorDraft || selectedProfile?.source !== 'custom') return
    setBusy(true)
    setError(null)
    try {
      const result = await api.chatMaestroStrategyProfilesUpdate(selectedProfile.id, {
        name: profileName,
        config: draft,
        orchestrator: orchestratorDraft,
      })
      if (!result.ok) throw new Error(profileError(result.error))
      setProfileCatalog(result.catalog)
      setProfileName(result.profile.name)
      setDraft(cloneMaestroConfig(result.profile.config))
      setOrchestratorDraft({ ...result.profile.orchestrator })
      markSaved()
      recordEvent({ kind: 'saved', target: 'custom', profileName: result.profile.name })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const deleteProfile = async () => {
    if (selectedProfile?.source !== 'custom') return
    if (!ownerWindow.confirm(t('maestro.strategyProfiles.confirmDelete', { name: selectedProfile.name }))) return
    setBusy(true)
    try {
      const result = await api.chatMaestroStrategyProfilesDelete(selectedProfile.id)
      if (!result.ok) throw new Error('maestro-strategy-profile-not-found')
      setProfileCatalog(result.catalog)
      const global = result.catalog.items.find((item) => item.id === GLOBAL_MAESTRO_STRATEGY_PROFILE_ID)
      if (global) loadProfile(global)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const submitName = async () => {
    if (!nameDialog) return
    const name = nameDialog.value.trim().replace(/\s+/g, ' ')
    if (!name) return setNameDialog({ ...nameDialog, error: t('maestro.strategyProfiles.nameRequired') })
    const taken = editableProfiles.some(
      (item) =>
        item.source === 'custom' &&
        item.id !== (nameDialog.mode === 'rename' ? selectedProfileId : '') &&
        item.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
    )
    if (taken) return setNameDialog({ ...nameDialog, error: t('maestro.strategyProfiles.nameDuplicate') })
    if (nameDialog.mode === 'rename') {
      setProfileName(name)
      setNameDialog(null)
      return
    }
    const failure = await createProfile(name)
    if (failure) setNameDialog((current) => (current ? { ...current, error: failure } : current))
    else setNameDialog(null)
  }

  const changeOrchestrator = (next: MaestroOrchestratorProfileV1) => {
    setOrchestratorDraft(next)
    if (selectedProfile?.source !== 'global') return
    setProfileCatalog((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) =>
              item.source === 'global' || item.source === 'builtin' ? { ...item, orchestrator: { ...next } } : item
            ),
          }
        : current
    )
  }

  if (!payload || !draft) {
    return <p className="text-sm text-muted-foreground">{t('settings.loading')}</p>
  }

  const reviewing = review !== null
  const proposedStrategy = review?.units.some((unit) => unit.key === MAESTRO_PROPOSAL_STRATEGY_UNIT)
    ? review.proposal.config.strategy
    : null
  const canSaveAs = !busy && !reviewing && !!orchestratorDraft && idIssues.length === 0

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-[14rem] flex-1">
          <h3 className="text-sm font-medium text-foreground">{t('maestro.title')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('maestro.settingsDescription')}</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={busy || reviewing}>
              <button
                type="button"
                className="inline-flex h-8 max-w-[18rem] items-center gap-1.5 rounded-lg border border-white/[0.14] bg-white/[0.03] px-2.5 text-sm hover:bg-white/[0.06] disabled:opacity-50"
              >
                <span className="text-muted-foreground">{t('maestro.strategyProfiles.editing')}</span>
                <span className="truncate font-medium text-foreground">{scopeLabel}</span>
                {dirty && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-amber-400"
                    role="img"
                    aria-label={t('maestro.unsaved')}
                  />
                )}
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">
                {t('maestro.strategyProfiles.editingMenu')}
              </p>
              {editableProfiles.map((item) => (
                <DropdownMenuItem key={item.id} onSelect={() => selectProfile(item.id)} className="items-start">
                  <Check className={cn('mt-0.5', item.id !== selectedProfileId && 'invisible')} />
                  <span className="min-w-0">
                    <span className="block truncate">{maestroStrategyProfileLabel(item, t)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.source === 'global'
                        ? t('maestro.strategyProfiles.globalHint')
                        : maestroStrategyProfileSummary(item, t)}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!canSaveAs}
                onSelect={() => setNameDialog({ mode: 'create', value: '', error: null })}
                className="items-start"
              >
                <Plus className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block">{t('maestro.strategyProfiles.saveAsNewEllipsis')}</span>
                  {!orchestratorDraft && (
                    <span className="block text-xs text-muted-foreground">
                      {t('maestro.strategyProfiles.needsOrchestrator')}
                    </span>
                  )}
                </span>
              </DropdownMenuItem>
              {selectedProfile?.source === 'custom' && (
                <>
                  <DropdownMenuItem
                    disabled={busy}
                    onSelect={() => setNameDialog({ mode: 'rename', value: profileName, error: null })}
                  >
                    <Pencil /> {t('maestro.strategyProfiles.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem destructive disabled={busy} onSelect={() => void deleteProfile()}>
                    <Trash2 /> {t('maestro.strategyProfiles.delete')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            aria-expanded={assistantOpen}
            aria-controls="maestro-configurator-panel"
            onClick={() => {
              if (assistantOpen && !assistantVisible) return setAssistantHidden(false)
              setAssistantOpen((value) => !value)
              setAssistantHidden(false)
            }}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-sm',
              assistantOpen
                ? 'border-amber-400/40 bg-amber-400/[0.09] text-foreground'
                : 'border-white/[0.14] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground'
            )}
          >
            <Sparkles className="size-3.5 text-amber-300" /> {t('maestro.configurator.title')}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2">
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2.5">
          <span id="maestro-strategy-label" className="text-xs text-muted-foreground">
            {t('maestro.strategy')}
          </span>
          <div
            role="radiogroup"
            aria-labelledby="maestro-strategy-label"
            className="inline-flex flex-wrap gap-0.5 rounded-lg border border-border bg-black/20 p-0.5"
          >
            {STRATEGIES.map((strategy) => (
              <button
                key={strategy}
                type="button"
                role="radio"
                aria-checked={draft.strategy === strategy}
                disabled={reviewing}
                title={t(`maestro.strategyHints.${strategy}`)}
                onClick={() => draft.strategy !== strategy && setDraft({ ...draft, strategy })}
                className={cn(
                  'rounded-md px-2.5 py-1 text-sm transition-colors disabled:cursor-default',
                  draft.strategy === strategy
                    ? 'bg-white/[0.12] text-foreground'
                    : 'text-muted-foreground enabled:hover:text-foreground',
                  strategy === proposedStrategy &&
                    'text-amber-200 outline-dashed outline-1 -outline-offset-1 outline-amber-400'
                )}
              >
                {t(`maestro.strategies.${strategy}`)}
              </button>
            ))}
          </div>
        </div>
        {review && proposedStrategy ? (
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground/80 hover:bg-white/[0.05]">
            <input
              type="checkbox"
              className="accent-amber-400"
              checked={review.selected.has(MAESTRO_PROPOSAL_STRATEGY_UNIT)}
              onChange={(event) => toggleUnit(MAESTRO_PROPOSAL_STRATEGY_UNIT, event.target.checked)}
            />
            {t('maestro.poolEditor.review.switchStrategy', { strategy: t(`maestro.strategies.${proposedStrategy}`) })}
          </label>
        ) : (
          <span
            title={t(`maestro.strategyHints.${draft.strategy}`)}
            className="hidden min-w-0 flex-1 basis-40 truncate text-xs text-muted-foreground/80 lg:block"
          >
            {t(`maestro.strategyHints.${draft.strategy}`)}
          </span>
        )}
        <div className="ml-auto min-w-0">
          <OrchestratorProfileEditor
            value={orchestratorDraft}
            persistGlobal={selectedProfile?.source === 'global'}
            disabled={reviewing}
            onChange={changeOrchestrator}
          />
        </div>
      </div>

      <div
        ref={workspaceRef}
        className="relative flex h-[min(760px,calc(100vh-230px))] min-h-[520px] overflow-hidden rounded-lg border border-border bg-white/[0.02]"
      >
        <MaestroPoolEditor
          value={draft}
          onChange={setDraft}
          config={config}
          catalogRevision={catalogRevision}
          orchestrator={orchestratorDraft}
          onImportAgents={() => void importAgents()}
          review={
            review && {
              summary: review.proposal.summary,
              base: review.base,
              proposed: review.proposal.config,
              units: review.units,
              selected: review.selected,
            }
          }
          onToggleUnit={toggleUnit}
          onReviewBack={endReview}
          onReviewDismiss={dismissReview}
          onReviewApply={applyReview}
          reviewAction={
            assistantOpen &&
            !assistantVisible && (
              <button
                type="button"
                onClick={() => setAssistantHidden(false)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-white/[0.05]"
              >
                <Sparkles className="size-3 text-amber-300" /> {t('maestro.configurator.showConversation')}
              </button>
            )
          }
          savedRevision={savedRevision}
        />
        {assistantOpen && !overlay && (
          <AssistantSplitter
            width={shownAssistantWidth}
            min={ASSISTANT_MIN_WIDTH}
            max={maxAssistantWidth}
            onChange={setAssistantWidth}
          />
        )}
        {assistantOpen && (
          <div
            id="maestro-configurator-panel"
            hidden={!assistantVisible}
            style={overlay ? { bottom: 8 + reviewBarHeight } : { width: shownAssistantWidth }}
            className={cn(
              'flex min-h-0 flex-col',
              overlay
                ? 'absolute right-2 top-2 z-10 w-[min(440px,calc(100%-16px))] overflow-hidden rounded-xl border border-white/[0.14] bg-[#141416] shadow-[0_24px_70px_rgba(0,0,0,0.65)]'
                : 'shrink-0 bg-black/[0.12]'
            )}
          >
            <MaestroConfigurator
              draft={draft}
              scopeLabel={scopeLabel}
              catalogRevision={catalogRevision}
              reviewingProposalId={review?.proposal.id ?? null}
              onReview={startReview}
              onClose={() => {
                // Over the Pool during a review, closing only steps aside; the header button brings it back.
                if (overlay && reviewing) return setAssistantHidden(true)
                setAssistantOpen(false)
                setAssistantHidden(false)
              }}
            />
          </div>
        )}
      </div>

      {(payload.diagnostics.length > 0 || idIssues.length > 0 || error) && (
        <div className="space-y-1">
          {payload.diagnostics.map((diagnostic, index) => (
            <p
              key={`${diagnostic.code}-${index}`}
              className="rounded border border-amber-500/20 bg-amber-500/[0.06] p-2 text-xs text-amber-200"
            >
              {diagnostic.message}
            </p>
          ))}
          {idIssues.map((issue) => (
            <p key={issue} className="rounded border border-red-500/20 bg-red-500/[0.08] p-2 text-xs text-red-300">
              {issue}
            </p>
          ))}
          {error && (
            <p role="alert" className="rounded border border-red-500/20 bg-red-500/[0.08] p-2 text-xs text-red-300">
              {error}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {dirty ? (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-amber-300">
            <span className="size-1.5 rounded-full bg-amber-400" aria-hidden="true" />
            {changeCount > 0 ? t('maestro.unsavedCount', { count: changeCount }) : t('maestro.unsaved')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
            {saved ? t('maestro.saved') : t('maestro.allSaved')}
          </span>
        )}
        <span className="min-w-0 flex-1 basis-52 text-xs text-muted-foreground/80">
          {reviewing
            ? t('maestro.saveHintReviewing')
            : selectedProfile?.source === 'custom'
              ? t('maestro.saveHintCustom')
              : t('maestro.saveHintGlobal')}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={busy || !dirty || reviewing}
            onClick={discardChanges}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-white/[0.05] hover:text-foreground disabled:opacity-40"
          >
            {t('maestro.discard')}
          </button>
          {selectedProfile?.source === 'custom' ? (
            <button
              type="button"
              disabled={busy || reviewing || !dirty || !profileName.trim() || !orchestratorDraft || idIssues.length > 0}
              onClick={() => void updateProfile()}
              className="max-w-[20rem] truncate rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
            >
              {t('maestro.strategyProfiles.updateNamed', { name: profileName.trim() || selectedProfile.name })}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || reviewing || !dirty || idIssues.length > 0}
              onClick={() => void saveGlobal()}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
            >
              {t('maestro.saveGlobal')}
            </button>
          )}
        </div>
      </div>

      <Dialog open={nameDialog !== null} onOpenChange={(open) => !open && !busy && setNameDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {nameDialog?.mode === 'rename'
                ? t('maestro.strategyProfiles.renameTitle')
                : t('maestro.strategyProfiles.saveAsNewTitle')}
            </DialogTitle>
            <DialogDescription>
              {nameDialog?.mode === 'rename'
                ? t('maestro.strategyProfiles.renameDescription')
                : t('maestro.strategyProfiles.saveAsNewDescription')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              void submitName()
            }}
          >
            <label htmlFor="maestro-strategy-profile-name" className="text-xs font-medium text-muted-foreground">
              {t('maestro.strategyProfiles.nameLabel')}
            </label>
            <Input
              id="maestro-strategy-profile-name"
              autoFocus
              value={nameDialog?.value ?? ''}
              placeholder={t('maestro.strategyProfiles.namePlaceholder')}
              disabled={busy}
              aria-invalid={Boolean(nameDialog?.error)}
              onChange={(event) =>
                setNameDialog((current) => (current ? { ...current, value: event.target.value, error: null } : current))
              }
            />
            {nameDialog?.error && (
              <p role="alert" className="text-xs text-red-300">
                {nameDialog.error}
              </p>
            )}
          </form>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setNameDialog(null)}>
              {t('maestro.strategyProfiles.cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void submitName()}>
              {nameDialog?.mode === 'rename'
                ? t('maestro.strategyProfiles.renameConfirm')
                : t('maestro.strategyProfiles.saveAsNewConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
