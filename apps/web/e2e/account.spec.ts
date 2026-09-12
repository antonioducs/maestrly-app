import {expect,test} from '@playwright/test'
import {translate,type Locale} from '../src/i18n/index.js'
test('changes an isolated account password, validates confirmation and rejects the old password',async({page,request},info)=>{
 test.skip(!process.env.MAESTRLY_LIVE_E2E,'Requires isolated test installation.')
 const L=(key:string)=>translate(key,info.project.name as Locale),base=process.env.MAESTRLY_WEB_URL!
 const original='Initial-test-password-123',updated='Changed-test-password-456',email='password-'+crypto.randomUUID()+'@example.test'
 const signed=await request.post(base+'/api/auth/sign-in/email',{data:{email:process.env.MAESTRLY_E2E_EMAIL,password:process.env.MAESTRLY_E2E_PASSWORD}});expect(signed.ok()).toBe(true)
 const headers={'x-maestrly-protocol-version':'1.0','idempotency-key':crypto.randomUUID()}
 const orgs=await (await request.get(base+'/api/v1/organizations',{headers})).json()
 const invite=await request.post(base+'/api/v1/organizations/'+orgs[0].id+'/invitations',{headers,data:{email,role:'member'}});expect(invite.ok()).toBe(true)
 const url=new URL((await invite.json()).url)
 const registered=await request.post(base+'/api/v1/invitations/register',{headers,data:{organizationId:orgs[0].id,email,token:url.searchParams.get('token'),name:'Password fixture',password:original}});expect(registered.ok()).toBe(true)
 await page.goto('/')
 await page.getByLabel(L('Email'),{exact:true}).fill(email);await page.getByLabel(L('Password'),{exact:true}).fill(original)
 await page.getByRole('button',{name:L('Sign in'),exact:true}).click()
 const trigger=page.getByRole('button',{name:L('My account'),exact:true});await trigger.click()
 const dialog=page.getByRole('dialog'),submit=dialog.getByRole('button',{name:L('Change password'),exact:true})
 await submit.click();await expect(dialog.getByLabel(L('Current password'),{exact:true})).toBeFocused()
 await dialog.getByLabel(L('Current password'),{exact:true}).fill('Incorrect-current-password')
 await dialog.getByLabel(L('New password'),{exact:true}).fill(updated)
 await dialog.getByLabel(L('Confirm new password'),{exact:true}).fill(updated+'mismatch')
 await submit.click();await expect(dialog.getByRole('alert')).toHaveText(L('The new passwords do not match.'))
 await dialog.getByLabel(L('Confirm new password'),{exact:true}).fill(updated)
 await submit.click();await expect(dialog.getByRole('alert')).toHaveText(L('Invalid password'))
 await dialog.getByLabel(L('Current password'),{exact:true}).fill(original)
 for(const width of [1440,390]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}
 await submit.click();await expect(dialog).toHaveCount(0);await expect(page.getByRole('status')).toHaveText(L('Password changed successfully.'))
 await trigger.click();await expect(dialog.getByLabel(L('Current password'),{exact:true})).toHaveValue('');await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0)
 const oldLogin=await request.post(base+'/api/auth/sign-in/email',{data:{email,password:original}});expect(oldLogin.status()).toBe(401)
 const newLogin=await request.post(base+'/api/auth/sign-in/email',{data:{email,password:updated}});expect(newLogin.status()).toBe(200)
})
