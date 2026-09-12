import { expect, it } from 'vitest'
import { integrationAvailable } from './helpers.js'
import { chatFixture } from './project-chat-fixture.js'
import {
  claimChat,
  assertChatLease,
  runnerTransaction,
  finishChat,
  uploadChatEvents,
  reconcileChat,
} from '../../src/modules/project-chat/dispatch.js'
import { snapshot, chatTransaction, ownedSession } from '../../src/modules/project-chat/service.js'
import { decideInteraction } from '../../src/modules/project-chat/interactions.js'
import { claimJob } from '../../src/modules/jobs/claim.js'
import {createCard,moveCard} from '../../src/modules/cards/service.js'
import {getBoard} from '../../src/modules/boards/service.js'
import {createExecutionPolicy,assignColumnPolicy} from '../../src/modules/automation/policies.js'

it.skipIf(!integrationAvailable)(
  'deduplicates commands, serializes claims, fences expired leases and never re-executes uncertain work',
  async () => {
    const f = await chatFixture()
    try {
      const clientId = crypto.randomUUID(),
        t = await f.send('Read the project', clientId)
      expect((await f.send('Read the project', clientId)).id).toBe(t.id)
      await expect(f.send('Different message', clientId)).rejects.toThrow(/different content/)
      const claims = await Promise.all([claimChat(f.pool, f.identity), claimChat(f.pool, f.identity)])
      expect(claims.filter(Boolean)).toHaveLength(1)
      const claim = claims.find(Boolean)!
    const board=await getBoard(f.pool,{...f.scope,boardId:f.boardId}),column=board.columns.find(c=>c.role==='normal')!
    const card=await createCard(f.pool,{...f.scope,boardId:f.boardId,title:'Competing job'})
    const policy=await createExecutionPolicy(f.pool,{...f.scope,name:'Capacity proof',taskType:'code',executionProfileId:'default',requiredCapabilities:[],repositoryBindingId:null,provider:'codex',model:'fixture',approvalRequired:false,maxDurationSeconds:120,maxLogBytes:100000,delivery:{mode:'patch',requireHumanApproval:true},enabled:true})
    await assignColumnPolicy(f.pool,{...f.scope,columnId:column.id,policyId:policy.id})
    const moved=await moveCard(f.pool,{...f.scope,cardId:card.id,move:{expectedVersion:card.version,targetColumnId:column.id,targetPosition:0,source:'human',allowAutomationChain:false,chainDepth:0}})
    expect(moved.jobId).toBeTruthy()
    expect(await claimJob(f.pool, { ...f.identity, protocolVersion: '1.0' })).toBeNull()
      await expect(f.send('Second concurrent turn')).rejects.toThrow(/active/)
      await runnerTransaction(f.pool, f.identity, (c) =>
        c.query("update chat_turns set lease_expires_at=now()-interval '1 second' where id=$1", [t.id])
      )
      await expect(
        runnerTransaction(f.pool, f.identity, (c) => assertChatLease(c, f.identity, t.id, claim.turn.leaseId!))
      ).rejects.toThrow(/expired/)
      await reconcileChat(f.pool)
      expect((await snapshot(f.pool, f.scope, f.session.id)).turn?.state).toBe('interrupted')
      expect(await claimChat(f.pool, f.identity)).toBeNull()
    } finally {
      await f.pool.end()
    }
  }
)
it.skipIf(!integrationAvailable)('plan decisions create a single follow-up and reject stale versions', async () => {
  const f = await chatFixture()
  try {
    await f.send('Plan this change')
    const claim = (await claimChat(f.pool, f.identity))!
    const interaction = {
      id: crypto.randomUUID(),
      sessionId: f.session.id,
      turnId: claim.turn.id,
      version: 1,
      payload: { type: 'plan' as const, requestId: 'native-plan', title: 'Plan', plan: 'Read and test.' },
      state: 'pending' as const,
      decision: null,
    }
    await runnerTransaction(f.pool, f.identity, async (c) => {
      await assertChatLease(c, f.identity, claim.turn.id, claim.turn.leaseId!)
      await uploadChatEvents(c, f.session, claim.turn, [
        { eventId: 'plan', payload: { type: 'interaction', interaction } },
      ])
      await finishChat(c, f.session, claim.turn, 'succeeded')
    })
    const decide = (version: number) =>
      chatTransaction(f.pool, f.scope, true, async (c) =>
        decideInteraction(c, await ownedSession(c, f.scope, f.session.id, true), interaction.id, version, {
          type: 'plan',
          action: 'approve',
        })
      )
    await expect(decide(2)).rejects.toThrow(/changed/)
    await Promise.all([decide(1), decide(1)])
    const next = (await claimChat(f.pool, f.identity))!
    expect(next.decision?.decision).toMatchObject({ action: 'approve' })
    expect(next.turn.id).not.toBe(claim.turn.id)
  } finally {
    await f.pool.end()
  }
})
