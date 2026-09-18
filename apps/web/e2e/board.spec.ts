import { translate, type Locale } from '../src/i18n/index.js'
import { expect, test } from '@playwright/test'

const now = '2026-09-07T01:00:00.000Z'
const project = { id: 'project', organizationId: 'org', name: 'Launch control', description: '', archivedAt: null, createdAt: now, updatedAt: now }
const board = { id: 'board', organizationId: 'org', projectId: 'project', name: 'Delivery board', archivedAt: null, createdAt: now, updatedAt: now }
const columns = [
  { id: 'backlog', organizationId: 'org', projectId: 'project', boardId: 'board', name: 'Backlog', position: 0, executionPolicyId: null, createdAt: now, updatedAt: now },
  { id: 'review', organizationId: 'org', projectId: 'project', boardId: 'board', name: 'Review', position: 1, executionPolicyId: 'policy', createdAt: now, updatedAt: now },
]
const card = { id: 'card', organizationId: 'org', projectId: 'project', boardId: 'board', columnId: 'backlog', parentCardId: null, title: 'Verify release evidence', description: '', acceptanceCriteria: [], priority: 'high', labels: [], assigneeUserIds: [], position: 0, version: 1, archivedAt: null, createdAt: now, updatedAt: now }

test('creates and moves work with a keyboard-accessible alternative', async ({ page }, testInfo) => {
  const L = (key: string) => translate(key, testInfo.project.name as Locale)
  let moveBody: Record<string, unknown> | undefined
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/get-session')) return route.fulfill({ json: { user: { id: 'owner', name: 'Ada Lovelace', email: 'ada@example.test' } } })
    if (url.pathname === '/api/v1/organizations') return route.fulfill({ json: [{ id: 'org', name: 'Acme', role: 'owner' }] })
    if (url.pathname.endsWith('/repositories') || url.pathname.endsWith('/policies')) return route.fulfill({json:[]})
    if (url.pathname.endsWith('/projects')) return route.fulfill({ json: [project] })
    if (url.pathname.endsWith('/boards')) return route.fulfill({ json: [board] })
    if (url.pathname.endsWith('/boards/board')) return route.fulfill({ json: { board, columns, cards: [moveBody ? { ...card, columnId: 'review', version: 2 } : card] } })
    if (url.pathname.endsWith('/cards/card')) return route.fulfill({ json: { card, comments: [], attachments: [], executions: [], artifacts: [] } })
    if (url.pathname.endsWith('/move')) { moveBody = route.request().postDataJSON(); return route.fulfill({ json: { card: { ...card, columnId: 'review', version: 2 }, jobId: 'job' } }) }
    if (url.pathname.endsWith('/executions')) return route.fulfill({ json: [
      { id:'j1', cardId:'card', cardTitle:'Verify release evidence', jobState:'active', runState:'running', approvalId:null, approvalStatus:null, informationRequestId:null, informationQuestion:null, createdAt: now },
      { id:'j2', cardId:'card', cardTitle:'Verify release evidence', jobState:'waiting', runState:null, approvalId:'a', approvalStatus:'pending', informationRequestId:null, informationQuestion:null, createdAt: now },
    ]})
    if (url.pathname.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': ready\n\n' })
    return route.fulfill({ status: 204, body: '' })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: L('Board'), level:2 })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: L('{count} waiting for you').replace('{count}','1') })).toBeVisible()
  await expect(page.locator('.board-pulse')).toContainText(L('{count} running now').replace('{count}','1'))
  await page.screenshot({ path: 'test-results/platform-board.png', fullPage: true })
  const other = testInfo.project.name === 'en' ? 'pt-BR' : 'en'
  await page.getByRole('combobox', { name: L('Language') }).click()
  await page.getByRole('option', {name: other === 'en' ? 'English' : 'Português', exact:true}).click()
  await expect(page.getByRole('heading', { name: translate('Board', other), level:2, exact: true })).toBeVisible()
  await expect(page.getByRole('button', {name: 'Verify release evidence', exact:true})).toBeVisible()
  await page.getByRole('combobox', { name: translate('Language', other) }).click()
  await page.getByRole('option', {name: testInfo.project.name === 'en' ? 'English' : 'Português', exact:true}).click()
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900})
    await page.screenshot({path:'/tmp/maestrly-board-i18n-'+testInfo.project.name+'-'+width+'.png'})
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  if(await page.getByRole('button',{name:L('Open sidebar'),exact:true}).isVisible()) await page.getByRole('button',{name:L('Open sidebar'),exact:true}).click()
  await page.getByRole('combobox', {name:L('Project'),exact:true}).click()
  await page.getByRole('option', {name:'Launch control',exact:true}).click()
  await page.getByRole('button', {name:L('Automations'),exact:true}).click()
  await expect(page.getByRole('heading',{name:L('Column automations'),exact:true})).toBeVisible()
  await page.getByRole('navigation').getByRole('button', {name:L('Board'),exact:true}).click()
  await page.getByRole('textbox', {name:L('Search cards')}).fill('no matching card')
  await expect(page.locator('.work-card')).toHaveCount(0)
  await page.getByRole('textbox', {name:L('Search cards')}).fill('')
  await page.getByRole('button', {name:L('List'),exact:true}).click()
  await expect(page.locator('.board')).toHaveClass(/board-list/)
  await page.getByRole('button', {name:L('Board'),exact:true}).last().click()
  const select = page.getByRole('combobox', {name:L('Move') + ' Verify release evidence'})
  await select.focus()
  await select.click()
  await page.getByRole('option', {name:'Review',exact:true}).click()
  await expect.poll(() => moveBody?.targetColumnId).toBe('review')
  expect(moveBody).toMatchObject({ expectedVersion: 1, source: 'human', allowAutomationChain: false })
  await expect(page.locator('.board-column[data-cue="fired"]')).toHaveCount(1)
  await expect(page.locator('.board-column[data-automated="true"]')).toHaveCount(1)
  await expect(page.locator('.work-card[data-priority="high"]')).toHaveCount(1)
  await expect(page.locator('.work-card .execution-track')).toHaveCount(0)
})

test('viewer can inspect work but cannot mutate it', async ({ page }, testInfo) => {
  const L = (key: string) => translate(key, testInfo.project.name as Locale)
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/get-session')) return route.fulfill({ json: { user: { id: 'viewer', name: 'Grace Hopper', email: 'grace@example.test' } } })
    if (url.pathname === '/api/v1/organizations') return route.fulfill({ json: [{ id: 'org', name: 'Acme', role: 'member' }] })
    if (url.pathname.endsWith('/repositories') || url.pathname.endsWith('/policies')) return route.fulfill({json:[]})
    if (url.pathname.endsWith('/projects')) return route.fulfill({ json: [{ ...project, currentRole: 'viewer' }] })
    if (url.pathname.endsWith('/boards')) return route.fulfill({ json: [board] })
    if (url.pathname.endsWith('/boards/board')) return route.fulfill({ json: { board, columns, cards: [card] } })
    if (url.pathname.endsWith('/cards/card')) return route.fulfill({ json: { card, comments: [], attachments: [], executions: [], artifacts: [] } })
    if (url.pathname.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': ready\n\n' })
    return route.fulfill({ status: 403, json: { message: L('Forbidden') } })
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: L('Add card') })).toHaveCount(0)
  await expect(page.getByRole('combobox', {name:L('Move') + ' Verify release evidence'})).toBeDisabled()
  await page.getByRole('button', { name: 'Verify release evidence', exact:true }).click()
  await expect(page.getByRole('button', { name: L('Save changes') })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Verify release evidence' })).toBeVisible()
})

test('respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/get-session')) return route.fulfill({ json: { user: { id: 'owner', name: 'Ada Lovelace', email: 'ada@example.test' } } })
    if (url.pathname === '/api/v1/organizations') return route.fulfill({ json: [{ id: 'org', name: 'Acme', role: 'owner' }] })
    if (url.pathname.endsWith('/repositories') || url.pathname.endsWith('/policies') || url.pathname.endsWith('/executions')) return route.fulfill({ json: [] })
    if (url.pathname.endsWith('/projects')) return route.fulfill({ json: [project] })
    if (url.pathname.endsWith('/boards')) return route.fulfill({ json: [board] })
    if (url.pathname.endsWith('/boards/board')) return route.fulfill({ json: { board, columns, cards: [card] } })
    if (url.pathname.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': ready\n\n' })
    return route.fulfill({ status: 204, body: '' })
  })
  await page.goto('/')
  const column = page.locator('.board-column').first()
  await expect(column).toBeVisible()
  expect(await column.evaluate((el) => getComputedStyle(el).animationDuration)).toBe('0s')
  expect(await page.locator('.work-card').first().evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s/)
})

test('live snapshots refresh an open card while preserving metadata drafts', async ({ page }, info) => {
  const L = (key: string) => translate(key, info.project.name as Locale)
  let current: Omit<typeof card, 'archivedAt'> & { archivedAt: string | null } = { ...card }
  let comments: unknown[] = []
  let events: unknown[] = []
  let history: unknown[] = []
  let detailReads = 0
  let deleted = false
  await page.addInitScript(() => {
    class Stream {
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null
      constructor() { Reflect.set(window, 'refreshBoard', () => this.onmessage?.({ data: '{"type":"card.updated"}', lastEventId: '1' })) }
      addEventListener() {}
      close() {}
    }
    Reflect.set(window, 'EventSource', Stream)
  })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/get-session')) return route.fulfill({ json: { user: { id: 'owner', name: 'Ada', email: 'ada@example.test' } } })
    if (path === '/api/v1/organizations') return route.fulfill({ json: [{ id: 'org', name: 'Acme', role: 'owner' }] })
    if (path.endsWith('/projects')) return route.fulfill({ json: [project] })
    if (path.endsWith('/boards')) return route.fulfill({ json: [board, { ...board, id: 'other-board', name: 'Other board' }] })
    if (path.endsWith('/boards/other-board')) return route.fulfill({ json: { board: { ...board, id: 'other-board', name: 'Other board' }, columns: [], cards: [] } })
    if (path.endsWith('/boards/board')) return route.fulfill({ json: { board, columns, cards: deleted || current.archivedAt ? [] : [current], archivedCards: current.archivedAt ? [current] : [] } })
    if (path.endsWith('/cards/card')) {
      if (route.request().method() === 'PATCH') {
        const { expectedVersion, ...patch } = route.request().postDataJSON()
        expect(expectedVersion).toBe(current.version)
        current = { ...current, ...patch, version: current.version + 1 }
        return route.fulfill({ json: current })
      }
      detailReads++
      return route.fulfill({ json: { card: current, comments, attachments: [], executions: [], artifacts: [] } })
    }
    if (path.endsWith('/events')) return route.fulfill({ json: { items: events, nextCursor: null } })
    if (path.endsWith('/history')) return route.fulfill({ json: history })
    return route.fulfill({ json: [] })
  })
  const refresh = () => page.evaluate(() => Reflect.get(window, 'refreshBoard')())
  await page.goto('/')
  await page.getByRole('button', { name: card.title, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('[contenteditable=true]').first()).toBeVisible()
  await dialog.getByRole('textbox', { name: L('Title'), exact: true }).fill('My unsaved title')
  await dialog.getByRole('tab', { name: new RegExp('^' + L('Activity')) }).click()
  await dialog.getByRole('button', { name: L('Write'), exact: true }).last().click()
  await dialog.getByRole('textbox', { name: L('Comment'), exact: true }).fill('My unsent comment')
  const before = detailReads
  comments = [{ id: 'comment', body: 'Remote comment', authorType: 'human', authorId: 'owner', createdAt: now, version: 1 }]
  await refresh()
  await expect(dialog.locator('.comment-entry')).toContainText('Remote comment')
  expect(detailReads).toBeGreaterThan(before)
  await expect(dialog.getByRole('textbox', { name: L('Comment'), exact: true })).toHaveValue('My unsent comment')
  await expect(dialog.locator('.timeline-entry')).toHaveCount(0)
  events = [{ id: 'event', type: 'card.updated', actor: { type: 'human' }, data: {}, createdAt: now, reason: 'Remote activity' }]
  await refresh()
  await expect(dialog.locator('.timeline-entry')).toContainText('Remote activity')
  await dialog.getByRole('tab', { name: new RegExp('^' + L('History')) }).click()
  await expect(dialog.locator('.history-list button')).toHaveCount(0)
  history = [{ id: 'version', body: 'Remote description', version: 1, actor: {}, createdAt: now }]
  await refresh()
  await expect(dialog.locator('.history-list button')).toHaveCount(1)
  current = { ...current, title: 'Remote title', version: 2, columnId: 'review' }
  await refresh()
  await expect(dialog.getByRole('heading', { name: 'Remote title', exact: true })).toBeVisible()
  await dialog.getByRole('tab', { name: L('Details'), exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: L('Title'), exact: true })).toHaveValue('My unsaved title')
  await dialog.getByRole('button', { name: L('Save changes'), exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(L('The card changed after it was loaded.'))
  // A navigation update can replace the board while its modal is still open.
  await page.locator('.board-tabs').getByRole('button', { name: 'Other board', exact: true }).evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByText(L('No columns yet.'), { exact: true })).toBeVisible()
  await page.locator('.board-tabs').getByRole('button', { name: board.name, exact: true }).click()
  await expect(page.getByRole('button', { name: current.title, exact: true })).toBeVisible()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: current.title, exact: true }).click()
  await expect(dialog.getByRole('tab', { name: L('Details'), exact: true })).toBeVisible()
  current = { ...current, archivedAt: now, version: 3 }
  await refresh()
  await expect(dialog.getByRole('button', { name: L('Restore'), exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: L('Save changes'), exact: true })).toHaveCount(0)
  current = { ...current, archivedAt: null, version: 4 }
  deleted = true
  await refresh()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.work-card')).toHaveCount(0)

})
