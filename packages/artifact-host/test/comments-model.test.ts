import { describe, expect, it } from 'vitest'
import {
  anchorsFor,
  authorLabel,
  avatarTone,
  buildThreads,
  firstSeen,
  flipsLeft,
  initials,
  isUnread,
  listThreads,
  markSeen,
  offscreen,
  openCounts,
  parseSeen,
  pinnedThreads,
  placeCard,
  pruneSeen,
  relativeTime,
  snippet,
  steppable,
} from '../src/shell/comments-model.js'
import type { PublicComment } from '../src/shell/contract.js'

let sequence = 0

function comment(overrides: Partial<PublicComment> = {}): PublicComment {
  sequence++
  return {
    id: `c${sequence}`.padEnd(22, '0'),
    version: 2,
    parentId: null,
    author: { kind: 'invited', name: 'Maria', verified: true, self: false },
    body: `Comment ${sequence}`,
    anchor: { quote: { exact: `passage ${sequence}`, prefix: '', suffix: '' } },
    status: 'open',
    createdAt: sequence * 10,
    canDelete: false,
    ...overrides,
  }
}

const reply = (parent: PublicComment, overrides: Partial<PublicComment> = {}) =>
  comment({ parentId: parent.id, anchor: null, version: parent.version, ...overrides })

describe('threads', () => {
  it('nests replies under their thread, both in the order they were written', () => {
    const later = comment({ createdAt: 30 })
    const earlier = comment({ createdAt: 20 })
    const second = reply(later, { createdAt: 50 })
    const first = reply(later, { createdAt: 40 })
    const orphan = comment({ parentId: 'gone'.padEnd(22, '0') })
    const threads = buildThreads([second, later, first, earlier, orphan])
    expect(threads.map((thread) => thread.comment.id)).toEqual([earlier.id, later.id])
    expect(threads[1]!.replies.map((item) => item.id)).toEqual([first.id, second.id])
  })

  it('lists one status, on this version and then on the others', () => {
    const open = comment()
    const done = comment({ status: 'resolved' })
    const older = comment({ version: 1 })
    const olderDone = comment({ version: 1, status: 'resolved' })
    const threads = buildThreads([open, done, older, olderDone])
    const ids = (list: { comment: PublicComment }[]) => list.map((thread) => thread.comment.id)
    const opened = listThreads(threads, 2, 'open')
    expect([ids(opened.here), ids(opened.elsewhere)]).toEqual([[open.id], [older.id]])
    const resolved = listThreads(threads, 2, 'resolved')
    expect([ids(resolved.here), ids(resolved.elsewhere)]).toEqual([[done.id], [olderDone.id]])
    expect(openCounts(threads)).toEqual(
      new Map([
        [2, 1],
        [1, 1],
      ])
    )
  })

  it('pins open threads of the version on screen that point at something, and the active one', () => {
    const open = comment()
    const spot = comment({ anchor: { point: { selector: '#chart', rx: 0.5, ry: 0.2 } } })
    const page = comment({ anchor: null })
    const done = comment({ status: 'resolved' })
    const older = comment({ version: 1 })
    const threads = buildThreads([open, spot, page, done, older])
    const ids = (options: { showResolved: boolean; activeId: string | null }) =>
      pinnedThreads(threads, 2, options).map((thread) => thread.comment.id)
    expect(ids({ showResolved: false, activeId: null })).toEqual([open.id, spot.id])
    expect(ids({ showResolved: true, activeId: null })).toEqual([open.id, spot.id, done.id])
    expect(ids({ showResolved: false, activeId: done.id })).toEqual([open.id, spot.id, done.id])
    // A comment about the whole page has no place to pin, even while it is open in the card.
    expect(ids({ showResolved: false, activeId: page.id })).toEqual([open.id, spot.id])
  })

  it('steps through the open threads of the version on screen, and the one being read', () => {
    const open = comment()
    const page = comment({ anchor: null })
    const done = comment({ status: 'resolved' })
    const older = comment({ version: 1 })
    const threads = buildThreads([open, page, done, older])
    expect(steppable(threads, 2, null).map((thread) => thread.comment.id)).toEqual([open.id, page.id])
    expect(steppable(threads, 2, done.id).map((thread) => thread.comment.id)).toEqual([open.id, page.id, done.id])
  })
})

describe('anchorsFor', () => {
  it('sends the page only its own text and places in it, never names or comment text', () => {
    const quoted = comment({
      anchor: { quote: { exact: 'Sales grew', prefix: 'a', suffix: 'b' }, hint: { selector: 'p' } },
    })
    const spot = comment({ anchor: { point: { selector: '#chart', rx: 0.5, ry: 0.2 } } })
    const anchors = anchorsFor(buildThreads([quoted, spot]), { point: { selector: 'h1', rx: 0, ry: 1 } })
    expect(anchors).toEqual([
      { id: quoted.id, quote: { exact: 'Sales grew', prefix: 'a', suffix: 'b' } },
      { id: spot.id, point: { selector: '#chart', rx: 0.5, ry: 0.2 } },
      { id: 'draft', point: { selector: 'h1', rx: 0, ry: 1 } },
    ])
    expect(JSON.stringify(anchors)).not.toContain('Maria')
    expect(JSON.stringify(anchors)).not.toContain('Comment')
  })
})

describe('unread', () => {
  it('counts what others wrote after the first visit, until the thread is opened', () => {
    const old = comment({ createdAt: 100 })
    const seen = firstSeen([old])
    expect(seen).toEqual({ baseline: 100, threads: {} })
    const fresh = comment({ createdAt: 200 })
    const mine = comment({ createdAt: 300, author: { kind: 'guest', name: 'Ana', verified: false, self: true } })
    let threads = buildThreads([old, fresh, mine])
    expect(threads.map((thread) => isUnread(thread, seen))).toEqual([false, true, false])

    const read = markSeen(seen, threads[1]!)
    expect(isUnread(threads[1]!, read)).toBe(false)
    // A reply from someone else makes the thread new again; the reader's own reply does not.
    threads = buildThreads([old, fresh, mine, reply(fresh, { createdAt: 400 })])
    expect(isUnread(threads[1]!, read)).toBe(true)
    const again = markSeen(read, threads[1]!)
    threads = buildThreads([
      old,
      fresh,
      mine,
      reply(fresh, { createdAt: 400 }),
      reply(old, { createdAt: 500, author: { kind: 'owner', name: 'A', verified: true, self: true } }),
    ])
    expect(isUnread(threads[0]!, again)).toBe(false)
  })

  it('forgets deleted threads and survives a damaged stored value', () => {
    const kept = comment()
    const seen = { baseline: 5, threads: { [kept.id]: 9, gone: 3 } }
    expect(pruneSeen(seen, buildThreads([kept]))).toEqual({ baseline: 5, threads: { [kept.id]: 9 } })
    expect(parseSeen(JSON.stringify(seen))).toEqual(seen)
    expect(parseSeen('{"baseline":"x"}')).toBeNull()
    expect(parseSeen('not json')).toBeNull()
    expect(parseSeen(null)).toBeNull()
    expect(parseSeen('{"baseline":1,"threads":{"a":"x","b":2}}')).toEqual({ baseline: 1, threads: { b: 2 } })
  })
})

describe('names and faces', () => {
  const t = (key: string, vars: Record<string, string | number> = {}) => `${key}:${Object.values(vars).join(',')}`
  const author = (kind: PublicComment['author']['kind'], name: string, self = false) => ({
    kind,
    name,
    verified: kind !== 'guest',
    self,
  })

  it('names each kind of author', () => {
    expect(authorLabel(t, author('invited', 'Maria'))).toBe('Maria')
    expect(authorLabel(t, author('invited', 'Maria', true))).toBe('you:')
    expect(authorLabel(t, author('guest', 'Ana'))).toBe('unverified:Ana')
    expect(authorLabel(t, author('owner', 'Antonio'))).toBe('commentOwner:Antonio')
    expect(authorLabel(t, author('owner', ''))).toBe('commentOwnerUnnamed:')
    expect(authorLabel(t, author('agent', 'Antonio'))).toBe('commentAgent:Antonio')
    expect(authorLabel(t, author('agent', ''))).toBe('commentAgentUnnamed:')
  })

  it('takes up to two initials and a stable tone', () => {
    expect(initials('Maria Lopes da Silva')).toBe('ML')
    expect(initials('  joão ')).toBe('J')
    expect(initials('')).toBe('')
    expect(initials('Élodie Ávila')).toBe('ÉÁ')
    expect(avatarTone('invited', 'Maria')).toBe(avatarTone('invited', 'Maria'))
    expect(avatarTone('invited', 'Maria')).toBeGreaterThanOrEqual(0)
    expect(avatarTone('invited', 'Maria')).toBeLessThan(8)
  })

  it('shortens text on one line', () => {
    expect(snippet('Short', 10)).toBe('Short')
    expect(snippet('Two\nlines   here', 40)).toBe('Two lines here')
    expect(snippet('A long sentence that goes on', 12)).toBe('A long sent…')
  })

  it('says how long ago, in the reader’s language', () => {
    const now = 1_000_000_000
    expect(relativeTime('en', now - 20_000, now, 'now')).toBe('now')
    // The exact words come from the runtime's locale data, which varies between versions.
    const expected = (unit: Intl.RelativeTimeFormatUnit, value: number, locale = 'en') =>
      new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' }).format(-value, unit)
    expect(relativeTime('en', now - 5 * 60_000, now, 'now')).toBe(expected('minute', 5))
    expect(relativeTime('pt-BR', now - 3 * 3_600_000, now, 'agora')).toBe(expected('hour', 3, 'pt-BR'))
    expect(relativeTime('en', now - 2 * 86_400_000, now, 'now')).toBe(expected('day', 2))
    expect(relativeTime('en', now - 15 * 86_400_000, now, 'now')).toBe(expected('week', 2))
  })
})

describe('placement', () => {
  const stage = { width: 1000, height: 700 }
  const card = { width: 340, height: 300 }

  it('puts the card beside its pin, and on the other side near the edge', () => {
    const right = placeCard({ left: 100, top: 200, width: 30, height: 30 }, card, stage)
    expect(right).toMatchObject({ left: 140, top: 194, originX: 'left' })
    const left = placeCard({ left: 800, top: 200, width: 30, height: 30 }, card, stage)
    expect(left).toMatchObject({ left: 450, originX: 'right' })
    // Near the bottom it moves up to stay in view.
    expect(placeCard({ left: 100, top: 650, width: 30, height: 30 }, card, stage).top).toBe(388)
    // Without room on either side it centers on the pin.
    const narrow = placeCard({ left: 180, top: 100, width: 30, height: 30 }, card, { width: 400, height: 700 })
    expect(narrow.left).toBe(25)
    expect(placeCard(null, card, stage)).toMatchObject({ left: 644, top: 16 })
  })

  it('opens previews to the left near the right edge', () => {
    expect(flipsLeft(600, 1000)).toBe(false)
    expect(flipsLeft(800, 1000)).toBe(true)
  })

  it('finds the open pins scrolled out of sight, nearest first', () => {
    const pins = { a: { x: 1, y: -400 }, b: { x: 1, y: -20 }, c: { x: 1, y: 300 }, d: { x: 1, y: 900 }, e: null }
    expect(offscreen(['a', 'b', 'c', 'd', 'e'], pins, 700)).toEqual({ above: ['b', 'a'], below: ['d'] })
    expect(offscreen(['c'], pins, 700)).toEqual({ above: [], below: [] })
  })
})
