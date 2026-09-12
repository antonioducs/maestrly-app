import { describe,it,expect } from 'vitest'
import { columnAutomationSchema } from '@maestrly/protocol'
import { integrationAvailable,runtimePool,seedOrganization } from './helpers.js'
import { createProject } from '../../src/modules/projects/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createCard,moveCard,getCardDetail,updateCard } from '../../src/modules/cards/service.js'
import { transaction,manageColumns } from '../../src/modules/kanban/service.js'
import { getColumnAutomation,saveColumnAutomation,columnAutomationHistory,saveCardOverride,cardAutomationContext,releaseDispatch,saveBoardAutomationLimits } from '../../src/modules/automation/column-service.js'
import { requestColumnAgent } from '../../src/modules/automation/dispatch.js'
import { createRunnerEnrollment,enrollRunner } from '../../src/modules/runners/service.js'
import { claimJob } from '../../src/modules/jobs/claim.js'
const caps={version:1 as const,models:[{provider:'codex' as const,model:'fixture',label:'Fixture',efforts:['low','high'],fastMode:true,fastServiceTier:'priority'}],maestro:true,subagents:true,preCommands:true,issues:[]}
describe.skipIf(!integrationAvailable)('column automation lifecycle',()=>{
  it('isolates column configs, preserves versions and forwards overrides to a compatible claim',async()=>{
    const pool=runtimePool()
    try{
      const userId='automation-'+crypto.randomUUID(),organizationId=await seedOrganization('Automation',userId),scope={organizationId,userId}
      const project=await createProject(pool,{organizationId,actorUserId:userId,name:'Automation'})
      const board=await getBoard(pool,{...scope,boardId:project.boardId})
      const a=board.columns[1]!,b=board.columns[2]!
      expect(board.columns.map(c=>c.role)).toEqual(['backlog','normal','normal','done'])
      const enrollment=await createRunnerEnrollment(pool,{...scope,projectIds:[project.project.id]})
      const runner=await enrollRunner(pool,{organizationId,token:enrollment.token,name:'Fixture runner',protocolVersion:'1.0',capabilities:[],maxConcurrency:1})
      const identity={organizationId,...runner,protocolVersion:'1.0',automationCapabilities:caps}
      expect(await claimJob(pool,identity)).toBeNull()
      const config=columnAutomationSchema.parse({enabled:true,autoRun:false,provider:'codex',model:'fixture',effort:'low',promptTemplate:'Review {task_title} in {column_name}: {task_body}',approvalRequired:false,maxDurationSeconds:20,maxLogBytes:4096})
      const first=await saveColumnAutomation(pool,{...scope,columnId:a.id,expectedPolicyId:null,config})
      expect((await getColumnAutomation(pool,{...scope,columnId:b.id})).config).toMatchObject({enabled:false,model:'',promptTemplate:''})
      await expect(saveColumnAutomation(pool,{...scope,columnId:board.columns[0]!.id,expectedPolicyId:null,config})).rejects.toThrow(/Fixed/)
      await expect(manageColumns(pool,{...scope,boardId:board.board.id,expectedVersion:2,action:'reorder',order:[b.id,a.id,board.columns[0]!.id,board.columns[3]!.id]})).rejects.toThrow(/Fixed/)
      const results=await Promise.allSettled([
        saveColumnAutomation(pool,{...scope,columnId:a.id,expectedPolicyId:first.policyId,config:{...config,promptTemplate:'First edit'}}),
        saveColumnAutomation(pool,{...scope,columnId:a.id,expectedPolicyId:first.policyId,config:{...config,promptTemplate:'Second edit'}}),
      ])
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
      const history=await columnAutomationHistory(pool,{...scope,columnId:a.id})
      expect(history.map(h=>h.version)).toEqual([2,1])
      const current=await getColumnAutomation(pool,{...scope,columnId:a.id})
      const restored=await saveColumnAutomation(pool,{...scope,columnId:a.id,expectedPolicyId:current.policyId,config:history[1]!.config})
      expect(restored.version).toBe(3)
      const card=await createCard(pool,{...scope,boardId:board.board.id,columnId:a.id,title:'Card {column_name}',description:'Markdown body'})
      await saveCardOverride(pool,{...scope,cardId:card.id,columnId:a.id,expectedVersion:0,config:{effort:'high',fastMode:true}})
      const preview=await cardAutomationContext(pool,{...scope,cardId:card.id})
      expect(preview.renderedPrompt).toBe('Review Card {column_name} in In progress: Markdown body')
      expect(preview.effective.effort).toBe('high')
      await expect(requestColumnAgent(pool,{...scope,cardId:card.id,expectedVersion:card.version,expectedPolicyId:restored.policyId,expectedOverrideVersion:0})).rejects.toThrow(/override changed/)
      const requested=await requestColumnAgent(pool,{...scope,cardId:card.id,expectedVersion:card.version,expectedPolicyId:restored.policyId,expectedOverrideVersion:1})
      expect(requested.jobId).toBeTruthy()
      await expect(requestColumnAgent(pool,{...scope,cardId:card.id,expectedVersion:card.version,expectedPolicyId:restored.policyId,expectedOverrideVersion:1})).rejects.toThrow(/already queued/)
      expect(await claimJob(pool,{...identity,automationCapabilities:{...caps,models:[{...caps.models[0]!,fastMode:false}]}})).toBeNull()
      await updateCard(pool,{...scope,cardId:card.id,patch:{expectedVersion:card.version,description:'A later human edit'}})
      const claim=await claimJob(pool,identity)
      expect(claim?.envelope.cardVersion).toBe(card.version)
      expect(claim?.envelope.snapshot).toMatchObject({effort:'high',fastMode:true,fastServiceTier:'priority',renderedPrompt:preview.renderedPrompt,maxDurationSeconds:20,maxLogBytes:4096,automationVersion:1})
      await saveColumnAutomation(pool,{...scope,columnId:a.id,expectedPolicyId:restored.policyId,config:{...config,effort:'low',promptTemplate:'New future prompt'}})
      const frozen=await transaction(pool,scope,c=>c.query('select snapshot from jobs where id=$1',[requested.jobId]))
      expect(frozen.rows[0].snapshot.effort).toBe('high')
      expect(frozen.rows[0].snapshot.renderedPrompt).toBe(preview.renderedPrompt)
      const second=await saveColumnAutomation(pool,{...scope,columnId:b.id,expectedPolicyId:null,config:{...config,autoRun:true,promptTemplate:'B {task_title}'}})
      const moved=await moveCard(pool,{...scope,cardId:card.id,move:{expectedVersion:card.version+1,targetColumnId:b.id,targetPosition:0,source:'human',allowAutomationChain:false,chainDepth:0}})
      expect(moved.jobId).toBeTruthy()
      expect((await getColumnAutomation(pool,{...scope,columnId:b.id})).policyId).toBe(second.policyId)
      expect((await cardAutomationContext(pool,{...scope,cardId:card.id,columnId:b.id})).override).toBeNull()
      const foreign=await seedOrganization('Foreign','foreign-'+crypto.randomUUID())
      await expect(getColumnAutomation(pool,{organizationId:foreign,userId,columnId:a.id})).rejects.toThrow(/not found/)
    }finally{await pool.end()}
  })
  it('keeps loop blocks until explicit release and does not auto-run manual columns',async()=>{
    const pool=runtimePool()
    try{
      const userId='guard-'+crypto.randomUUID(),organizationId=await seedOrganization('Guard',userId),scope={organizationId,userId}
      const project=await createProject(pool,{organizationId,actorUserId:userId,name:'Guard'}),board=await getBoard(pool,{...scope,boardId:project.boardId})
      const enrollment=await createRunnerEnrollment(pool,{...scope,projectIds:[project.project.id]}),runner=await enrollRunner(pool,{organizationId,token:enrollment.token,name:'Fixture',protocolVersion:'1.0',capabilities:[],maxConcurrency:1})
      await claimJob(pool,{organizationId,...runner,protocolVersion:'1.0',automationCapabilities:caps})
      const config=columnAutomationSchema.parse({enabled:true,model:'fixture',approvalRequired:false})
      const columnId=board.columns[1]!.id
      const policy=await saveColumnAutomation(pool,{...scope,columnId,expectedPolicyId:null,config})
      await saveBoardAutomationLimits(pool,{...scope,boardId:project.boardId,expectedVersion:2,limits:{maxPerCardPerColumn:1,breakerWindowMs:1000}})
      const card=await createCard(pool,{...scope,boardId:project.boardId,title:'Guard'})
      const moved=await moveCard(pool,{...scope,cardId:card.id,move:{expectedVersion:1,targetColumnId:columnId,targetPosition:0,source:'human',allowAutomationChain:false,chainDepth:0}})
      expect(moved.jobId).toBeUndefined()
      const first=await requestColumnAgent(pool,{...scope,cardId:card.id,expectedVersion:2,expectedPolicyId:policy.policyId,expectedOverrideVersion:0})
      await transaction(pool,scope,c=>c.query("update jobs set state='completed' where id=$1",[first.jobId]))
      expect(await requestColumnAgent(pool,{...scope,cardId:card.id,expectedVersion:2,expectedPolicyId:policy.policyId,expectedOverrideVersion:0})).toMatchObject({blocked:true,jobId:null})
      await transaction(pool,scope,c=>c.query("update automation_dispatch_guards set window_started_at=now()-interval '1 day' where card_id=$1",[card.id]))
      expect((await cardAutomationContext(pool,{...scope,cardId:card.id})).blocked).toBe(true)
      await releaseDispatch(pool,{...scope,cardId:card.id,columnId})
      expect((await requestColumnAgent(pool,{...scope,cardId:card.id,expectedVersion:2,expectedPolicyId:policy.policyId,expectedOverrideVersion:0})).jobId).toBeTruthy()
      const reader='reader-'+crypto.randomUUID()
      await transaction(pool,scope,async c=>{
        await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')",[organizationId,reader])
        await c.query("insert into project_members(organization_id,project_id,user_id,role) values($1,$2,$3,'viewer')",[organizationId,project.project.id,reader])
      })
      await expect(saveColumnAutomation(pool,{organizationId,userId:reader,columnId,expectedPolicyId:policy.policyId,config})).rejects.toThrow(/authorized/)
      expect((await getCardDetail(pool,{...scope,cardId:card.id})).card.columnId).toBe(columnId)
    }finally{await pool.end()}
  })
})
