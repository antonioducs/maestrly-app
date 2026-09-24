import { useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, Loader2, MessageSquarePlus, Share2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatModelMeta, ChatModelRef, ChatReasoningEffort } from '../../shared/chat'
import type { ConversationDispatchPlacement, StandardPlanHandoff } from '../../shared/conversation-dispatch'
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
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  /** Conversation that produced the plan; its current settings are the starting point. */
  sourceConversationId: string
  busy: boolean
  decisionError: string | null
  onOpenChange(open: boolean): void
  onConfirm(handoff: StandardPlanHandoff): Promise<boolean>
}

const selectionKey = (selection: ChatModelRef | null): string =>
  selection ? `${selection.providerId}\0${selection.modelId}` : ''

/**
 * Chooses the destination of "Implement in new conversation". Only choices the selected model advertises are
 * offered; main validates the final settings again before anything is created.
 */
export function StandardPlanHandoffDialog({
  open,
  sourceConversationId,
  busy,
  decisionError,
  onOpenChange,
  onConfirm,
}: Props) {
  const { t } = useTranslation('ui')
  const [selection, setSelection] = useState<ChatModelRef | null>(null)
  const [reasoning, setReasoning] = useState<ChatReasoningEffort>('off')
  const [fastMode, setFastMode] = useState(false)
  const [placement, setPlacement] = useState<ConversationDispatchPlacement>('shared')
  const [meta, setMeta] = useState<{ key: string; value: ChatModelMeta | null } | null>(null)
  const [loadingSource, setLoadingSource] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const metaGeneration = useRef(0)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoadingSource(true)
    setLoadError(null)
    setPlacement('shared')
    setMeta(null)
    void Promise.all([
      window.api.chatGetSelection(sourceConversationId),
      window.api.chatGetReasoning(sourceConversationId),
      window.api.chatGetFastMode(sourceConversationId),
    ])
      .then(([currentSelection, currentReasoning, currentFast]) => {
        if (!alive) return
        setSelection(currentSelection?.providerId && currentSelection.modelId ? currentSelection : null)
        setReasoning(currentReasoning || 'off')
        setFastMode(currentFast === true)
      })
      .catch((error) => alive && setLoadError(error instanceof Error ? error.message : String(error)))
      .finally(() => alive && setLoadingSource(false))
    return () => {
      alive = false
    }
  }, [open, sourceConversationId])

  const currentKey = selectionKey(selection)
  useEffect(() => {
    if (!open || !selection) return
    const generation = ++metaGeneration.current
    const key = selectionKey(selection)
    void window.api
      .chatModelMeta(selection.modelId, selection.providerId)
      .catch(() => null)
      .then((value) => {
        // A late answer for a previous model must never unlock submission for the current one.
        if (metaGeneration.current === generation) setMeta({ key, value })
      })
  }, [open, selection])

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

  const canSubmit = !busy && !loadingSource && metaReady && !!selection
  const error = loadError ?? decisionError

  const submit = () => {
    if (!canSubmit || !selection) return
    void onConfirm({
      settings: {
        providerId: selection.providerId,
        modelId: selection.modelId,
        reasoning: efforts.length ? reasoning || 'off' : 'off',
        fastMode: fastAvailable && fastMode,
      },
      placement,
    }).then((ok) => ok && onOpenChange(false))
  }

  const placements: Array<{
    value: ConversationDispatchPlacement
    icon: React.ReactNode
    label: string
    hint: string
  }> = [
    {
      value: 'shared',
      icon: <Share2 className="size-3.5" />,
      label: t('plan.handoff.placementShared'),
      hint: t('plan.handoff.placementSharedHint'),
    },
    {
      value: 'worktree',
      icon: <GitBranch className="size-3.5" />,
      label: t('plan.handoff.placementWorktree'),
      hint: t('plan.handoff.placementWorktreeHint'),
    },
  ]

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquarePlus className="size-4 text-primary" /> {t('plan.handoff.title')}
          </DialogTitle>
          <DialogDescription>{t('plan.handoff.description')}</DialogDescription>
        </DialogHeader>

        {loadingSource ? (
          <div className="flex h-20 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('plan.handoff.loading')}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">{t('plan.handoff.settings')}</p>
              <div
                data-testid="plan-handoff-settings"
                className="flex min-w-0 flex-wrap items-center gap-1 rounded-lg border border-border bg-black/20 p-2"
              >
                <ChatModelChip
                  value={selection}
                  avoidOverflow
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
              {!selection && <p className="text-xs text-muted-foreground">{t('plan.handoff.noModel')}</p>}
              {metaReady && !fastAvailable && (
                <p className="text-xs text-muted-foreground">{t('plan.handoff.fastUnavailable')}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <p id="plan-handoff-placement" className="text-xs font-medium text-foreground">
                {t('plan.handoff.placement')}
              </p>
              <div role="radiogroup" aria-labelledby="plan-handoff-placement" className="grid grid-cols-2 gap-2">
                {placements.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={placement === option.value}
                    disabled={busy}
                    onClick={() => setPlacement(option.value)}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
                      placement === option.value
                        ? 'border-primary/50 bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      {option.icon}
                      {option.label}
                    </span>
                    <span className="text-[11px] leading-snug text-muted-foreground">{option.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <p role="alert" className="rounded border border-red-500/20 bg-red-500/[0.08] p-2 text-xs text-red-300">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('plan.handoff.cancel')}
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('plan.handoff.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
