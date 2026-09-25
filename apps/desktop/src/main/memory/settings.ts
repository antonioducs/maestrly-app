import type { MemorySettings } from '../../shared/memory'
import { getAppSetting } from '../store/app-settings'

export const MEMORY_SETTINGS_KEY = 'chat.memory'
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  autoRecall: true,
  extraction: { enabled: false, selection: null },
}

export function parseMemorySettings(value: unknown): MemorySettings | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const extraction = input.extraction as Record<string, unknown> | undefined
  if (typeof input.autoRecall !== 'boolean' || !extraction || typeof extraction.enabled !== 'boolean') return null
  const raw = extraction.selection as Record<string, unknown> | null | undefined
  if (raw === null || raw === undefined)
    return { autoRecall: input.autoRecall, extraction: { enabled: extraction.enabled, selection: null } }
  if (
    typeof raw.providerId !== 'string' ||
    !raw.providerId ||
    typeof raw.modelId !== 'string' ||
    !raw.modelId ||
    typeof raw.effort !== 'string' ||
    typeof raw.fastMode !== 'boolean'
  )
    return null
  return {
    autoRecall: input.autoRecall,
    extraction: {
      enabled: extraction.enabled,
      selection: { providerId: raw.providerId, modelId: raw.modelId, effort: raw.effort, fastMode: raw.fastMode },
    },
  }
}

export function readMemorySettings(): MemorySettings {
  const stored = getAppSetting(MEMORY_SETTINGS_KEY)
  if (!stored) return DEFAULT_MEMORY_SETTINGS
  try {
    return parseMemorySettings(JSON.parse(stored)) ?? DEFAULT_MEMORY_SETTINGS
  } catch {
    return DEFAULT_MEMORY_SETTINGS
  }
}
