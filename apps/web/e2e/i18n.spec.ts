import { expect, test } from '@playwright/test'
import { translate, type Locale } from '../src/i18n/index.js'

test('switches immediately and persists across reload, invitation and authorization', async ({ page }, info) => {
  const initial = info.project.name as Locale
  const other = initial === 'en' ? 'pt-BR' : 'en'
  const L = (key: string) => translate(key, other)
  let signedIn=false
  await page.route('**/api/auth/get-session', route => route.fulfill({json:signedIn?{user:{id:'locale-user',name:'Locale user',email:'someone@example.test'}}:null}))
  await page.route('**/api/auth/sign-in/email', route => route.fulfill({status:401,json:{message:'Invalid email or password'}}))
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang',initial)
  await page.getByRole('combobox').click()
  await page.getByRole('option', {name: other === 'en' ? 'English' : 'Português (Brasil)', exact:true}).click()
  await expect(page.getByRole('heading',{name:L('Sign in'),exact:true})).toBeVisible()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang',other)
  await page.getByLabel(L('Email'),{exact:true}).fill('someone@example.test')
  await page.getByLabel(L('Password'),{exact:true}).fill('incorrect-password')
  await page.getByRole('button',{name:L('Sign in'),exact:true}).click()
  await expect(page.getByRole('alert')).toHaveText(L('Invalid email or password'))
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900})
    await page.screenshot({path:'/tmp/maestrly-i18n-'+other+'-'+width+'.png'})
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.goto('/invite')
  await expect(page.getByRole('heading',{name:L('Join this instance')})).toBeVisible()
  await expect(page.getByRole('combobox')).toHaveText(other === 'en' ? 'English' : 'Português (Brasil)')
  await page.goto('/device')
  await expect(page.getByRole('heading',{name:L('Sign in'),exact:true})).toBeVisible()
  await expect(page.getByRole('combobox')).toHaveText(other === 'en' ? 'English' : 'Português (Brasil)')
  signedIn=true
  await page.reload()
  await expect(page.getByRole('heading',{name:L('Connect a client')})).toBeVisible()
  await expect(page.getByRole('combobox')).toHaveText(other === 'en' ? 'English' : 'Português (Brasil)')
})
