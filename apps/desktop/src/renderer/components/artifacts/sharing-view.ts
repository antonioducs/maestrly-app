/** What the sharing interface derives from its data. No React, so it is tested directly. */
import {
  type ArtifactEventView,
  type ArtifactPersonView,
  MAX_ACCESS_CODE_CHARS,
  MAX_ARTIFACT_NAME_CHARS,
  MIN_ACCESS_CODE_CHARS,
} from '../../../shared/artifacts'
// A relative import: unit tests compile this file without the renderer's path aliases.
import type { TFn } from '../settings/shared'

const DAY_MS = 24 * 60 * 60 * 1000

/** How long a link for anyone lasts, in days; null never expires. */
export const EXPIRY_CHOICES = [7, 30, 90, null] as const

export function expiryFromDays(days: number | null, now: number): number | null {
  return days === null ? null : now + days * DAY_MS
}

/** The choice a stored expiry corresponds to, within a day; anything else is a date of its own. */
export function expiryChoice(expiresAt: number | null, now: number): number | null | 'custom' {
  if (expiresAt === null) return null
  for (const days of EXPIRY_CHOICES)
    if (days !== null && Math.abs(expiresAt - (now + days * DAY_MS)) <= DAY_MS) return days
  return 'custom'
}

export function validateAccessCode(code: string): 'ok' | 'too_short' | 'too_long' {
  if (code.length < MIN_ACCESS_CODE_CHARS) return 'too_short'
  return code.length > MAX_ACCESS_CODE_CHARS ? 'too_long' : 'ok'
}

export function validatePersonName(name: string): 'ok' | 'empty' | 'too_long' {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  return trimmed.length > MAX_ARTIFACT_NAME_CHARS ? 'too_long' : 'ok'
}

/** "Safari on iPhone" from the stored "Safari/iPhone"; the host keeps nothing finer than that. */
export function deviceLabel(t: TFn, label: string): string {
  const [browser, os, ...rest] = label.split('/')
  if (!browser || os === undefined || rest.length) return label || t('artifacts.share.deviceUnknown')
  if (os === 'Unknown') return browser === 'Browser' ? t('artifacts.share.deviceUnknown') : browser
  return t('artifacts.share.device', { browser, os })
}

/** One line for something that happened on a shared artifact, such as "Maria opened it on Safari on iPhone". */
export function eventText(t: TFn, event: ArtifactEventView): string {
  const name = String(event.data.name ?? '') || t('artifacts.events.someone')
  if (event.kind === 'device_added')
    return t('artifacts.events.device_added', { name, device: deviceLabel(t, String(event.data.device ?? '')) })
  return t(`artifacts.events.${event.kind}`, { name })
}

/** The people who can open the artifact right now, and the devices they use. */
export function sharingSummary(people: readonly ArtifactPersonView[]): { people: number; devices: number } {
  const active = people.filter((person) => !person.revoked)
  return { people: active.length, devices: active.reduce((sum, person) => sum + person.devices.length, 0) }
}
