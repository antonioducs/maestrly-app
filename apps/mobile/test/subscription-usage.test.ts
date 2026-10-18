import type { MobileSubscriptionUsageEntry, MobileSubscriptionUsageWindow } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import {
  formatCompactDuration,
  groupUsageByProvider,
  usageAccountLabel,
  usageErrorLine,
  usagePercent,
  usageResetLine,
  usageTone,
  usageUpdatedLine,
  usageWindowLabel,
} from '../src/chats/subscription-usage'
import { demoSubscriptionUsage } from '../src/demo/chat-fixtures'
import { translator } from '../src/i18n/translate'

const NOW = Date.parse('2026-10-18T12:00:00.000Z')
const MINUTE = 60_000
const { t } = translator('en')
const pt = translator('pt-BR').t
const window = (extra: Partial<MobileSubscriptionUsageWindow> = {}): MobileSubscriptionUsageWindow => ({
  id: 'w',
  kind: 'other',
  usedPercent: 10,
  resetsAt: null,
  durationMins: null,
  ...extra,
})
const entry = (extra: Partial<MobileSubscriptionUsageEntry> = {}): MobileSubscriptionUsageEntry => ({
  providerId: 'builtin_claude_subscription',
  providerKind: 'claude',
  providerLabel: 'Claude',
  state: 'ready',
  fetchedAt: NOW,
  windows: [],
  ...extra,
})

describe('subscription usage', () => {
  it('colors a window as the desktop does', () => {
    expect([0, 79.9, 80, 90, 90.1, 100].map(usageTone)).toEqual([
      'normal',
      'normal',
      'high',
      'high',
      'critical',
      'critical',
    ])
    expect(usagePercent(window({ usedPercent: 42.5 }))).toBe(43)
  })

  it('writes durations compactly', () => {
    expect(formatCompactDuration(0)).toBe('<1m')
    expect(formatCompactDuration(30_000)).toBe('1m')
    expect(formatCompactDuration(125 * MINUTE)).toBe('2h 5m')
    expect(formatCompactDuration(180 * MINUTE)).toBe('3h')
    expect(formatCompactDuration((3 * 24 * 60 + 4 * 60) * MINUTE)).toBe('3d 4h')
    expect(formatCompactDuration(2 * 24 * 60 * MINUTE)).toBe('2d')
  })

  it('names each kind of window', () => {
    expect(usageWindowLabel(window({ kind: 'five-hour' }), t)).toBe('5-hour window')
    expect(usageWindowLabel(window({ kind: 'weekly' }), t)).toBe('Weekly · all models')
    expect(usageWindowLabel(window({ kind: 'weekly-model', label: 'Opus' }), t)).toBe('Weekly · Opus')
    expect(usageWindowLabel(window({ kind: 'weekly-model', id: 'seven_day_sonnet' }), t)).toBe(
      'Weekly · seven_day_sonnet'
    )
    expect(usageWindowLabel(window({ label: 'Monthly credits' }), t)).toBe('Monthly credits')
    expect(usageWindowLabel(window({ durationMins: 24 * 60 }), t)).toBe('1d window')
    expect(usageWindowLabel(window(), t)).toBe('Usage window')
    expect(usageWindowLabel(window({ kind: 'five-hour' }), pt)).toBe('Janela de 5 horas')
  })

  it('says when a window starts over: soon in a duration, later as a date', () => {
    expect(usageResetLine(null, t, 'en', NOW)).toBeNull()
    expect(usageResetLine(NOW - 1, t, 'en', NOW)).toBe('Resetting now')
    expect(usageResetLine(NOW + 125 * MINUTE, t, 'en', NOW)).toBe('Resets in 2h 5m')
    expect(usageResetLine(NOW + 125 * MINUTE, pt, 'pt-BR', NOW)).toBe('Reinicia em 2h 5m')
    const later = usageResetLine(NOW + 9 * 24 * 60 * MINUTE, t, 'en', NOW)
    expect(later).toMatch(/^Resets /)
    expect(later).not.toMatch(/Resets in/)
    expect(later).toContain('2026')
  })

  it('says how long ago the usage was read', () => {
    expect(usageUpdatedLine(NOW - 20_000, t, NOW)).toBe('Updated just now')
    expect(usageUpdatedLine(NOW - 5 * MINUTE, t, NOW)).toBe('Updated 5m ago')
    expect(usageUpdatedLine(NOW - 5 * MINUTE, pt, NOW)).toBe('Atualizado há 5m')
  })

  it('names accounts and errors without the provider’s own text', () => {
    expect(usageAccountLabel(entry({ accountLabel: 'Work' }), t)).toBe('Work')
    expect(usageAccountLabel(entry(), t)).toBe('Default account')
    expect(usageErrorLine(entry({ state: 'error', error: 'unavailable' }), t)).toMatch(/isn’t reporting limits/)
    expect(usageErrorLine(entry({ state: 'error', error: 'unknown-account' }), t)).toMatch(/no longer on the server/)
    expect(usageErrorLine(entry({ state: 'error', error: 'failed' }), t)).toMatch(/Couldn’t read/)
    expect(usageErrorLine(entry({ state: 'error' }), t)).toMatch(/Couldn’t read/)
  })

  it('groups the accounts of each provider, in the host’s order', () => {
    const groups = groupUsageByProvider(demoSubscriptionUsage(NOW))
    expect(groups.map((group) => [group.label, group.entries.map((item) => item.accountLabel ?? null)])).toEqual([
      ['ChatGPT', [null]],
      ['Claude', ['Personal', 'Work']],
      ['Google AI', [null]],
    ])
    expect(groupUsageByProvider([])).toEqual([])
  })
})
