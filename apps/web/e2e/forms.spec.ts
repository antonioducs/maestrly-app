import { translate, type Locale } from '../src/i18n/index.js'
import { expect, test } from '@playwright/test'

for (const kind of ['project', 'answer'] as const) {
  test(kind + ' form validates, cancels and preserves input after failure', async ({ page }, testInfo) => {
  const L = (key: string) => translate(key, testInfo.project.name as Locale)
    let attempts = 0
    let payload: Record<string, unknown> = {}
    let created = false
    const project = { id: 'p', name: 'Website launch', currentRole: 'maintainer' }
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/get-session')) return route.fulfill({ json: { user: { name: 'Owner', email: 'owner@example.test' } } })
      if (path.endsWith('/organizations')) return route.fulfill({ json: [{ id: 'org', name: 'Maestrly', role: 'owner' }] })
      if (route.request().method() === 'POST') {
        attempts++; payload = route.request().postDataJSON()
        if (attempts === 1) return route.fulfill({ status: 500, json: { message: 'Please try again' } })
        created = true
        return route.fulfill({ json: { project, boardId: 'b' } })
      }
      if (path.endsWith('/projects')) return route.fulfill({ json: kind === 'answer' || created ? [project] : [] })
      if (path.endsWith('/boards')) return route.fulfill({ json: [] })
      if (path.endsWith('/executions')) return route.fulfill({ json: [{ id: 'job', cardTitle: 'Review website', jobState: 'waiting', informationRequestId: 'req', informationQuestion: 'Which audience should we prioritize?\nPlease include any constraints.', createdAt: '2026-09-07' }] })
      return route.fulfill({ status: 200, body: '' })
    })
    page.on('dialog', () => { throw new Error('Unexpected browser prompt') })
    await page.goto('/')
    if (kind === 'answer') await page.getByRole('button', { name: L('Executions'), exact: true }).click()
    const trigger = page.getByRole('button', { name: kind === 'project' ? L('Create first project') : L('Answer agent'), exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog')
    const field = dialog.getByLabel(kind === 'project' ? L('Project name') : L('Your response'))
    await expect(field).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await dialog.getByRole('button', {name:L('Cancel'),exact:true}).click()
    await expect(dialog).toHaveCount(0)
    await trigger.click()
    const submit = dialog.getByRole('button', {name:kind === 'project' ? L('Create project') : L('Send response'),exact:true})
    await submit.click()
    expect(attempts).toBe(0)
    await field.fill('   ')
    await submit.click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    expect(attempts).toBe(0)
    await field.fill(kind === 'project' ? 'Website launch' : 'Prioritize existing customers.\nKeep the current scope.')
    if (kind === 'project') await dialog.getByLabel(L('Description (optional)')).fill('Launch scope')
    await submit.click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(field).not.toHaveValue('')
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900})
      await page.screenshot({path:'/tmp/maestrly-form-'+kind+'-'+width+'.png'})
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await submit.focus()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button',{name:L('Close dialog')})).toBeFocused()
    await submit.click()
    await expect(dialog).toHaveCount(0)
    expect(attempts).toBe(2)
    expect(payload).toMatchObject(kind === 'project' ? {name:'Website launch',description:'Launch scope'} : {response:'Prioritize existing customers.\nKeep the current scope.'})
    if (kind === 'project') await expect(page.getByRole('heading',{name:L('Board'),level:2,exact:true})).toBeVisible()
  })
}
