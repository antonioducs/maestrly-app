import {
  FLEET_IMAGE_LIMITS,
  FLEET_IMAGE_MEDIA_TYPES,
  type FleetCompactionConfig,
  type FleetSelection,
  type FleetSelectionOption,
  type FleetUsage,
} from '@maestrly/bot-fleet-protocol'

export type ComposerFile = Pick<File, 'name' | 'size' | 'type'>
export type AttachmentError = 'type' | 'size' | 'count' | 'total'

export function validateAttachments(existing: ComposerFile[], incoming: ComposerFile[]): AttachmentError | null {
  if (incoming.some((file) => !FLEET_IMAGE_MEDIA_TYPES.includes(file.type as (typeof FLEET_IMAGE_MEDIA_TYPES)[number])))
    return 'type'
  if (incoming.some((file) => file.size > FLEET_IMAGE_LIMITS.attachmentMaxBytes)) return 'size'
  if (existing.length + incoming.length > FLEET_IMAGE_LIMITS.attachmentsMax) return 'count'
  if (
    [...existing, ...incoming].reduce((sum, file) => sum + file.size, 0) > FLEET_IMAGE_LIMITS.attachmentsTotalMaxBytes
  )
    return 'total'
  return null
}

export function selectionPatch(
  current: FleetSelection | null,
  change: { model?: FleetSelectionOption | null; reasoning?: string | null; fastMode?: boolean }
): FleetSelection | null {
  if ('model' in change) {
    if (!change.model) return null
    const model = change.model
    const sameModel = current?.providerId === model.providerId && current.modelId === model.modelId
    return {
      providerId: model.providerId,
      modelId: model.modelId,
      reasoning:
        sameModel && current?.reasoning && model.efforts.includes(current.reasoning)
          ? current.reasoning
          : (model.efforts[0] ?? null),
      fastMode: sameModel && model.fastMode ? current.fastMode : false,
    }
  }
  if (!current) return null
  return { ...current, ...change }
}

export const formatFleetTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const cost = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`)
export function formatFleetUsage(usage: FleetUsage): string | null {
  const used = usage.contextUsedTokens
  if (used == null) return usage.costUsd == null ? null : `~${cost(usage.costUsd)}`
  const window = usage.contextWindowTokens
  const context = `~${formatFleetTokens(used)}${window ? `/${formatFleetTokens(window)} ${((used / window) * 100).toFixed(1)}%` : ''}`
  return `${context}${usage.costUsd == null ? '' : ` · ~${cost(usage.costUsd)}`}`
}

/** The owner's cap on the bot's window when it is what bounds it, so the meter can show it as a limit. */
export function fleetUsageLimit(usage: FleetUsage, compaction: FleetCompactionConfig | null): number | null {
  const limit = compaction?.contextLimitTokens ?? null
  return limit !== null && usage.contextWindowTokens === limit ? limit : null
}
