import { expect, it } from 'vitest'
import {
  botRef,
  hostRef,
  localRef,
  type OverviewBot,
  type OverviewConversation,
  overviewSummary,
  parseOverviewRef,
  summarizeOverview,
} from '../../src/shared/assistant-overview'
import { conversationKind } from '../../src/shared/inbox-kind'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function conversation(id: string, patch: Partial<OverviewConversation> = {}): OverviewConversation {
  return {
    ref: localRef(id),
    name: id,
    place: { kind: 'local' },
    workspaceName: null,
    branch: null,
    status: 'idle',
    running: false,
    pending: [],
    botCreated: false,
    lastActivityAt: NOW - HOUR,
    ...patch,
  }
}

function bot(id: string, patch: Partial<OverviewBot> = {}): OverviewBot {
  return {
    ref: botRef('server-1', id),
    name: id,
    role: null,
    place: { kind: 'bot-server', serverId: 'server-1', serverName: 'VPS' },
    status: 'idle',
    activity: null,
    pending: [],
    runningRoutine: null,
    ...patch,
  }
}

const summarize = (conversations: OverviewConversation[], bots: OverviewBot[] = [], limits = {}) =>
  summarizeOverview({ conversations, bots, workspaces: [], hosts: [], now: NOW }, limits)

it('parses the three ref forms and a bare conversation id', () => {
  expect(parseOverviewRef(localRef('6f1c2a'))).toEqual({ kind: 'local', conversationId: '6f1c2a' })
  expect(parseOverviewRef('6f1c2a-90b1')).toEqual({ kind: 'local', conversationId: '6f1c2a-90b1' })
  expect(parseOverviewRef(hostRef('srv/workspaces', 'c-1'))).toEqual({
    kind: 'host',
    hostId: 'srv/workspaces',
    conversationId: 'c-1',
  })
  expect(parseOverviewRef(botRef('server-1', 'bot_7'))).toEqual({ kind: 'bot', serverId: 'server-1', botId: 'bot_7' })
})

it.each(['', 'host:', 'host:srv', 'bot::x', 'other:1:2', 'local:', 'host:srv/ws:', 'a b'])('refuses %j', (ref) => {
  expect(parseOverviewRef(ref)).toBeNull()
})

it('puts what waits for the person first, by kind and then by recency', () => {
  const overview = summarize(
    [
      conversation('failed', { status: 'error', lastActivityAt: NOW - 1000 }),
      conversation('approval', { pending: [{ itemId: 'p1', need: 'approval', summary: 'npm install' }] }),
      conversation('old-question', {
        pending: [{ itemId: 'q1', need: 'question', summary: 'Which branch?' }],
        lastActivityAt: NOW - 5 * HOUR,
      }),
      conversation('new-question', {
        pending: [{ itemId: 'q2', need: 'question', summary: 'Ship it?' }],
        lastActivityAt: NOW - HOUR,
      }),
      conversation('busy', { running: true, status: 'working' }),
    ],
    [bot('reviewer', { pending: [{ itemId: 'b1', need: 'plan', summary: 'Plan ready' }] })]
  )
  expect(overview.needsYou.map((item) => item.name)).toEqual([
    'new-question',
    'old-question',
    'approval',
    'reviewer',
    'failed',
  ])
  expect(overview.running.map((item) => item.name)).toEqual(['busy'])
  expect(overview.recent).toEqual([])
})

it('keeps a running conversation that also waits only in needsYou', () => {
  const overview = summarize([
    conversation('asking', { running: true, pending: [{ itemId: 'q', need: 'question', summary: '?' }] }),
  ])
  expect(overview.needsYou).toHaveLength(1)
  expect(overview.running).toHaveLength(0)
})

it('lists recent conversations from the last day only, newest first', () => {
  const overview = summarize([
    conversation('yesterday', { lastActivityAt: NOW - 30 * HOUR }),
    conversation('morning', { lastActivityAt: NOW - 3 * HOUR }),
    conversation('now', { lastActivityAt: NOW - 60_000 }),
    conversation('never', { lastActivityAt: null }),
  ])
  expect(overview.recent.map((item) => item.name)).toEqual(['now', 'morning'])
})

it('caps each list and says which were cut', () => {
  const many = Array.from({ length: 5 }, (_, index) =>
    conversation(`c${index}`, { running: true, lastActivityAt: NOW - index })
  )
  const overview = summarize(many, [bot('a'), bot('b')], { running: 3, bots: 1 })
  expect(overview.running.map((item) => item.name)).toEqual(['c0', 'c1', 'c2'])
  expect(overview.bots).toHaveLength(1)
  expect(overview.truncated).toEqual({ needsYou: false, running: true, recent: false, bots: true })
})

it('shortens summaries to one line of at most 200 characters', () => {
  expect(overviewSummary('  a\n\n b  ')).toBe('a b')
  const long = overviewSummary('x'.repeat(300))
  expect(long).toHaveLength(200)
  expect(long.endsWith('…')).toBe(true)
  expect(overviewSummary(null)).toBe('')
})

it('keeps the notification center kinds as they were', () => {
  expect(conversationKind('working', true, false)).toBe('plan')
  expect(conversationKind('asking', false, false)).toBe('question')
  expect(conversationKind('waiting', false, false)).toBe('approval')
  expect(conversationKind('error', false, true)).toBe('error')
  expect(conversationKind('ready', false, true)).toBe('finished')
  expect(conversationKind('ready', false, false)).toBeNull()
})
