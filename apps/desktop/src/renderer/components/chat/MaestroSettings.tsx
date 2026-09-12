import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Save, Sparkles, Trash2 } from 'lucide-react'
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
  MaestroStrategyProfileCatalog,
} from '../../../shared/maestro'
import { GLOBAL_MAESTRO_STRATEGY_PROFILE_ID, cloneMaestroConfig } from '../../../shared/maestro'
import { notifyMaestroConfigChanged } from '@/lib/maestro-config-events'
import { cn } from '@/lib/utils'
import { createMaestroResource, MaestroConfigEditor, maestroConfigIdIssues } from './MaestroControl'
import { MaestroConfigurator } from './MaestroConfigurator'
import { ChatModelChip } from './ChatModelChip'
import { ChatReasoningPicker } from './ChatReasoningPicker'
import { FastModeChip } from './ChatFastModeToggle'
import { Input } from '@/components/ui/input'
import { SearchSelect } from '@/components/ui/search-select'
import { maestroStrategyProfileOptions, mergeMaestroOrchestratorModelMeta } from '@/lib/maestro-strategy-profiles'

/** The shared editor saves global changes immediately; custom profiles retain a local draft. */
function OrchestratorProfileEditor({
  value,
  persistGlobal,
  onChange,
}: {
  value: MaestroOrchestratorProfileV1 | null
  persistGlobal: boolean
  onChange(value: MaestroOrchestratorProfileV1): void
}) {
  const { t } = useTranslation('chat')
  const [meta, setMeta] = useState<ChatModelMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selection: ChatModelRef | null = value ? { providerId: value.providerId, modelId: value.modelId } : null

  useEffect(() => {
    let alive = true
    setMeta(null)
    if (!selection) return
    void Promise.all([
      window.api.chatModelMeta(selection.modelId, selection.providerId).catch(() => null),
      window.api.chatSubagentProfilesModelMeta(selection.providerId, selection.modelId).catch(() => ({
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
  }, [selection?.modelId, selection?.providerId])

  const efforts = meta?.reasoningEfforts?.length ? meta.reasoningEfforts : [...DEFAULT_REASONING_EFFORTS]

  const commit = async (next: MaestroOrchestratorProfileV1) => {
    if (persistGlobal) {
      const result = await window.api.chatSetDefault(next)
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
    <div className="w-full space-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1 rounded-lg border border-border bg-black/20 p-2">
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
      </div>
      <p className="text-xs text-muted-foreground">
        {persistGlobal ? t('maestro.orchestratorInherited') : t('maestro.strategyProfiles.orchestratorSaved')}
      </p>
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  )
}

export function MaestroSettings({ config }: { config: ChatConfig }) {
  const { t } = useTranslation('chat')
  const [payload, setPayload] = useState<MaestroConfigPayload | null>(null)
  const [draft, setDraft] = useState<MaestroConfigV1 | null>(null)
  const [profileCatalog, setProfileCatalog] = useState<MaestroStrategyProfileCatalog | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState<string>(GLOBAL_MAESTRO_STRATEGY_PROFILE_ID)
  const [profileName, setProfileName] = useState('')
  const [orchestratorDraft, setOrchestratorDraft] = useState<MaestroOrchestratorProfileV1 | null>(null)
  const [catalogRevision, setCatalogRevision] = useState(0)

  const [assistantOpen, setAssistantOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  const [savedRevision, setSavedRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    const [next, strategies] = await Promise.all([
      window.api.chatMaestroGetGlobal(),
      window.api.chatMaestroStrategyProfilesList(),
    ])
    setPayload(next)
    setProfileCatalog(strategies)
    const selected = strategies.items.find((item) => item.id === selectedProfileId) ?? strategies.items[0]
    if (selected) {
      setSelectedProfileId(selected.id)
      setDraft(cloneMaestroConfig(selected.config))
      setOrchestratorDraft(selected.orchestrator ? { ...selected.orchestrator } : null)
      setProfileName(selected.source === 'custom' ? selected.name : '')
    } else {
      setDraft(cloneMaestroConfig(next.config))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])
  useEffect(() => {
    const unsubscribes = CHAT_SUBSCRIPTION_PROVIDER_KINDS.map((provider) =>
      window.api.onChatSubscriptionStatus(provider, () => setCatalogRevision((revision) => revision + 1))
    )
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [])

  const selectedProfile = profileCatalog?.items.find((item) => item.id === selectedProfileId) ?? null
  const profileOptions = useMemo(
    () => maestroStrategyProfileOptions(profileCatalog?.items ?? [], t),
    [profileCatalog?.items, t]
  )
  const dirty = useMemo(() => {
    if (!draft || !payload || !selectedProfile) return false
    if (selectedProfile.source === 'global') return JSON.stringify(draft) !== JSON.stringify(payload.config)
    if (selectedProfile.source === 'builtin') return false
    return (
      profileName.trim() !== selectedProfile.name ||
      JSON.stringify(draft) !== JSON.stringify(selectedProfile.config) ||
      JSON.stringify(orchestratorDraft) !== JSON.stringify(selectedProfile.orchestrator)
    )
  }, [draft, orchestratorDraft, payload, profileName, selectedProfile])
  const idIssues = useMemo(() => (draft ? maestroConfigIdIssues(draft, t) : []), [draft, t])

  const importAgents = async () => {
    if (!draft) return
    const catalog = await window.api.chatSubagentProfilesCatalog()
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
    const selected = profileCatalog?.items.find((item) => item.id === id)
    if (!selected) return
    setSelectedProfileId(id)
    setDraft(cloneMaestroConfig(selected.config))
    setOrchestratorDraft(selected.orchestrator ? { ...selected.orchestrator } : null)
    setProfileName(selected.source === 'custom' ? selected.name : '')
    setError(null)
  }

  const saveGlobal = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const result = await window.api.chatMaestroSetGlobal(draft)
      if (!result.ok || !result.value) {
        throw new Error(result.errors?.map((item) => item.message).join(' ') || t('maestro.errors.invalidConfig'))
      }
      setPayload(result.value)
      setDraft(cloneMaestroConfig(result.value.config))
      setSaved(true)
      setSavedRevision((revision) => revision + 1)
      setTimeout(() => setSaved(false), 1500)
      notifyMaestroConfigChanged()
      const strategies = await window.api.chatMaestroStrategyProfilesList()
      setProfileCatalog(strategies)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const createProfile = async () => {
    if (!draft || !orchestratorDraft) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.chatMaestroStrategyProfilesCreate({
        name: profileName,
        config: draft,
        orchestrator: orchestratorDraft,
      })
      if (!result.ok) throw new Error(result.error)
      setProfileCatalog(result.catalog)
      setSelectedProfileId(result.profile.id)
      setProfileName(result.profile.name)
      setDraft(cloneMaestroConfig(result.profile.config))
      setOrchestratorDraft({ ...result.profile.orchestrator })
      setSaved(true)
      setSavedRevision((revision) => revision + 1)
      setTimeout(() => setSaved(false), 1500)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const updateProfile = async () => {
    if (!draft || !orchestratorDraft || selectedProfile?.source !== 'custom') return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.chatMaestroStrategyProfilesUpdate(selectedProfile.id, {
        name: profileName,
        config: draft,
        orchestrator: orchestratorDraft,
      })
      if (!result.ok) throw new Error(result.error)
      setProfileCatalog(result.catalog)
      setProfileName(result.profile.name)
      setDraft(cloneMaestroConfig(result.profile.config))
      setOrchestratorDraft({ ...result.profile.orchestrator })
      setSaved(true)
      setSavedRevision((revision) => revision + 1)
      setTimeout(() => setSaved(false), 1500)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const deleteProfile = async () => {
    if (selectedProfile?.source !== 'custom') return
    if (!window.confirm(t('maestro.strategyProfiles.confirmDelete', { name: selectedProfile.name }))) return
    setBusy(true)
    try {
      const result = await window.api.chatMaestroStrategyProfilesDelete(selectedProfile.id)
      if (!result.ok) throw new Error('maestro-strategy-profile-not-found')
      setProfileCatalog(result.catalog)
      const global = result.catalog.items.find((item) => item.id === GLOBAL_MAESTRO_STRATEGY_PROFILE_ID)
      if (global) {
        setSelectedProfileId(global.id)
        setProfileName('')
        setDraft(cloneMaestroConfig(global.config))
        setOrchestratorDraft(global.orchestrator ? { ...global.orchestrator } : null)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{t('maestro.globalSettingsTitle')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('maestro.globalSettingsDescription')}</p>
        </div>
        <button
          type="button"
          aria-expanded={assistantOpen}
          aria-controls="maestro-configurator-panel"
          onClick={() => setAssistantOpen((value) => !value)}
          className={cn(
            'shrink-0 rounded-md border px-2.5 py-1.5 text-sm',
            assistantOpen
              ? 'border-primary/50 bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:bg-white/5 hover:text-foreground'
          )}
        >
          {t('maestro.configurator.title')}
        </button>
      </div>

      <div className="grid gap-2 rounded-lg border border-border bg-white/[0.02] p-3 md:grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)]">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t('maestro.strategyProfiles.catalogLabel')}
          </label>
          <SearchSelect
            value={selectedProfileId}
            options={profileOptions}
            onChange={(id) => id && selectProfile(id)}
            ariaLabel={t('maestro.strategyProfiles.catalogLabel')}
            placeholder={t('maestro.strategyProfiles.select')}
            contentClassName="min-w-[30rem]"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="maestro-strategy-profile-name" className="text-xs font-medium text-muted-foreground">
            {selectedProfile?.source === 'custom'
              ? t('maestro.strategyProfiles.nameLabel')
              : t('maestro.strategyProfiles.newNameLabel')}
          </label>
          <Input
            id="maestro-strategy-profile-name"
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            placeholder={t('maestro.strategyProfiles.namePlaceholder')}
            disabled={busy}
          />
        </div>
      </div>

      <div
        className={cn(
          'grid min-w-0 grid-cols-1 gap-3',
          assistantOpen && 'xl:grid-cols-[minmax(0,1fr)_minmax(320px,22rem)]'
        )}
      >
        <MaestroConfigEditor
          value={draft}
          onChange={setDraft}
          config={config}
          catalogRevision={catalogRevision}
          onImportAgents={() => void importAgents()}
          orchestratorSlot={
            <OrchestratorProfileEditor
              value={orchestratorDraft}
              persistGlobal={selectedProfile?.source === 'global'}
              onChange={changeOrchestrator}
            />
          }
          savedRevision={savedRevision}
          className="h-[min(700px,calc(100vh-250px))] min-h-[520px] rounded-lg border border-border bg-white/[0.02]"
        />
        {assistantOpen && (
          <div id="maestro-configurator-panel" className="min-w-0">
            <MaestroConfigurator
              draft={draft}
              catalogRevision={catalogRevision}
              onApply={setDraft}
              onClose={() => setAssistantOpen(false)}
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

      <div className="flex items-center justify-end gap-2">
        {dirty && <span className="mr-auto text-sm text-amber-300">{t('maestro.unsaved')}</span>}
        {saved && !dirty && <span className="mr-auto text-sm text-emerald-300">{t('maestro.saved')}</span>}
        {selectedProfile?.source === 'custom' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void deleteProfile()}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-40"
          >
            <Trash2 className="size-3.5" /> {t('maestro.strategyProfiles.delete')}
          </button>
        )}
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => {
            selectProfile(selectedProfileId)
          }}
          className="rounded-md border border-white/[0.1] px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          {t('maestro.discard')}
        </button>
        {selectedProfile?.source === 'global' && (
          <button
            type="button"
            disabled={busy || !dirty || idIssues.length > 0}
            onClick={() => void saveGlobal()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            {t('maestro.saveGlobal')}
          </button>
        )}
        {selectedProfile?.source === 'custom' && (
          <button
            type="button"
            disabled={busy || !dirty || !profileName.trim() || !orchestratorDraft || idIssues.length > 0}
            onClick={() => void updateProfile()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            <Save className="size-3.5" /> {t('maestro.strategyProfiles.update')}
          </button>
        )}
        <button
          type="button"
          disabled={busy || !profileName.trim() || !orchestratorDraft || idIssues.length > 0}
          onClick={() => void createProfile()}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.1] px-3 py-1.5 text-sm text-foreground hover:bg-white/[0.05] disabled:opacity-40"
        >
          <Plus className="size-3.5" /> {t('maestro.strategyProfiles.saveAsNew')}
        </button>
      </div>
    </div>
  )
}
