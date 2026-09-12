import { expect, it } from 'vitest'
import { integrationAvailable } from './helpers.js'
import { chatFixture } from './project-chat-fixture.js'
import {
  claimChat,
  assertChatLease,
  runnerTransaction,
  uploadChatEvents,
} from '../../src/modules/project-chat/dispatch.js'
import { listChatEvents } from '../../src/modules/project-chat/events.js'
import { snapshot } from '../../src/modules/project-chat/service.js'

it.skipIf(!integrationAvailable)(
  'replays committed events without duplicate text after a lost upload ACK',
  async () => {
    const f = await chatFixture()
    try {
      await f.send('Stream this')
      const claim = (await claimChat(f.pool, f.identity))!,
        id = crypto.randomUUID()
      const start = {
        eventId: 'start',
        payload: {
          type: 'message' as const,
          message: {
            id,
            sessionId: f.session.id,
            turnId: claim.turn.id,
            role: 'assistant' as const,
            parts: [],
            createdAt: new Date().toISOString(),
          },
        },
      }
      const delta = {
        eventId: 'delta',
        payload: { type: 'delta' as const, messageId: id, partId: 'text', kind: 'text' as const, delta: 'First chunk' },
      }
      const upload = () =>
        runnerTransaction(f.pool, f.identity, async (c) => {
          await assertChatLease(c, f.identity, claim.turn.id, claim.turn.leaseId!)
          await uploadChatEvents(c, f.session, claim.turn, [start, delta])
        })
      await upload()
      const before = await snapshot(f.pool, f.scope, f.session.id)
      await upload()
      expect((await snapshot(f.pool, f.scope, f.session.id)).cursor).toBe(before.cursor)
      expect(before.messages.find((message) => message.id === id)?.parts[0]).toMatchObject({ text: 'First chunk' })
      expect(await listChatEvents(f.pool, f.scope, f.session.id, before.cursor)).toEqual([])
    } finally {
      await f.pool.end()
    }
  }
)
