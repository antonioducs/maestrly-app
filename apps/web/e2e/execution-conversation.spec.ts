import {expect,test} from '@playwright/test'
import {columnAutomationSchema} from '@maestrly/protocol'
import {translate,type Locale} from '../src/i18n/index.js'

test('shows the execution conversation and merges streamed message revisions',async({page},info)=>{
 const L=(key:string)=>translate(key,info.project.name as Locale),now=new Date().toISOString()
 const card={id:'card',organizationId:'org',projectId:'project',boardId:'board',columnId:'column',parentCardId:null,title:'Executor conversation',description:'Task',acceptanceCriteria:[],labels:[],priority:'none',assigneeUserIds:[],position:0,version:1,archivedAt:null,createdAt:now,updatedAt:now}
 const board={id:'board',name:'Delivery',rolesConfigured:true,version:1},columns=[{id:'column',name:'Build',role:'normal',executionPolicyId:null}]
 const offsets:number[]=[]
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname
  if(path.endsWith('/get-session'))return route.fulfill({json:{user:{id:'owner',name:'Owner',email:'owner@example.test'}}})
  if(path.endsWith('/organizations'))return route.fulfill({json:[{id:'org',name:'Organization',role:'owner'}]})
  if(path.endsWith('/projects'))return route.fulfill({json:[{id:'project',name:'Project',currentRole:'maintainer'}]})
  if(path.endsWith('/boards'))return route.fulfill({json:[board]})
  if(path.endsWith('/boards/board'))return route.fulfill({json:{board,columns,cards:[card]}})
  if(path.endsWith('/cards/card'))return route.fulfill({json:{card,userId:'owner',columnName:'Build',canModerate:true,subtasks:[],parent:null,comments:[],attachments:[],executions:[{jobId:'job',jobState:'succeeded',runState:'succeeded'}],artifacts:[],attempts:[{id:'run',attempt:1,state:'succeeded',startedAt:now,outcome:{summary:'Verified'}}],requests:[]}})
  if(path.endsWith('/automation'))return route.fulfill({json:{column:{id:'column',name:'Build',role:'normal'},policyId:null,cardVersion:1,config:columnAutomationSchema.parse({}),effective:columnAutomationSchema.parse({}),override:null,overrideVersion:0,blocked:false,active:false,renderedPrompt:'Task',runners:[]}})
  if(path.endsWith('/automation-catalog'))return route.fulfill({json:{runners:[]}})
  if(path.endsWith('/execution-events')){
   expect(url.searchParams.get('runId')).toBe('run')
   const offset=Number(url.searchParams.get('offset')??0);offsets.push(offset)
   return route.fulfill({json:offset===0?{more:true,items:[{type:'other',data:{}},{type:'maestrly.message',data:{id:'task',role:'user',text:'Implement the card',createdAt:1,tools:[]}},{type:'maestrly.message',data:{id:'agent',role:'assistant',text:'Working…',createdAt:2,tools:[]}}]}:offset===3?{more:false,items:[{type:'maestrly.message',data:{id:'agent',role:'assistant',text:'**Verified implementation.**\n<script>window.executorXss=true</script>',createdAt:2,tools:[{name:'write',state:'completed'}]}}]}:{more:false,items:[]}})
  }
  if(path.endsWith('/events'))return route.fulfill({contentType:'text/event-stream',body:': ready\n\n'})
  return route.fulfill({json:[]})
 })
 await page.goto('/')
 await page.getByRole('button',{name:'Executor conversation',exact:true}).click()
 const dialog=page.getByRole('dialog')
 await dialog.getByRole('tab',{name:L('Executions'),exact:true}).click()
 await dialog.getByText(L('Execution conversation'),{exact:true}).click()
 await expect(dialog.locator('.execution-message')).toHaveCount(2)
 await expect(dialog.locator('.execution-message').last()).toContainText('Verified implementation.')
 await expect(dialog.locator('.execution-tool')).toContainText('write')
 expect(offsets).toContain(3)
 expect(await page.evaluate(()=>Object.hasOwn(window,'executorXss'))).toBe(false)
 await page.screenshot({path:info.outputPath('execution-conversation.png')})
})
