import { describe, expect, it } from 'vitest'
import type { FleetInboxItem } from '@maestrly/bot-fleet-protocol'
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
