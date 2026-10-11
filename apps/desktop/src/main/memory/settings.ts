import { readPersonalMemorySettings } from './personal-memory-settings'
import type { MemorySpace } from './spaces'
import type { MemorySettings } from '../../shared/memory'
import { getAppSetting } from '../store'

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

/** Unreadable settings fall back to the defaults: the chat config and turns never fail over memory. */
export function readMemorySettings(): MemorySettings {
  try {
    const stored = getAppSetting(MEMORY_SETTINGS_KEY)
    return (stored && parseMemorySettings(JSON.parse(stored))) || DEFAULT_MEMORY_SETTINGS
  } catch (error) {
    console.warn('[memory] settings unreadable, using defaults:', error instanceof Error ? error.message : error)
    return DEFAULT_MEMORY_SETTINGS
  }
}

export function memorySettingsForSpace(space: Pick<MemorySpace, 'kind'>): MemorySettings {
  return space.kind === 'personal' ? readPersonalMemorySettings() : readMemorySettings()
}
