import { expect, it } from 'vitest'
import { integrationAvailable } from './helpers.js'
import { chatFixture } from './project-chat-fixture.js'
import { inTenantTransaction } from '../../src/db/transaction.js'
import { snapshot } from '../../src/modules/project-chat/service.js'

it.skipIf(!integrationAvailable)(
  'isolates private chats from same-project peers and foreign runners at RLS',
  async () => {
    const f = await chatFixture()
    try {
      await f.send('Private context')
      const stranger = 'peer-' + crypto.randomUUID()
      await inTenantTransaction(f.pool, { ...f.scope, actor: { type: 'human', userId: f.scope.userId } }, async (c) => {
        await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')", [
          f.scope.organizationId,
          stranger,
        ])
      })
      for (const actor of [
        { type: 'human' as const, userId: stranger },
        { type: 'runner' as const, runnerId: crypto.randomUUID() },
      ]) {
        const rows = await inTenantTransaction(f.pool, { ...f.scope, actor }, (c) =>
          c.query('select * from chat_messages')
        )
        expect(rows.rowCount).toBe(0)
      }
      await expect(snapshot(f.pool, { ...f.scope, userId: stranger }, f.session.id)).rejects.toThrow(/not found/)
      expect((await snapshot(f.pool, f.scope, f.session.id)).messages[0].parts[0]).toMatchObject({
        text: 'Private context',
      })
      const publicEvents = await inTenantTransaction(
        f.pool,
        { ...f.scope, actor: { type: 'human', userId: stranger } },
        (c) => c.query("select * from domain_events where data::text like '%Private context%'")
      )
      expect(publicEvents.rowCount).toBe(0)
    } finally {
      await f.pool.end()
    }
  }
)
