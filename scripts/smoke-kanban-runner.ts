import { columnAutomationSchema } from '@maestrly/protocol'
import { execFileSync } from 'node:child_process'
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { RunnerEngine,WorkspaceManager,RunnerJournal,ContainerCommandRunner,type ExecutorAdapter } from '@maestrly/runner-core'
import { RunnerHttpClient,enroll } from '../apps/runner/src/server-client.js'
import type { RunnerConfig } from '../apps/runner/src/config.js'

if(process.env.MAESTRLY_LIVE_E2E!=='1') throw new Error('This smoke requires the isolated Kanban test harness.')
const base=process.env.MAESTRLY_CANONICAL_URL!
const root=await mkdtemp(path.join(os.tmpdir(),'kanban-git-e2e-'))
const repo=path.join(root,'source')
try {
  const login=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:process.env.MAESTRLY_WEB_ORIGIN!},body:JSON.stringify({email:process.env.MAESTRLY_E2E_EMAIL,password:process.env.MAESTRLY_E2E_PASSWORD})})
  assert.equal(login.status,200)
  const cookie=login.headers.getSetCookie().map(c=>c.split(';',1)[0]).join('; ')
  async function request(url:string,body?:unknown,method=body?'POST':'GET'):Promise<any> {
    const response=await fetch(base+url,{method,headers:{cookie,'x-maestrly-protocol-version':'1.0','content-type':'application/json','idempotency-key':crypto.randomUUID()},...(body?{body:JSON.stringify(body)}:{})})
    if(!response.ok)throw new Error(`Fixture HTTP ${response.status}: ${await response.text()}`)
    return response.status===204?null:response.json()
  }
  const org=(await request('/api/v1/organizations'))[0].id
  const prefix='/api/v1/organizations/'+org
  const project=await request(prefix+'/projects',{name:'Git runner fixture'})
  const boardId=project.boardId,projectId=project.project.id
  const board=await request(prefix+'/boards/'+boardId)
  execFileSync('git',['init','--initial-branch=main',repo],{stdio:'ignore'})
  const git=(args:string[],cwd=repo)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
  await writeFile(path.join(repo,'fixture.txt'),'main\n');git(['add','.']);git(['commit','-m','fixture'])
  git(['checkout','-b','release'])
  await writeFile(path.join(repo,'fixture.txt'),'release\n');git(['commit','-am','release'])
  const baseCommit=git(['rev-parse','HEAD'])
  git(['checkout','main'])
  const binding=await request(prefix+'/projects/'+projectId+'/repositories',{name:'Fixture repository',baseBranch:'release',disabled:false,makeDefault:true})

  const enrollment=await request('/api/v1/runner-enrollments',{organizationId:org,projectIds:[projectId]})
  const identity=await enroll({serverUrl:base,organizationId:org,token:enrollment.token,name:'Isolated Git fixture',maxConcurrency:1})
  const config:RunnerConfig={serverUrl:base,organizationId:org,...identity,name:'Fixture',maxConcurrency:1,isolationMode:'native-sandbox',containerImage:'postgres:17-alpine',repositories:[{bindingId:binding.id,localPath:repo}]}
  const catalog={read:async()=>({version:1 as const,models:[{provider:'codex' as const,model:'fixture',label:'Fixture',efforts:['high'],fastMode:true,fastServiceTier:'priority'}],maestro:true,subagents:true,preCommands:true,issues:[]})}
  await new RunnerHttpClient(config,catalog).claim()
  await request(prefix+'/columns/'+board.columns[1].id+'/automation',{expectedPolicyId:null,config:columnAutomationSchema.parse({enabled:true,autoRun:true,provider:'codex',model:'fixture',effort:'high',fastMode:true,mode:'maestro',subagentsEnabled:true,approvalRequired:false,preCommands:['printf prepared > preflight.txt'],promptTemplate:'Work on {task_title}: {task_body}'})},'PUT')
  const card=await request(prefix+'/boards/'+boardId+'/cards',{title:'Produce fixture patch'})
  await request(prefix+'/cards/'+card.id+'/move',{expectedVersion:card.version,targetColumnId:board.columns[1].id,targetPosition:0,source:'human',allowAutomationChain:false,chainDepth:0})
  assert.equal(await new RunnerHttpClient({...config,repositories:[]},catalog).claim(),null,'runner without the repository must not claim')
  let edited=false
  const adapter:ExecutorAdapter={capabilities:async()=>({executor:'codex',capabilities:[]}),start:async context=>{
    assert.equal(context.envelope.snapshot.repositoryBranch,'release')
    assert.equal(context.envelope.snapshot.effort,'high')
    assert.equal(context.envelope.snapshot.fastMode,true)
    assert.equal(await readFile(path.join(context.environment.workspacePath,'preflight.txt'),'utf8'),'prepared')
    if(context.readOnly) {
      const planning=context.envelope.snapshot.renderedPrompt?.includes('Plan independent')
      return {done:Promise.resolve({state:'succeeded',summary:planning?'{"tasks":[{"resource":"backend","task":"Implement fixture"}]}':'{"approved":true,"feedback":"Verified"}'}),cancel:async()=>{}}
    }
    assert.equal(context.environment.gitBaseCommit,baseCommit)
    assert.equal(await readFile(path.join(context.environment.workspacePath,'fixture.txt'),'utf8'),edited?'verified\n':'release\n')
    edited=true
    await writeFile(path.join(context.environment.workspacePath,'fixture.txt'),'verified\n')
    await writeFile(path.join(context.environment.workspacePath,'added.txt'),'new evidence\n')
    await context.emit({type:'fixture.verified',data:{baseCommit}})
    return {done:Promise.resolve({state:'succeeded',summary:'Isolated fixture complete.'}),cancel:async()=>{}}
  }}
  const engine=new RunnerEngine(new RunnerHttpClient(config,catalog),new Map([['codex',adapter]]),new WorkspaceManager({repositories:config.repositories,isolated:true}),new RunnerJournal(path.join(root,'journal.json')),{commandRunner:new ContainerCommandRunner(config.containerImage)})
  assert.equal(await engine.runOnce(),true)
  const detail=await request(prefix+'/cards/'+card.id)
  assert.equal(detail.card.columnId,board.columns[1].id,'agent success must not move the card')
  assert.equal(detail.executions[0].jobState,'completed',detail.attempts[0]?.outcome?.failure)
  assert.equal(detail.attempts[0].state,'succeeded')
  const patch=detail.artifacts.find((a:any)=>a.kind==='patch')
  assert.ok(patch)
  const download=await fetch(base+prefix+'/artifacts/'+patch.id+'/download?protocolVersion=1.0',{headers:{cookie}})
  assert.equal(download.status,200)
  const patchFile=path.join(root,'delivery.patch')
  await writeFile(patchFile,await download.text())
  assert.equal(git(['status','--porcelain']),'')
  assert.equal(await readFile(path.join(repo,'fixture.txt'),'utf8'),'main\n')
  git(['checkout','release']);git(['apply','--check',patchFile])
  git(['apply',patchFile])
  assert.equal(await readFile(path.join(repo,'added.txt'),'utf8'),'new evidence\n')
  process.stdout.write('Git smoke: column config → compatible claim → isolated pre-command → Maestro delegates/review → verified patch passed.\n')
} finally {await rm(root,{recursive:true,force:true})}
