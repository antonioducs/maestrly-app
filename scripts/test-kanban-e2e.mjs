#!/usr/bin/env node
import { spawn,spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp,rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const root=await mkdtemp(path.join(os.tmpdir(),'maestrly-kanban-e2e-'))
const container='maestrly-kanban-e2e-'+process.pid
const children=[]
const pgPassword=randomBytes(24).toString('hex')
const runtimePassword=randomBytes(24).toString('hex')
const userPassword=randomBytes(24).toString('hex')
let started=false
function command(executable,args,env=process.env,capture=false) {
  const result=spawnSync(executable,args,{env,stdio:capture?'pipe':'inherit',encoding:'utf8',shell:false})
  if(result.status!==0)throw new Error(capture?'Fixture command failed.':`${executable} exited ${result.status}`)
  return result.stdout?.trim()
}
async function port() {
  const server=createServer()
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const result=server.address().port
  await new Promise(resolve=>server.close(resolve))
  return result
}
async function ready(url) {
  for(let attempt=0;attempt<80;attempt++) {
    try { if((await fetch(url)).ok) return } catch {}
    await new Promise(resolve=>setTimeout(resolve,250))
  }
  throw new Error('Fixture did not become ready: '+url)
}
function start(executable,args,env) {
  const child=spawn(executable,args,{env,stdio:['ignore','pipe','pipe'],shell:false,detached:process.platform!=='win32'})
  child.stdout.on('data',()=>{})
  child.stderr.on('data',chunk=>{if(/Error|error TS/.test(String(chunk)))process.stderr.write(chunk)})
  children.push(child)
  return child
}
try {
  command('npm',['run','build:runner-core'])
  command('npm',['run','build:web'])
  command('docker',['run','--rm','-d','--name',container,'-e',`POSTGRES_PASSWORD=${pgPassword}`,'-e','POSTGRES_DB=maestrly','-p','127.0.0.1::5432','postgres:17-alpine'],process.env,true)
  started=true
  for(let attempt=0;attempt<100;attempt++) {
    if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d','maestrly'],{stdio:'ignore'}).status===0)break
    await new Promise(resolve=>setTimeout(resolve,200))
  }
  const pgPort=command('docker',['port',container,'5432/tcp'],process.env,true).split(':').at(-1)
  command('docker',['exec',container,'psql','-U','postgres','-d','maestrly','-v','ON_ERROR_STOP=1','-c',`create role maestrly_runtime login password '${runtimePassword}' nosuperuser nobypassrls;`],process.env,true)
  const apiPort=await port(),webPort=await port(),apiUrl=`http://127.0.0.1:${apiPort}`,webUrl=`http://127.0.0.1:${webPort}`
  const env={...process.env,OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(apiPort),LOG_LEVEL:'silent',
    DATABASE_URL:`postgres://maestrly_runtime:${runtimePassword}@127.0.0.1:${pgPort}/maestrly`,
    MIGRATION_DATABASE_URL:`postgres://postgres:${pgPassword}@127.0.0.1:${pgPort}/maestrly`,
    BETTER_AUTH_SECRET:randomBytes(32).toString('hex'),MAESTRLY_CANONICAL_URL:apiUrl,MAESTRLY_WEB_ORIGIN:webUrl,
    MAESTRLY_SERVER_URL:apiUrl,MAESTRLY_STORAGE_DIR:path.join(root,'attachments'),
    MAESTRLY_BOOTSTRAP_EMAIL:'owner@example.test',MAESTRLY_BOOTSTRAP_PASSWORD:userPassword,
    MAESTRLY_E2E_EXTERNAL:'1',MAESTRLY_WEB_URL:webUrl,MAESTRLY_LIVE_E2E:'1',
    MAESTRLY_E2E_EMAIL:'owner@example.test',MAESTRLY_E2E_PASSWORD:userPassword,
  }
  command(process.execPath,['--import','tsx','apps/server/src/db/migrate.ts'],env)
  command(process.execPath,['--import','tsx','apps/server/src/modules/auth/bootstrap.ts'],env)
  let apiChild=start(process.execPath,['--import','tsx','apps/server/src/main.ts'],env)
  start('npm',['exec','--workspace','@maestrly/web','--','vite','preview','--host','127.0.0.1','--port',String(webPort),'--strictPort'],env)
  await ready(apiUrl+'/api/v1/health/ready');await ready(webUrl)
  async function restartApi() {
    try {if(process.platform==='win32')apiChild.kill('SIGTERM');else process.kill(-apiChild.pid,'SIGTERM')}catch{}
    if(apiChild.exitCode===null)await new Promise(resolve=>apiChild.once('exit',resolve))
    apiChild=start(process.execPath,['--import','tsx','apps/server/src/main.ts'],env)
    await ready(apiUrl+'/api/v1/health/ready')
  }
  if(process.env.MAESTRLY_DESKTOP_E2E!=='only'){
    command(process.execPath,['--import','tsx','scripts/smoke-kanban-runner.ts'],env)
    for(const locale of ['en','pt-BR']) {
      if(locale==='pt-BR')await restartApi()
      const args=process.argv.slice(2)
      // Independent auth-heavy scenarios get a fresh rate-limit window; production limits stay enabled.
      command('npm',['run','test:e2e','--workspace','@maestrly/web','--','--project='+locale,...(args.length?args:['--grep-invert','real team:'])],env)
      if(!args.length){await restartApi();command('npm',['run','test:e2e','--workspace','@maestrly/web','--','--project='+locale,'--grep','real team:'],env)}
    }
  }
  if(['1','only'].includes(process.env.MAESTRLY_DESKTOP_E2E)){
    await restartApi()
    if(!process.env.MAESTRLY_PACKAGED_EXECUTABLE)command('npm',['run','build:desktop'],env)
    command('npm',['run','test:e2e','--workspace','@maestrly/desktop','--',process.env.MAESTRLY_PROJECT_CHAT_E2E==='1'?'project-chat.spec.ts':'personal-device.spec.ts'],env)
  }
} finally {
  for(const child of children) {
    try{if(process.platform==='win32')child.kill('SIGTERM');else process.kill(-child.pid,'SIGTERM')}catch{}
  }
  await new Promise(resolve=>setTimeout(resolve,400))
  if(started)spawnSync('docker',['stop',container],{stdio:'ignore'})
  await rm(root,{recursive:true,force:true})
}
