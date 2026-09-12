import {createProject} from '../../src/modules/projects/service.js'
import {createCard} from '../../src/modules/cards/service.js'
import {getBoard} from '../../src/modules/boards/service.js'
import { describe, expect, it } from 'vitest'
import { executeIdempotent } from '../../src/modules/events/http-idempotency.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

describe.skipIf(!integrationAvailable)('idempotent writes', () => {
  it('replays the same content and rejects a changed payload', async () => {
    const pool = runtimePool()
    try {
      const suffix = crypto.randomUUID()
      const userId = `owner-${suffix}`
      const organizationId = await seedOrganization(`Idempotency ${suffix}`, userId)
      let calls = 0
      const execute = (body: unknown) => executeIdempotent(pool, {
        organizationId, actorId: userId, actor: { type: 'human', userId }, key: 'same-key', method: 'POST', path: '/cards', body,
      }, async () => ({ status: 201, body: { call: ++calls } }))
      await expect(execute({ title: 'Same' })).resolves.toMatchObject({ replayed: false, body: { call: 1 } })
      await expect(execute({ title: 'Same' })).resolves.toMatchObject({ replayed: true, body: { call: 1 } })
      await expect(execute({ title: 'Changed' })).rejects.toThrow(/different content/)
      expect(calls).toBe(1)
    } finally { await pool.end() }
  })
  it('rolls back domain changes when the idempotent operation fails before recording its response',async()=>{
    const pool=runtimePool()
    try {
      const userId='atomic-'+crypto.randomUUID(),organizationId=await seedOrganization('Atomic fixture',userId)
      const project=await createProject(pool,{organizationId,actorUserId:userId,name:'Atomic'})
      await expect(executeIdempotent(pool,{organizationId,actorId:userId,actor:{type:'human',userId},key:'atomic-key',method:'POST',path:'/cards',body:{}},async()=>{
        await createCard(pool,{organizationId,userId,boardId:project.boardId,title:'Must roll back'})
        throw new Error('Simulated transaction failure')
      })).rejects.toThrow(/Simulated/)
      expect((await getBoard(pool,{organizationId,userId,boardId:project.boardId})).cards).toHaveLength(0)
    } finally {await pool.end()}
  })

})
