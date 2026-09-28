import {
  FLEET_COMPACTION_LIMITS,
  type FleetBot,
  type FleetCompactionConfig,
  type FleetCompactionProgress,
  type FleetCompactionState,
  type FleetSelectionOption,
} from '@maestrly/bot-fleet-protocol'
import type { BackgroundCompactionStatus } from '../../../shared/background-compaction'
import type { ChatCompactionProgress } from '../../../shared/chat'

export type CompactionForm = { modelId: string; reasoning: string | null; fastMode: boolean; intervalThousands: string }

/** The model choice that makes a bot use its environment's default; never a model id, which always holds `::`. */
export const ENVIRONMENT_COMPACTION_CHOICE = '__environment__'

/** Where a bot's compaction model comes from; a gateway from before environment defaults stores only the bot's own. */
export function compactionSourceOf(
  bot: Pick<FleetBot, 'compaction' | 'compactionSource'>
): FleetBot['compactionSource'] {
  return bot.compactionSource ?? (bot.compaction ? 'bot' : null)
}

/** A compaction model as the Bots UI names it: its account and model when listed, else its model id. */
export function compactionModelLabel(config: FleetCompactionConfig, options: FleetSelectionOption[]): string {
  const option = options.find((item) => item.providerId === config.providerId && item.modelId === config.modelId)
  return option ? `${option.providerLabel} · ${option.modelLabel}` : config.modelId
}

export function compactionFormFrom(config: FleetCompactionConfig | null): CompactionForm {
  return {
    modelId: config ? `${config.providerId}::${config.modelId}` : '',
    reasoning: config?.reasoning ?? null,
    fastMode: config?.fastMode ?? false,
    intervalThousands: String((config?.intervalTokens ?? FLEET_COMPACTION_LIMITS.intervalTokensDefault) / 1_000),
  }
}

export function compactionPatch(form: CompactionForm): FleetCompactionConfig | null {
  const interval = Number(form.intervalThousands)
  const separator = form.modelId.indexOf('::')
  if (
    separator < 1 ||
    separator === form.modelId.length - 2 ||
    !/^\d+$/.test(form.intervalThousands) ||
    !Number.isInteger(interval) ||
    interval * 1_000 < FLEET_COMPACTION_LIMITS.intervalTokensMin ||
    interval * 1_000 > FLEET_COMPACTION_LIMITS.intervalTokensMax
  )
    return null
  return {
    providerId: form.modelId.slice(0, separator),
    modelId: form.modelId.slice(separator + 2),
    reasoning: form.reasoning,
    fastMode: form.fastMode,
    intervalTokens: interval * 1_000,
  }
}

export function compactionProgress(
  progress: FleetCompactionProgress | null | undefined
): ChatCompactionProgress | undefined {
  if (!progress) return undefined
  return {
    id: progress.id,
    status: progress.status,
    phase: progress.phase ?? undefined,
    completed: progress.completed ?? undefined,
    total: progress.total ?? undefined,
    attempt: progress.attempt ?? undefined,
    beforeTokens: progress.beforeTokens ?? undefined,
    afterTokens: progress.afterTokens ?? undefined,
    afterQuality: progress.afterQuality ?? undefined,
    error: progress.error ?? undefined,
    updatedAt: Date.parse(progress.updatedAt),
  }
}

export function backgroundCompactionState(
  background: FleetCompactionState['background'] | null | undefined
): BackgroundCompactionStatus | undefined {
  if (!background) return undefined
  return { revision: 0, status: background.status, error: background.error ?? undefined }
}
