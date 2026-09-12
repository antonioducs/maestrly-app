import { mkdtemp,rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe,it,expect,vi } from 'vitest'
import { columnAutomationSchema } from '@maestrly/protocol'
import { startOrchestration,RunnerEngine,RunnerJournal,WorkspaceManager,ClaudeAgentExecutor,RuntimeCatalog,codexModelCapabilities,claudeModelCapabilities,type ExecutionContext,type ExecutorAdapter,type RunnerServer,type ExecutionOutcome } from '../src/index.js'
function context(config:Record<string,unknown>={}):ExecutionContext {
 return {envelope:{protocolVersion:'1.0',organizationId:'org',projectId:'project',boardId:'board',cardId:'card',jobId:'job',runId:'run',attempt:1,leaseId:'lease',leaseExpiresAt:new Date(Date.now()+60000).toISOString(),sourceEventId:'event',cardVersion:1,policyVersion:1,executionProfileId:'default',snapshot:{title:'Task',description:'Task',acceptanceCriteria:[],provider:'codex',model:'fixture',taskType:'code',repositoryBindingId:null,delivery:{mode:'patch',requireHumanApproval:true},renderedPrompt:'Approved task',automation:columnAutomationSchema.parse(config)}},environment:{workspacePath:'/fixture',isolated:true,environment:{},cleanup:async()=>{}},emit:vi.fn(async()=>{})}
}
describe('automation runtime',()=>{
 it('runs real bounded delegates and independent Maestro reviews',async()=>{
   const calls:ExecutionContext[]=[]
   const adapter:ExecutorAdapter={capabilities:async()=>({executor:'codex',capabilities:[]}),start:async c=>{
     calls.push(c)
     const prompt=c.envelope.snapshot.renderedPrompt!
     return {done:Promise.resolve({state:'succeeded',summary:prompt.includes('Plan independent')?JSON.stringify({tasks:[{resource:'backend',task:'Implement'}]}):prompt.includes('Independently inspect')?JSON.stringify({approved:true,feedback:'Verified'}):'Work verified.'}),cancel:async()=>{}}
   }}
   const handle=await startOrchestration(adapter,context({mode:'maestro',subagentsEnabled:true,maestroStrategy:'best-quality'}))
   const result=await handle.done
   expect(result.state).toBe('succeeded')
   expect(calls).toHaveLength(5)
   expect(calls.map(c=>!!c.readOnly)).toEqual([true,false,false,true,true])
   expect(new Set(calls.map(c=>c.stageId)).size).toBe(5)
   expect(result.artifacts?.[0]?.name).toBe('maestro-stages.json')
 })
 it('honors standard/no-subagents and rejects invalid delegation plans',async()=>{
   const start=vi.fn(async()=>({done:Promise.resolve({state:'succeeded' as const,summary:'{"tasks":[{"resource":"unknown","task":"bad"}]}'}),cancel:async()=>{}}))
   const adapter:ExecutorAdapter={capabilities:async()=>({executor:'codex',capabilities:[]}),start}
   await (await startOrchestration(adapter,context({mode:'standard',subagentsEnabled:false}))).done
   expect(start).toHaveBeenCalledTimes(1)
   const result=await (await startOrchestration(adapter,context({mode:'maestro',subagentsEnabled:true}))).done
   expect(result.state).toBe('failed')
   expect(start).toHaveBeenCalledTimes(2)
 })
 it('cancels an active delegate and never starts the next stage',async()=>{
   let announce!:()=>void,finish!:(value:ExecutionOutcome)=>void
   const started=new Promise<void>(resolve=>{announce=resolve}),pending=new Promise<ExecutionOutcome>(resolve=>{finish=resolve})
   const start=vi.fn(async(c:ExecutionContext)=>{
     if(c.envelope.snapshot.renderedPrompt!.includes('Plan independent'))return {done:Promise.resolve({state:'succeeded' as const,summary:'{"tasks":[{"resource":"backend","task":"Work"}]}'}),cancel:async()=>{}}
     announce()
     return {done:pending,cancel:async()=>{finish({state:'cancelled'})}}
   })
   const handle=await startOrchestration({capabilities:async()=>({executor:'codex',capabilities:[]}),start},context({mode:'maestro',subagentsEnabled:true}))
   await started;await handle.cancel('Stop')
   expect((await handle.done).state).toBe('cancelled')
   expect(start).toHaveBeenCalledTimes(2)
 })
 it('applies Claude effort/fast and read-only permissions to the SDK',async()=>{
   const factory=vi.fn(()=>({async *[Symbol.asyncIterator](){yield {type:'result',subtype:'success',is_error:false,result:'Verified',total_cost_usd:0}},close(){}}))
   const executor=new ClaudeAgentExecutor({executable:'/fixture/claude',queryFactory:factory as never,environment:{ANTHROPIC_API_KEY:'fixture'}})
   const c=context();c.readOnly=true;c.envelope.snapshot.effort='xhigh';c.envelope.snapshot.fastMode=true
   expect((await (await executor.start(c)).done).state).toBe('succeeded')
   expect(factory).toHaveBeenCalledWith(expect.objectContaining({prompt:'Approved task',options:expect.objectContaining({pathToClaudeCodeExecutable:'/fixture/claude',effort:'xhigh',settings:{fastMode:true,fastModePerSessionOptIn:true},tools:['Read','Glob','Grep'],settingSources:[]})}))
 })
 it('advertises only supported models and their concrete options',()=>{
   const models=codexModelCapabilities([{slug:'allowed',display_name:'Allowed',visibility:'list',supported_in_api:true,supported_reasoning_levels:[{effort:'high'}],service_tiers:[{id:'priority'}]},{slug:'hidden',visibility:'hide',supported_in_api:true}],new Set(['allowed','hidden']))
   expect(models).toEqual([{provider:'codex',model:'allowed',label:'Allowed',efforts:['high'],fastMode:true,fastServiceTier:'priority'}])
   expect(claudeModelCapabilities([{value:'alias',resolvedModel:'canonical',displayName:'Model',description:'',supportsFastMode:true,supportedEffortLevels:['high']}])).toMatchObject([{model:'canonical',fastMode:true,efforts:['high']}])
 })
 it('discovers and caches metadata without sending a model prompt',async()=>{
   let input:Promise<IteratorResult<unknown>>|undefined,received=false
   const close=vi.fn(),supportedModels=vi.fn(async()=>[{value:'claude-fixture',displayName:'Fixture',description:'',supportedEffortLevels:['high']}])
   const claudeQuery=vi.fn((args:{prompt:AsyncIterable<unknown>})=>{
     input=args.prompt[Symbol.asyncIterator]().next().then(value=>{received=true;return value})
     return {supportedModels,close}
   })
   const fetch=vi.fn(async()=>new Response(JSON.stringify({data:[{id:'allowed'}]})))
   const loadCodexCatalog=vi.fn(async()=>[{slug:'allowed',supported_in_api:true},{slug:'unavailable',supported_in_api:true}])
   const catalog=new RuntimeCatalog({environment:{OPENAI_API_KEY:'fixture-openai',ANTHROPIC_API_KEY:'fixture-claude'},fetch:fetch as never,claudeQuery:claudeQuery as never,loadCodexCatalog})
   const pending=catalog.read()
   expect(received).toBe(false)
   const result=await pending
   expect(result.models.map(model=>model.model)).toEqual(['allowed','claude-fixture'])
   expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/models',expect.objectContaining({headers:{authorization:'Bearer fixture-openai'}}))
   expect(await input).toEqual({done:true,value:undefined})
   expect(close).toHaveBeenCalledOnce()
   expect(await catalog.read()).toBe(result)
   expect(supportedModels).toHaveBeenCalledOnce()
   const absent=await new RuntimeCatalog({environment:{},fetch:fetch as never,claudeQuery:claudeQuery as never}).read()
   expect(absent).toMatchObject({models:[],maestro:false,subagents:false,preCommands:false})
   expect(fetch).toHaveBeenCalledOnce()
   expect(claudeQuery).toHaveBeenCalledOnce()
 })
 it('cancels preparation without starting an agent or a subsequent command',async()=>{
   const root=await mkdtemp(path.join(os.tmpdir(),'automation-pre-cancel-'))
   try{
     const c=context({preCommands:['prepare','next']})
     let announce!:()=>void,finish!:(result:ExecutionOutcome)=>void
     const started=new Promise<void>(resolve=>{announce=resolve}),pending=new Promise<ExecutionOutcome>(resolve=>{finish=resolve})
     const cancel=vi.fn(async()=>{finish({state:'cancelled'})}),start=vi.fn()
     const server:RunnerServer={claim:async()=>({envelope:c.envelope,executionToken:'fixture'}),renew:async()=>({leaseExpiresAt:c.envelope.leaseExpiresAt,cancellationRequested:false}),event:async()=>{},complete:vi.fn(async()=>{}),reconcile:async()=>'terminal',uploadArtifact:async()=>{throw new Error('not expected')}}
     const commandStart=vi.fn(async()=>{announce();return {done:pending,cancel}})
     const engine=new RunnerEngine(server,new Map([['codex',{capabilities:async()=>({executor:'codex',capabilities:[]}),start}]]),new WorkspaceManager({repositories:[]}),new RunnerJournal(path.join(root,'journal.json')),{commandRunner:{available:async()=>true,start:commandStart}})
     const run=engine.runOnce()
     await started;await engine.stop('User cancelled preparation.');await run
     expect(cancel).toHaveBeenCalledWith('User cancelled preparation.')
     expect(start).not.toHaveBeenCalled()
     expect(commandStart).toHaveBeenCalledOnce()
     expect(server.complete).toHaveBeenCalledWith('run','lease',expect.objectContaining({state:'cancelled',failure:'User cancelled preparation.'}))
   }finally{await rm(root,{recursive:true,force:true})}
 })
 for(const succeeds of [true,false])it('runs isolated pre-commands before agent startup: '+succeeds,async()=>{
   const root=await mkdtemp(path.join(os.tmpdir(),'automation-pre-test-'))
   try{
     const c=context({preCommands:['prepare']});c.envelope.snapshot.maxLogBytes=1024
     let prepared=false
     const start=vi.fn(async(_c:ExecutionContext)=>{expect(prepared).toBe(true);return {done:Promise.resolve({state:'succeeded' as const}),cancel:async()=>{}}})
     const emitted:string[]=[]
     const server:RunnerServer={claim:async()=>({envelope:c.envelope,executionToken:'fixture'}),renew:async()=>({leaseExpiresAt:c.envelope.leaseExpiresAt,cancellationRequested:false}),event:async(_r,_l,e)=>{emitted.push(e.type)},complete:vi.fn(async()=>{}),reconcile:async()=>'terminal',uploadArtifact:async()=>{throw new Error('not expected')}}
     await new RunnerEngine(server,new Map([['codex',{capabilities:async()=>({executor:'codex',capabilities:[]}),start}]]),new WorkspaceManager({repositories:[]}),new RunnerJournal(path.join(root,'journal.json')),{commandRunner:{available:async()=>true,start:async ctx=>{
       prepared=true
       await ctx.emit({type:'pre_command.stdout',data:{text:'x'.repeat(10000)}})
       return {done:Promise.resolve(succeeds?{state:'succeeded'}:{state:'failed',failure:'Preparation failed'}),cancel:async()=>{}}
     }}}).runOnce()
     expect(start).toHaveBeenCalledTimes(succeeds?1:0)
     expect(server.complete).toHaveBeenCalledWith('run','lease',expect.objectContaining({state:succeeds?'succeeded':'failed'}))
     expect(emitted).toContain('run.logs_truncated')
   }finally{await rm(root,{recursive:true,force:true})}
 })
 it('enforces the wall-clock timeout and cancels the executor',async()=>{
   const root=await mkdtemp(path.join(os.tmpdir(),'automation-timeout-'))
   try{
     vi.useFakeTimers()
     const c=context();c.envelope.snapshot.maxDurationSeconds=1
     let announce!:()=>void,finish!:(result:ExecutionOutcome)=>void
     const started=new Promise<void>(resolve=>{announce=resolve}),pending=new Promise<ExecutionOutcome>(resolve=>{finish=resolve})
     const cancel=vi.fn(async()=>{finish({state:'cancelled'})})
     const server:RunnerServer={claim:async()=>({envelope:c.envelope,executionToken:'fixture'}),renew:async()=>({leaseExpiresAt:c.envelope.leaseExpiresAt,cancellationRequested:false}),event:async()=>{},complete:vi.fn(async()=>{}),reconcile:async()=>'terminal',uploadArtifact:async()=>{throw new Error('not expected')}}
     const engine=new RunnerEngine(server,new Map([['codex',{capabilities:async()=>({executor:'codex',capabilities:[]}),start:async()=>{announce();return {done:pending,cancel}}}]]),new WorkspaceManager({repositories:[]}),new RunnerJournal(path.join(root,'journal.json')))
     const run=engine.runOnce()
     await started;await vi.advanceTimersByTimeAsync(1001);await run
     expect(cancel).toHaveBeenCalledWith('Execution timeout exceeded.')
     expect(server.complete).toHaveBeenCalledWith('run','lease',expect.objectContaining({state:'failed',failure:'Execution timeout exceeded.'}))
   }finally{vi.useRealTimers();await rm(root,{recursive:true,force:true})}
 })
})
