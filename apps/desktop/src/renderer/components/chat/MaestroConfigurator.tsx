import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, RefreshCw, RotateCcw, Send, Sparkles, Square, X } from 'lucide-react'
import type { ChatModelRef } from '../../../shared/chat'
import { cloneMaestroConfig, type MaestroConfigV1 } from '../../../shared/maestro'
import {
  hashMaestroConfig,
  type MaestroConfiguratorChange,
  type MaestroConfiguratorMessage,
  type MaestroConfiguratorProfile,
  type MaestroConfiguratorProposal,
} from '../../../shared/maestro-configurator'
import type { SubagentProfileModelMetaResult } from '../../../shared/subagent-profile-effort'
import { subagentProfileEffortIds } from '@/lib/subagent-profile-editor'
import { cn } from '@/lib/utils'
import { ChatModelChip } from './ChatModelChip'
import { ChatReasoningPicker } from './ChatReasoningPicker'
import { FastModeChip } from './ChatFastModeToggle'

const emptyProfile = (): MaestroConfiguratorProfile => ({ providerId: '', modelId: '', effort: 'off' })

const candidateLabel = (candidate: { providerId: string; modelId: string; effort: string; fastMode?: boolean }) =>
  `${candidate.providerId} / ${candidate.modelId} · ${candidate.effort}${candidate.fastMode ? ' · Fast' : ''}`

const mergeMessage = (messages: MaestroConfiguratorMessage[], message: MaestroConfiguratorMessage) =>
  (messages.some((current) => current.id === message.id) ? messages : [...messages, message]).sort(
    (left, right) => left.createdAt - right.createdAt
  )

function changeLabel(change: MaestroConfiguratorChange, t: (key: string, options?: Record<string, unknown>) => string) {
  switch (change.kind) {
    case 'strategy':
      return t('maestro.configurator.diffStrategy', { before: change.before, after: change.after })
    case 'resource-added':
      return t('maestro.configurator.diffResourceAdded', { label: change.label })
    case 'resource-removed':
      return t('maestro.configurator.diffResourceRemoved', { label: change.label })
    case 'resource-field':
      return t('maestro.configurator.diffResourceField', { label: change.label, field: change.field })
    case 'candidate-added':
      return t('maestro.configurator.diffCandidateAdded', {
        label: change.label,
        candidate: candidateLabel(change.candidate),
      })
    case 'candidate-removed':
      return t('maestro.configurator.diffCandidateRemoved', {
        label: change.label,
        candidate: candidateLabel(change.candidate),
      })
    case 'candidate-replaced':
      return t('maestro.configurator.diffCandidateReplaced', {
        label: change.label,
        before: candidateLabel(change.before),
        after: candidateLabel(change.after),
      })
  }
}

function ProposalCard({
  proposal,
  draft,
  applied,
  onApply,
}: {
  proposal: MaestroConfiguratorProposal
  draft: MaestroConfigV1
  applied: boolean
  onApply: () => void
}) {
  const { t } = useTranslation('chat')
  const stale = proposal.baseHash !== hashMaestroConfig(draft)
  const visible = proposal.changes.slice(0, 12)
  return (
    <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{t('maestro.configurator.proposalTitle')}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{proposal.summary}</p>
        </div>
      </div>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        {visible.map((change, index) => (
          <li key={`${change.kind}-${index}`} className="flex gap-1.5">
            <span aria-hidden="true">•</span>
            <span>{changeLabel(change, t)}</span>
          </li>
        ))}
        {proposal.changes.length > visible.length && (
          <li>{t('maestro.configurator.moreChanges', { count: proposal.changes.length - visible.length })}</li>
        )}
      </ul>
      {proposal.diagnostics.map((item, index) => (
        <p key={`${item.message}-${index}`} className="mt-1.5 text-xs text-amber-300">
          {item.message}
        </p>
      ))}
      {stale && !applied && (
        <p className="mt-2 flex items-center gap-1 text-xs text-amber-300">
          <AlertTriangle className="size-3" /> {t('maestro.configurator.staleProposal')}
        </p>
      )}
      <button
        type="button"
        disabled={stale || applied}
        onClick={onApply}
        className="mt-2.5 w-full rounded-md bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
      >
        {applied ? t('maestro.configurator.applied') : t('maestro.configurator.applyDraft')}
      </button>
    </div>
  )
}

export function MaestroConfigurator({
  draft,
  catalogRevision,
  onApply,
  onClose,
}: {
  draft: MaestroConfigV1
  catalogRevision: number
  onApply: (config: MaestroConfigV1) => void
  onClose: () => void
}) {
  const { t } = useTranslation('chat')
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
  const [applied, setApplied] = useState<Set<string>>(() => new Set())
  const profileRevision = useRef(0)
  const terminalTurns = useRef(new Set<string>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const friendlyError = useCallback(
    (value: string) => {
      const known: Record<string, string> = {
        'maestro-configurator-busy': t('maestro.configurator.errorBusy'),
        'maestro-configurator-empty-message': t('maestro.configurator.errorEmpty'),
        'maestro-configurator-stale-draft': t('maestro.configurator.errorStale'),
        'maestro-configurator-no-model': t('maestro.configurator.errorNoModel'),
      }
      return known[value] ?? value
    },
    [t]
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const state = await window.api.chatMaestroConfiguratorState()
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
  }, [])

  useEffect(() => {
    void load()
  }, [load, catalogRevision])

  useEffect(() => {
    let alive = true
    setProfileMeta(null)
    if (!profile.providerId || !profile.modelId) return
    void window.api
      .chatSubagentProfilesModelMeta(profile.providerId, profile.modelId)
      .then((value) => alive && setProfileMeta(value))
      .catch(() => alive && setProfileMeta({ status: 'unavailable', meta: null }))
    return () => {
      alive = false
    }
  }, [profile.providerId, profile.modelId, catalogRevision])

  useEffect(
    () =>
      window.api.onChatMaestroConfiguratorEvent((event) => {
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
    [friendlyError]
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streamingText, progress])

  const persistProfile = useCallback((next: MaestroConfiguratorProfile) => {
    setProfile(next)
    setError(null)
    if (!next.providerId || !next.modelId || !next.effort) return
    const revision = ++profileRevision.current
    void window.api
      .chatMaestroConfiguratorSetProfile(next)
      .then((result) => {
        if (revision !== profileRevision.current) return
        if (result.ok) setProfile(result.profile)
        else setError(result.errors.join(' '))
      })
      .catch((reason) => {
        if (revision === profileRevision.current) setError(reason instanceof Error ? reason.message : String(reason))
      })
  }, [])

  useEffect(() => {
    if (profile.fastMode !== true || profileMeta?.status !== 'available') return
    if (profileMeta.meta?.fastModeCapability !== true) persistProfile({ ...profile, fastMode: undefined })
  }, [persistProfile, profile, profileMeta])

  const send = async (text = draftText) => {
    const normalized = text.trim()
    if (!normalized || activeTurnId) return
    setError(null)
    setProgress(null)
    setStreamingText('')
    try {
      const result = await window.api.chatMaestroConfiguratorSend({
        text: normalized,
        draft,
        baseHash: hashMaestroConfig(draft),
      })
      if (!result.ok) {
        setError(friendlyError(result.error))
        return
      }
      setMessages((current) => mergeMessage(current, result.userMessage))
      setActiveTurnId(terminalTurns.current.has(result.turnId) ? null : result.turnId)
      setDraftText('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const reset = async () => {
    if (messages.length > 0 && !window.confirm(t('maestro.configurator.confirmReset'))) return
    try {
      await window.api.chatMaestroConfiguratorReset()
      setMessages([])
      setActiveTurnId(null)
      setStreamingText('')
      setProgress(null)
      setError(null)
      setApplied(new Set())
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

  return (
    <section className="flex min-h-[420px] flex-col rounded-lg border border-border bg-white/[0.02] xl:h-[min(700px,calc(100vh-250px))]">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Sparkles className="size-4 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{t('maestro.configurator.title')}</p>
          <p className="truncate text-xs text-muted-foreground">{t('maestro.configurator.scope')}</p>
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
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" aria-live="polite">
        {!loading && messages.length === 0 && !activeTurnId && (
          <div className="space-y-2">
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
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              'max-w-[94%] rounded-lg border px-3 py-2 text-sm',
              message.role === 'user'
                ? 'ml-auto border-primary/25 bg-primary/[0.12] text-foreground'
                : 'mr-auto border-border bg-white/[0.03] text-foreground'
            )}
          >
            <p className="whitespace-pre-wrap break-words">{message.text}</p>
            {message.proposal && (
              <ProposalCard
                proposal={message.proposal}
                draft={draft}
                applied={applied.has(message.proposal.id)}
                onApply={() => {
                  onApply(cloneMaestroConfig(message.proposal!.config))
                  setApplied((current) => new Set(current).add(message.proposal!.id))
                }}
              />
            )}
          </div>
        ))}
        {activeTurnId && (
          <div className="mr-auto max-w-[94%] rounded-lg border border-border bg-white/[0.03] px-3 py-2 text-sm text-foreground">
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

      <div className="border-t border-border p-2.5">
        <label className="sr-only" htmlFor="maestro-configurator-composer">
          {t('maestro.configurator.composerLabel')}
        </label>
        <div className="rounded-lg border border-border bg-black/20 px-2 pb-1.5 pt-2 focus-within:border-primary/50">
          <textarea
            id="maestro-configurator-composer"
            value={draftText}
            rows={2}
            disabled={!!activeTurnId || !modelReady}
            placeholder={t('maestro.configurator.placeholder')}
            onChange={(event) => setDraftText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return
              event.preventDefault()
              void send()
            }}
            className="min-h-10 w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />

          <div className="flex min-w-0 items-center gap-1">
            {efforts.length > 0 && (
              <ChatReasoningPicker
                value={profile.effort}
                efforts={efforts}
                allowUltra={false}
                onChange={(effort) => persistProfile({ ...profile, effort: effort || 'off' })}
              />
            )}
            {profileMeta?.status === 'available' && profileMeta.meta?.fastModeCapability === true && (
              <FastModeChip
                enabled={profile.fastMode === true}
                onToggle={() => persistProfile({ ...profile, fastMode: profile.fastMode === true ? undefined : true })}
              />
            )}
            <ChatModelChip
              value={selection}
              providerFilter={providerFilter}
              onSelect={(next) => persistProfile({ providerId: next.providerId, modelId: next.modelId, effort: 'off' })}
            />
            {activeTurnId ? (
              <button
                type="button"
                aria-label={t('maestro.configurator.stop')}
                onClick={() => void window.api.chatMaestroConfiguratorCancel(activeTurnId)}
                className="ml-auto shrink-0 rounded-md bg-red-500/15 p-1.5 text-red-300 hover:bg-red-500/25"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                aria-label={t('maestro.configurator.send')}
                disabled={!draftText.trim() || !modelReady}
                onClick={() => void send()}
                className="ml-auto shrink-0 rounded-md bg-primary p-1.5 text-primary-foreground disabled:opacity-40"
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
