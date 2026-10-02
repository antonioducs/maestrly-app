import { EventEmitter } from 'node:events'
import type { PersonalMemorySettings } from '../../shared/memory'
import { getAppSetting, setAppSetting } from '../store/app-settings'
import { parseMemorySettings } from './settings'

export const PERSONAL_MEMORY_SETTINGS_KEY = 'chat.personalMemory'
export const DEFAULT_PERSONAL_MEMORY_SETTINGS: PersonalMemorySettings = {
  enabled: true,
  autoRecall: true,
  extraction: { enabled: false, selection: null },
}
const events = new EventEmitter()
events.setMaxListeners(50)

export function parsePersonalMemorySettings(value: unknown): PersonalMemorySettings | null {
  const memory = parseMemorySettings(value)
  if (!memory || typeof (value as PersonalMemorySettings).enabled !== 'boolean') return null
  return { ...memory, enabled: (value as PersonalMemorySettings).enabled }
}

/** Only an absent setting uses defaults; corrupt or unavailable storage denies access. */
export function readPersonalMemorySettings(): PersonalMemorySettings {
  try {
    const raw = getAppSetting(PERSONAL_MEMORY_SETTINGS_KEY)
    if (raw === null) return structuredClone(DEFAULT_PERSONAL_MEMORY_SETTINGS)
    const settings = parsePersonalMemorySettings(JSON.parse(raw))
    if (settings) return settings
  } catch {
    // Fail closed until the profile can be read authoritatively.
  }
  return { enabled: false, autoRecall: false, extraction: { enabled: false, selection: null } }
}

export function setPersonalMemorySettings(settings: PersonalMemorySettings): void {
  const parsed = parsePersonalMemorySettings(settings)
  if (!parsed) throw new Error('Invalid personal memory settings')
  setAppSetting(PERSONAL_MEMORY_SETTINGS_KEY, JSON.stringify(parsed))
  events.emit('changed', parsed)
}

export function onPersonalMemorySettingsChanged(listener: (settings: PersonalMemorySettings) => void): () => void {
  events.on('changed', listener)
  return () => events.off('changed', listener)
}
