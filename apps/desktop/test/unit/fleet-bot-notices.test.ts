import { describe, expect, it, vi } from 'vitest'
import {
  fleetPeerThreadSchema,
  fleetRoutineRunSchema,
  type FleetActivityEntry,
  type FleetPeerThread,
  type FleetRoutineRun,
} from '@maestrly/bot-fleet-protocol'
import { FleetBotAttention } from '../../src/main/notifications/bot-attention'
import { FleetBotNotices } from '../../src/main/notifications/bot-notices'
import type { SystemNotice } from '../../src/main/notifications/system-notices'
import type { FleetServerId } from '../../src/shared/fleet-servers'

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const AT = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-01T00:05:00.000Z'

const entry = (
  kind: FleetActivityEntry['kind'],
  data: FleetActivityEntry['data'] = {},
  summary: string | null = null
): FleetActivityEntry => ({ seq: 1, at: AT, botId: 'alex', environmentId: null, kind, summary, data })
const run = (seenAt: string | null): FleetRoutineRun =>
  fleetRoutineRunSchema.parse({
    id: 'run-1',
    routineId: 'routine-1',
    botId: 'alex',
    trigger: 'schedule',
    status: 'completed',
    deliveredAt: AT,
    finishedAt: AT,
    report: null,
    finalText: null,
    conversation: 'own',
    seenAt,
  })
const thread = (lastActivityAt: string, seenActivityAt: string | null): FleetPeerThread =>
  fleetPeerThreadSchema.parse({
    id: 't-1',
    botId: 'alex',
    peer: { botId: 'nina', name: 'Nina' },
    title: 'Release',
    origin: 'peer',
    status: 'open',
    hops: 1,
    hopLimit: 8,
    messages: 1,
    pinned: false,
    conversation: 'own',
    report: null,
    reportAt: null,
    working: false,
    peerWorking: false,
    createdAt: AT,
    lastActivityAt,
    seenActivityAt,
    expiresAt: null,
    conversationDeletedAt: null,
    kept: null,
  })
const runSeen = (seenAt: string | null) =>
  ({ type: 'routine_run.updated', at: AT, botId: 'alex', run: run(seenAt) }) as const
const threadSeen = (lastActivityAt: string, seenActivityAt: string | null) =>
  ({ type: 'peer_thread.updated', at: AT, botId: 'alex', thread: thread(lastActivityAt, seenActivityAt) }) as const

function setup(seen = false) {
  const shown: SystemNotice[] = []
  const dismissed: string[] = []
  const open = vi.fn()
  let stored: string | null = null
  const attention = new FleetBotAttention({
    load: () => stored,
    save: (value) => {
      stored = value
    },
    emit: () => undefined,
  })
  const notices = new FleetBotNotices({
    notices: {
      show: (notice) => void shown.push(notice),
      dismiss: (key) => void dismissed.push(key),
      dismissPrefix: (prefix) => void dismissed.push(prefix),
    },
    attention,
    sees: () => seen,
    botName: (_serverId, botId) => (botId === 'alex' ? 'Alex' : null),
    serverName: () => null,
    open,
  })
  const marks = () => attention.list().map(({ serverId, botId }) => `${serverId}/${botId}`)
  return { notices, shown, dismissed, marks, open, attention }
}
const view = ({ key, title, subtitle, body }: SystemNotice) => ({ key, title, subtitle, body })

describe('FleetBotNotices', () => {
  it('tells and marks a finished turn, and opens where it happened', () => {
    const s = setup()
    s.notices.live(S1, entry('turn_completed', { source: 'owner' }, 'The report is ready.'))
    s.notices.live(S1, entry('turn_completed', { source: 'routine', runId: 'run-1', alert: true }))
    s.notices.live(S1, entry('needs_you', { threadId: 't-1' }))
    expect(s.shown.map(view)).toEqual([
      {
        key: `bot:${S1}/alex:main`,
        title: 'Alex',
        subtitle: undefined,
        body: 'Finished what you asked — The report is ready.',
      },
      { key: `bot:${S1}/alex:run:run-1`, title: 'Alex', subtitle: undefined, body: 'Finished a routine run' },
      {
        key: `bot:${S1}/alex:thread:t-1`,
        title: 'Alex',
        subtitle: undefined,
        body: 'Paused a conversation with another bot',
      },
    ])
    expect(s.marks()).toEqual([`${S1}/alex`])
    s.shown[1].onClick()
    s.shown[2].onClick()
    expect(s.open.mock.calls).toEqual([
      [{ kind: 'bot', serverId: S1, botId: 'alex', runId: 'run-1' }],
      [{ kind: 'bot', serverId: S1, botId: 'alex', threadId: 't-1' }],
    ])
  })

  it('marks a bot that answered another bot without telling, and tells what waits without marking', () => {
    const s = setup()
    s.notices.live(S1, entry('turn_completed', { source: 'peer' }))
    expect(s.shown).toEqual([])
    expect(s.marks()).toEqual([`${S1}/alex`])
    s.attention.clear(S1, 'alex')
    s.notices.live(S1, entry('needs_you', {}, 'Bash'))
    expect(s.shown.map(({ body }) => body)).toEqual(['Needs you'])
    expect(s.marks()).toEqual([])
  })

  it('stays quiet about the bot the owner looks at', () => {
    const s = setup(true)
    s.notices.live(S1, entry('turn_failed', { source: 'owner' }))
    expect(s.shown).toEqual([])
    expect(s.marks()).toEqual([])
  })

  it('clears the mark and the notices of a bot the owner sees', () => {
    const s = setup()
    s.notices.live(S1, entry('turn_failed', { source: 'owner' }))
    s.notices.seen(S1, 'alex')
    expect(s.marks()).toEqual([])
    expect(s.dismissed).toEqual([`bot:${S1}/alex:`])
  })
})

describe('FleetBotNotices of runs and threads seen on another device', () => {
  it("clears a run's mark and notice once the owner opened the run anywhere", () => {
    const s = setup()
    s.notices.live(S1, entry('turn_completed', { source: 'routine', runId: 'run-1', alert: true }))
    s.notices.sideConversation(S1, runSeen(null))
    expect(s.marks()).toEqual([`${S1}/alex`])
    expect(s.dismissed).toEqual([])
    s.notices.sideConversation(S1, runSeen(LATER))
    expect(s.marks()).toEqual([])
    expect(s.dismissed).toEqual([`bot:${S1}/alex:run:run-1`])
  })

  it("clears a thread's mark once the owner saw its last activity anywhere, and not before", () => {
    const s = setup()
    s.notices.live(S1, entry('needs_you', { threadId: 't-1' }))
    s.notices.sideConversation(S1, threadSeen(LATER, AT))
    expect(s.marks()).toEqual([`${S1}/alex`])
    s.notices.sideConversation(S1, threadSeen(LATER, LATER))
    expect(s.marks()).toEqual([])
    expect(s.dismissed).toEqual([`bot:${S1}/alex:thread:t-1`])
  })

  it('keeps a mark until every run and thread it was for is seen', () => {
    const s = setup()
    s.notices.live(S1, entry('turn_completed', { source: 'routine', runId: 'run-1', alert: true }))
    s.notices.live(S1, entry('turn_completed', { source: 'peer', runId: 't-1', threadId: 't-1' }))
    s.notices.sideConversation(S1, runSeen(LATER))
    expect(s.marks()).toEqual([`${S1}/alex`])
    s.notices.sideConversation(S1, threadSeen(LATER, LATER))
    expect(s.marks()).toEqual([])
  })

  it("keeps what only this computer clears: the bot's own conversation and answers to the owner in a run", () => {
    const s = setup()
    s.notices.live(S1, entry('turn_completed', { source: 'routine', runId: 'run-1', alert: true }))
    s.notices.live(S1, entry('turn_completed', { source: 'owner' }))
    s.notices.sideConversation(S1, runSeen(LATER))
    expect(s.marks()).toEqual([`${S1}/alex`])
    s.notices.seen(S1, 'alex')
    // The bot answered the owner's change in a run they had seen: the run's state says nothing of it.
    s.notices.live(S1, entry('turn_completed', { source: 'owner', runId: 'run-1' }))
    s.notices.sideConversation(S1, runSeen(LATER))
    expect(s.marks()).toEqual([`${S1}/alex`])
  })

  it('marks nothing for a run the owner opened before it ended, and still tells it ended', () => {
    const s = setup()
    s.notices.sideConversation(S1, runSeen(AT))
    s.notices.live(S1, entry('turn_completed', { source: 'routine', runId: 'run-1', alert: true }))
    expect(s.marks()).toEqual([])
    expect(s.shown.map(({ key }) => key)).toEqual([`bot:${S1}/alex:run:run-1`])
  })
})
