import type { ProjectRole } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { changeMember, lockTeam, teamTransaction } from './team.js'

// Internal callers use the same audited mutation as the versioned HTTP endpoint.
export async function setProjectMembership(pool:DatabasePool,input:{organizationId:string;projectId:string;actorUserId:string;userId:string;role:ProjectRole|null}):Promise<void>{
 const scope={organizationId:input.organizationId,projectId:input.projectId,userId:input.actorUserId}
 await teamTransaction(pool,scope,async client=>{
  await lockTeam(client,scope)
  const result=await client.query('select team_version from projects where organization_id=$1 and id=$2',[scope.organizationId,scope.projectId])
  await changeMember(pool,scope,{expectedVersion:Number(result.rows[0].team_version),userId:input.userId,role:input.role})
 })
}
