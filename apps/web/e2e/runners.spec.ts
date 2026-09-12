import { expect, test } from '@playwright/test'
import { translate, type Locale } from '../src/i18n/index.js'

for (const role of ['owner', 'viewer']) {
  test(`runner removal respects ${role} permissions, cancellation and failures`, async ({ page }, info) => {
    const L = (key: string) => translate(key, info.project.name as Locale)
    let attempts = 0
    let revoked = false
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/get-session')) return route.fulfill({ json: { user: { id: 'owner', name: 'Owner' } } })
      if (path.endsWith('/organizations')) return route.fulfill({ json: [{ id: 'org', name: 'Workspace', role }] })
      if (path.endsWith('/projects')) return route.fulfill({ json: [{ id: 'project', name: 'Active project', currentRole: role === 'owner' ? 'maintainer' : role }] })
      if (path.endsWith('/revoke')) {
        expect(route.request().method()).toBe('POST')
        expect(path).toBe('/api/v1/organizations/org/projects/project/runners/runner/revoke')
        attempts++
        if (attempts === 1) return route.fulfill({ status: 500, json: { message: 'Please try again' } })
        revoked = true
        return route.fulfill({ status: 204 })
      }
      if (path.endsWith('/runners')) return route.fulfill({ json: [
        { id: 'runner', name: 'Mac mini — equipe', status: revoked ? 'revoked' : 'offline', capabilities: [], lastSeenAt: null },
        { id: 'old', name: 'Previously revoked', status: 'revoked', capabilities: [], lastSeenAt: null },
      ] })
      if (path.endsWith('/meta')) return route.fulfill({ json: { canonicalUrl: 'http://localhost' } })
      return route.fulfill({ json: [] })
    })
    await page.goto('/')
    await page.getByRole('navigation').getByRole('button', { name: L('Runners'), exact: true }).click()
    await expect(page.getByText('Mac mini — equipe', { exact: true })).toBeVisible()
    await expect(page.getByText('Previously revoked')).toHaveCount(0)
    const trigger = page.getByRole('button', { name: L('Remove runner'), exact: true })
    if (role === 'viewer') { await expect(trigger).toHaveCount(0); return }
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('runners-mobile.png') })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: L('Remove runner'), exact: true })
    await expect(dialog).toContainText('Mac mini — equipe')
    await expect(dialog).toContainText(L('This revokes the runner’s access to all its projects and requests cancellation of its running work.'))
    await dialog.getByRole('button', { name: L('Cancel'), exact: true }).click()
    expect(attempts).toBe(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    const submit = dialog.getByRole('button', { name: L('Remove runner'), exact: true })
    await submit.click()
    await expect(dialog.getByRole('alert')).toContainText(L('Please try again'))
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText(L('No runner is enrolled'), { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.reload()
    await page.getByRole('navigation').getByRole('button', { name: L('Runners'), exact: true }).click()
    await expect(page.getByText('Mac mini — equipe', { exact: true })).toHaveCount(0)
    expect(attempts).toBe(2)
  })
}

test('real API: removing a runner revokes credentials and stays removed after reload', async ({ page }, info) => {
  test.skip(!process.env.MAESTRLY_LIVE_E2E, 'Requires the isolated API fixture.')
  const L = (key: string) => translate(key, info.project.name as Locale)
  await page.goto('/')
  await page.getByRole('textbox', { name: L('Email'), exact: true }).fill(process.env.MAESTRLY_E2E_EMAIL!)
  await page.getByLabel(L('Password'), { exact: true }).fill(process.env.MAESTRLY_E2E_PASSWORD!)
  await page.getByRole('button', { name: L('Sign in'), exact: true }).click()
  await expect(page.getByRole('navigation', { name: L('Workspace') })).toBeVisible()
  const headers = { 'x-maestrly-protocol-version': '1.0', 'idempotency-key': crypto.randomUUID() }
  const org = (await (await page.request.get('/api/v1/organizations', { headers })).json())[0].id
  const name = 'Runner removal ' + info.project.name + ' ' + Date.now()
  const created = await (await page.request.post(`/api/v1/organizations/${org}/projects`, { headers, data: { name } })).json()
  const projectId = created.project.id
  const enrollment = await (await page.request.post('/api/v1/runner-enrollments', { headers: { ...headers, 'idempotency-key': crypto.randomUUID() }, data: { organizationId: org, projectIds: [projectId] } })).json()
  const enrolled = await page.request.post('/api/v1/runners/enroll', { headers, data: { organizationId: org, token: enrollment.token, name: 'Disposable runner', protocolVersion: '1.0', capabilities: [] } })
  expect(enrolled.status()).toBe(201)
  const runner = await enrolled.json()
  const runnerHeaders = { 'x-maestrly-protocol-version': '1.0', 'x-maestrly-organization-id': org, 'x-maestrly-runner-id': runner.runnerId, authorization: 'Runner ' + runner.credential }
  expect((await page.request.post('/api/v1/runners/presence', { headers: runnerHeaders, data: { online: false } })).status()).toBe(200)
  await page.reload()
  await page.getByRole('combobox', { name: L('Project'), exact: true }).click()
  await page.getByRole('option', { name, exact: true }).click()
  await page.getByRole('navigation').getByRole('button', { name: L('Runners'), exact: true }).click()
  await expect(page.getByText('Disposable runner', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: L('Remove runner'), exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: L('Remove runner'), exact: true }).click()
  await expect(page.getByText(L('No runner is enrolled'), { exact: true })).toBeVisible()
  expect((await page.request.post('/api/v1/runners/presence', { headers: runnerHeaders, data: { online: true } })).status()).toBe(401)
  await page.reload()
  await page.getByRole('navigation').getByRole('button', { name: L('Runners'), exact: true }).click()
  await expect(page.getByText('Disposable runner', { exact: true })).toHaveCount(0)
})
