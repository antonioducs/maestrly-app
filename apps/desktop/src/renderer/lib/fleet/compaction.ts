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

export type CompactionForm = {
  modelId: string
  reasoning: string | null
  fastMode: boolean
  intervalThousands: string
  /** Empty: the conversation uses its model's own window. */
  contextLimitThousands: string
}

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
    contextLimitThousands: config?.contextLimitTokens ? String(config.contextLimitTokens / 1_000) : '',
  }
}

/** A whole number of thousands in range, in tokens; null otherwise. */
function tokensFromThousands(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const tokens = Number(value) * 1_000
  return tokens >= min && tokens <= max ? tokens : null
}

/** The form's summary interval in tokens; null when it is not a whole number of thousands in range. */
export function compactionIntervalTokens(form: CompactionForm): number | null {
  return tokensFromThousands(
    form.intervalThousands,
    FLEET_COMPACTION_LIMITS.intervalTokensMin,
    FLEET_COMPACTION_LIMITS.intervalTokensMax
  )
}

/** The form's context limit in tokens: null when empty (the model's own window), undefined when it is invalid. */
export function compactionContextLimitTokens(form: CompactionForm): number | null | undefined {
  const value = form.contextLimitThousands.trim()
  if (!value) return null
  return (
    tokensFromThousands(
      value,
      FLEET_COMPACTION_LIMITS.contextLimitTokensMin,
      FLEET_COMPACTION_LIMITS.contextLimitTokensMax
    ) ?? undefined
  )
}

export function compactionPatch(form: CompactionForm): FleetCompactionConfig | null {
  const separator = form.modelId.indexOf('::')
  const intervalTokens = compactionIntervalTokens(form)
  const contextLimitTokens = compactionContextLimitTokens(form)
  if (
    separator < 1 ||
    separator === form.modelId.length - 2 ||
    intervalTokens === null ||
    contextLimitTokens === undefined
  )
    return null
  return {
    providerId: form.modelId.slice(0, separator),
    modelId: form.modelId.slice(separator + 2),
    reasoning: form.reasoning,
    fastMode: form.fastMode,
    intervalTokens,
    // Left out without a limit, so a config without one stays exactly as configs were before limits existed.
    ...(contextLimitTokens !== null ? { contextLimitTokens } : {}),
  }
}

/** Whether two configs compact the same way; a missing limit and a null one both mean the model's window. */
export function sameCompactionConfig(a: FleetCompactionConfig | null, b: FleetCompactionConfig | null): boolean {
  if (!a || !b) return a === b
  return (
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.reasoning === b.reasoning &&
    a.fastMode === b.fastMode &&
    a.intervalTokens === b.intervalTokens &&
    (a.contextLimitTokens ?? null) === (b.contextLimitTokens ?? null)
  )
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
