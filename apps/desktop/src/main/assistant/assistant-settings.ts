import type { Rectangle } from 'electron'
import {
  ASSISTANT_SETTINGS_KEY,
  ASSISTANT_WINDOW_BOUNDS_KEY,
  type AssistantSettings,
  mergeAssistantSettings,
  parseAssistantSettings,
} from '../../shared/assistant'
import { getAppSetting, setAppSetting } from '../store'

function json(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function getAssistantSettings(): AssistantSettings {
  return parseAssistantSettings(json(getAppSetting(ASSISTANT_SETTINGS_KEY)))
}

/** Merge a patch into the stored settings; an invalid patch throws and changes nothing. */
export function setAssistantSettings(patch: unknown): AssistantSettings {
  const next = mergeAssistantSettings(getAssistantSettings(), patch)
  setAppSetting(ASSISTANT_SETTINGS_KEY, JSON.stringify(next))
  return next
}

export function getAssistantWindowBounds(): Rectangle | null {
  const value = json(getAppSetting(ASSISTANT_WINDOW_BOUNDS_KEY)) as Partial<Rectangle> | null
  if (!value || typeof value !== 'object') return null
  const { x, y, width, height } = value
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { x: x!, y: y!, width: width!, height: height! }
}

export function setAssistantWindowBounds(bounds: Rectangle): void {
  setAppSetting(ASSISTANT_WINDOW_BOUNDS_KEY, JSON.stringify(bounds))
}
