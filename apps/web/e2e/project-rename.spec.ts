import { expect, test } from '@playwright/test'
import { translate, type Locale } from '../src/i18n/index.js'

for (const viewer of [false, true]) {
  test(`project rename ${viewer ? 'is hidden for viewers' : 'saves and survives reload'}`, async ({ page }, testInfo) => {
    const L = (key: string) => translate(key, testInfo.project.name as Locale)
    let project = { id: 'p', organizationId: 'org', name: 'Original', currentRole: viewer ? 'viewer' : 'contributor' }
    let attempts = 0
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/get-session')) return route.fulfill({ json: { user: { name: 'Member', email: 'member@example.test' } } })
      if (path.endsWith('/organizations')) return route.fulfill({ json: [{ id: 'org', name: 'Organization', role: 'member' }] })
      if (path.endsWith('/projects/p') && route.request().method() === 'PATCH') {
        attempts++
        expect(route.request().postDataJSON()).toEqual({ name: 'Renamed project' })
        expect(route.request().headers()['idempotency-key']).toBeTruthy()
        if (attempts === 1) return route.fulfill({ status: 500, json: { message: 'Please try again' } })
        project = { ...project, name: 'Renamed project' }
        return route.fulfill({ json: project })
      }
      if (path.endsWith('/projects')) return route.fulfill({ json: [project] })
      if (path.endsWith('/boards')) return route.fulfill({ json: [] })
      return route.fulfill({ body: '' })
    })
    await page.goto('/')
    await expect(page.locator('#project-select')).toContainText('Original')
    const trigger = page.getByRole('button', { name: L('Rename project'), exact: true })
    if (viewer) { await expect(trigger).toHaveCount(0); return }
    await trigger.click()
    const dialog = page.getByRole('dialog')
    const field = dialog.getByLabel(L('Project name'))
    await expect(field).toHaveValue('Original')
    await dialog.getByRole('button', { name: L('Cancel'), exact: true }).click()
    expect(attempts).toBe(0)
    await trigger.click()
    await field.fill('   ')
    const save = dialog.getByRole('button', { name: L('Save changes'), exact: true })
    await save.click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    expect(attempts).toBe(0)
    await field.fill(' Renamed project ')
    await save.click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(field).toHaveValue(' Renamed project ')
    await save.click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('#project-select')).toContainText('Renamed project')
    await page.reload()
    await expect(page.locator('#project-select')).toContainText('Renamed project')
  })
}
