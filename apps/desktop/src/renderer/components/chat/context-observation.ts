import type { TFunction } from 'i18next'
import { contextOccupancy } from '../../../shared/chat'
import type {
  ChatCompactionProgress,
  ChatContextSnapshot,
  ChatHistoryStats,
  ChatMessage,
  ChatModelMeta,
  ChatModelRef,
} from '../../../shared/chat'

export const formatContextTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export function sameContextModel(a: ChatModelRef | null | undefined, b: ChatModelRef | null | undefined): boolean {
  return !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId
}

function isMainMessage(message: ChatMessage): boolean {
  return (
    !message.internal &&
    !message.reviewLoop &&
    message.source !== 'chatgpt-web-review-loop' &&
    message.source !== 'maestrly-review-loop' &&
    (!message.executionScope || message.executionScope.kind === 'conversation')
  )
}

/** Stop at context boundaries instead of resurrecting an older matching model's observation. */
export function selectContextObservation(
  messages: readonly ChatMessage[],
  target: {
    conversationId: string
    model: ChatModelRef | null
    streaming: boolean
    compacting?: boolean
    after?: number
  }
): { snapshot?: ChatContextSnapshot; progress?: ChatCompactionProgress } {
  if (!target.model) return {}
  let snapshot: ChatContextSnapshot | undefined
  let progress: ChatCompactionProgress | undefined
  let latestAssistantId: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.conversationId !== target.conversationId || !isMainMessage(message)) continue
    const boundary = message.parts.some((part) => part.type === 'compaction')
    if (message.role === 'assistant') {
      latestAssistantId ??= message.id
      const currentProgress =
        message.compactionProgress?.model && !sameContextModel(message.compactionProgress.model, target.model)
          ? undefined
          : message.compactionProgress
      const conversationProgress =
        currentProgress?.scope === 'conversation' && sameContextModel(currentProgress.model, target.model)
      if (message.model && !sameContextModel(message.model, target.model) && !conversationProgress) break
      const candidate = sameContextModel(message.contextSnapshot?.model, target.model)
        ? message.contextSnapshot
        : undefined
      if (message.contextSnapshot && !candidate && !conversationProgress) break
      // Legacy markers have no observation timestamp; do not assume their attached sample survived compaction.
      if (boundary && !currentProgress) break
      if (!progress && currentProgress && currentProgress.updatedAt >= (target.after ?? 0)) {
        const active = currentProgress.status === 'running' || currentProgress.status === 'retrying'
        const ended =
          message.id !== latestAssistantId || (!conversationProgress && (!!message.finishReason || !!message.error))
        progress =
          active && (ended || (!target.streaming && !target.compacting))
            ? { ...currentProgress, status: message.error || message.finishReason === 'error' ? 'failed' : 'cancelled' }
            : currentProgress
      }
      if (
        !snapshot &&
        currentProgress?.status === 'completed' &&
        currentProgress.updatedAt >= (target.after ?? 0) &&
        (!candidate || currentProgress.updatedAt >= candidate.observedAt)
      ) {
        // A completed summary can precede the next measured provider sample.
        if (currentProgress.afterTokens != null) {
          snapshot = {
            model: target.model,
            sequence: candidate?.sequence ?? 0,
            ...(candidate?.modelContextWindow != null ? { modelContextWindow: candidate.modelContextWindow } : {}),
            usedTokens: currentProgress.afterTokens,
            quality: currentProgress.afterQuality ?? 'estimated',
            observedAt: currentProgress.updatedAt,
          }
        }
      } else if (!snapshot && candidate && candidate.observedAt >= (target.after ?? 0)) {
        snapshot = candidate
      }
      if (currentProgress?.status === 'completed') break
    }
    if (boundary || (snapshot && progress)) break
  }
  return { snapshot, progress }
}

/** Billing remains independent of whichever context observation is displayed. */
export function contextMeterReading(
  history: ChatHistoryStats | null,
  meta: ChatModelMeta | null,
  snapshot: ChatContextSnapshot | undefined,
  model: ChatModelRef | null
) {
  const observation = snapshot && sameContextModel(snapshot.model, model) ? snapshot : undefined
  const projection = history?.contextProjection
  const legacyUsage = sameContextModel(history?.lastModel, model) ? history?.lastUsage : null
  const used = observation?.usedTokens ?? projection?.usedTokens ?? (legacyUsage ? contextOccupancy(legacyUsage) : 0)
  // A sample with no runtime ceiling must not inherit an older request's denominator.
  const window = observation
    ? (observation.modelContextWindow ?? meta?.contextWindow)
    : (projection?.modelContextWindow ?? meta?.contextWindow)
  return {
    used,
    window,
    quality: observation?.quality ?? projection?.quality ?? 'measured',
    observation,
    projection,
  }
}

export function compactionStatusText(progress: ChatCompactionProgress | undefined, t: TFunction<'chat'>) {
  if (!progress) return { label: '', reduction: null }
  const active = progress.status === 'running' || progress.status === 'retrying'
  let label: string
  if (active) {
    label =
      progress.phase === 'consolidate'
        ? t('compactionStatus.consolidating')
        : progress.phase === 'chunk' && progress.total != null && progress.total > 0
          ? t('compactionStatus.step', {
              step: Math.min((progress.completed ?? 0) + 1, progress.total),
              total: progress.total,
            })
          : t('compactionStatus.running')
    if (progress.status === 'retrying') {
      label +=
        ' · ' +
        (progress.attempt != null
          ? t('compactionStatus.retryAttempt', { attempt: progress.attempt })
          : t('compactionStatus.retrying'))
    }
  } else {
    label = t(`compactionStatus.${progress.status}`)
    if (progress.status === 'failed' && progress.error?.trim()) label += `: ${progress.error.trim()}`
  }
  const reduction =
    progress.status === 'completed' && progress.beforeTokens != null && progress.afterTokens != null
      ? t('compactionStatus.reduction', {
          before: formatContextTokens(progress.beforeTokens),
          after: `${progress.afterQuality === 'measured' ? '' : '~'}${formatContextTokens(progress.afterTokens)}`,
        })
      : null
  return { label, reduction }
}
