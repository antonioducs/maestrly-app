import { describe, expect, it } from 'vitest'
import type { FleetInboxItem } from '@maestrly/bot-fleet-protocol'
import {
  dismissInboxItem,
  filterInbox,
  INBOX_READ_TTL_MS,
  type InboxLedger,
  type InboxObservation,
  type InboxView,
  inboxCounts,
  inboxItems,
  inboxPlaces,
  inboxSourceCounts,
  markInboxRead,
  parseInboxLedger,
  reconcileInbox,
  restoreInboxEntry,
  withStickyGroup,
} from '../../src/renderer/lib/inbox/inbox-model'
import {
  botObservations,
  conversationObservations,
  type InboxConversationInput,
} from '../../src/renderer/lib/inbox/inbox-sources'
import type { Conversation } from '../../src/shared/conversation'
import { type FleetServerId, fleetKey } from '../../src/shared/fleet-servers'
import type { FleetBotAttentionEvent } from '../../src/shared/notifications'

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const HOUR = 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 7, 12)
const here = { key: 'host:local', label: 'This computer' }

const view = (title: string, overrides: Partial<InboxView> = {}): InboxView => ({
  source: 'workspace',
  title,
  summary: null,
  place: here,
  target: { kind: 'conversation', conversationId: title },
  ...overrides,
})

const observation = (
  key: string,
  active: InboxObservation['active'],
  at: number | null,
  overrides: Partial<InboxObservation> = {}
): InboxObservation => ({ key, view: view(key), active, at, ...overrides })

/** Runs the sources' observations through the center at a time, as the hook does. */
function step(ledger: InboxLedger, observations: InboxObservation[], now: number) {
  const next = reconcileInbox(ledger, observations, now)
  return { ledger: next, items: inboxItems(next, observations, now) }
}

describe('notifications center ledger', () => {
  it('lists an unread ended turn as new, then as read for a day, then forgets it', () => {
    let s = step({}, [observation('a', { kind: 'finished', unread: true }, T0)], T0)
    expect(s.items.map(({ key, group, unread, at }) => ({ key, group, unread, at }))).toEqual([
      { key: 'a', group: 'new', unread: true, at: T0 },
    ])
    // The owner opened it on some computer: the mark is gone.
    s = step(s.ledger, [observation('a', null, T0)], T0 + HOUR)
    expect(s.items[0]).toMatchObject({ group: 'read', unread: false, expiresAt: T0 + HOUR + INBOX_READ_TTL_MS })
    s = step(s.ledger, [observation('a', null, T0)], T0 + HOUR + INBOX_READ_TTL_MS + 1)
    expect(s.items).toEqual([])
    expect(s.ledger).toEqual({})
  })

  it('keeps what waits for the owner listed, read or not, and shows it resolved once answered', () => {
    let s = step({}, [observation('q', { kind: 'question', unread: true }, T0, { status: 'asking' })], T0)
    expect(s.items[0]).toMatchObject({ group: 'waiting', unread: true, kind: 'question' })
    s = step(s.ledger, [observation('q', { kind: 'question', unread: false }, T0, { status: 'asking' })], T0 + HOUR)
    expect(s.items[0]).toMatchObject({ group: 'waiting', unread: false })
    s = step(
      s.ledger,
      [observation('q', { kind: 'question', unread: false }, T0, { status: 'asking' })],
      T0 + 30 * HOUR
    )
    expect(s.items[0]).toMatchObject({ group: 'waiting' })
    s = step(s.ledger, [observation('q', null, T0, { status: 'ready' })], T0 + 31 * HOUR)
    expect(s.items[0]).toMatchObject({ group: 'read', kind: 'finished' })
  })

  it('takes a later event of a read item as new, at its own time', () => {
    let s = step({}, [observation('a', { kind: 'finished', unread: true }, T0)], T0)
    s = step(s.ledger, [observation('a', null, T0)], T0 + HOUR)
    s = step(s.ledger, [observation('a', { kind: 'error', unread: true }, T0 + 2 * HOUR)], T0 + 2 * HOUR)
    expect(s.items[0]).toMatchObject({ group: 'new', kind: 'error', at: T0 + 2 * HOUR })
    // A mark without a time may be the one being cleared: the row is unread while it lasts, at the time it had.
    s = step(s.ledger, [observation('a', null, T0)], T0 + 3 * HOUR)
    s = step(s.ledger, [observation('a', { kind: 'error', unread: true }, null)], T0 + 4 * HOUR)
    expect(s.items[0]).toMatchObject({ group: 'new', unread: true, at: T0 + 2 * HOUR })
  })

  it('returns the same ledger when nothing changed', () => {
    const observations = [
      observation('a', { kind: 'finished', unread: true }, T0),
      observation('b', null, T0),
      observation('q', { kind: 'question', unread: false }, T0),
    ]
    const first = reconcileInbox({}, observations, T0)
    expect(reconcileInbox(first, observations, T0 + 1_000)).toBe(first)
    // A listing a moment later than the live status is the same event.
    const later = [observation('a', { kind: 'finished', unread: true }, T0 + 500), ...observations.slice(1)]
    expect(reconcileInbox(first, later, T0 + 1_000)).toBe(first)
  })

  it('hides a dismissed item until something newer happens, and undoes a dismissal', () => {
    let s = step({}, [observation('a', { kind: 'finished', unread: true }, T0)], T0)
    const before = s.ledger.a
    const dismissed = dismissInboxItem(s.ledger, 'a', T0 + 1_000)
    expect(inboxItems(dismissed, [observation('a', null, T0)], T0 + 2_000)).toEqual([])
    expect(
      inboxItems(
        restoreInboxEntry(dismissed, 'a', before),
        [observation('a', { kind: 'finished', unread: true }, T0)],
        T0
      )
    ).toHaveLength(1)
    s = step(dismissed, [observation('a', null, T0)], T0 + HOUR)
    expect(s.items).toEqual([])
    s = step(s.ledger, [observation('a', { kind: 'finished', unread: true }, T0 + 2 * HOUR)], T0 + 2 * HOUR)
    expect(s.items[0]).toMatchObject({ group: 'new', unread: true })
  })

  it('keeps what it knew of a bot mark read back after a restart', () => {
    const known = observation('bot', { kind: 'error', unread: true }, T0, {
      view: view('Atlas', { source: 'bot', summary: 'The token expired' }),
    })
    const first = reconcileInbox({}, [known], T0)
    const unknown = observation('bot', { kind: 'finished', unread: true }, null, {
      known: false,
      view: view('Atlas', { source: 'bot' }),
    })
    const s = step(first, [unknown], T0 + HOUR)
    expect(s.ledger).toBe(first)
    expect(s.items[0]).toMatchObject({ kind: 'error', summary: 'The token expired', at: T0 })
  })

  it("reads a bot's request in its own ledger and forgets it once it is answered", () => {
    const request = observation('req', { kind: 'approval', unread: true }, T0, { ownRead: true, transient: true })
    let s = step({}, [request], T0)
    expect(s.items[0]).toMatchObject({ group: 'waiting', unread: true })
    s = { ledger: markInboxRead(s.ledger, ['req'], T0 + 1_000), items: [] }
    s = step(s.ledger, [request], T0 + 2_000)
    expect(s.items[0]).toMatchObject({ group: 'waiting', unread: false })
    s = step(s.ledger, [], T0 + 3_000)
    expect(s.ledger).toEqual({})
  })

  it('lists only what a source lists now, and keeps the entries of a host that is away', () => {
    let s = step({}, [observation('a', { kind: 'finished', unread: true }, T0)], T0)
    s = step(s.ledger, [], T0 + HOUR)
    expect(s.items).toEqual([])
    expect(Object.keys(s.ledger)).toEqual(['a'])
    s = step(s.ledger, [observation('a', { kind: 'finished', unread: true }, T0)], T0 + 2 * HOUR)
    expect(s.items[0]).toMatchObject({ group: 'new', at: T0 })
  })

  it('keeps an opened item in its group while it stays open', () => {
    const s = step({}, [observation('a', { kind: 'finished', unread: true }, T0)], T0)
    const read = step(s.ledger, [observation('a', null, T0)], T0 + 1_000)
    expect(withStickyGroup(read.items, { key: 'a', group: 'new' })[0].group).toBe('new')
    expect(withStickyGroup(read.items, null)[0].group).toBe('read')
  })

  it('reads back only valid entries', () => {
    const s = step({}, [observation('a', { kind: 'finished', unread: true }, T0)], T0)
    const stored = JSON.stringify({
      ...s.ledger,
      bad: { kind: 'other', at: 1, view: s.ledger.a.view },
      worse: { kind: 'finished', at: 'x' },
    })
    expect(parseInboxLedger(stored)).toEqual(s.ledger)
    expect(parseInboxLedger('{')).toEqual({})
    expect(parseInboxLedger('[1]')).toEqual({})
    expect(parseInboxLedger(null)).toEqual({})
  })

  it('filters by place, source and text, and counts what the rail shows', () => {
    const away = { key: 'host:remote', label: 'Cloud' }
    const observations = [
      observation('a', { kind: 'finished', unread: true }, T0),
      observation('b', { kind: 'approval', unread: false }, T0 + 1, {
        view: view('Deploy', { source: 'bot', place: away, summary: 'Run kubectl' }),
      }),
      observation('c', { kind: 'question', unread: true }, T0 + 2, { view: view('Chat', { source: 'chat' }) }),
    ]
    const { items } = step({}, observations, T0 + 3)
    expect(inboxCounts(items)).toEqual({ waiting: 2, unread: 1 })
    expect(inboxPlaces(items)).toEqual([
      { ...away, count: 1 },
      { ...here, count: 2 },
    ])
    expect(inboxSourceCounts(items)).toEqual({ all: 3, workspace: 1, chat: 1, bot: 1 })
    expect(filterInbox(items, { place: 'host:remote', source: null, query: '' }).map(({ key }) => key)).toEqual(['b'])
    expect(filterInbox(items, { place: null, source: 'chat', query: '' }).map(({ key }) => key)).toEqual(['c'])
    expect(filterInbox(items, { place: null, source: null, query: 'KUBECTL' }).map(({ key }) => key)).toEqual(['b'])
  })
})

describe('notifications center sources', () => {
  const conversation = (id: string, overrides: Partial<Conversation> = {}): Conversation =>
    ({
      id,
      name: id,
      scope: 'project',
      workspaceId: 'w',
      status: 'ready',
      archived: 0,
      lastActivityAt: T0,
      ...overrides,
    }) as Conversation
  const inputs = (...conversations: Conversation[]): InboxConversationInput[] =>
    conversations.map((item) => ({ conversation: item, project: 'maestrly-app', place: here }))

  it('tells what each conversation needs: a plan, a question, an approval, then what ended unread', () => {
    const observations = conversationObservations(
      inputs(
        conversation('plan', { status: 'ready' }),
        conversation('question'),
        conversation('approval'),
        conversation('failed'),
        conversation('quiet'),
        conversation('archived', { archived: 1 })
      ),
      {
        statuses: { question: 'asking', approval: 'waiting', failed: 'error' },
        attention: new Set(['plan', 'question', 'failed', 'archived']),
        pendingPlanIds: new Set(['plan']),
        liveAt: { failed: T0 + HOUR },
      }
    )
    expect(observations.map(({ key, active, at }) => ({ key, active, at }))).toEqual([
      { key: 'conversation:plan', active: { kind: 'plan', unread: true }, at: T0 },
      { key: 'conversation:question', active: { kind: 'question', unread: true }, at: T0 },
      { key: 'conversation:approval', active: { kind: 'approval', unread: false }, at: T0 },
      { key: 'conversation:failed', active: { kind: 'error', unread: true }, at: T0 + HOUR },
      { key: 'conversation:quiet', active: null, at: T0 },
    ])
    expect(observations[0].view).toMatchObject({ source: 'workspace', project: 'maestrly-app', title: 'plan' })
    const [chat] = conversationObservations(
      inputs(conversation('chat', { scope: 'standalone' } as Partial<Conversation>)),
      {
        statuses: {},
        attention: new Set(),
        pendingPlanIds: new Set(),
        liveAt: {},
      }
    )
    expect(chat.view.source).toBe('chat')
  })

  it("tells each bot's mark with what marked it, and each request that waits", () => {
    const place = () => ({ key: 'env:cloud', label: 'Cloud' })
    const events = new Map<string, FleetBotAttentionEvent>([
      [fleetKey(S1, 'atlas'), { kind: 'routineFailed', at: T0, summary: 'Token expired', runId: 'run-1' }],
      [fleetKey(S1, 'nova'), { kind: 'threadPaused', at: T0 + 1, summary: null, threadId: 't-1' }],
    ])
    const request: FleetInboxItem = {
      botId: 'atlas',
      interaction: {
        kind: 'permission',
        id: 'perm-1',
        at: new Date(T0 + 2).toISOString(),
        title: 'Run kubectl rollout restart',
        detail: null,
        tool: null,
        itemId: 'item-1',
      },
    }
    const observations = botObservations(
      [
        {
          serverId: S1,
          bots: [
            { id: 'atlas', name: 'Atlas', tint: '#112233', environmentId: 'e1' },
            { id: 'nova', name: 'Nova', tint: '#445566', environmentId: 'e1' },
            { id: 'echo', name: 'Echo', tint: '#778899', environmentId: 'e1' },
            { id: 'orion', name: 'Orion', tint: '#aabbcc', environmentId: 'e1' },
          ],
          inbox: [request],
          place,
        },
      ],
      new Set([fleetKey(S1, 'atlas'), fleetKey(S1, 'nova'), fleetKey(S1, 'echo')]),
      events
    )
    expect(observations.map(({ key, active, at, known }) => ({ key, active, at, known }))).toEqual([
      { key: `bot:${S1}/atlas`, active: { kind: 'error', unread: true }, at: T0, known: true },
      { key: `bot:${S1}/nova`, active: { kind: 'help', unread: true }, at: T0 + 1, known: true },
      { key: `bot:${S1}/echo`, active: { kind: 'activity', unread: true }, at: null, known: false },
      { key: `bot:${S1}/orion`, active: null, at: null, known: false },
      { key: `request:${S1}/atlas/perm-1`, active: { kind: 'approval', unread: true }, at: T0 + 2, known: undefined },
    ])
    expect(observations[0].view).toMatchObject({
      bot: { name: 'Atlas', lane: 'routine' },
      summary: 'Token expired',
      target: { kind: 'bot', serverId: S1, botId: 'atlas', runId: 'run-1' },
    })
    expect(observations[1].view.bot?.lane).toBe('thread')
    expect(observations[4]).toMatchObject({
      ownRead: true,
      transient: true,
      view: { summary: 'Run kubectl rollout restart', target: { requestId: 'perm-1' } },
    })
  })
})
