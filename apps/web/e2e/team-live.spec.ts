import {expect,test,type Page} from '@playwright/test'
import {translate,type Locale} from '../src/i18n/index.js'
test('real team: invitation registration, roles, revocation, renewal and existing-account acceptance',async({page,browser},info)=>{
 test.skip(!process.env.MAESTRLY_LIVE_E2E,'Requires the isolated fixture database.')
 test.setTimeout(120000)
 const L=(key:string)=>translate(key,info.project.name as Locale),base=process.env.MAESTRLY_WEB_URL!
 const contexts:Awaited<ReturnType<typeof browser.newContext>>[]=[]
 const open=async()=>{const c=await browser.newContext({locale:info.project.name==='en'?'en-US':'pt-BR',baseURL:base});contexts.push(c);return c.newPage()}
 const login=async(p:Page,email:string,password:string)=>{await p.getByLabel(L('Email'),{exact:true}).fill(email);await p.getByLabel(L('Password'),{exact:true}).fill(password);await p.getByRole('button',{name:L('Sign in'),exact:true}).click()}
 const request=async(method:'get'|'post',url:string,data?:unknown)=>{const response=await page.request[method](url,{headers:{'x-maestrly-protocol-version':'1.0','idempotency-key':crypto.randomUUID()},data});expect(response.ok(),url+' '+await response.text()).toBe(true);return response.json()}
 try{
  await page.setViewportSize({width:1440,height:1000});await page.goto('/')
  await login(page,process.env.MAESTRLY_E2E_EMAIL!,process.env.MAESTRLY_E2E_PASSWORD!)
  await expect(page.getByRole('navigation',{name:L('Workspace')})).toBeVisible()
  const org=(await request('get','/api/v1/organizations'))[0].id,root='/api/v1/organizations/'+org
  const name='Team '+info.project.name+' '+Date.now(),created=await request('post',root+'/projects',{name}),project=created.project.id,teamPath=root+'/projects/'+project+'/team'
  await page.reload();await page.getByRole('combobox',{name:L('Project'),exact:true}).click();await page.getByRole('option',{name,exact:true}).click()
  await page.getByRole('button',{name:L('Team'),exact:true}).click()
  await expect(page.getByRole('heading',{name:L('Project team'),exact:true})).toBeVisible()
  expect(await page.getByRole('button',{name:L('Remove access'),exact:true}).count()).toBe(0)
  await page.getByRole('button',{name:L('Invite to project'),exact:true}).click()
  const email='team-'+crypto.randomUUID()+'@example.test',password='fixture-password-12345'
  let dialog=page.getByRole('dialog')
  await dialog.getByLabel(L('Email'),{exact:true}).fill(email)
  await dialog.getByRole('button',{name:L('Create invitation'),exact:true}).click()
  await expect(page.getByLabel(L('Invitation link'),{exact:true})).toBeVisible()
  const link=await page.getByLabel(L('Invitation link'),{exact:true}).inputValue()
  const invited=await open();await invited.goto(link)
  await invited.getByLabel(L('Your name'),{exact:true}).fill('Invited teammate')
  await invited.getByLabel(L('Create password'),{exact:true}).fill(password)
  await invited.getByRole('button',{name:L('Create local account'),exact:true}).click()
  await expect(invited.getByRole('navigation',{name:L('Workspace')})).toBeVisible()
  await invited.getByRole('button',{name:L('Team'),exact:true}).click()
  await expect(invited.getByRole('button',{name:L('Invite to project'),exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:L('Refresh'),exact:true}).click()
  const row=page.locator('.team-person').filter({has:page.getByText('Invited teammate',{exact:true})})
  await expect(row).toBeVisible()
  await row.getByRole('button',{name:L('Change role'),exact:true}).click()
  dialog=page.getByRole('dialog');await dialog.getByRole('combobox',{name:L('Project role'),exact:true}).click();await page.getByRole('option',{name:L('viewer'),exact:true}).click();await dialog.getByRole('button',{name:L('Save changes'),exact:true}).click()
  await expect(row.locator('.team-role')).toHaveText(L('viewer'))
  const state=await request('get',teamPath),member=state.members.find((m:{email:string})=>m.email===email)
  const forbidden=await invited.request.put(teamPath+'/members',{headers:{'x-maestrly-protocol-version':'1.0','idempotency-key':crypto.randomUUID()},data:{expectedVersion:state.version,userId:member.userId,role:'maintainer'}})
  expect(forbidden.status()).toBe(403)
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:info.outputPath('team-'+width+'-'+theme+'.png'),animations:'disabled'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}}
  await page.setViewportSize({width:1440,height:1000})
  await row.getByRole('button',{name:L('Remove access'),exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog).toContainText(L('This person will lose project access. Existing work and history will be preserved.'));await dialog.getByRole('button',{name:L('Remove access'),exact:true}).click()
  await expect(invited.getByRole('heading',{name:L('Project team'),exact:true})).toHaveCount(0,{timeout:10000})
  expect((await invited.request.get(teamPath,{headers:{'x-maestrly-protocol-version':'1.0'}})).status()).toBe(403)
  // The account remains usable and can accept another invitation through sign-in.
  await page.getByRole('button',{name:L('Invite to project'),exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel(L('Email'),{exact:true}).fill(email);await dialog.getByRole('button',{name:L('Create invitation'),exact:true}).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const secondLink=await page.getByLabel(L('Invitation link'),{exact:true}).inputValue()
  const pendingRow=page.locator('.team-person').filter({hasText:email}).filter({has:page.getByRole('button',{name:L('Revoke invitation'),exact:true})})
  await pendingRow.getByRole('button',{name:L('Revoke invitation'),exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:L('Revoke invitation'),exact:true}).click()
  const existing=await open();await existing.goto(secondLink);await expect(existing.getByRole('alert')).toContainText(L('Invitation is invalid, expired, or already used.'))
  const revoked=page.locator('.team-person').filter({hasText:email}).filter({has:page.getByRole('button',{name:L('Renew invitation'),exact:true})})
  await revoked.getByRole('button',{name:L('Renew invitation'),exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:L('Save changes'),exact:true}).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const thirdLink=await page.getByLabel(L('Invitation link'),{exact:true}).inputValue();expect(thirdLink).not.toBe(secondLink)
  await existing.goto(thirdLink);await existing.getByRole('button',{name:L('Already have an account? Sign in'),exact:true}).click();await login(existing,email,password)
  await existing.getByRole('button',{name:L('Accept invitation'),exact:true}).click();await expect(existing.getByRole('navigation',{name:L('Workspace')})).toBeVisible()
  await page.getByRole('button',{name:L('Refresh'),exact:true}).click();await expect(row).toBeVisible()
  await row.getByRole('button',{name:L('Remove access'),exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:L('Remove access'),exact:true}).click()
  await page.getByRole('button',{name:L('Add member'),exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('combobox',{name:L('Member'),exact:true}).click();await page.getByRole('option',{name:'Invited teammate · '+email,exact:true}).click();await dialog.getByRole('button',{name:L('Save changes'),exact:true}).click();await expect(row).toBeVisible()
 }finally{for(const c of contexts)await c.close().catch(()=>{})}
})
