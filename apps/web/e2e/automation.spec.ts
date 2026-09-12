import { expect,test } from '@playwright/test'
import { columnAutomationSchema,renderAutomationPrompt } from '@maestrly/protocol'
import { translate,type Locale } from '../src/i18n/index.js'
const org='10000000-0000-4000-8000-000000000001',project='10000000-0000-4000-8000-000000000002',board='10000000-0000-4000-8000-000000000003'
const a='10000000-0000-4000-8000-000000000004',b='10000000-0000-4000-8000-000000000005',runner='10000000-0000-4000-8000-000000000006'
test('configures independent column agents with effort, fast, prompt preview and history',async({page},info)=>{
 const L=(key:string)=>translate(key,info.project.name as Locale),now=new Date().toISOString()
 const columns=[{id:'backlog',name:'Backlog',role:'backlog'},{id:a,name:'Build',role:'normal'},{id:b,name:'Review',role:'normal'},{id:'done',name:'Done',role:'done'}].map((c,position)=>({...c,position,executionPolicyId:null as string|null}))
 const configs=new Map([[a,columnAutomationSchema.parse({})],[b,columnAutomationSchema.parse({})]])
 const histories=new Map<string,Array<{id:string;version:number;createdAt:string;config:ReturnType<typeof columnAutomationSchema.parse>}>>([[a,[]],[b,[]]])
 const card={id:'card',title:'My task',description:'Task description',columnId:a,parentCardId:null,labels:[],priority:'none',version:1,position:0,assigneeUserIds:[],acceptanceCriteria:[],archivedAt:null,createdAt:now,updatedAt:now}
 const writes:Array<{columnId:string;config:ReturnType<typeof columnAutomationSchema.parse>}>=[]
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method(),id=path.split('/columns/')[1]?.split('/')[0]
  if(path.endsWith('/get-session'))return route.fulfill({json:{user:{id:'owner',name:'Owner',email:'owner@example.test'}}})
  if(path.endsWith('/organizations'))return route.fulfill({json:[{id:org,name:'Organization',role:'owner'}]})
  if(path.endsWith('/projects'))return route.fulfill({json:[{id:project,name:'Automation project',currentRole:'maintainer'}]})
  if(path.endsWith('/boards'))return route.fulfill({json:[{id:board,name:'Delivery',version:1,rolesConfigured:true}]})
  if(path.endsWith('/boards/'+board))return route.fulfill({json:{board:{id:board,name:'Delivery',version:1,rolesConfigured:true},columns,cards:[card]}})
  if(path.endsWith('/repositories'))return route.fulfill({json:[]})
  if(path.endsWith('/policies'))return route.fulfill({json:[...histories.entries()].flatMap(([,items])=>items.map(item=>({id:item.id,enabled:item.config.enabled,provider:item.config.provider,model:item.config.model,automationConfig:item.config})))})
  if(path.endsWith('/automation-catalog'))return route.fulfill({json:{runners:[{id:runner,name:'Runner fixture',status:'online',lastSeenAt:now,repositories:[],capabilities:{version:1,models:[{provider:'codex',model:'codex-fixture',label:'Codex fixture',efforts:['low','high'],fastMode:true},{provider:'claude-agent',model:'claude-fixture',label:'Claude fixture',efforts:['low','high'],fastMode:false}],maestro:true,subagents:true,preCommands:true,issues:[]}}]}})
  if(id&&path.endsWith('/automation')&&method==='GET')return route.fulfill({json:{column:{...columns.find(c=>c.id===id),boardId:board,projectId:project},projectName:'Automation project',boardName:'Delivery',boardVersion:1,rolesConfigured:true,policyId:columns.find(c=>c.id===id)?.executionPolicyId,version:histories.get(id)?.length??0,config:configs.get(id),limits:{}}})
  if(id&&path.endsWith('/automation')&&method==='PUT'){
   const body=route.request().postDataJSON()
   expect(body.expectedPolicyId).toBe(columns.find(c=>c.id===id)?.executionPolicyId)
   const config=columnAutomationSchema.parse(body.config),history=histories.get(id)!,policyId=crypto.randomUUID()
   writes.push({columnId:id,config});configs.set(id,config);history.unshift({id:policyId,version:history.length+1,createdAt:now,config});columns.find(c=>c.id===id)!.executionPolicyId=policyId
   return route.fulfill({json:{policyId,version:history.length,config}})
  }
  if(id&&path.endsWith('/preview')){
   const body=route.request().postDataJSON()
   return route.fulfill({json:{prompt:renderAutomationPrompt(body.promptTemplate,card,columns.find(c=>c.id===id)!.name)}})
  }
  if(id&&path.endsWith('/history'))return route.fulfill({json:histories.get(id)})
  if(path.endsWith('/events'))return route.fulfill({contentType:'text/event-stream',body:': ready\n\n'})
  return route.fulfill({json:[]})
 })
 await page.goto('/')
 await expect(page.getByRole('button',{name:L('Configure automation')+' Backlog',exact:true})).toHaveCount(0)
 await page.getByRole('button',{name:L('Configure automation')+' Build',exact:true}).click()
 let dialog=page.getByRole('dialog')
 await expect(dialog.getByText('Automation project',{exact:true})).toBeVisible()
 await dialog.getByRole('combobox',{name:L('Model'),exact:true}).click()
 await page.getByRole('option',{name:'Codex fixture',exact:true}).click()
 await dialog.getByRole('combobox',{name:L('Reasoning effort'),exact:true}).click()
 await page.getByRole('option',{name:L('high'),exact:true}).click()
 await dialog.getByRole('checkbox',{name:L('Fast mode'),exact:true}).check()
 await dialog.getByRole('checkbox',{name:L('Agent enabled'),exact:true}).check()
 await dialog.getByRole('combobox',{name:L('Execution mode'),exact:true}).click()
 await page.getByRole('option',{name:'Maestro',exact:true}).click()
 await expect(dialog.getByRole('checkbox',{name:L('Allow Maestrly subagents'),exact:true})).toBeChecked()
 await dialog.getByRole('textbox',{name:L('Initialization prompt'),exact:true}).fill('Build {task_title}: {task_body}')
 await dialog.getByRole('button',{name:L('Preview prompt'),exact:true}).click()
 const preview=page.getByRole('dialog',{name:L('Rendered prompt'),exact:true})
 await expect(preview).toContainText('Build My task: Task description')
 await preview.getByRole('button',{name:L('Close dialog'),exact:true}).click()
 await dialog.getByRole('button',{name:L('Save automation'),exact:true}).click()
 await expect(dialog.getByRole('status')).toHaveText(L('Automation saved for this column.'))
 expect(writes[0]?.config).toMatchObject({effort:'high',fastMode:true,mode:'maestro',subagentsEnabled:true,autoRun:false})
 await dialog.getByRole('button',{name:L('Configuration history'),exact:true}).click()
 const history=page.getByRole('dialog',{name:L('Configuration history'),exact:true})
 await expect(history.locator('.history-list button')).toHaveCount(1)
 await history.getByRole('button',{name:L('Close dialog'),exact:true}).click()
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000})
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme)
   await page.screenshot({path:info.outputPath('automation-'+width+'-'+theme+'.png'),animations:'disabled'})
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 }
 await dialog.getByRole('button',{name:L('Close'),exact:true}).click()
 await page.getByRole('button',{name:L('Configure automation')+' Review',exact:true}).click()
 dialog=page.getByRole('dialog')
 await expect(dialog.getByRole('checkbox',{name:L('Agent enabled'),exact:true})).not.toBeChecked()
 await expect(dialog.getByRole('textbox',{name:L('Initialization prompt'),exact:true})).toHaveValue('')
 await dialog.getByRole('combobox',{name:L('Provider'),exact:true}).click()
 await page.getByRole('option',{name:'Claude Agent SDK',exact:true}).click()
 await dialog.getByRole('combobox',{name:L('Model'),exact:true}).click()
 await page.getByRole('option',{name:'Claude fixture',exact:true}).click()
 await expect(dialog.getByRole('checkbox',{name:L('Fast mode'),exact:true})).toHaveCount(0)
 await dialog.getByRole('checkbox',{name:L('Agent enabled'),exact:true}).check()
 await dialog.getByRole('checkbox',{name:L('Run automatically on entry'),exact:true}).check()
 await dialog.getByRole('button',{name:L('Save automation'),exact:true}).click()
 await expect(dialog.getByRole('status')).toHaveText(L('Automation saved for this column.'))
 expect(writes[1]?.config).toMatchObject({provider:'claude-agent',model:'claude-fixture',fastMode:false,mode:'standard',autoRun:true,promptTemplate:''})
})
