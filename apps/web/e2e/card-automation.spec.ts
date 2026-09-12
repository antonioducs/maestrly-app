import { expect,test } from '@playwright/test'
import { columnAutomationSchema } from '@maestrly/protocol'
import { translate,type Locale } from '../src/i18n/index.js'
test('saves per-column overrides, releases a block and requests the exact previewed execution',async({page},info)=>{
 const L=(key:string)=>translate(key,info.project.name as Locale),now=new Date().toISOString(),columnId='20000000-0000-4000-8000-000000000001',policyId='20000000-0000-4000-8000-000000000002'
 const config=columnAutomationSchema.parse({enabled:true,autoRun:false,model:'main',approvalRequired:false})
 const card={id:'card',organizationId:'org',projectId:'project',boardId:'board',columnId,parentCardId:null,title:'Run this card',description:'Description',acceptanceCriteria:[],labels:[],priority:'none',assigneeUserIds:[],position:0,version:1,archivedAt:null,createdAt:now,updatedAt:now}
 const board={id:'board',name:'Delivery',rolesConfigured:true,version:1},columns=[{id:columnId,name:'Build',role:'normal',executionPolicyId:policyId}]
 let override:Record<string,unknown>={},version=0,blocked=true,active=false,request:Record<string,unknown>|undefined
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method()
  if(path.endsWith('/get-session'))return route.fulfill({json:{user:{id:'owner',name:'Owner',email:'owner@example.test'}}})
  if(path.endsWith('/organizations'))return route.fulfill({json:[{id:'org',name:'Organization',role:'owner'}]})
  if(path.endsWith('/projects'))return route.fulfill({json:[{id:'project',name:'Project',currentRole:'maintainer'}]})
  if(path.endsWith('/boards'))return route.fulfill({json:[board]})
  if(path.endsWith('/boards/board'))return route.fulfill({json:{board,columns,cards:[card]}})
  if(path.endsWith('/cards/card'))return route.fulfill({json:{card,userId:'owner',columnName:'Build',canModerate:true,subtasks:[],parent:null,comments:[],attachments:[],executions:[],artifacts:[],attempts:[],requests:[]}})
  if(path.endsWith('/automation-catalog'))return route.fulfill({json:{runners:[{id:'runner',name:'Runner',status:'online',lastSeenAt:now,capabilities:{version:1,models:['main','alternative'].map(model=>({provider:'codex',model,label:model,efforts:['low','high'],fastMode:true})),maestro:true,subagents:true,preCommands:false,issues:[]}}]}})
  if(path.endsWith('/automation/override')){
   const body=route.request().postDataJSON();expect(body.expectedVersion).toBe(version);expect(body.columnId).toBe(columnId)
   override=body.config??{};version++;return route.fulfill({json:{ok:true}})
  }
  if(path.endsWith('/automation/release')){blocked=false;return route.fulfill({json:{ok:true}})}
  if(path.endsWith('/automation/run')){request=route.request().postDataJSON();active=true;return route.fulfill({json:{jobId:'job'}})}
  if(path.endsWith('/automation')&&method==='GET')return route.fulfill({json:{column:{id:columnId,name:'Build',role:'normal'},policyId,cardVersion:1,config,effective:{...config,...override},override,overrideVersion:version,blocked,active,renderedPrompt:'Execute this exact preview.',runners:[{runnerId:'runner',name:'Runner',compatible:true,reasons:[]}]}})
  if(path.endsWith('/events'))return route.fulfill({contentType:'text/event-stream',body:': ready\n\n'})
  return route.fulfill({json:[]})
 })
 await page.goto('/')
 await page.getByRole('button',{name:'Run this card',exact:true}).click()
 const dialog=page.getByRole('dialog')
 await dialog.getByRole('tab',{name:L('Executions'),exact:true}).click()
 await dialog.getByRole('combobox',{name:L('Override model'),exact:true}).click()
 await page.getByRole('option',{name:'alternative',exact:true}).click()
 await dialog.getByRole('combobox',{name:L('Override effort'),exact:true}).click()
 await page.getByRole('option',{name:L('high'),exact:true}).click()
 await dialog.getByRole('button',{name:L('Save overrides'),exact:true}).click()
 await expect.poll(()=>override.model).toBe('alternative')
 expect(override.effort).toBe('high')
 await expect(dialog.getByRole('button',{name:L('Run agent'),exact:true})).toBeDisabled()
 await dialog.getByRole('button',{name:L('Release dispatch'),exact:true}).click()
 await dialog.getByRole('button',{name:L('Run agent'),exact:true}).click()
 const confirmation=page.getByRole('dialog',{name:L('Run agent'),exact:true})
 await expect(confirmation).toContainText('Execute this exact preview.')
 await confirmation.getByRole('button',{name:L('Request execution'),exact:true}).click()
 await expect.poll(()=>request?.expectedPolicyId).toBe(policyId)
 expect(request?.expectedVersion).toBe(1)
 await expect(dialog.getByRole('button',{name:L('Run agent'),exact:true})).toBeDisabled()
})
