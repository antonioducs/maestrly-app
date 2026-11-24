import type { InboxGroup, InboxKind } from '@maestrly/bot-fleet-protocol/inbox'
import type { Translate } from '../../i18n'
import type { MobileInboxItem } from '../../inbox'
import type { Palette } from '../../theme/tokens'
import type { IconName } from '../icons'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const LEAVES_WINDOW_MS = 3 * HOUR_MS

export const INBOX_GROUP_ORDER: readonly InboxGroup[] = ['waiting', 'new', 'read']

export function formatCompactAge(ms: number, t: Translate): string {
  const safe = Math.max(0, ms)
  if (safe < MINUTE_MS) return t('age.now')
  if (safe < HOUR_MS) return t('age.m', { n: Math.floor(safe / MINUTE_MS) })
  if (safe < DAY_MS) return t('age.h', { n: Math.floor(safe / HOUR_MS) })
  return t('age.d', { n: Math.floor(safe / DAY_MS) })
}

export type RowTimeDisplay = {
  text: string
  tone: 'cue' | 'faint' | 'muted'
  bold: boolean
}

export function formatRowTime(
  item: Pick<MobileInboxItem, 'group' | 'at' | 'expiresAt'>,
  now: number,
  t: Translate
): RowTimeDisplay {
  if (item.group === 'read' && item.expiresAt !== null) {
    const remaining = Math.max(0, item.expiresAt - now)
    if (remaining < LEAVES_WINDOW_MS) {
      const roundedHoursMs = Math.max(HOUR_MS, Math.ceil(remaining / HOUR_MS) * HOUR_MS)
      return {
        text: t('inbox.leavesIn', { time: formatCompactAge(roundedHoursMs, t) }),
        tone: 'faint',
        bold: false,
      }
    }
  }
  return {
    text: formatCompactAge(now - item.at, t),
    tone: item.group === 'waiting' ? 'cue' : 'muted',
    bold: item.group === 'waiting',
  }
}

export function formatInboxCounts(counts: { waiting: number; unread: number }, t: Translate): string {
  if (counts.waiting + counts.unread === 0) return t('inbox.countsNone')
  return t('inbox.counts', { waiting: counts.waiting, new: counts.unread })
}

export function formatInboxPlace(
  item: Pick<MobileInboxItem, 'serverName' | 'environmentId' | 'environmentName'>,
  options: { serverCount: number; environmentCount: number; filtered: boolean }
): string | null {
  const env = options.environmentCount > 1 && item.environmentId ? (item.environmentName ?? item.environmentId) : null
  const server = options.serverCount > 1 && !options.filtered ? item.serverName : null
  const label = [env, server].filter(Boolean).join(' · ')
  return label || null
}

export function groupInboxItems(
  items: readonly MobileInboxItem[]
): Array<{ group: InboxGroup; items: MobileInboxItem[] }> {
  const buckets: Record<InboxGroup, MobileInboxItem[]> = {
    waiting: [],
    new: [],
    read: [],
  }
  for (const item of items) buckets[item.group].push(item)
  const compare = (a: MobileInboxItem, b: MobileInboxItem) =>
    b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  return INBOX_GROUP_ORDER.flatMap((group) => {
    const list = buckets[group]
    if (list.length === 0) return []
    list.sort(compare)
    return [{ group, items: list }]
  })
}

export function splitDismissedTemplate(
  template: string,
  title: string
): { before: string; title: string; after: string } {
  const marker = '{title}'
  const index = template.indexOf(marker)
  if (index < 0) return { before: template, title: '', after: '' }
  return {
    before: template.slice(0, index),
    title,
    after: template.slice(index + marker.length),
  }
}

export type KindDisplaySpec = {
  icon: IconName
  iconColor: (palette: Palette) => string
  labelTone: 'cue' | 'brick' | 'ink' | 'muted'
}

export function inboxRowKindSpec(kind: InboxKind, read: boolean): KindDisplaySpec {
  const icon: Record<InboxKind, IconName> = {
    approval: 'shield',
    question: 'help-circle',
    plan: 'clipboard',
    help: 'hand',
    error: 'alert',
    finished: 'check',
    activity: 'sparkles',
  }
  if (read) {
    return {
      icon: icon[kind],
      iconColor: (palette) => palette.muted,
      labelTone: 'muted',
    }
  }
  if (kind === 'error') {
    return { icon: icon[kind], iconColor: (palette) => palette.brick, labelTone: 'brick' }
  }
  if (kind === 'finished') {
    return { icon: icon[kind], iconColor: (palette) => palette.moss, labelTone: 'ink' }
  }
  if (kind === 'activity') {
    return { icon: icon[kind], iconColor: (palette) => palette.muted, labelTone: 'ink' }
  }
  return { icon: icon[kind], iconColor: (palette) => palette.cueInk, labelTone: 'cue' }
}

export function inboxRowAccessibilityLabel(
  item: MobileInboxItem,
  options: { branch: string | null; place: string | null; timeText: string; t: Translate }
): string {
  const parts: string[] = [item.title, options.t(`inbox.kind.${item.kind}`)]
  if (item.group !== 'read' && item.summary) parts.push(item.summary)
  if (item.source === 'workspace') {
    if (item.project) parts.push(item.project)
    if (options.branch) parts.push(options.branch)
  } else if (item.source === 'chat') {
    parts.push(options.t('inbox.source.chat'))
  } else if (item.source === 'routine') {
    parts.push(options.t('inbox.source.routine'))
  } else {
    const lane = item.bot?.lane ?? 'main'
    parts.push(options.t(`inbox.lane.${lane}`))
  }
  if (options.place) {
    parts.push(item.stale ? `${options.place}, ${options.t('inbox.offline')}` : options.place)
  }
  parts.push(options.timeText)
  if (item.unread) parts.push(options.t('inbox.unread'))
  return parts.join(', ')
}
