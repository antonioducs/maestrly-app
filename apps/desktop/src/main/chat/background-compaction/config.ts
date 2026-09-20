import { createHash } from 'node:crypto'
import type { BackgroundCompactionConfig } from '../../../shared/background-compaction'

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Structural validation only. Provider-specific effort/Fast validation belongs to the settings service. */
export function parseBackgroundCompactionConfig(value: unknown): BackgroundCompactionConfig | null {
  const raw = objectValue(value)
  if (!raw || typeof raw.enabled !== 'boolean' || !Number.isSafeInteger(raw.intervalTokens)) return null
  const intervalTokens = Number(raw.intervalTokens)
  if (intervalTokens <= 0) return null

  let selection: BackgroundCompactionConfig['selection'] = null
  if (raw.selection != null) {
    const selected = objectValue(raw.selection)
    if (
      !selected ||
      typeof selected.providerId !== 'string' ||
      selected.providerId.length === 0 ||
      typeof selected.modelId !== 'string' ||
      selected.modelId.length === 0 ||
      typeof selected.effort !== 'string' ||
      typeof selected.fastMode !== 'boolean'
    ) {
      return null
    }
    selection = {
      providerId: selected.providerId,
      modelId: selected.modelId,
      effort: selected.effort,
      fastMode: selected.fastMode,
    }
  }
  if (raw.enabled && !selection) return null
  return { enabled: raw.enabled, intervalTokens, selection }
}

export function backgroundCompactionConfigIdentity(config: BackgroundCompactionConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        enabled: config.enabled,
        intervalTokens: config.intervalTokens,
        selection: config.selection,
      })
    )
    .digest('hex')
}

export function effectiveBackgroundCompactionInterval(configured: number, conversationWindow: number): number {
  const halfWindow = Math.max(1, Math.floor(conversationWindow / 2))
  return Math.min(configured, halfWindow)
}
