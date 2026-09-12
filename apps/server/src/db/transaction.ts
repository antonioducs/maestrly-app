import { AsyncLocalStorage } from 'node:async_hooks'
import type { Actor } from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from './pool.js'

export interface TransactionContext {
  organizationId: string
  projectId?: string
  actor: Actor
}

const activeTransactions = new AsyncLocalStorage<{pool:DatabasePool;client:DatabaseClient;context:TransactionContext}>()
const actorUser=(actor:Actor)=>actor.type==='human'||actor.type==='desktop_agent'?actor.userId:actor.type==='execution_agent'?actor.requestedByUserId:''

export async function inTenantTransaction<T>(
  pool: DatabasePool,
  context: TransactionContext,
  operation: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const active=activeTransactions.getStore()
  if(active?.pool===pool && active.context.organizationId===context.organizationId) {
    // HTTP idempotency and domain changes must commit or roll back together.
    const previousActor=JSON.stringify(active.context.actor),nextActor=JSON.stringify(context.actor)
    const changed=previousActor!==nextActor||active.context.projectId!==context.projectId
    if(changed) await active.client.query("select set_config('app.actor',$1,true),set_config('app.user_id',$2,true),set_config('app.project_id',$3,true)",[nextActor,actorUser(context.actor),context.projectId??''])
    try {return await activeTransactions.run({...active,context},()=>operation(active.client))}
    finally {if(changed) await active.client.query("select set_config('app.actor',$1,true),set_config('app.user_id',$2,true),set_config('app.project_id',$3,true)",[previousActor,actorUser(active.context.actor),active.context.projectId??'']).catch(()=>undefined)}
  }
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('app.organization_id', $1, true)", [context.organizationId])
    await client.query("select set_config('app.project_id', $1, true)", [context.projectId ?? ''])
    await client.query("select set_config('app.actor', $1, true)", [JSON.stringify(context.actor)])
    const userId = context.actor.type === 'human' || context.actor.type === 'desktop_agent'
      ? context.actor.userId
      : context.actor.type === 'execution_agent'
        ? context.actor.requestedByUserId
        : ''
    await client.query("select set_config('app.user_id', $1, true)", [userId])
    await client.query("set local statement_timeout = '10s'")
    const result = await activeTransactions.run({pool,client,context},()=>operation(client))
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
