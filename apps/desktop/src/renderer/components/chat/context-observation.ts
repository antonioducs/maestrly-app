import type { TFunction } from 'i18next'
import { contextOccupancy } from '../../../shared/chat'
import type {
  ChatCompactionProgress,
  ChatContextSnapshot,
  ChatHistoryStats,
  ChatModelMeta,
  ChatModelRef,
} from '../../../shared/chat'

export const formatContextTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export { sameContextModel, isMainMessage, selectContextObservation } from '../../../shared/context-observation'
import { sameContextModel } from '../../../shared/context-observation'

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
