import type { ChatSubscriptionProviderKind, ChatSubscriptionUsageWindow } from '../../../shared/chat'

export type SubscriptionUsageTone = 'normal' | 'high' | 'critical'

export function supportsSubscriptionUsage(providerKind: ChatSubscriptionProviderKind): boolean {
  return providerKind === 'codex-subscription' || providerKind === 'claude-subscription'
}

export function subscriptionUsageTone(usedPercent: number): SubscriptionUsageTone {
  if (usedPercent > 90) return 'critical'
  if (usedPercent >= 80) return 'high'
  return 'normal'
}

export interface SubscriptionUsageLabelDescriptor {
  key: string
  values?: Record<string, string | number>
}

export function subscriptionUsageLabel(window: ChatSubscriptionUsageWindow): SubscriptionUsageLabelDescriptor {
  if (window.kind === 'five-hour') return { key: 'settings.subscriptionUsageFiveHour' }
  if (window.kind === 'weekly') return { key: 'settings.subscriptionUsageWeekly' }
  if (window.kind === 'weekly-model') {
    return {
      key: 'settings.subscriptionUsageWeeklyModel',
      values: { label: window.label || window.id },
    }
  }
  if (window.id === 'primary') return { key: 'settings.subscriptionUsagePrimary' }
  if (window.id === 'secondary') return { key: 'settings.subscriptionUsageSecondary' }
  if (window.label) return { key: 'settings.subscriptionUsageNamedWindow', values: { label: window.label } }
  if (window.durationMins !== null) {
    return {
      key: 'settings.subscriptionUsageTimedWindow',
      values: { time: formatCompactDuration(window.durationMins * 60_000) },
    }
  }
  return { key: 'settings.subscriptionUsageOtherWindow' }
}

export type SubscriptionUsageResetDisplay =
  | { kind: 'none' }
  | { kind: 'now' }
  | { kind: 'relative'; value: string }
  | { kind: 'absolute'; value: string }

export function formatCompactDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '<1m'
  const totalMinutes = Math.max(1, Math.ceil(durationMs / 60_000))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

export function subscriptionUsageResetDisplay(
  resetsAt: number | null,
  locale: string,
  now = Date.now()
): SubscriptionUsageResetDisplay {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return { kind: 'none' }
  const remaining = resetsAt - now
  if (remaining <= 0) return { kind: 'now' }
  if (remaining <= 7 * 24 * 60 * 60_000) {
    return { kind: 'relative', value: formatCompactDuration(remaining) }
  }
  return {
    kind: 'absolute',
    value: new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(resetsAt)),
  }
}
