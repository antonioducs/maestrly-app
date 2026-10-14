import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ScanSearch } from 'lucide-react'
import {
  CHATGPT_WEB_PROVIDER_ID,
  type ChatModelMeta,
  type ChatModelRef,
  type ChatReasoningEffort,
} from '../../../shared/chat'
import type { ReviewModelChoice, ReviewReviewerOptions, ReviewTarget } from '../../../shared/review'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ChatModelChip } from '@/components/chat/ChatModelChip'
import { ChatReasoningPicker } from '@/components/chat/ChatReasoningPicker'
import { FastModeChip } from '@/components/chat/ChatFastModeToggle'
import { useHostApi } from '@/lib/hosts/host-context'
import { initialReviewerChoice, reviewErrorText, reviewModelLabel } from '@/lib/review'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  conversationId: string
  target: ReviewTarget
  onOpenChange(open: boolean): void
  /** Starts the review; resolves to why it could not start, or null. Without a reviewer, the conversation's model runs. */
  onStart(reviewer?: ReviewModelChoice): Promise<string | null>
}

const selectionKey = (selection: ChatModelRef | null): string =>
  selection ? `${selection.providerId}\0${selection.modelId}` : ''

// ChatGPT Web runs in the browser and cannot run reviewers.
const reviewerProvider = (providerId: string): boolean => providerId !== CHATGPT_WEB_PROVIDER_ID

/**
 * Chooses who reviews before a review starts: the conversation's own model, or another model with its effort and Fast
 * setting. The last choice is offered first; main validates the model again before anything runs.
 */
export function ReviewStartDialog({ open, conversationId, target, onOpenChange, onStart }: Props) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [options, setOptions] = useState<ReviewReviewerOptions | null>(null)
  const [loading, setLoading] = useState(false)
  const [useConversation, setUseConversation] = useState(true)
  const [selection, setSelection] = useState<ChatModelRef | null>(null)
  const [reasoning, setReasoning] = useState<ChatReasoningEffort>('off')
  const [fastMode, setFastMode] = useState(false)
  const [meta, setMeta] = useState<{ key: string; value: ChatModelMeta | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const metaGeneration = useRef(0)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError(null)
    setBusy(false)
    setMeta(null)
    void api
      .chatReviewReviewerOptions(conversationId)
      .then((loaded) => {
        if (!alive) return
        const initial = initialReviewerChoice(loaded)
        setOptions(loaded)
        setUseConversation(initial.useConversation)
        setSelection(initial.choice ? { providerId: initial.choice.providerId, modelId: initial.choice.modelId } : null)
        setReasoning((initial.choice?.reasoning || 'off') as ChatReasoningEffort)
        setFastMode(initial.choice?.fastMode === true)
      })
      .catch((cause) => alive && setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, conversationId, api])

  const currentKey = selectionKey(selection)
  useEffect(() => {
    if (!open || !selection) return
    const generation = ++metaGeneration.current
    const key = selectionKey(selection)
    void api
      .chatModelMeta(selection.modelId, selection.providerId)
      .catch(() => null)
      .then((value) => {
        // A late answer for a previous model must never unlock starting with the current one.
        if (metaGeneration.current === generation) setMeta({ key, value })
      })
  }, [open, selection, api])

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

  const conversationModel = options?.conversation ?? null
  const canStart = !busy && !loading && (useConversation ? !!conversationModel : metaReady && !!selection && !!options)

  const start = async () => {
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
    else onOpenChange(false)
  }

  const choices = [
    {
      conversation: true,
      label: t('review.reviewerConversation'),
      hint: conversationModel ? reviewModelLabel(conversationModel) : t('review.reviewerConversationMissing'),
      disabled: !conversationModel,
    },
    { conversation: false, label: t('review.reviewerOther'), hint: t('review.reviewerOtherHint'), disabled: false },
  ]

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-lg" data-testid="review-start-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanSearch className="size-4 text-primary" />
            {target === 'code' ? t('review.dialogTitleCode') : t('review.dialogTitlePlan')}
          </DialogTitle>
          <DialogDescription>
            {target === 'code' ? t('review.dialogDescriptionCode') : t('review.dialogDescriptionPlan')}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-20 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('review.dialogLoading')}
          </div>
        ) : (
          <div className="space-y-3">
            <p id="review-reviewer-label" className="text-xs font-medium text-foreground">
              {t('review.reviewerLabel')}
            </p>
            <div role="radiogroup" aria-labelledby="review-reviewer-label" className="grid gap-2">
              {choices.map((choice) => {
                const checked = useConversation === choice.conversation
                return (
                  <button
                    key={String(choice.conversation)}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={busy || choice.disabled}
                    onClick={() => setUseConversation(choice.conversation)}
                    className={cn(
                      'flex min-w-0 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
                      checked
                        ? 'border-primary/50 bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <span className="text-xs font-medium">{choice.label}</span>
                    <span className="max-w-full truncate text-[11px] leading-snug text-muted-foreground">
                      {choice.hint}
                    </span>
                  </button>
                )
              })}
            </div>

            {!useConversation && (
              <div className="space-y-1.5">
                <div
                  data-testid="review-reviewer-settings"
                  className="flex min-w-0 flex-wrap items-center gap-1 rounded-lg border border-border bg-black/20 p-2"
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
                      avoidOverflow
                      onChange={setReasoning}
                    />
                  )}
                  {metaReady && fastAvailable && (
                    <FastModeChip enabled={fastMode} onToggle={() => setFastMode((value) => !value)} />
                  )}
                  {selection && !metaReady && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                </div>
                {!selection && <p className="text-xs text-muted-foreground">{t('review.reviewerChooseModel')}</p>}
              </div>
            )}

            <p className="text-[11px] leading-snug text-muted-foreground">
              {target === 'code' ? t('review.runsCode') : t('review.runsPlan')}
            </p>

            {error && (
              <p role="alert" className="rounded border border-red-500/20 bg-red-500/[0.08] p-2 text-xs text-red-300">
                {t('review.startFailed', { reason: error })}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('review.cancel')}
          </Button>
          <Button disabled={!canStart} onClick={() => void start()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('review.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
