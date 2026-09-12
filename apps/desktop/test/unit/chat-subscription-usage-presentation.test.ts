import { describe, expect, it } from 'vitest'
import {
  formatCompactDuration,
  subscriptionUsageLabel,
  subscriptionUsageResetDisplay,
  subscriptionUsageTone,
  supportsSubscriptionUsage,
} from '../../src/renderer/components/chat/subscription-usage-presentation'

describe('subscription usage presentation', () => {
  it('enables graphs only for the two providers with official snapshots', () => {
    expect(supportsSubscriptionUsage('codex-subscription')).toBe(true)
    expect(supportsSubscriptionUsage('claude-subscription')).toBe(true)
    expect(supportsSubscriptionUsage('github-copilot-subscription')).toBe(false)
    expect(supportsSubscriptionUsage('grok-subscription')).toBe(false)
  })

  it('maps semantic and unknown windows to stable labels', () => {
    expect(
      subscriptionUsageLabel({
        id: 'five-hour',
        kind: 'five-hour',
        usedPercent: 10,
        resetsAt: null,
        durationMins: 300,
      })
    ).toEqual({ key: 'settings.subscriptionUsageFiveHour' })
    expect(
      subscriptionUsageLabel({
        id: 'weekly-opus',
        kind: 'weekly-model',
        usedPercent: 10,
        resetsAt: null,
        durationMins: 10_080,
        label: 'Opus',
      })
    ).toEqual({ key: 'settings.subscriptionUsageWeeklyModel', values: { label: 'Opus' } })
    expect(
      subscriptionUsageLabel({
        id: 'future',
        kind: 'other',
        usedPercent: 10,
        resetsAt: null,
        durationMins: 120,
      })
    ).toEqual({ key: 'settings.subscriptionUsageTimedWindow', values: { time: '2h' } })
  })

  it('formats reset countdowns and progressive warning tones deterministically', () => {
    const now = Date.parse('2026-08-29T12:00:00Z')
    expect(formatCompactDuration(3 * 60 * 60_000 + 25 * 60_000)).toBe('3h 25m')
    expect(subscriptionUsageResetDisplay(now + 3 * 60 * 60_000 + 25 * 60_000, 'en', now)).toEqual({
      kind: 'relative',
      value: '3h 25m',
    })
    expect(subscriptionUsageResetDisplay(now - 1, 'en', now)).toEqual({ kind: 'now' })
    expect(subscriptionUsageResetDisplay(null, 'en', now)).toEqual({ kind: 'none' })
    expect(subscriptionUsageTone(79.9)).toBe('normal')
    expect(subscriptionUsageTone(80)).toBe('high')
    expect(subscriptionUsageTone(90)).toBe('high')
    expect(subscriptionUsageTone(90.1)).toBe('critical')
  })
})
