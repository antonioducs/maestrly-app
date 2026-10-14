import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList, Clock, FileCode, Loader2, Lock, Route, UserRound } from 'lucide-react'
import {
  CHATGPT_WEB_PROVIDER_ID,
  type ChatModelMeta,
  type ChatModelRef,
  type ChatReasoningEffort,
} from '../../../../shared/chat'
import type { ReviewModelChoice, ReviewPrepareResult, ReviewTarget } from '../../../../shared/review'
import { Button } from '@/components/ui/button'
import { ChatModelChip } from '@/components/chat/ChatModelChip'
import { ChatReasoningPicker } from '@/components/chat/ChatReasoningPicker'
import { FastModeChip } from '@/components/chat/ChatFastModeToggle'
import { useHostApi } from '@/lib/hosts/host-context'
import { initialReviewerChoice, reviewErrorText, reviewModelLabel } from '@/lib/review'
import { cn } from '@/lib/utils'
import { LANE_STYLE } from './review-style'

const selectionKey = (selection: ChatModelRef | null): string =>
  selection ? `${selection.providerId}\0${selection.modelId}` : ''

// ChatGPT Web runs in the browser and cannot run reviewers.
const reviewerProvider = (providerId: string): boolean => providerId !== CHATGPT_WEB_PROVIDER_ID

function Card({ icon: Icon, title, children }: { icon: typeof FileCode; title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-white/[0.07] bg-[#16161b] p-4">
      <h3 className="mb-3 flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
      </h3>
      {children}
    </section>
  )
}

/**
 * First stage of a review: what will be reviewed, who reviews it and how the review runs. Nothing runs and the
 * conversation is not held until the person starts the review.
 */
export function ReviewScopeStage({
  conversationId,
  target,
  onStart,
  onBack,
}: {
  conversationId: string
  target: ReviewTarget
  /** Starts the review; resolves to why it could not start, or null. */
  onStart: (reviewer?: ReviewModelChoice) => Promise<string | null>
  onBack: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [prepared, setPrepared] = useState<ReviewPrepareResult | null>(null)
  const [useConversation, setUseConversation] = useState(true)
  const [lastUsed, setLastUsed] = useState<'conversation' | 'model' | null>(null)
  const [selection, setSelection] = useState<ChatModelRef | null>(null)
  const [reasoning, setReasoning] = useState<ChatReasoningEffort>('off')
  const [fastMode, setFastMode] = useState(false)
  const [meta, setMeta] = useState<{ key: string; value: ChatModelMeta | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const metaGeneration = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setPrepared(null)
    setError(null)
    void api
      .chatReviewPrepare(conversationId, target)
      .catch(
        (cause): ReviewPrepareResult => ({ ok: false, error: cause instanceof Error ? cause.message : String(cause) })
      )
      .then((result) => {
        if (!alive) return
        setPrepared(result)
        if (!result.ok) return
        const initial = initialReviewerChoice(result.reviewer)
        setLastUsed(result.reviewer.last?.kind ?? null)
        setUseConversation(initial.useConversation)
        setSelection(initial.choice ? { providerId: initial.choice.providerId, modelId: initial.choice.modelId } : null)
        setReasoning((initial.choice?.reasoning || 'off') as ChatReasoningEffort)
        setFastMode(initial.choice?.fastMode === true)
      })
    return () => {
      alive = false
    }
  }, [api, conversationId, target])

  useEffect(() => rootRef.current?.focus(), [])

  const currentKey = selectionKey(selection)
  useEffect(() => {
    if (!selection) return
    const generation = ++metaGeneration.current
    const key = selectionKey(selection)
    void api
      .chatModelMeta(selection.modelId, selection.providerId)
      .catch(() => null)
      .then((value) => {
        // A late answer for a previous model must never unlock starting with the current one.
        if (metaGeneration.current === generation) setMeta({ key, value })
      })
  }, [selection, api])

  const currentMeta = meta?.key === currentKey ? meta.value : null
  const metaReady = !!selection && meta?.key === currentKey
  const efforts = useMemo(
    () => (currentMeta?.reasoning && currentMeta.reasoningEfforts?.length ? currentMeta.reasoningEfforts : []),
    [currentMeta]
  )
  const fastAvailable = currentMeta?.fastModeCapability === true
  useEffect(() => {
    if (!metaReady) return
    if (!efforts.length) setReasoning('off')
    if (!fastAvailable) setFastMode(false)
  }, [efforts.length, fastAvailable, metaReady])

  const ready = prepared?.ok ? prepared : null
  const conversationModel = ready?.reviewer.conversation ?? null
  const canStart = !busy && !!ready && (useConversation ? !!conversationModel : metaReady && !!selection)
  const reviewerName = useConversation ? conversationModel?.modelId : selection?.modelId

  const start = useCallback(async () => {
    if (!canStart) return
    const reviewer =
      useConversation || !selection
        ? undefined
        : {
            providerId: selection.providerId,
            modelId: selection.modelId,
            reasoning: efforts.length ? reasoning || 'off' : 'off',
            fastMode: fastAvailable && fastMode,
          }
    setBusy(true)
    setError(null)
    const failure = await onStart(reviewer)
    setBusy(false)
    if (failure) setError(reviewErrorText(t, failure))
  }, [canStart, efforts.length, fastAvailable, fastMode, onStart, reasoning, selection, t, useConversation])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const element = event.target as HTMLElement
    if (element.closest('input, textarea, [role="listbox"], [role="menu"]')) return
    if (event.key === 'Enter' && !element.closest('button')) {
      event.preventDefault()
      void start()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onBack()
    }
  }

  const lenses = ready?.lenses ?? []
  let what: ReactNode = (
    <div className="flex h-16 items-center gap-2 text-[12.5px] text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" /> {t('review.room.loadingScope')}
    </div>
  )
  if (ready?.scope.kind === 'code') {
    const scope = ready.scope
    const largest = Math.max(1, ...scope.files.map((file) => (file.added ?? 0) + (file.deleted ?? 0)))
    what = (
      <>
        <ul className="mb-3 flex flex-col gap-2.5">
          {scope.files.map((file) => {
            const total = (file.added ?? 0) + (file.deleted ?? 0)
            return (
              <li key={file.path} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1">
                <span title={file.path} className="truncate font-mono text-[12px] text-foreground">
                  {file.path}
                </span>
                <span className="flex items-center gap-1.5 font-mono text-[11.5px]">
                  {file.isNew && (
                    <span className="rounded border border-white/[0.12] px-1.5 font-sans text-[10.5px] text-muted-foreground">
                      {t('review.room.newFile')}
                    </span>
                  )}
                  {file.added === undefined ? (
                    <span className="text-muted-foreground">{t('review.room.binary')}</span>
                  ) : (
                    <>
                      <span className="text-emerald-400">+{file.added}</span>
                      <span className="text-red-400">−{file.deleted ?? 0}</span>
                    </>
                  )}
                </span>
                <span
                  aria-hidden
                  className="col-span-2 flex h-[3px] overflow-hidden rounded-full bg-white/[0.05]"
                  style={{ width: `${Math.max(4, (total / largest) * 100)}%` }}
                >
                  <i
                    className="bg-emerald-400"
                    style={{ width: `${total ? ((file.added ?? 0) / total) * 100 : 0}%` }}
                  />
                  <i className="bg-red-400" style={{ width: `${total ? ((file.deleted ?? 0) / total) * 100 : 0}%` }} />
                </span>
              </li>
            )
          })}
        </ul>
        {scope.filesTotal > scope.files.length && (
          <p className="mb-1.5 text-[12px] text-muted-foreground">
            {t('review.room.moreFiles', { count: scope.filesTotal - scope.files.length })}
          </p>
        )}
        <p className="text-[12px] leading-snug text-muted-foreground">
          {t('review.room.codeScopeNote', { head: scope.head.slice(0, 7) })}
        </p>
      </>
    )
  } else if (ready?.scope.kind === 'plan') {
    const scope = ready.scope
    what = (
      <>
        <div className="mb-3 rounded-lg border border-white/[0.07] bg-[#111115] px-3 py-2.5 text-[13px] text-foreground/85">
          {scope.title && <b className="mb-1.5 block font-medium text-foreground">{scope.title}</b>}
          {scope.steps.length > 0 && (
            <ol className="flex list-decimal flex-col gap-1 pl-4.5">
              {scope.steps.map((step, index) => (
                <li key={`${index}:${step}`}>{step}</li>
              ))}
            </ol>
          )}
        </div>
        <p className="text-[12px] leading-snug text-muted-foreground">
          {t('review.room.planScopeNote', { version: scope.version })}
        </p>
      </>
    )
  }

  const choice = (conversation: boolean) => {
    const checked = useConversation === conversation
    const disabled = conversation && !conversationModel
    return (
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={busy || disabled || !ready}
        onClick={() => setUseConversation(conversation)}
        className={cn(
          'flex min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50',
          checked ? 'border-sky-300/55 bg-sky-300/[0.06]' : 'border-white/[0.1] hover:border-white/[0.2]'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border-[1.5px]',
            checked ? 'border-sky-300' : 'border-white/[0.25]'
          )}
        >
          {checked && <span className="size-1.5 rounded-full bg-sky-300" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-foreground">
            {t(conversation ? 'review.reviewerConversation' : 'review.reviewerOther')}
          </span>
          <span
            className={cn(
              'block text-[12px] leading-snug text-muted-foreground',
              conversation ? 'truncate' : 'line-clamp-2'
            )}
          >
            {conversation
              ? conversationModel
                ? reviewModelLabel(conversationModel)
                : t('review.reviewerConversationMissing')
              : t('review.reviewerOtherHint')}
          </span>
        </span>
        {lastUsed === (conversation ? 'conversation' : 'model') && (
          <span className="shrink-0 rounded border border-white/[0.12] px-1.5 text-[10.5px] leading-4 text-muted-foreground">
            {t('review.room.lastUsed')}
          </span>
        )}
      </button>
    )
  }

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col outline-none">
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {prepared && !prepared.ok ? (
          <div
            role="alert"
            className="mx-auto mt-8 max-w-md rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-4 text-[13px] text-amber-100"
          >
            {t('review.startFailed', { reason: reviewErrorText(t, prepared.error) })}
          </div>
        ) : (
          <div className="mx-auto grid max-w-[1180px] gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(290px,1fr))]">
            <Card icon={target === 'code' ? FileCode : ClipboardList} title={t('review.room.whatTitle')}>
              {what}
            </Card>
            <Card icon={UserRound} title={t('review.room.whoTitle')}>
              <div role="radiogroup" aria-label={t('review.room.whoTitle')} className="flex flex-col gap-2">
                {choice(true)}
                {choice(false)}
              </div>
              {!useConversation && ready && (
                <div
                  data-testid="review-reviewer-settings"
                  className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1 rounded-lg border border-white/[0.1] bg-black/20 p-2"
                >
                  <ChatModelChip
                    value={selection}
                    avoidOverflow
                    providerFilter={reviewerProvider}
                    onSelect={(next) => {
                      setSelection(next)
                      setMeta(null)
                    }}
                  />
                  {metaReady && efforts.length > 0 && (
                    <ChatReasoningPicker
                      value={reasoning}
                      efforts={efforts}
                      nativeUltraMode={currentMeta?.nativeUltraMode === true}
                      allowUltra={false}
                      avoidOverflow
                      onChange={setReasoning}
                    />
                  )}
                  {metaReady && fastAvailable && (
                    <FastModeChip enabled={fastMode} onToggle={() => setFastMode((value) => !value)} />
                  )}
                  {selection && !metaReady && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                  {!selection && (
                    <span className="px-1 text-[12px] text-muted-foreground">{t('review.reviewerChooseModel')}</span>
                  )}
                </div>
              )}
            </Card>
            <Card icon={Route} title={t('review.room.howTitle')}>
              <ol className="mb-3.5 flex flex-col gap-3">
                <li className="grid grid-cols-[22px_1fr] gap-2.5 text-[13px]">
                  <span className="grid size-[22px] place-items-center rounded-full border border-white/[0.12] text-[11px] text-muted-foreground">
                    1
                  </span>
                  <div>
                    <b className="font-medium">
                      {t('review.room.howReviewers', { count: lenses.length || (target === 'code' ? 3 : 2) })}
                    </b>
                    <small className="block text-[12px] leading-snug text-muted-foreground">
                      {t('review.room.howReviewersHint')}
                    </small>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {lenses.map((lens) => {
                        const { color, icon: Icon } = LANE_STYLE[lens]
                        return (
                          <span
                            key={lens}
                            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] text-foreground/85"
                            style={{ borderColor: `${color}59`, background: `${color}14` }}
                          >
                            <Icon className="size-3" style={{ color }} />
                            {t(`review.lens.${lens}`)}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                </li>
                <li className="grid grid-cols-[22px_1fr] gap-2.5 text-[13px]">
                  <span className="grid size-[22px] place-items-center rounded-full border border-white/[0.12] text-[11px] text-muted-foreground">
                    2
                  </span>
                  <div>
                    <b className="font-medium">{t('review.room.howVerifier')}</b>
                    <small className="block text-[12px] leading-snug text-muted-foreground">
                      {t('review.room.howVerifierHint')}
                    </small>
                  </div>
                </li>
                <li className="grid grid-cols-[22px_1fr] gap-2.5 text-[13px]">
                  <span className="grid size-[22px] place-items-center rounded-full border border-white/[0.12] text-[11px] text-muted-foreground">
                    3
                  </span>
                  <div>
                    <b className="font-medium">{t('review.room.howDecide')}</b>
                    <small className="block text-[12px] leading-snug text-muted-foreground">
                      {t(target === 'code' ? 'review.room.howDecideCode' : 'review.room.howDecidePlan')}
                    </small>
                  </div>
                </li>
              </ol>
              <div className="flex items-center gap-2 border-t border-white/[0.07] pt-3 text-[12px] text-muted-foreground">
                <Clock className="size-3.5 shrink-0" />
                <span>
                  {t('review.room.estimate', {
                    runs: (lenses.length || (target === 'code' ? 3 : 2)) + 1,
                    model: reviewerName ?? '',
                  })}
                </span>
              </div>
            </Card>
          </div>
        )}
      </div>
      <footer className="flex flex-wrap items-center gap-2.5 border-t border-white/[0.07] bg-black/40 px-4 py-2.5 text-[12.5px]">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
          <Lock className="size-3.5 shrink-0 text-amber-300" />
          {t('review.room.lockNote')}
        </span>
        {error && (
          <span role="alert" className="w-full text-[12px] text-red-300 sm:w-auto">
            {error}
          </span>
        )}
        <Button disabled={!canStart} onClick={() => void start()} data-testid="review-start">
          {busy && <Loader2 className="size-4 animate-spin" />}
          {t('review.start')}
          <kbd className="ml-1 rounded border border-black/20 px-1 font-mono text-[10px] opacity-70">⏎</kbd>
        </Button>
      </footer>
    </div>
  )
}
