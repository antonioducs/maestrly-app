import { expect, test } from '@playwright/test'

test('opens the linked project and board instead of the remembered or first board', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('maestrly-board:org:linked', 'first-board'))
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/get-session')) return route.fulfill({ json: { user: { id: 'member', name: 'Member' } } })
    if (path.endsWith('/organizations')) return route.fulfill({ json: [{ id: 'org', name: 'Organization', role: 'owner' }] })
    if (path.endsWith('/projects')) return route.fulfill({ json: [{ id: 'first', name: 'Other project' }, { id: 'linked', name: 'Linked project' }] })
    if (path.endsWith('/boards')) return route.fulfill({ json: [{ id: 'first-board', name: 'Other board', archivedAt: null }, { id: 'linked-board', name: 'Linked board', archivedAt: null }] })
    if (path.endsWith('/boards/linked-board')) return route.fulfill({ json: { board: { id: 'linked-board', projectId: 'linked', name: 'Linked board', version: 1 }, columns: [{ id: 'col', name: 'Linked column', position: 0, role: 'normal' }], cards: [], archivedCards: [] } })
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' })
    return route.fulfill({ json: [] })
  })
  await page.goto('/?organization=org&project=linked&board=linked-board')
  await expect(page.locator('#project-select')).toContainText('Linked project')
  await expect(page.getByText('Linked column', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('Linked column', { exact: true })).toBeVisible()
})
