import { expect,test } from '@playwright/test'
import { translate,type Locale } from '../src/i18n/index.js'
import { columnAutomationSchema } from '@maestrly/protocol'

test('personal computer: owned registration, atomic card move, exact device delivery and disconnection',async({page},info)=>{
 test.skip(!process.env.MAESTRLY_LIVE_E2E,'Requires isolated real API fixtures.')
 test.setTimeout(90000)
 const L=(key:string)=>translate(key,info.project.name as Locale)
 await page.setViewportSize({width:1440,height:1000});await page.goto('/')
 await page.getByLabel(L('Email'),{exact:true}).fill(process.env.MAESTRLY_E2E_EMAIL!)
 await page.getByLabel(L('Password'),{exact:true}).fill(process.env.MAESTRLY_E2E_PASSWORD!)
 await page.getByRole('button',{name:L('Sign in'),exact:true}).click()
 await expect(page.getByRole('navigation',{name:L('Workspace')})).toBeVisible()
 const request=async(method:'get'|'post'|'put',url:string,data?:unknown,extra:Record<string,string>={})=>{
  const response=await page.request[method](url,{headers:{'x-maestrly-protocol-version':'1.0','idempotency-key':crypto.randomUUID(),...extra},data})
  expect(response.ok(),url+' status '+response.status()).toBe(true)
  return response.status()===204?undefined:response.json()
 }
 const org=(await request('get','/api/v1/organizations'))[0].id,root='/api/v1/organizations/'+org
 const name='Personal '+info.project.name+' '+Date.now(),created=await request('post',root+'/projects',{name}),projectId=created.project.id
 const board=await request('get',root+'/boards/'+created.boardId),column=board.columns[1]
 const device=await request('post','/api/v1/personal-devices',{organizationId:org,projectIds:[projectId],name:'My MacBook'})
 const headers=(identity:{runnerId:string;credential:string})=>({'x-maestrly-organization-id':org,'x-maestrly-runner-id':identity.runnerId,authorization:'Runner '+identity.credential})
 const caps={version:1,models:[{provider:'codex',model:'fixture',label:'Fixture',efforts:['high'],fastMode:false}],maestro:true,subagents:true,preCommands:false,issues:[]}
 const claim=(identity:{runnerId:string;credential:string})=>request('post','/api/v1/runners/claim',{repositories:[],automationCapabilities:caps},headers(identity))
 expect(await claim(device)).toBeNull()
 const enrollment=await request('post','/api/v1/runner-enrollments',{organizationId:org,projectIds:[projectId]})
 const shared=await request('post','/api/v1/runners/enroll',{organizationId:org,token:enrollment.token,name:'Team runner',protocolVersion:'1.0',capabilities:[],maxConcurrency:1})
 expect(await claim(shared)).toBeNull()
 await request('put',root+'/columns/'+column.id+'/automation',{expectedPolicyId:null,config:columnAutomationSchema.parse({enabled:true,autoRun:true,model:'fixture',approvalRequired:false,runnerSelector:'runner',targetRunnerId:shared.runnerId,promptTemplate:'Implement {task_title}'})})
 const card=await request('post',root+'/boards/'+created.boardId+'/cards',{columnId:board.columns[0].id,title:'Work on my machine'})
 await page.reload();await page.getByRole('combobox',{name:L('Project'),exact:true}).click();await page.getByRole('option',{name,exact:true}).click()
 await page.getByRole('button',{name:L('My computers'),exact:true}).click()
 await expect(page.locator('.personal-device-list')).toContainText('My MacBook')
 await expect(page.locator('.personal-device-list')).not.toContainText('Team runner')
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:info.outputPath('personal-devices-'+width+'.png'),animations:'disabled'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:L('Board'),exact:true}).first().click()
 await page.getByRole('button',{name:L('Run on my computer')+' '+card.title,exact:true}).click()
 const dialog=page.getByRole('dialog')
 await expect(dialog).toContainText('Implement Work on my machine')
 await expect(dialog.getByRole('combobox',{name:L('My computer'),exact:true})).toContainText('My MacBook')
 await page.screenshot({path:info.outputPath('personal-execution-preview.png'),animations:'disabled'})
 await dialog.getByRole('button',{name:L('Move and execute on my computer'),exact:true}).click()
 await expect(dialog).toHaveCount(0)
 const detail=await request('get',root+'/cards/'+card.id)
 expect(detail.card.columnId).toBe(column.id);expect(detail.executions).toHaveLength(1)
 expect(await claim(shared)).toBeNull()
 const personal=await claim(device);expect(personal.envelope.snapshot.personalDevice.deviceId).toBe(device.runnerId)
 expect(personal.envelope.snapshot.targetRunnerId).toBe(device.runnerId)
 expect((await request('get',root+'/columns/'+column.id+'/automation')).config.targetRunnerId).toBe(shared.runnerId)
 await request('post','/api/v1/runners/runs/'+personal.envelope.runId+'/complete',{leaseId:personal.envelope.leaseId,completion:{state:'succeeded',summary:'Personal fixture verified',artifacts:[]}},headers(device))
 await page.getByRole('button',{name:L('My computers'),exact:true}).click()
 await page.getByRole('button',{name:L('Disconnect computer'),exact:true}).click()
 await page.getByRole('dialog').getByRole('button',{name:L('Disconnect computer'),exact:true}).click()
 await expect(page.locator('.personal-device-list article')).toHaveCount(0)
 await page.getByText(L('Connect my desktop'),{exact:true}).click()
 await expect(page.getByLabel(L('Instance URL'),{exact:true})).toBeVisible()
 const refused=await page.request.post('/api/v1/runners/claim',{headers:{'x-maestrly-protocol-version':'1.0',...headers(device)},data:{}})
 expect(refused.ok()).toBe(false)
})
