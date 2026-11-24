import { describe, expect, it } from 'vitest'
import { translator } from '../src/i18n/translate'
import type { MobileInboxItem } from '../src/inbox'
import { palettes } from '../src/theme/tokens'
import {
  formatCompactAge,
  formatInboxCounts,
  formatInboxPlace,
  formatRowTime,
  groupInboxItems,
  inboxRowAccessibilityLabel,
  inboxRowKindSpec,
  splitDismissedTemplate,
} from '../src/ui/inbox/format'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.parse('2026-11-24T12:00:00.000Z')

function sampleItem(overrides: Partial<MobileInboxItem> = {}): MobileInboxItem {
  return {
    key: 'srv|item-1',
    serverId: 'srv',
    serverName: 'Home server',
    environmentId: 'personal',
    environmentName: 'Personal',
    stale: false,
    source: 'workspace',
    title: 'Fix flaky test',
    project: 'maestrly',
    summary: '50 of 50 runs passed.',
    place: { key: 'srv/personal', label: 'Home server · Personal' },
    target: { kind: 'conversation', conversationId: 'c1' },
    kind: 'finished',
    group: 'new',
    unread: true,
    at: NOW - 10 * MINUTE,
    expiresAt: null,
    ...overrides,
  }
}

describe('inbox UI helpers', () => {
  it('formats compact ages in English and Brazilian Portuguese', () => {
    const en = translator('en').t
    const pt = translator('pt-BR').t

    expect(formatCompactAge(0, en)).toBe('now')
    expect(formatCompactAge(59_999, en)).toBe('now')
    expect(formatCompactAge(MINUTE, en)).toBe('1m')
    expect(formatCompactAge(59 * MINUTE, en)).toBe('59m')
    expect(formatCompactAge(HOUR, en)).toBe('1h')
    expect(formatCompactAge(23 * HOUR + 59 * MINUTE, en)).toBe('23h')
    expect(formatCompactAge(DAY, en)).toBe('1d')

    expect(formatCompactAge(30_000, pt)).toBe('agora')
    expect(formatCompactAge(15 * MINUTE, pt)).toBe('15min')
    expect(formatCompactAge(2 * HOUR, pt)).toBe('2h')
    expect(formatCompactAge(3 * DAY, pt)).toBe('3d')
  })

  it('formats row time with cue tone for waiting and Leaves in under 3h for read items', () => {
    const { t } = translator('en')

    expect(formatRowTime(sampleItem({ group: 'waiting', at: NOW - 2 * MINUTE }), NOW, t)).toEqual({
      text: '2m',
      tone: 'cue',
      bold: true,
    })

    expect(formatRowTime(sampleItem({ group: 'new', at: NOW - 12 * MINUTE }), NOW, t)).toEqual({
      text: '12m',
      tone: 'muted',
      bold: false,
    })

    expect(
      formatRowTime(sampleItem({ group: 'read', at: NOW - 22 * HOUR, expiresAt: NOW + 110 * MINUTE }), NOW, t)
    ).toEqual({
      text: 'Leaves in 2h',
      tone: 'faint',
      bold: false,
    })

    expect(
      formatRowTime(sampleItem({ group: 'read', at: NOW - 23 * HOUR, expiresAt: NOW + 10 * MINUTE }), NOW, t)
    ).toEqual({
      text: 'Leaves in 1h',
      tone: 'faint',
      bold: false,
    })

    expect(
      formatRowTime(sampleItem({ group: 'read', at: NOW - 20 * HOUR, expiresAt: NOW + 4 * HOUR }), NOW, t)
    ).toEqual({
      text: '20h',
      tone: 'muted',
      bold: false,
    })
  })

  it('formats header counts and place labels under server filters', () => {
    const { t } = translator('en')
    expect(formatInboxCounts({ waiting: 0, unread: 0 }, t)).toBe('Nothing pending')
    expect(formatInboxCounts({ waiting: 3, unread: 4 }, t)).toBe('3 waiting on you · 4 new')

    const item = sampleItem({ serverName: 'Work server', environmentId: 'prod', environmentName: 'Production' })
    expect(formatInboxPlace(item, { serverCount: 2, environmentCount: 2, filtered: false })).toBe(
      'Production · Work server'
    )
    expect(formatInboxPlace(item, { serverCount: 2, environmentCount: 2, filtered: true })).toBe('Production')
    expect(formatInboxPlace(item, { serverCount: 2, environmentCount: 1, filtered: true })).toBeNull()
    expect(formatInboxPlace(item, { serverCount: 1, environmentCount: 1, filtered: false })).toBeNull()
    expect(formatInboxPlace(item, { serverCount: 1, environmentCount: 2, filtered: false })).toBe('Production')
  })

  it('groups items in waiting -> new -> read order, newest first with key tie-breaker', () => {
    const items = [
      sampleItem({ key: 'r1', group: 'read', unread: false, at: NOW - 30 * MINUTE }),
      sampleItem({ key: 'n-b', group: 'new', at: NOW - 10 * MINUTE }),
      sampleItem({ key: 'n-a', group: 'new', at: NOW - 10 * MINUTE }),
      sampleItem({ key: 'n-top', group: 'new', at: NOW - 5 * MINUTE }),
      sampleItem({ key: 'w1', group: 'waiting', kind: 'approval', at: NOW - 2 * MINUTE }),
    ]
    const grouped = groupInboxItems(items)
    expect(grouped.map((g) => g.group)).toEqual(['waiting', 'new', 'read'])
    expect(grouped[1].items.map((i) => i.key)).toEqual(['n-top', 'n-a', 'n-b'])
  })

  it('splits dismissed template around {title} and omits summary for read accessibility labels', () => {
    const en = translator('en').t
    const pt = translator('pt-BR').t

    expect(splitDismissedTemplate(en('inbox.dismissed'), 'Deploy rc.2')).toEqual({
      before: '“',
      title: 'Deploy rc.2',
      after: '” dismissed',
    })
    expect(splitDismissedTemplate(pt('inbox.dismissed'), 'Deploy rc.2')).toEqual({
      before: '“',
      title: 'Deploy rc.2',
      after: '” dispensada',
    })

    const waitingLabel = inboxRowAccessibilityLabel(
      sampleItem({ group: 'waiting', kind: 'approval', unread: true, stale: true }),
      { branch: 'feat/x', place: 'Personal · Home server', timeText: '2m', t: en }
    )
    expect(waitingLabel).toBe(
      'Fix flaky test, Needs your approval, 50 of 50 runs passed., maestrly, feat/x, Personal · Home server, Offline, 2m, Unread'
    )

    const readLabel = inboxRowAccessibilityLabel(
      sampleItem({ group: 'read', kind: 'finished', unread: false, source: 'chat' }),
      { branch: null, place: null, timeText: '5h', t: en }
    )
    expect(readLabel).toBe('Fix flaky test, Finished, Chat, 5h')
  })

  it('maps kind colors for active vs read rows', () => {
    expect(inboxRowKindSpec('question', false).icon).toBe('help-circle')
    expect(inboxRowKindSpec('approval', false).labelTone).toBe('cue')
    expect(inboxRowKindSpec('error', false).iconColor(palettes.light)).toBe(palettes.light.brick)
    expect(inboxRowKindSpec('finished', false).iconColor(palettes.dark)).toBe(palettes.dark.moss)
    expect(inboxRowKindSpec('error', true).iconColor(palettes.light)).toBe(palettes.light.muted)
    expect(inboxRowKindSpec('approval', true).labelTone).toBe('muted')
  })
})
