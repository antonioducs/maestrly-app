import { useChatOwnerWindow } from '@/lib/chat-window-context'
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  ImageIcon,
  ImagePlus,
  Loader2,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import type { ChatModelRef } from '../../../shared/chat'
import type { MaestroConfigV1 } from '../../../shared/maestro'
import {
  MAESTRO_CONFIGURATOR_IMAGE_MEDIA_TYPES,
  MAESTRO_CONFIGURATOR_MAX_IMAGES,
  maestroProposalOutcomes,
  maestroProposalUnitKeys,
  prepareMaestroConfiguratorDraft,
  type MaestroConfiguratorChange,
  type MaestroConfiguratorMessage,
  type MaestroConfiguratorProfile,
  type MaestroConfiguratorProposal,
  type MaestroConfiguratorThreadEvent,
  type MaestroProposalOutcome,
} from '../../../shared/maestro-configurator'
import { MAX_ATTACHMENT_IMAGE_BYTES, MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE } from '../../../shared/memory-policy'
import type { SubagentProfileModelMetaResult } from '../../../shared/subagent-profile-effort'
import { hasDraggedFiles } from '@/lib/attachment-kind'
import { subagentProfileEffortIds } from '@/lib/subagent-profile-editor'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import { ChatModelChip } from './ChatModelChip'
import { ChatReasoningPicker } from './ChatReasoningPicker'
import { FastModeChip } from './ChatFastModeToggle'

const emptyProfile = (): MaestroConfiguratorProfile => ({ providerId: '', modelId: '', effort: 'off' })

/** Upsert by id: a message can come back with more (an image transcribed after the turn started). */
const mergeMessage = (messages: MaestroConfiguratorMessage[], message: MaestroConfiguratorMessage) =>
  (messages.some((current) => current.id === message.id)
    ? messages.map((current) => (current.id === message.id ? message : current))
    : [...messages, message]
  ).sort((left, right) => left.createdAt - right.createdAt)

const IMAGE_TYPES: readonly string[] = MAESTRO_CONFIGURATOR_IMAGE_MEDIA_TYPES

interface DraftImage {
  id: string
  name: string
  mediaType: string
  bytes: Uint8Array
  previewUrl: string
}

function eventLabel(
  event: MaestroConfiguratorThreadEvent,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  switch (event.kind) {
    case 'proposal-applied':
      return event.skipped?.length
        ? t('maestro.configurator.eventAppliedPartial')
        : t('maestro.configurator.eventApplied')
    case 'proposal-dismissed':
      return t('maestro.configurator.eventDismissed')
    case 'draft-discarded':
      return t('maestro.configurator.eventDiscarded', { name: event.profileName })
    case 'saved':
      return event.target === 'global'
        ? t('maestro.configurator.eventSavedGlobal')
        : event.target === 'custom'
          ? t('maestro.configurator.eventSavedCustom', { name: event.profileName })
          : t('maestro.configurator.eventSavedNew', { name: event.profileName })
    case 'profile-selected':
      return t('maestro.configurator.eventProfileSelected', { name: event.profileName })
  }
}

interface ResourceDelta {
  label: string
  added: number
  removed: number
  kind: 'changed' | 'added' | 'removed'
}

/** Per agent, how many models a proposal adds and removes, for the summary in the thread. */
function resourceDeltas(changes: MaestroConfiguratorChange[]): ResourceDelta[] {
  const deltas = new Map<string, ResourceDelta>()
  for (const change of changes) {
    if (change.kind === 'strategy') continue
    const delta = deltas.get(change.resourceId) ?? { label: change.label, added: 0, removed: 0, kind: 'changed' }
    if (change.kind === 'resource-added') delta.kind = 'added'
    if (change.kind === 'resource-removed') delta.kind = 'removed'
    if (change.kind === 'candidate-added' || change.kind === 'candidate-replaced') delta.added += 1
    if (change.kind === 'candidate-removed' || change.kind === 'candidate-replaced') delta.removed += 1
    deltas.set(change.resourceId, delta)
  }
  return [...deltas.values()]
}

function ProposalCard({
  proposal,
  outcome,
  stale,
  reviewing,
  canReview,
  canRedo,
  onReview,
  onRedo,
}: {
  proposal: MaestroConfiguratorProposal
  outcome: MaestroProposalOutcome
  /** The draft changed after the proposal was made, so it can no longer be laid over the Pool. */
  stale: boolean
  reviewing: boolean
  canReview: boolean
  canRedo: boolean
  onReview: () => void
  onRedo: () => void
}) {
  const { t } = useTranslation('chat')
  const total = maestroProposalUnitKeys(proposal.changes).length
  const deltas = resourceDeltas(proposal.changes)
  const strategy = proposal.changes.find((change) => change.kind === 'strategy')
  const pending = outcome.status === 'pending' && !reviewing
  const meta = [
    t('maestro.configurator.proposalCount', { count: total }),
    deltas.length ? t('maestro.configurator.proposalAgents', { count: deltas.length }) : null,
    strategy?.kind === 'strategy'
      ? t('maestro.configurator.proposalStrategy', { strategy: t(`maestro.strategies.${strategy.after}`) })
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      className={cn(
        'mt-2 rounded-lg border p-3',
        reviewing || (pending && !stale)
          ? 'border-amber-500/30 bg-amber-500/[0.06]'
          : outcome.status === 'applied'
            ? 'border-border bg-white/[0.03]'
            : 'border-border opacity-70'
      )}
    >
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{proposal.summary}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>
        </div>
      </div>
      {deltas.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1">
          {deltas.slice(0, 12).map((delta) => (
            <li key={delta.label} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-xs text-foreground/80">
              {delta.label}
              {delta.kind === 'added' && (
                <span className="ml-1 text-amber-300">{t('maestro.configurator.deltaNew')}</span>
              )}
              {delta.kind === 'removed' && (
                <span className="ml-1 text-red-300">{t('maestro.configurator.deltaRemoved')}</span>
              )}
              {delta.kind === 'changed' && delta.added > 0 && (
                <span className="ml-1 font-medium text-amber-300">+{delta.added}</span>
              )}
              {delta.kind === 'changed' && delta.removed > 0 && (
                <span className="ml-1 font-medium text-red-300">−{delta.removed}</span>
              )}
              {delta.kind === 'changed' && delta.added === 0 && delta.removed === 0 && (
                <span className="ml-1 text-muted-foreground">{t('maestro.configurator.deltaEdited')}</span>
              )}
            </li>
          ))}
          {deltas.length > 12 && (
            <li className="px-1 text-xs text-muted-foreground">
              {t('maestro.configurator.moreChanges', { count: deltas.length - 12 })}
            </li>
          )}
        </ul>
      )}
      {proposal.diagnostics.map((item, index) => (
        <p key={`${item.message}-${index}`} className="mt-1.5 text-xs text-amber-300">
          {item.message}
        </p>
      ))}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted-foreground">
        {reviewing ? (
          <span className="inline-flex items-center gap-1 text-amber-300">
            <Sparkles className="size-3" /> {t('maestro.configurator.statusReviewing')}
          </span>
        ) : outcome.status === 'applied' ? (
          <>
            <span className="inline-flex items-center gap-1 text-emerald-300">
              <Check className="size-3" />
              {outcome.state === 'saved'
                ? t('maestro.configurator.statusSaved')
                : outcome.state === 'discarded'
                  ? t('maestro.configurator.statusDiscardedDraft')
                  : t('maestro.configurator.statusApplied')}
            </span>
            {outcome.skipped.length > 0 && (
              <span>
                {t('maestro.configurator.statusPartial', {
                  applied: Math.max(0, total - outcome.skipped.length),
                  count: total,
                })}
              </span>
            )}
          </>
        ) : outcome.status === 'dismissed' ? (
          <span>{t('maestro.configurator.statusDismissed')}</span>
        ) : outcome.status === 'superseded' ? (
          <span>{t('maestro.configurator.statusSuperseded')}</span>
        ) : stale ? (
          <>
            <span className="inline-flex items-center gap-1 text-amber-300">
              <AlertTriangle className="size-3" /> {t('maestro.configurator.staleProposal')}
            </span>
            <button
              type="button"
              disabled={!canRedo}
              onClick={onRedo}
              className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-white/[0.05] disabled:opacity-40"
            >
              {t('maestro.configurator.redo')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={!canReview}
              onClick={onReview}
              className="rounded-md bg-amber-400 px-2.5 py-1 text-xs font-medium text-amber-950 hover:bg-amber-300 disabled:opacity-40"
            >
              {t('maestro.configurator.review')}
            </button>
            <span>{t('maestro.configurator.reviewHint')}</span>
          </>
        )}
      </div>
    </div>
  )
}

export function MaestroConfigurator({
  draft,
  scopeLabel,
  catalogRevision,
  reviewingProposalId,
  onReview,
  onClose,
}: {
  draft: MaestroConfigV1
  /** What the editor has open, so the user knows what a proposal would change. */
  scopeLabel: string
  catalogRevision: number
  /** The proposal laid over the Pool right now, if any. */
  reviewingProposalId: string | null
  /** Opens a proposal for review in the Pool; the editor applies only what the user keeps. */
  onReview: (proposal: MaestroConfiguratorProposal) => void
  onClose: () => void
}) {
  const ownerWindow = useChatOwnerWindow()
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [messages, setMessages] = useState<MaestroConfiguratorMessage[]>([])
  const [profile, setProfile] = useState<MaestroConfiguratorProfile>(emptyProfile)
  const [profileMeta, setProfileMeta] = useState<SubagentProfileModelMetaResult | null>(null)
  const [providerCount, setProviderCount] = useState(0)
  const [modelCount, setModelCount] = useState(0)
  const [runnableProviderIds, setRunnableProviderIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [images, setImages] = useState<DraftImage[]>([])
  const [dropActive, setDropActive] = useState(false)
  const imagesRef = useRef<DraftImage[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const profileRevision = useRef(0)
  const terminalTurns = useRef(new Set<string>())
  const scrollRef = useRef<HTMLDivElement>(null)
  // The same normalized revision the main process computes, so case or stray spaces never make a proposal stale.
  const prepared = useMemo(() => prepareMaestroConfiguratorDraft(draft), [draft])
  const draftHash = prepared.ok ? prepared.value.baseHash : null
  const unfinishedCandidates = prepared.ok ? prepared.value.skippedCandidates.length : 0
  // The thread records what the user did with each proposal, so the state survives the panel closing or a reload.
  const outcomes = useMemo(() => maestroProposalOutcomes(messages), [messages])
  const friendlyError = useCallback(
    (value: string) => {
      const known: Record<string, string> = {
        'maestro-configurator-busy': t('maestro.configurator.errorBusy'),
        'maestro-configurator-empty-message': t('maestro.configurator.errorEmpty'),
        'maestro-configurator-stale-draft': t('maestro.configurator.errorStale'),
        'maestro-configurator-no-model': t('maestro.configurator.errorNoModel'),
        'maestro-configurator-no-vision': t('maestro.configurator.errorNoVision'),
        'maestro-configurator-invalid-image': t('maestro.configurator.errorInvalidImage'),
        'maestro-configurator-image-failed': t('maestro.configurator.errorImageFailed'),
      }
      return known[value] ?? value
    },
    [t]
  )

  useEffect(() => {
    imagesRef.current = images
  }, [images])
  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl)), [])

  const addImageFiles = useCallback(
    (files: File[]) => {
      void (async () => {
        const accepted: DraftImage[] = []
        let count = imagesRef.current.length
        let total = imagesRef.current.reduce((sum, image) => sum + image.bytes.byteLength, 0)
        let rejected = false
        for (const file of files) {
          if (
            !IMAGE_TYPES.includes(file.type) ||
            file.size > MAX_ATTACHMENT_IMAGE_BYTES ||
            count >= MAESTRO_CONFIGURATOR_MAX_IMAGES ||
            total + file.size > MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE
          ) {
            rejected = true
            continue
          }
          const bytes = new Uint8Array(await file.arrayBuffer())
          count += 1
          total += bytes.byteLength
          accepted.push({
            id: crypto.randomUUID(),
            name: file.name || 'image',
            mediaType: file.type,
            bytes,
            previewUrl: URL.createObjectURL(file),
          })
        }
        if (rejected) setError(t('maestro.configurator.imageRejected', { max: MAESTRO_CONFIGURATOR_MAX_IMAGES }))
        if (!accepted.length) return
        setImages((current) => {
          const room = Math.max(0, MAESTRO_CONFIGURATOR_MAX_IMAGES - current.length)
          accepted.slice(room).forEach((image) => URL.revokeObjectURL(image.previewUrl))
          return [...current, ...accepted.slice(0, room)]
        })
      })()
    },
    [t]
  )

  const removeImage = (id: string) =>
    setImages((current) => {
      const removed = current.find((image) => image.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return current.filter((image) => image.id !== id)
    })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const state = await api.chatMaestroConfiguratorState()
      setMessages(state.thread.messages)
      setProfile(state.profile ?? emptyProfile())
      setProviderCount(state.catalog.providers.length)
      setRunnableProviderIds(state.catalog.providers.map((provider) => provider.id))
      setModelCount(state.catalog.providers.reduce((count, provider) => count + provider.models.length, 0))
      setActiveTurnId(state.activeTurnId)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load, catalogRevision])

  useEffect(() => {
    let alive = true
    setProfileMeta(null)
    if (!profile.providerId || !profile.modelId) return
    void api
      .chatSubagentProfilesModelMeta(profile.providerId, profile.modelId)
      .then((value) => alive && setProfileMeta(value))
      .catch(() => alive && setProfileMeta({ status: 'unavailable', meta: null }))
    return () => {
      alive = false
    }
  }, [api, profile.providerId, profile.modelId, catalogRevision])

  useEffect(
    () =>
      api.onChatMaestroConfiguratorEvent((event) => {
        if (event.kind === 'reset') {
          terminalTurns.current.clear()
          setMessages([])
          setActiveTurnId(null)
          setStreamingText('')
          setProgress(null)
          setError(null)
          return
        }
        if (event.kind === 'text-update') {
          setActiveTurnId((current) => current ?? event.turnId)
          setStreamingText((current) =>
            event.update.kind === 'append' ? current + event.update.text : event.update.text
          )
          return
        }
        if (event.kind === 'progress') {
          setProgress(event.message)
          return
        }
        if (event.kind === 'message') {
          setMessages((current) => mergeMessage(current, event.message))
          return
        }
        if (event.kind === 'completed') {
          terminalTurns.current.add(event.turnId)
          setMessages((current) => mergeMessage(current, event.message))
          setActiveTurnId(null)
          setStreamingText('')
          setProgress(null)
          return
        }
        if (event.kind === 'cancelled') {
          terminalTurns.current.add(event.turnId)
          setActiveTurnId(null)
          setStreamingText('')
          setProgress(null)
          return
        }
        terminalTurns.current.add(event.turnId)
        setActiveTurnId(null)
        setStreamingText('')
        setProgress(null)
        setError(friendlyError(event.error))
      }),
    [api, friendlyError]
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streamingText, progress])

  const persistProfile = useCallback(
    (next: MaestroConfiguratorProfile) => {
      setProfile(next)
      setError(null)
      if (!next.providerId || !next.modelId || !next.effort) return
      const revision = ++profileRevision.current
      void api
        .chatMaestroConfiguratorSetProfile(next)
        .then((result) => {
          if (revision !== profileRevision.current) return
          if (result.ok) setProfile(result.profile)
          else setError(result.errors.join(' '))
        })
        .catch((reason) => {
          if (revision === profileRevision.current) setError(reason instanceof Error ? reason.message : String(reason))
        })
    },
    [api]
  )

  useEffect(() => {
    if (profile.fastMode !== true || profileMeta?.status !== 'available') return
    if (profileMeta.meta?.fastModeCapability !== true) persistProfile({ ...profile, fastMode: undefined })
  }, [persistProfile, profile, profileMeta])

  const send = async (text = draftText) => {
    const normalized = text.trim()
    const attached = imagesRef.current
    if ((!normalized && attached.length === 0) || activeTurnId) return
    if (!prepared.ok) {
      setError(prepared.errors.map((item) => item.message).join(' '))
      return
    }
    setError(null)
    setProgress(null)
    setStreamingText('')
    try {
      const result = await api.chatMaestroConfiguratorSend({
        text: normalized,
        draft,
        baseHash: prepared.value.baseHash,
        ...(attached.length
          ? { images: attached.map(({ name, mediaType, bytes }) => ({ name, mediaType, bytes })) }
          : {}),
      })
      if (!result.ok) {
        setError(friendlyError(result.error))
        return
      }
      setMessages((current) => mergeMessage(current, result.userMessage))
      setActiveTurnId(terminalTurns.current.has(result.turnId) ? null : result.turnId)
      setDraftText('')
      attached.forEach((image) => URL.revokeObjectURL(image.previewUrl))
      setImages((current) => current.filter((image) => !attached.includes(image)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const onComposerDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (activeTurnId || !hasDraggedFiles(Array.from(event.dataTransfer.types))) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }
  const onComposerDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false)
  }
  const onComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    if (activeTurnId || !hasDraggedFiles(Array.from(event.dataTransfer.types))) return
    event.preventDefault()
    setDropActive(false)
    addImageFiles(Array.from(event.dataTransfer.files))
  }

  const reset = async () => {
    if (messages.length > 0 && !ownerWindow.confirm(t('maestro.configurator.confirmReset'))) return
    try {
      await api.chatMaestroConfiguratorReset()
      setMessages([])
      setActiveTurnId(null)
      setStreamingText('')
      setProgress(null)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const suggestions = useMemo(
    () => [
      t('maestro.configurator.suggestionBuild'),
      t('maestro.configurator.suggestionQuality'),
      t('maestro.configurator.suggestionReplace'),
    ],
    [t]
  )
  const providerFilter = useCallback(
    (providerId: string) => runnableProviderIds.includes(providerId),
    [runnableProviderIds]
  )
  const selection: ChatModelRef | null =
    profile.providerId && profile.modelId ? { providerId: profile.providerId, modelId: profile.modelId } : null
  const efforts = subagentProfileEffortIds(profileMeta)
  const modelReady = Boolean(selection)
  const catalogHint = t('maestro.configurator.catalogCount', { providers: providerCount, models: modelCount })

  const modelControls = (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <ChatModelChip
        value={selection}
        providerFilter={providerFilter}
        avoidOverflow
        onSelect={(next) => persistProfile({ providerId: next.providerId, modelId: next.modelId, effort: 'off' })}
      />
      {efforts.length > 0 && (
        <ChatReasoningPicker
          value={profile.effort}
          efforts={efforts}
          allowUltra={false}
          avoidOverflow
          onChange={(effort) => persistProfile({ ...profile, effort: effort || 'off' })}
        />
      )}
      {profileMeta?.status === 'available' && profileMeta.meta?.fastModeCapability === true && (
        <FastModeChip
          enabled={profile.fastMode === true}
          onToggle={() => persistProfile({ ...profile, fastMode: profile.fastMode === true ? undefined : true })}
        />
      )}
    </div>
  )

  return (
    <section aria-label={t('maestro.configurator.title')} className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-3 pb-2 pt-2">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-4 shrink-0 text-amber-300" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{t('maestro.configurator.title')}</p>
            <p className="truncate text-xs text-muted-foreground">
              {t('maestro.configurator.scope', { name: scopeLabel })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            title={`${t('maestro.configurator.refreshCatalog')} · ${catalogHint}`}
            aria-label={t('maestro.configurator.refreshCatalog')}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </button>
          <button
            type="button"
            onClick={() => void reset()}
            title={t('maestro.configurator.newThread')}
            aria-label={t('maestro.configurator.newThread')}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
          >
            <RotateCcw className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('maestro.close')}
            aria-label={t('maestro.close')}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">{t('maestro.configurator.modelLabel')}</span>
          {modelControls}
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" aria-live="polite">
        {!loading && messages.length === 0 && !activeTurnId && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">{t('maestro.configurator.emptyTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('maestro.configurator.empty')}</p>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                disabled={!modelReady}
                onClick={() => void send(suggestion)}
                className="block w-full rounded-lg border border-border bg-white/[0.02] px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-white/[0.05] hover:text-foreground disabled:opacity-40"
              >
                {suggestion}
              </button>
            ))}
            <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground/80">
              <ImageIcon className="size-3.5" aria-hidden="true" /> {t('maestro.configurator.imageHint')}
            </p>
          </div>
        )}
        {messages.map((message) =>
          message.role === 'event' && message.event ? (
            <p
              key={message.id}
              className="flex items-center gap-2 text-center text-xs text-muted-foreground before:h-px before:min-w-3 before:flex-1 before:bg-border after:h-px after:min-w-3 after:flex-1 after:bg-border"
            >
              {eventLabel(message.event, t)}
            </p>
          ) : (
            <div
              key={message.id}
              className={cn(
                'text-sm',
                message.role === 'user'
                  ? 'ml-auto max-w-[88%] rounded-lg border border-primary/25 bg-primary/[0.12] px-3 py-2 text-foreground'
                  : 'mr-auto max-w-full text-foreground/90'
              )}
            >
              {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
              {message.images && message.images.length > 0 && (
                <ul className={cn('flex flex-wrap gap-1', message.text && 'mt-1.5')}>
                  {message.images.map((image, index) => (
                    <li
                      key={`${image.name}-${index}`}
                      title={
                        image.descriptionModel
                          ? t('maestro.configurator.imageTranscribed', { model: image.descriptionModel })
                          : t('maestro.configurator.imageUnread')
                      }
                      className="inline-flex max-w-full items-center gap-1 rounded bg-white/[0.06] px-1.5 py-0.5 text-xs text-muted-foreground"
                    >
                      <ImageIcon className="size-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{image.name}</span>
                    </li>
                  ))}
                </ul>
              )}
              {message.proposal && (
                <ProposalCard
                  proposal={message.proposal}
                  outcome={outcomes.get(message.proposal.id) ?? { status: 'pending' }}
                  stale={message.proposal.baseHash !== draftHash}
                  reviewing={reviewingProposalId === message.proposal.id}
                  canReview={reviewingProposalId === null}
                  canRedo={!activeTurnId && modelReady}
                  onReview={() => onReview(message.proposal!)}
                  onRedo={() =>
                    void send(t('maestro.configurator.redoRequest', { summary: message.proposal!.summary }))
                  }
                />
              )}
            </div>
          )
        )}
        {activeTurnId && (
          <div className="mr-auto max-w-full text-sm text-foreground/90">
            {streamingText ? (
              <p className="whitespace-pre-wrap break-words">{streamingText}</p>
            ) : (
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> {t('maestro.configurator.thinking')}
              </p>
            )}
            {progress && <p className="mt-1 text-xs text-muted-foreground">{progress}</p>}
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="mx-3 mb-2 rounded border border-red-500/20 bg-red-500/[0.08] p-2 text-xs text-red-300"
        >
          {error}
        </p>
      )}

      {unfinishedCandidates > 0 && (
        <p className="mx-3 mb-2 text-xs text-amber-300">
          {t('maestro.configurator.unfinishedCandidates', { count: unfinishedCandidates })}
        </p>
      )}

      <div className="border-t border-border p-2.5">
        <label className="sr-only" htmlFor="maestro-configurator-composer">
          {t('maestro.configurator.composerLabel')}
        </label>
        <div
          className={cn(
            'relative rounded-lg border border-border bg-black/20 px-2 pb-1.5 pt-2 focus-within:border-primary/50',
            dropActive && 'border-dashed border-primary/60'
          )}
          onDragEnter={onComposerDragOver}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          {images.length > 0 && (
            <ul className="mb-1.5 flex flex-wrap gap-1.5">
              {images.map((image) => (
                <li key={image.id} className="relative">
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    className="size-12 rounded-md border border-border object-cover"
                  />
                  <button
                    type="button"
                    aria-label={t('maestro.configurator.removeImage', { name: image.name })}
                    title={t('maestro.configurator.removeImage', { name: image.name })}
                    onClick={() => removeImage(image.id)}
                    className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            id="maestro-configurator-composer"
            value={draftText}
            rows={2}
            disabled={!!activeTurnId || !modelReady}
            placeholder={t('maestro.configurator.placeholder')}
            onChange={(event) => setDraftText(event.target.value)}
            onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
              const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
              if (!files.length) return
              event.preventDefault()
              addImageFiles(files)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              void send()
            }}
            className="min-h-10 w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            multiple
            hidden
            onChange={(event) => {
              addImageFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />

          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              aria-label={t('maestro.configurator.attachImage')}
              title={t('maestro.configurator.attachImage')}
              disabled={!!activeTurnId || !modelReady || images.length >= MAESTRO_CONFIGURATOR_MAX_IMAGES}
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground disabled:opacity-40"
            >
              <ImagePlus className="size-3.5" />
            </button>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
              {t('maestro.configurator.composerHint')}
            </span>
            {activeTurnId ? (
              <button
                type="button"
                aria-label={t('maestro.configurator.stop')}
                onClick={() => void api.chatMaestroConfiguratorCancel(activeTurnId)}
                className="shrink-0 rounded-md bg-red-500/15 p-1.5 text-red-300 hover:bg-red-500/25"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                aria-label={t('maestro.configurator.send')}
                disabled={(!draftText.trim() && images.length === 0) || !modelReady}
                onClick={() => void send()}
                className="shrink-0 rounded-md bg-primary p-1.5 text-primary-foreground disabled:opacity-40"
              >
                <Send className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
