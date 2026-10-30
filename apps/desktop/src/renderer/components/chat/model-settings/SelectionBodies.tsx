import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, MessageSquare, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import { SearchSelect } from '@/components/ui/search-select'
import { subagentProfileProviders } from '@/lib/subagent-profile-editor'
import {
  DEFAULT_REASONING_EFFORTS,
  isChatProviderConnected,
  type ChatConfig,
  type ChatModelMeta,
} from '../../../../shared/chat'
import { isRealSubagentProfileEffort } from '../../../../shared/subagent-profile-effort'
import type { SubagentProfileCandidate } from '../../../../shared/subagent-profiles'
import { chatProviderChoices } from '../account-pool'
import { CandidateFields } from '../subagent-profiles/CandidateFields'
import { PickerField, SaveNote, SegmentedChoice } from './controls'
import { effortShortLabel, sameModelSelection, type ModelSelection } from './model-selection'
import { modelDisplayName } from '../model-search'

/** Error text to show, or null once saved. */
export type CommitSelection = (selection: ModelSelection | null) => Promise<string | null>

/**
 * Keeps the panel's draft and saves it as soon as it is complete, so closing the panel never loses a choice and
 * an incomplete one (a provider without a model yet) is simply not saved.
 */
function useAutoCommit(initial: ModelSelection | null, onCommit: CommitSelection) {
  const { t } = useTranslation('chat')
  const committed = useRef(initial)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null)
  const commit = (next: ModelSelection | null) => {
    if (sameModelSelection(next, committed.current)) return
    const previous = committed.current
    committed.current = next
    setSaving(true)
    setNote(null)
    onCommit(next)
      .then((error) => {
        if (error) committed.current = previous
        setNote(error ? { error: true, text: error } : { error: false, text: t('modelSettings.saved') })
      })
      .catch(() => {
        committed.current = previous
        setNote({ error: true, text: t('modelSettings.saveFailed') })
      })
      .finally(() => setSaving(false))
  }
  return { commit, saving, note, clearNote: () => setNote(null) }
}

function PanelFooter({
  saving,
  note,
  children,
}: {
  saving: boolean
  note: { error: boolean; text: string } | null
  children?: ReactNode
}) {
  const { t } = useTranslation('chat')
  if (!children && !saving && !note) return null
  return (
    <div className="flex min-h-6 flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
      <div className="flex flex-wrap items-center gap-1">{children}</div>
      {saving ? (
        <span role="status" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t('modelSettings.saving')}
        </span>
      ) : (
        <SaveNote note={note} />
      )}
    </div>
  )
}

export function InheritOption({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string
  hint: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors',
        selected ? 'border-indigo-400/60 bg-indigo-500/10' : 'border-border hover:bg-white/[0.04]'
      )}
    >
      <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block text-[12px] text-foreground">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  )
}

const candidateOf = (value: ModelSelection | null, config: ChatConfig): SubagentProfileCandidate =>
  value
    ? {
        providerId: value.providerId,
        modelId: value.modelId,
        effort: value.effort ?? '',
        ...(value.fastMode ? { fastMode: true } : {}),
      }
    : { providerId: subagentProfileProviders(chatProviderChoices(config))[0]?.id ?? '', modelId: '', effort: '' }

/**
 * Model of a background task or a subagent candidate, from the catalogs the subagent runtime resolves. With
 * `allowOff` the provider may decide the effort; without it an explicit effort is required.
 */
export function ProfileSelectionBody({
  value,
  config,
  catalogRevision,
  allowOff = false,
  inherit,
  onCommit,
  actions,
}: {
  value: ModelSelection | null
  config: ChatConfig
  catalogRevision: number
  allowOff?: boolean
  /** Offers following the conversation's model, saved as null. */
  inherit?: { label: string; hint: string }
  onCommit: CommitSelection
  actions?: ReactNode
}) {
  const { commit, saving, note, clearNote } = useAutoCommit(value, onCommit)
  const [candidate, setCandidate] = useState(() => candidateOf(value, config))
  const [inheriting, setInheriting] = useState(value == null && inherit != null)
  const change = (next: SubagentProfileCandidate) => {
    setCandidate(next)
    setInheriting(false)
    clearNote()
    const effortReady = allowOff ? Boolean(next.effort) : isRealSubagentProfileEffort(next.effort)
    if (!next.providerId || !next.modelId || !effortReady) return
    commit({
      providerId: next.providerId,
      modelId: next.modelId,
      effort: next.effort || 'off',
      fastMode: next.fastMode === true,
    })
  }
  return (
    <>
      {inherit && (
        <InheritOption
          label={inherit.label}
          hint={inherit.hint}
          selected={inheriting}
          onSelect={() => {
            setInheriting(true)
            commit(null)
          }}
        />
      )}
      <CandidateFields
        candidate={candidate}
        config={config}
        catalogRevision={catalogRevision}
        layout="stacked"
        allowOff={allowOff}
        onChange={change}
      />
      <PanelFooter saving={saving} note={note}>
        {actions}
      </PanelFooter>
    </>
  )
}

/**
 * Model of the conversation runtime: the default for new conversations and the image interpreter. It lists the
 * models the conversation picker offers and keeps an id typed by hand.
 */
export function ChatSelectionBody({
  value,
  config,
  modelFilterRevision,
  allowFast = false,
  requireVision = false,
  onCommit,
}: {
  value: ModelSelection | null
  config: ChatConfig
  modelFilterRevision: number
  allowFast?: boolean
  requireVision?: boolean
  onCommit: CommitSelection
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const { commit, saving, note, clearNote } = useAutoCommit(value, onCommit)
  const choices = chatProviderChoices(config)
  const connected = choices.filter(isChatProviderConnected)
  const providers = choices.filter((provider) => isChatProviderConnected(provider) || provider.id === value?.providerId)
  const [draft, setDraft] = useState<ModelSelection>(
    () => value ?? { providerId: connected[0]?.id ?? '', modelId: '', effort: 'off' }
  )
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [meta, setMeta] = useState<{ modelKey: string; value: ChatModelMeta | null } | null>(null)
  const providerConnected = connected.some((provider) => provider.id === draft.providerId)

  const change = (next: ModelSelection) => {
    setDraft(next)
    clearNote()
    if (next.providerId && next.modelId) commit({ ...next, effort: next.effort || 'off' })
  }

  useEffect(() => {
    if (!draft.providerId || !providerConnected) {
      setModels([])
      return
    }
    let alive = true
    setLoading(true)
    api
      .chatModels(draft.providerId)
      .then((next) => alive && setModels(next))
      .catch(() => alive && setModels([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [api, draft.providerId, providerConnected, modelFilterRevision])

  const modelKey = `${draft.providerId}::${draft.modelId}`
  useEffect(() => {
    if (!draft.providerId || !draft.modelId) return
    let alive = true
    api
      .chatModelMeta(draft.modelId, draft.providerId)
      .then((value) => alive && setMeta({ modelKey, value }))
      .catch(() => alive && setMeta({ modelKey, value: null }))
    return () => {
      alive = false
    }
  }, [api, draft.providerId, draft.modelId, modelKey])

  const currentMeta = meta?.modelKey === modelKey ? meta.value : undefined
  const efforts = currentMeta?.reasoningEfforts?.length ? currentMeta.reasoningEfforts : [...DEFAULT_REASONING_EFFORTS]

  // A model that drops the effort or Fast the previous one had falls back to the provider's default.
  useEffect(() => {
    if (!currentMeta) return
    const effort = draft.effort || 'off'
    const effortInvalid = effort !== 'off' && (!currentMeta.reasoning || !efforts.includes(effort))
    const fastInvalid = draft.fastMode === true && (!allowFast || currentMeta.fastModeCapability !== true)
    if (effortInvalid || fastInvalid)
      change({ ...draft, effort: effortInvalid ? 'off' : effort, fastMode: fastInvalid ? false : draft.fastMode })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMeta])

  return (
    <>
      <PickerField label={t('subagentProfiles.provider')}>
        <SearchSelect
          value={draft.providerId || undefined}
          avoidOverflow
          options={providers.map((provider) => ({ id: provider.id, label: provider.name }))}
          placeholder={t('subagentProfiles.provider')}
          ariaLabel={t('subagentProfiles.provider')}
          onChange={(providerId) =>
            providerId &&
            providerId !== draft.providerId &&
            change({ providerId, modelId: '', effort: draft.effort, fastMode: false })
          }
        />
      </PickerField>
      <PickerField label={t('subagentProfiles.model')}>
        <SearchSelect
          value={draft.modelId || undefined}
          avoidOverflow
          options={[
            ...(draft.modelId && !models.includes(draft.modelId)
              ? [{ id: draft.modelId, label: modelDisplayName(draft.modelId) }]
              : []),
            ...models.map((model) => ({ id: model, label: modelDisplayName(model) })),
          ]}
          placeholder={loading ? t('settings.loadingModels') : t('settings.chooseModel')}
          ariaLabel={t('subagentProfiles.model')}
          allowCustom
          disabled={!providerConnected}
          onChange={(modelId) => modelId && change({ ...draft, modelId: modelId.trim() })}
        />
      </PickerField>
      {draft.modelId && currentMeta?.reasoning && (
        <PickerField label={t('subagentProfiles.effort')}>
          <SegmentedChoice
            value={draft.effort || 'off'}
            ariaLabel={t('subagentProfiles.effort')}
            options={[
              { id: 'off', label: t('reasoning.default') },
              ...efforts.map((effort) => ({ id: effort, label: effortShortLabel(effort, t), title: effort })),
            ]}
            onChange={(effort) => change({ ...draft, effort })}
          />
        </PickerField>
      )}
      {allowFast && draft.modelId && currentMeta?.fastModeCapability === true && (
        <PickerField label={t('modelSettings.speed')}>
          <SegmentedChoice
            value={draft.fastMode === true ? 'fast' : 'standard'}
            options={[
              { id: 'standard', label: t('subagentProfiles.standardMode') },
              { id: 'fast', label: t('fastMode.label'), title: t('fastMode.tooltip') },
            ]}
            ariaLabel={t('modelSettings.speed')}
            onChange={(speed) => change({ ...draft, fastMode: speed === 'fast' })}
          />
        </PickerField>
      )}
      {requireVision && draft.modelId && currentMeta?.vision === false && (
        <p className="text-[11px] text-amber-300">{t('settings.imageInterpreterNoVisionWarning')}</p>
      )}
      <PanelFooter saving={saving} note={note}>
        <button
          type="button"
          disabled={!providerConnected || reloading}
          title={t('settings.reloadModelsTitle')}
          onClick={() => {
            setReloading(true)
            void api
              .chatModels(draft.providerId, true)
              .then(setModels)
              .catch(() => undefined)
              .finally(() => setReloading(false))
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground disabled:opacity-45"
        >
          <RefreshCw className={cn('size-3', reloading && 'animate-spin')} />
          {t('modelSettings.reloadCatalog')}
        </button>
      </PanelFooter>
    </>
  )
}
