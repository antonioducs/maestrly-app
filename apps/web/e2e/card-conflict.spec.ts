import { expect,test } from '@playwright/test'
import { translate,type Locale } from '../src/i18n/index.js'
test('description autosave retains drafts on conflict and never overwrites silently',async({page},info)=>{
  const L=(key:string)=>translate(key,info.project.name as Locale)
  const now='2026-09-07T12:00:00Z'
  const project={id:'project',name:'Draft fixture',currentRole:'maintainer'},board={id:'board',name:'Board fixture',version:1}
  let card={id:'card',organizationId:'org',projectId:'project',boardId:'board',columnId:'column',parentCardId:null,title:'Conflict card',description:'Original',labels:[],assigneeUserIds:[],acceptanceCriteria:[],priority:'none',position:0,version:1,archivedAt:null,createdAt:now,updatedAt:now}
  let updates=0
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname
    if(path.endsWith('/get-session'))return route.fulfill({json:{user:{id:'owner',name:'Owner',email:'owner@example.test'}}})
    if(path.endsWith('/organizations'))return route.fulfill({json:[{id:'org',name:'Fixture',role:'owner'}]})
    if(path.endsWith('/projects'))return route.fulfill({json:[project]})
    if(path.endsWith('/boards'))return route.fulfill({json:[board]})
    if(path.endsWith('/boards/board'))return route.fulfill({json:{board,columns:[{id:'column',name:'Backlog',executionPolicyId:null}],cards:[card]}})
    if(path.endsWith('/members'))return route.fulfill({json:[]})
    if(path.endsWith('/cards/card')&&route.request().method()==='PATCH'){
      updates++
      const body=route.request().postDataJSON()
      if(updates===1){card={...card,description:'Other author',version:2};return route.fulfill({status:409,json:{message:'The card changed after it was loaded.',details:{current:card}}})}
      expect(body.expectedVersion).toBe(2)
      card={...card,description:body.description,version:3};return route.fulfill({json:card})
    }
    if(path.endsWith('/cards/card'))return route.fulfill({json:{card,userId:'owner',canModerate:true,columnName:'Backlog',parent:null,subtasks:[],comments:[],attachments:[],executions:[],attempts:[],requests:[],artifacts:[]}})
    if(path.endsWith('/events'))return route.fulfill({contentType:'text/event-stream',body:': ready\n\n'})
    return route.fulfill({json:[]})
  })
  await page.goto('/')
  await page.getByRole('button',{name:'Conflict card',exact:true}).click()
  const dialog=page.getByRole('dialog')
  await dialog.getByRole('button',{name:L('Write'),exact:true}).first().click()
  await dialog.getByRole('textbox',{name:L('Description'),exact:true}).fill('My **draft**')
  await expect(dialog.getByRole('status')).toHaveText(L('Another edit was saved. Your draft is preserved.'))
  await expect(dialog.getByRole('textbox',{name:L('Description'),exact:true})).toHaveValue('My **draft**')
  await dialog.getByRole('tab',{name:L('Events'),exact:true}).click()
  await dialog.getByRole('tab',{name:L('General'),exact:true}).click()
  await expect(dialog.getByRole('textbox',{name:L('Description'),exact:true})).toHaveValue('My **draft**')
  expect(updates).toBe(1)
  await dialog.getByRole('button',{name:L('Save my draft over this version'),exact:true}).click()
  await expect(dialog.getByRole('status')).toHaveText(L('All changes saved'))
  expect(updates).toBe(2)
})
