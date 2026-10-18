import type {
  MobileSubscriptionProviderKind,
  MobileSubscriptionUsageEntry,
  MobileSubscriptionUsageWindow,
} from '@maestrly/bot-fleet-protocol'
import { formatDateTime } from '../fleet/format'
import type { Translate } from '../i18n/translate'

const MINUTE = 60_000
const WEEK = 7 * 24 * 60 * MINUTE

export type UsageTone = 'normal' | 'high' | 'critical'

/** As the desktop colors a window: high from 80% used, critical above 90%. */
export function usageTone(usedPercent: number): UsageTone {
  if (usedPercent > 90) return 'critical'
  if (usedPercent >= 80) return 'high'
  return 'normal'
}

/** A duration as the desktop writes it: 45m, 2h 5m, 3d 4h; anything under a minute is `<1m`. */
export function formatCompactDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '<1m'
  const totalMinutes = Math.max(1, Math.ceil(ms / MINUTE))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/** A window's name, as the desktop's Accounts settings name it. */
export function usageWindowLabel(window: MobileSubscriptionUsageWindow, t: Translate): string {
  if (window.kind === 'five-hour') return t('usage.window.fiveHour')
  if (window.kind === 'weekly') return t('usage.window.weekly')
  if (window.kind === 'weekly-model') return t('usage.window.weeklyModel', { label: window.label || window.id })
  if (window.label) return window.label
  if (window.durationMins !== null && window.durationMins > 0)
    return t('usage.window.timed', { time: formatCompactDuration(window.durationMins * MINUTE) })
  return t('usage.window.other')
}

/** When a window starts over: in a compact duration within a week, else as a date; null when the provider does not say. */
export function usageResetLine(resetsAt: number | null, t: Translate, locale: string, now: number): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null
  const remaining = resetsAt - now
  if (remaining <= 0) return t('usage.resetting')
  if (remaining <= WEEK) return t('usage.resetsIn', { time: formatCompactDuration(remaining) })
  return t('usage.resetsOn', { time: formatDateTime(new Date(resetsAt).toISOString(), locale) })
}

export const usagePercent = (window: MobileSubscriptionUsageWindow): number =>
  Math.min(100, Math.max(0, Math.round(window.usedPercent)))

/** How long ago the phone last read the usage. */
export function usageUpdatedLine(readAt: number, t: Translate, now: number): string {
  const elapsed = now - readAt
  return elapsed < MINUTE ? t('usage.updatedNow') : t('usage.updatedAgo', { time: formatCompactDuration(elapsed) })
}

export function usageErrorLine(entry: MobileSubscriptionUsageEntry, t: Translate): string {
  if (entry.error === 'unavailable') return t('usage.error.unavailable')
  if (entry.error === 'unknown-account') return t('usage.error.unknownAccount')
  return t('usage.error.failed')
}

export type UsageGroup = {
  kind: MobileSubscriptionProviderKind
  label: string
  entries: MobileSubscriptionUsageEntry[]
}

/** The entries of each provider together, in the order the host listed the providers and their accounts. */
export function groupUsageByProvider(entries: MobileSubscriptionUsageEntry[]): UsageGroup[] {
  const groups = new Map<MobileSubscriptionProviderKind, UsageGroup>()
  for (const entry of entries) {
    const group = groups.get(entry.providerKind)
    if (group) group.entries.push(entry)
    else groups.set(entry.providerKind, { kind: entry.providerKind, label: entry.providerLabel, entries: [entry] })
  }
  return [...groups.values()]
}

/** An account's name: its label on the host, or the default account's. */
export const usageAccountLabel = (entry: MobileSubscriptionUsageEntry, t: Translate): string =>
  entry.accountLabel || t('usage.defaultAccount')
