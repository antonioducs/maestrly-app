import { describe, expect, it } from 'vitest'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_INTERNAL_ROUTES,
  FLEET_PEER_CONVERSATIONS_FEATURE,
  FLEET_PEER_THREAD_KEPT_FOLDER,
  FLEET_PEER_THREAD_LIMITS,
  FLEET_PEER_THREADS_QUERY,
  fleetBotSchema,
  fleetGatewayEventSchema,
  fleetInstanceInputSchema,
  fleetInternalPeerMessageRequestSchema,
  fleetInternalPeerMessageResponseSchema,
  fleetPeerThreadSchema,
  fleetPeerThreadSettingsSchema,
  fleetReaderWantsPeerThreads,
  fleetTranscriptItemSchema,
  isFleetPeerThreadEvent,
} from '../src/index.js'

const at = '2026-10-18T10:15:00.000Z'
const uuid = '00000000-0000-4000-8000-000000000001'
const thread = {
  id: 'thread-1',
  botId: 'atlas',
  peer: { botId: 'nina', name: 'Nina' },
  title: 'Release 4.2 regression',
  origin: 'primary',
  status: 'open',
  hops: 2,
  hopLimit: 8,
  messages: 2,
  pinned: false,
  conversation: 'own',
  report: null,
  reportAt: null,
  working: false,
  peerWorking: true,
  createdAt: at,
  lastActivityAt: at,
  expiresAt: null,
  conversationDeletedAt: null,
  kept: null,
}

describe('conversations between bots', () => {
  it('names the feature, the event query and the folder a deleted conversation keeps its files in', () => {
    expect(FLEET_PEER_CONVERSATIONS_FEATURE).toBe('peer-conversations')
    expect(FLEET_PEER_THREADS_QUERY).toBe('peerThreads')
    expect(FLEET_PEER_THREAD_KEPT_FOLDER).toBe('bots')
    expect(FLEET_PEER_THREAD_LIMITS.hopLimits).toEqual([4, 8, 16])
    expect(fleetReaderWantsPeerThreads(new URLSearchParams('peerThreads=1'))).toBe(true)
    expect(fleetReaderWantsPeerThreads(new URLSearchParams())).toBe(false)
  })

  it('sends a message of another bot, or of the owner, to the thread it belongs to, never with a run', () => {
    const peer = {
      idempotencyKey: uuid,
      source: 'peer',
      text: 'Did 4.2 pass?',
      peer: { botId: 'nina', name: 'Nina' },
      attachments: [],
    }
    const threadRef = { id: 'thread-1', title: 'Release 4.2 regression' }
    expect(fleetInstanceInputSchema.safeParse({ ...peer, thread: threadRef }).success).toBe(true)
    expect(
      fleetInstanceInputSchema.safeParse({ ...peer, source: 'owner', peer: undefined, thread: threadRef }).success
    ).toBe(true)
    expect(fleetInstanceInputSchema.safeParse({ ...peer, thread: threadRef, run: { id: 'run-1' } }).success).toBe(false)
    expect(
      fleetInstanceInputSchema.safeParse({
        ...peer,
        source: 'routine',
        peer: undefined,
        routine: { id: 'r', title: 'R', runId: 'run-1' },
        run: { id: 'run-1' },
        thread: threadRef,
      }).success
    ).toBe(false)
    // Peer messages still never go to a routine run's conversation.
    expect(fleetInstanceInputSchema.safeParse({ ...peer, run: { id: 'run-1' } }).success).toBe(false)
    expect(
      fleetInstanceInputSchema.safeParse({
        ...peer,
        thread: { ...threadRef, context: 'x'.repeat(FLEET_PEER_THREAD_LIMITS.contextMax + 1) },
      }).success
    ).toBe(false)
  })

  it('opens or continues a thread through the internal peer API', () => {
    expect(fleetInternalPeerMessageRequestSchema.parse({ to: 'nina', text: 'Hi', idempotencyKey: uuid })).toEqual({
      to: 'nina',
      text: 'Hi',
      idempotencyKey: uuid,
    })
    expect(
      fleetInternalPeerMessageRequestSchema.parse({
        to: 'nina',
        text: 'Hi',
        idempotencyKey: uuid,
        topic: 'Release 4.2',
        origin: 'primary',
      })
    ).toMatchObject({ topic: 'Release 4.2', origin: 'primary' })
    expect(
      fleetInternalPeerMessageRequestSchema.safeParse({
        to: 'nina',
        text: 'Hi',
        idempotencyKey: uuid,
        topic: 'x'.repeat(FLEET_PEER_THREAD_LIMITS.topicMax + 1),
      }).success
    ).toBe(false)
    expect(fleetInternalPeerMessageResponseSchema.parse({ messageId: 'm', delivered: true })).toEqual({
      messageId: 'm',
      delivered: true,
    })
    expect(
      fleetInternalPeerMessageResponseSchema.parse({ messageId: 'm', delivered: true, thread: 'thread-1' }).thread
    ).toBe('thread-1')
    expect(FLEET_INTERNAL_ROUTES.peerThreadReport).toMatchObject({
      method: 'POST',
      path: '/internal/v1/peers/threads/:threadId/report',
    })
  })

  it('shows a peer message with the thread it opened, and one from before threads without', () => {
    const peerOut = { kind: 'peer_out', id: 'p', at, to: { botId: 'nina', name: 'Nina' }, text: 'Hi', delivered: true }
    expect(fleetTranscriptItemSchema.parse(peerOut)).not.toHaveProperty('thread')
    expect(fleetTranscriptItemSchema.parse({ ...peerOut, thread: { id: 'thread-1' } })).toMatchObject({
      thread: { id: 'thread-1' },
    })
  })

  it('describes a thread as one of its bots sees it, with settings within their choices', () => {
    expect(fleetPeerThreadSchema.parse(thread)).toEqual(thread)
    expect(fleetPeerThreadSchema.safeParse({ ...thread, origin: 'owner' }).success).toBe(false)
    expect(fleetPeerThreadSettingsSchema.parse({})).toEqual({ retentionDays: 30, hopLimit: 8 })
    expect(fleetPeerThreadSettingsSchema.safeParse({ retentionDays: 45, hopLimit: 8 }).success).toBe(false)
    expect(fleetPeerThreadSettingsSchema.safeParse({ retentionDays: 30, hopLimit: 5 }).success).toBe(false)
    expect(fleetPeerThreadSettingsSchema.parse({ retentionDays: null, hopLimit: 16 })).toEqual({
      retentionDays: null,
      hopLimit: 16,
    })
    expect(fleetBotSchema.shape.peerSettings.parse(undefined)).toBeNull()
  })

  it('sends thread events only to readers that ask for them', () => {
    const events = [
      { type: 'peer_thread.updated', at, botId: 'atlas', thread },
      { type: 'peer_thread.removed', at, botId: 'atlas', threadId: 'thread-1' },
      {
        type: 'peer_thread.transcript.upsert',
        at,
        botId: 'atlas',
        threadId: 'thread-1',
        item: { kind: 'assistant', id: 'a', at, text: 'Done', streaming: false },
      },
      { type: 'peer_thread.transcript.reset', at, botId: 'atlas', threadId: 'thread-1' },
    ]
    for (const event of events) expect(isFleetPeerThreadEvent(fleetGatewayEventSchema.parse(event))).toBe(true)
    expect(isFleetPeerThreadEvent({ type: 'routine_run.removed' })).toBe(false)
  })

  it("serves a bot's threads to the owner's devices", () => {
    const routes = {
      botPeerThreads: ['GET', '/v1/bots/:id/peer-threads'],
      botPeerThreadGet: ['GET', '/v1/bots/:id/peer-threads/:threadId'],
      botPeerThreadPatch: ['PATCH', '/v1/bots/:id/peer-threads/:threadId'],
      botPeerThreadConversationDelete: ['DELETE', '/v1/bots/:id/peer-threads/:threadId/conversation'],
      botPeerThreadTranscript: ['GET', '/v1/bots/:id/peer-threads/:threadId/transcript'],
      botPeerThreadMessageSend: ['POST', '/v1/bots/:id/peer-threads/:threadId/messages'],
      botPeerThreadSettings: ['PUT', '/v1/bots/:id/peer-thread-settings'],
    } as const
    for (const [name, [method, path]] of Object.entries(routes))
      expect(FLEET_GATEWAY_ROUTES[name as keyof typeof routes]).toMatchObject({ method, path })
    const patch = FLEET_GATEWAY_ROUTES.botPeerThreadPatch.body
    expect(patch.parse({ pinned: true })).toEqual({ pinned: true })
    expect(patch.parse({ resume: true })).toEqual({ resume: true })
    expect(patch.safeParse({ resume: false }).success).toBe(false)
    expect(patch.safeParse({ hops: 0 }).success).toBe(false)
  })
})
