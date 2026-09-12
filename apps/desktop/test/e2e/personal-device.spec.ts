import {createServer,type Server} from 'node:http'
import {columnAutomationSchema} from '@maestrly/protocol'
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, readFile, realpath, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  DesktopExecutorSettings,DesktopExecutionRecord,
  PlatformConnectionView,
  DeviceAuthorizationView,
  EmbeddedRunnerView,
  PlatformProjectBinding,
} from '../../src/shared/platform'

declare const window: {
  api: {
    platformExecutorSettings():Promise<DesktopExecutorSettings>
    platformSaveExecutorSettings(value:DesktopExecutorSettings):Promise<DesktopExecutorSettings>
    platformExecutorHistory():Promise<DesktopExecutionRecord[]>
    platformOpenExecutorConversation(id:string):Promise<void>
    chatAddProvider(input:{name:string;baseURL:string;key:string;kind:'openai'}):Promise<{id?:string;ok:boolean}>
    addWorkspace(dir: string): Promise<{ id: string }>
    platformAddConnection(url: string): Promise<PlatformConnectionView>
    platformBeginDeviceAuthorization(id: string, clientId: string): Promise<DeviceAuthorizationView>
    platformPollDeviceAuthorization(id: string): Promise<PlatformConnectionView>
    platformSetProjectBinding(binding: PlatformProjectBinding): Promise<void>
    platformRunnerStatus():Promise<EmbeddedRunnerView>
    platformRunnerStart(id: string): Promise<EmbeddedRunnerView>
    platformRunnerStop(): Promise<void>
    platformDisconnect(id: string): Promise<PlatformConnectionView>
    setLocale(locale: string): Promise<void>
  }
}
const desktop = fileURLToPath(new URL('../..', import.meta.url))
test('pairs the real desktop, exposes only an owner device and disables it on disconnect', async ({
  request,
}, info) => {
  test.skip(!process.env.MAESTRLY_LIVE_E2E, 'Requires scripts/test-kanban-e2e.mjs with MAESTRLY_DESKTOP_E2E=1.')
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-personal-desktop-'))),
    server = process.env.MAESTRLY_SERVER_URL!
  const nonGit=await realpath(await mkdtemp(path.join(os.tmpdir(),'maestrly-non-git-folder-')))
  const cloneParent=await realpath(await mkdtemp(path.join(os.tmpdir(),'maestrly-clone-parent-')))
  const bare=path.join(cloneParent,'fixture-origin.git')
  let gitServer:Server|undefined
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  let modelServer:Server|undefined
  const modelRequests:any[]=[]
  let holdModel=false,heldRequests=0
  try {
    modelServer=createServer(async(req,res)=>{
      if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'executor-fixture',object:'model'}]}));return}
      if(req.url!=='/v1/chat/completions'){res.writeHead(404).end();return}
      let body='';for await(const chunk of req)body+=chunk
      const input=JSON.parse(body);modelRequests.push(input)
      if(holdModel){heldRequests++;return}
      const written=input.messages.some((m:any)=>m.role==='tool')
      res.setHeader('content-type','text/event-stream')
      const chunk=(delta:unknown,finish_reason:string|null=null)=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:0,model:'executor-fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n')
      if(!written){chunk({role:'assistant',tool_calls:[{index:0,id:'write-fixture',type:'function',function:{name:'write',arguments:JSON.stringify({path:'executor-proof.txt',content:'Verified desktop execution.\n'})}}]});chunk({},'tool_calls')}
      else if(!input.messages.some((m:any)=>m.role==='tool'&&m.tool_call_id==='report-fixture')){chunk({role:'assistant',tool_calls:[{index:0,id:'report-fixture',type:'function',function:{name:'executor_report',arguments:JSON.stringify({state:'succeeded',summary:'Created executor-proof.txt and verified the tool result.'})}}]});chunk({},'tool_calls')}
      else{chunk({role:'assistant',content:'Created executor-proof.txt through the full Maestrly chat engine. Verified the tool result.'});chunk({},'stop')}
      res.end('data: [DONE]\n\n')
    })
    await new Promise<void>(resolve=>modelServer!.listen(0,'127.0.0.1',resolve))
    const modelPort=(modelServer.address() as {port:number}).port
    const signedIn = await request.post(server + '/api/auth/sign-in/email', {
      data: { email: process.env.MAESTRLY_E2E_EMAIL, password: process.env.MAESTRLY_E2E_PASSWORD },
    })
    expect(signedIn.status()).toBe(200)
    const headers = { 'x-maestrly-protocol-version': '1.0', 'idempotency-key': crypto.randomUUID() }
    const orgs = await (await request.get(server + '/api/v1/organizations', { headers })).json()
    const organizationId = orgs[0].id
    const created = await (
      await request.post(server + '/api/v1/organizations/' + organizationId + '/projects', {
        headers,
        data: { name: 'Desktop personal fixture' },
      })
    ).json()
    const secondProject=await request.post(server+'/api/v1/organizations/'+organizationId+'/projects',{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{name:'Another local project'}})
    expect(secondProject.ok()).toBe(true)
    const secondProjectId=(await secondProject.json()).project.id
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'Fixture',
    ])
    // Serve a bare clone over Git's dumb HTTP protocol so the Kanban can hold a real http:// clone URL.
    execFileSync('git',['clone','--bare','-q',root,bare])
    execFileSync('git',['-C',bare,'update-server-info'])
    gitServer=createServer(async(req,res)=>{
      const file=path.join(bare,decodeURIComponent(new URL(req.url!,'http://x').pathname.replace(/^\/fixture\.git/,'')))
      if(!file.startsWith(bare)||!(await stat(file).catch(()=>null))?.isFile()){res.writeHead(404).end();return}
      createReadStream(file).pipe(res)
    })
    await new Promise<void>(resolve=>gitServer!.listen(0,'127.0.0.1',resolve))
    const cloneUrl='http://127.0.0.1:'+(gitServer.address() as {port:number}).port+'/fixture.git'
    const repo=await request.post(server+'/api/v1/organizations/'+organizationId+'/projects/'+secondProjectId+'/repositories',{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{name:'Fixture source',cloneUrl,baseBranch:'main'}})
    expect(repo.ok(),await repo.text()).toBe(true)
    const launch=()=>electron.launch({
      ...(process.env.MAESTRLY_PACKAGED_EXECUTABLE ? {executablePath:process.env.MAESTRLY_PACKAGED_EXECUTABLE,args:['--use-mock-keychain']} : {args:[path.join(desktop,'out/main/index.js')]}),
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'personal-test',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    app=await launch()
    let page = await app.firstWindow()
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const connection = await page.evaluate((url) => window.api.platformAddConnection(url), server)
    expect(connection.desktopClientId).toBe('maestrly-desktop-personal-v1')
    const pending = await page.evaluate((id) => window.api.platformBeginDeviceAuthorization(id, ''), connection.id)
    const reviewed=await request.get(server+'/api/auth/device?user_code='+encodeURIComponent(pending.userCode))
    expect(reviewed.status(),reviewed.status()===200?'':await reviewed.text()).toBe(200)
    const approved = await request.post(server + '/api/auth/device/approve', { data: { userCode: pending.userCode } })
    expect(approved.status(),approved.status()===200?'':await approved.text()).toBe(200)
    await expect
      .poll(
        async () => {
          const result = await page.evaluate((id) => window.api.platformPollDeviceAuthorization(id), connection.id)
          return result.state
        },
        { timeout: 20000, intervals: [1100] }
      )
      .toBe('connected')
    const provider=await page.evaluate(baseURL=>window.api.chatAddProvider({name:'Local executor fixture',baseURL,key:'fixture-key',kind:'openai'}),'http://127.0.0.1:'+modelPort+'/v1')
    expect(provider.ok).toBe(true)
    await page.getByTitle('Settings').click()
    await page.getByRole('button',{name:/Platform/}).click()
    await expect(page.getByText('Maestrly executor',{exact:true})).toBeVisible()
    const bindingPanel=page.getByTestId('project-binding-section')
    await bindingPanel.getByRole('combobox',{name:'Kanban project',exact:true}).click()
    await page.getByRole('option',{name:/Desktop personal fixture/}).click()
    await expect(bindingPanel.getByTestId('link-blocker')).toContainText('choose the folder on this computer')
    await bindingPanel.getByRole('button',{name:'Link project',exact:true}).click()
    await expect(bindingPanel.getByRole('alert')).toContainText('Choose the folder on this computer (step 2).')
    await expect(bindingPanel.getByRole('button',{name:'Choose folder…',exact:true})).toBeFocused()
    await bindingPanel.screenshot({style:'html{background:#252929!important}',path:info.outputPath('project-binding-empty-en.png')})
    await page.evaluate(()=>window.api.setLocale('pt-BR'))
    await expect(bindingPanel.getByRole('heading',{name:'Projetos neste computador',exact:true})).toBeVisible()
    await bindingPanel.screenshot({style:'html{background:#252929!important}',path:info.outputPath('project-binding-empty-pt.png')})
    await page.evaluate(()=>window.api.setLocale('en'))
    await app.evaluate(({dialog},folders)=>{let index=0;dialog.showOpenDialog=async()=>{if(index++===0)return {canceled:true,filePaths:[]};return {canceled:false,filePaths:[index===2?folders.nonGit:folders.root]}}},{root,nonGit})
    await bindingPanel.getByRole('button',{name:'Choose folder…',exact:true}).click()
    await expect(bindingPanel.getByTestId('link-blocker')).toContainText('choose the folder')
    await bindingPanel.getByRole('button',{name:'Choose folder…',exact:true}).click()
    await expect(bindingPanel.getByText(nonGit,{exact:true})).toBeVisible()
    await expect(bindingPanel.getByRole('alert')).toHaveCount(0)
    expect(execFileSync('git',['-C',nonGit,'rev-parse','--is-inside-work-tree']).toString().trim()).toBe('true')
    expect(execFileSync('git',['-C',nonGit,'log','--oneline']).toString().trim()).not.toBe('')
    await bindingPanel.getByRole('button',{name:'Choose another folder…',exact:true}).click()
    await expect(bindingPanel.getByText(root,{exact:true})).toBeVisible()
    await bindingPanel.getByRole('button',{name:'Link project',exact:true}).click()
    await expect(bindingPanel.getByTestId('saved-project-binding')).toContainText('Desktop personal fixture')
    await expect(bindingPanel.getByTestId('saved-project-binding')).toContainText(root)
    await expect(bindingPanel.getByRole('combobox',{name:'Folder on this computer',exact:true})).toHaveCount(0)
    await bindingPanel.screenshot({style:'html{background:#252929!important}',path:info.outputPath('project-binding-saved-en.png')})
    await page.evaluate(()=>window.api.setLocale('pt-BR'))
    await expect(bindingPanel.getByText('Projeto vinculado. Agora você pode iniciar o executor abaixo.',{exact:true})).toBeVisible()
    expect(await bindingPanel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
    await bindingPanel.screenshot({style:'html{background:#252929!important}',path:info.outputPath('project-binding-saved-pt.png')})
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(1000,900))
    expect(await bindingPanel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
    await bindingPanel.screenshot({style:'html{background:#252929!important}',path:info.outputPath('project-binding-narrow-pt.png')})
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(1400,1000))

    await page.evaluate(()=>window.api.setLocale('en'))
    await bindingPanel.getByRole('button',{name:'Remove link',exact:true}).click()
    await expect(bindingPanel.getByTestId('saved-project-binding')).toHaveCount(0)
    await bindingPanel.getByRole('button',{name:'Undo',exact:true}).click()
    await expect(bindingPanel.getByTestId('saved-project-binding')).toHaveCount(1)
    await bindingPanel.getByRole('button',{name:'Link another project',exact:true}).click()
    await bindingPanel.getByRole('combobox',{name:'Kanban project',exact:true}).click()
    await page.getByRole('option',{name:/Another local project/}).click()
    await expect(bindingPanel.getByRole('combobox',{name:'Folder on this computer',exact:true})).toHaveText('Select a local folder…')
    await bindingPanel.getByRole('combobox',{name:'Folder on this computer',exact:true}).click()
    await page.getByRole('option',{name:new RegExp('maestrly-personal-desktop-')}).click()
    await expect(bindingPanel.getByRole('alert')).toContainText('already linked to another project')
    await bindingPanel.getByRole('button',{name:'Link project',exact:true}).click()
    await expect(bindingPanel.getByRole('alert').first()).toContainText('already linked to another project')
    await expect(bindingPanel.getByTestId('saved-project-binding')).toHaveCount(1)


    await bindingPanel.getByRole('button',{name:'Cancel',exact:true}).click()
    await expect(bindingPanel.getByRole('alert')).toHaveCount(0)
    // Clone the repository registered in the Kanban straight from the desktop.
    await app.evaluate(({dialog},parent)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[parent]})},cloneParent)
    await bindingPanel.getByRole('button',{name:'Link another project',exact:true}).click()
    await bindingPanel.getByRole('combobox',{name:'Kanban project',exact:true}).click()
    await page.getByRole('option',{name:/Another local project/}).click()
    await bindingPanel.getByRole('button',{name:'Clone Fixture source…',exact:true}).click()
    const cloned=path.join(cloneParent,'fixture')
    await expect(bindingPanel.getByText(cloned,{exact:true})).toBeVisible({timeout:30000})
    await expect(bindingPanel.getByRole('alert')).toHaveCount(0)
    await expect(bindingPanel.getByRole('button',{name:'Clone Fixture source…',exact:true})).toHaveCount(0)
    await expect(bindingPanel.getByRole('combobox',{name:'Code repository',exact:true})).toHaveText('Fixture source · main')
    expect(execFileSync('git',['-C',cloned,'rev-parse','--abbrev-ref','HEAD']).toString().trim()).toBe('main')
    await bindingPanel.getByRole('button',{name:'Link project',exact:true}).click()
    await expect(bindingPanel.getByTestId('saved-project-binding')).toHaveCount(2)
    await expect(bindingPanel.getByTestId('saved-project-binding').filter({hasText:'Another local project'})).toContainText('Fixture source')
    await bindingPanel.screenshot({style:'html{background:#252929!important}',path:info.outputPath('project-binding-cloned-en.png')})
    await expect(bindingPanel.getByTestId('saved-project-binding').first()).toContainText('Desktop personal fixture')
    await page.getByLabel(/Local executor fixture/).check()
    await page.getByLabel('Continue in background when the window is closed',{exact:true}).check()
    await page.getByRole('button',{name:'Start executor',exact:true}).click()
    await expect(page.getByRole('button',{name:'Pause executor',exact:true})).toBeVisible()
    const state = await page.evaluate((id) => window.api.platformRunnerStart(id), connection.id)
    expect(state.state, state.error).toBe('running')
    expect(state.deviceId).toBeTruthy()
    const devicesUrl =
      server + '/api/v1/organizations/' + organizationId + '/projects/' + created.project.id + '/personal-devices'
    await expect
      .poll(
        async () => {
          const devices = await (await request.get(devicesUrl, { headers })).json()
          return devices[0]?.online
        },
        { timeout: 15000 }
      )
      .toBe(true)
    const shared = await (
      await request.get(
        server + '/api/v1/organizations/' + organizationId + '/projects/' + created.project.id + '/runners',
        { headers }
      )
    ).json()
    expect(shared).toEqual([])
    await expect(page.getByRole('button',{name:'Pause executor',exact:true})).toBeVisible()
    await page.screenshot({ path: info.outputPath('personal-desktop-en.png') })
    await page.evaluate(() => window.api.setLocale('pt-BR'))
    await expect(page.getByText('Executor Maestrly', { exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('personal-desktop-pt.png') })
    // Submit a real card. The operator's one-time configuration is the only approval.
    const call=async(method:'get'|'put'|'post',url:string,data?:unknown)=>{
      const response=await request[method](server+url,{headers:{...headers,'idempotency-key':crypto.randomUUID()},data})
      expect(response.ok(),await response.text()).toBe(true);return response.json()
    }
    let device:any
    await expect.poll(async()=>{device=(await call('get','/api/v1/organizations/'+organizationId+'/projects/'+created.project.id+'/personal-devices'))[0];return device?.capabilities?.models?.length??device?.automationCapabilities?.models?.length??0},{timeout:30000}).toBeGreaterThan(0)
    const catalog=device.capabilities??device.automationCapabilities
    const board=await call('get','/api/v1/organizations/'+organizationId+'/boards/'+created.boardId),column=board.columns[1]
    const config=columnAutomationSchema.parse({enabled:true,provider:'maestrly',model:catalog.models[0].model,taskType:'analysis',approvalRequired:true})
    const policy=await call('put','/api/v1/organizations/'+organizationId+'/columns/'+column.id+'/automation',{expectedPolicyId:null,config})
    const card=await call('post','/api/v1/organizations/'+organizationId+'/boards/'+created.boardId+'/cards',{columnId:column.id,title:'Desktop executor proof'})
    await call('post','/api/v1/organizations/'+organizationId+'/cards/'+card.id+'/automation/run',{expectedVersion:card.version,expectedPolicyId:policy.policyId,expectedOverrideVersion:0,personalDeviceId:state.deviceId})
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.close())
    expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false)
    let detail:any
    await expect.poll(async()=>{detail=await call('get','/api/v1/organizations/'+organizationId+'/cards/'+card.id);return detail.attempts[0]?.state},{timeout:60000}).toBe('succeeded')
    const history=await page.evaluate(()=>window.api.platformExecutorHistory())
    expect(history[0]).toMatchObject({title:'Desktop executor proof',state:'succeeded'})
    expect(await readFile(path.join(history[0]!.workspacePath,'executor-proof.txt'),'utf8')).toBe('Verified desktop execution.\n')
    expect(modelRequests.length).toBeGreaterThanOrEqual(2)
    expect(modelRequests[0].tools.some((t:any)=>/ask_question|review_plan|request_user_input/.test(t.function.name))).toBe(false)
    expect(JSON.stringify(modelRequests[0].messages)).toContain('No person is available')
    const events=await call('get','/api/v1/organizations/'+organizationId+'/cards/'+card.id+'/execution-events?runId='+detail.attempts[0].id)
    expect(events.items.some((e:any)=>e.type==='maestrly.message'&&e.data.text.includes('Created executor-proof'))).toBe(true)
    expect(detail.requests).toEqual([])
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.show())
    await page.evaluate(id=>window.api.platformOpenExecutorConversation(id),history[0]!.conversationId)
    await page.screenshot({path:info.outputPath('desktop-executor-conversation.png')})
    holdModel=true
    const cancelCard=await call('post','/api/v1/organizations/'+organizationId+'/boards/'+created.boardId+'/cards',{columnId:column.id,title:'Cancel desktop executor'})
    await call('post','/api/v1/organizations/'+organizationId+'/cards/'+cancelCard.id+'/automation/run',{expectedVersion:cancelCard.version,expectedPolicyId:policy.policyId,expectedOverrideVersion:0,personalDeviceId:state.deviceId})
    await expect.poll(()=>heldRequests,{timeout:30000}).toBe(1)
    await page.evaluate(()=>window.api.platformRunnerStop())
    await expect.poll(async()=>(await call('get','/api/v1/organizations/'+organizationId+'/cards/'+cancelCard.id)).attempts[0]?.state).toBe('cancelled')
    expect((await page.evaluate(()=>window.api.platformExecutorHistory()))[0]).toMatchObject({state:'cancelled'})
    holdModel=false
    await page.evaluate(async()=>window.api.platformSaveExecutorSettings({...await window.api.platformExecutorSettings(),autoStart:true}))
    await app.close();app=await launch();page=await app.firstWindow()
    await expect.poll(async()=>{const state=await page.evaluate(()=>window.api.platformRunnerStatus());return state.error??state.state},{timeout:30000}).toBe('running')
    await page.evaluate(async()=>window.api.platformSaveExecutorSettings({...await window.api.platformExecutorSettings(),mode:'team',autoStart:false}))
    const teamState=await page.evaluate(id=>window.api.platformRunnerStart(id),connection.id)
    expect(teamState.state,teamState.error).toBe('running');expect(teamState.mode).toBe('team')
    await expect.poll(async()=>{const runners=await call('get','/api/v1/organizations/'+organizationId+'/projects/'+created.project.id+'/automation-catalog');return runners.runners.some((r:any)=>r.id===teamState.deviceId&&r.capabilities?.models.length)},{timeout:30000}).toBe(true)
    const teamCard=await call('post','/api/v1/organizations/'+organizationId+'/boards/'+created.boardId+'/cards',{columnId:column.id,title:'Team desktop proof'})
    await call('post','/api/v1/organizations/'+organizationId+'/cards/'+teamCard.id+'/automation/run',{expectedVersion:teamCard.version,expectedPolicyId:policy.policyId,expectedOverrideVersion:0})
    await expect.poll(async()=>(await call('get','/api/v1/organizations/'+organizationId+'/cards/'+teamCard.id)).attempts[0]?.state,{timeout:30000}).toBe('succeeded')
    await page.evaluate((id) => window.api.platformDisconnect(id), connection.id)
    const stopped = await (await request.get(devicesUrl, { headers })).json()
    expect(stopped[0]).toMatchObject({ online: false, enabled: false })
  } finally {
    await app?.close()
    if(modelServer)await new Promise<void>(resolve=>modelServer!.close(()=>resolve()))
    await rm(root, { recursive: true, force: true })
    await rm(nonGit, { recursive: true, force: true })
    await rm(cloneParent, { recursive: true, force: true })
    if(gitServer)await new Promise<void>(resolve=>gitServer!.close(()=>resolve()))
  }
})
