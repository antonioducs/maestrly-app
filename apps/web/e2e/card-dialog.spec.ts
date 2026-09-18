import { expect, test } from '@playwright/test'
import { translate, type Locale } from '../src/i18n/index.js'

const now = '2026-09-17T10:32:00.000Z', earlier = '2026-09-16T18:40:00.000Z', first = '2026-09-12T09:00:00.000Z'
const columns = [
  { id: 'backlog', name: 'Backlog', role: 'backlog' },
  { id: 'refine', name: 'Technical refinement', role: 'normal' },
  { id: 'build', name: 'In development', role: 'normal' },
  { id: 'done', name: 'Done', role: 'done' },
].map((c, position) => ({ ...c, organizationId: 'org', projectId: 'project', boardId: 'board', position, executionPolicyId: null, createdAt: now, updatedAt: now }))
const base = { organizationId: 'org', projectId: 'project', boardId: 'board', parentCardId: null as string | null, labels: [] as string[], priority: 'none', assigneeUserIds: [] as string[], acceptanceCriteria: [] as string[], position: 0, version: 1, archivedAt: null, createdAt: first, updatedAt: now, description: '' }
const card = {
  ...base, id: 'a1f3c9d2-6b40-4e1a-9f7c-2d5e8b1c0a44', columnId: 'refine', title: 'Terms of Use acceptance and LGPD consent', version: 4, labels: ['lgpd', 'compliance', 'feature'], priority: 'high',
  assigneeUserIds: ['jc'], acceptanceCriteria: ['Users cannot use the app before accepting the current terms', 'The acceptance record stores user, version, timestamp, IP and user agent', 'A new terms version requires a new acceptance'],
  description: '## Context\n\nThe application does not record Terms of Use acceptance nor the personal-data consent required by LGPD. Every user must explicitly accept the terms and privacy policy before using the system, and the acceptance must be auditable.\n\n## Scope\n\n- Show the Terms of Use and Privacy Policy on sign-up and first access.\n- Require explicit opt-in (no pre-checked box).\n- Persist the acceptance: user, document version, timestamp, IP and user agent.',
}
const subtasks = [
  { ...base, id: 'c31a0000-0000-4000-8000-000000000001', parentCardId: card.id, columnId: 'done', title: 'Model the acceptance table' },
  { ...base, id: 'd9020000-0000-4000-8000-000000000002', parentCardId: card.id, columnId: 'build', title: 'Consent screen in onboarding' },
  { ...base, id: 'e7f40000-0000-4000-8000-000000000003', parentCardId: card.id, columnId: 'backlog', title: 'Document versioning' },
]
const members = [['jc', 'Jorge Cunha', 'maintainer'], ['mp', 'Marina Prado', 'contributor'], ['ra', 'Rafael Assis', 'contributor'], ['lb', 'Luana Barros', 'contributor'], ['tf', 'Thiago Ferreira', 'viewer'], ['cs', 'Camila Souza', 'contributor'], ['pm', 'Pedro Martins', 'contributor'], ['an', 'Ana Nogueira', 'maintainer'], ['gl', 'Gustavo Lima', 'contributor'], ['bs', 'Beatriz Santos', 'viewer'], ['fo', 'Felipe Oliveira', 'contributor'], ['dr', 'Daniela Rocha', 'contributor']].map(([id, name, role]) => ({ id, name, role }))

test('card dialog: two-pane layout, unified activity, searchable assignees and no layout shift', async ({ page }, info) => {
  const L = (key: string) => translate(key, info.project.name as Locale)
  let current = { ...card }
  const patches: Array<Record<string, unknown>> = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname, method = route.request().method()
    if (path.endsWith('/get-session')) return route.fulfill({ json: { user: { id: 'jc', name: 'Jorge Cunha', email: 'jorge@example.test' } } })
    if (path === '/api/v1/organizations') return route.fulfill({ json: [{ id: 'org', name: 'Guardião', role: 'owner' }] })
    if (path.endsWith('/projects')) return route.fulfill({ json: [{ id: 'project', name: 'Guardião Financeiro', currentRole: 'maintainer' }] })
    if (path.endsWith('/boards')) return route.fulfill({ json: [{ id: 'board', name: 'Main board', version: 1, rolesConfigured: true }] })
    if (path.endsWith('/boards/board')) return route.fulfill({ json: { board: { id: 'board', name: 'Main board', version: 1, rolesConfigured: true }, columns, cards: [current, ...subtasks] } })
    if (path.endsWith('/automation-catalog')) return route.fulfill({ json: { runners: [] } })
    if (path.endsWith('/members')) return route.fulfill({ json: members })
    if (path.endsWith('/cards/' + card.id)) {
      if (method === 'PATCH') { const { expectedVersion, ...patch } = route.request().postDataJSON(); expect(expectedVersion).toBe(current.version); patches.push(patch); current = { ...current, ...patch, version: current.version + 1 }; return route.fulfill({ json: current }) }
      return route.fulfill({ json: {
        card: current, userId: 'jc', columnName: 'Technical refinement', canModerate: true, parent: null, subtasks,
        comments: [
          { id: 'c1', body: 'Confirm with legal whether acceptance is per document version or only once.', authorType: 'human', authorId: 'jc', createdAt: earlier, version: 1 },
          { id: 'c2', body: 'Suggest storing the **hash** of the accepted document, not only the version.', authorType: 'human', authorId: 'mp', createdAt: '2026-09-16T16:05:00.000Z', version: 1 },
        ],
        attachments: [{ id: 'f1', filename: 'terms-of-use-v3.pdf', sizeBytes: 188416 }, { id: 'f2', filename: 'consent-flow.png', sizeBytes: 626688 }],
        executions: [{ jobId: 'j2', jobState: 'completed', runState: 'failed' }, { jobId: 'j1', jobState: 'completed', runState: 'succeeded' }],
        attempts: [
          { id: 'run-2', jobId: 'j2', attempt: 2, state: 'failed', startedAt: '2026-09-17T08:02:00.000Z', finishedAt: '2026-09-17T08:14:00.000Z', outcome: { failure: '**Blocked:** the workspace was empty — no repository linked to the column. Nothing was changed.' } },
          { id: 'run-1', jobId: 'j1', attempt: 1, state: 'succeeded', startedAt: '2026-09-16T19:10:00.000Z', finishedAt: '2026-09-16T19:22:00.000Z', outcome: { summary: 'Technical refinement delivered: 3 subtasks proposed.' } },
        ],
        requests: [], artifacts: [{ id: 'a1', name: 'conversation.json', kind: 'log', orphaned: false }],
      } })
    }
    const child = subtasks.find((s) => path.endsWith('/cards/' + s.id))
    if (child) return route.fulfill({ json: { card: child, userId: 'jc', columnName: columns.find((c) => c.id === child.columnId)!.name, canModerate: true, parent: current, subtasks: [], comments: [], attachments: [], executions: [], attempts: [], requests: [], artifacts: [] } })
    if (path.endsWith('/events') && path.includes('/cards/')) return route.fulfill({ json: { items: [
      { id: 'e1', type: 'run.failed', actor: { type: 'runner' }, actorName: 'MacBook', data: {}, createdAt: '2026-09-17T08:14:00.000Z' },
      { id: 'e2', type: 'card.transitioned', actor: { type: 'human' }, actorName: 'Jorge Cunha', data: { fromColumnId: 'backlog', toColumnId: 'refine' }, fromColumnName: 'Backlog', toColumnName: 'Technical refinement', createdAt: '2026-09-16T18:12:00.000Z' },
      { id: 'e3', type: 'card.created', actor: { type: 'human' }, actorName: 'Jorge Cunha', data: {}, createdAt: first },
    ], nextCursor: null } })
    if (path.endsWith('/history')) return route.fulfill({ json: [{ id: 'v4', body: current.description, version: 4, actor: {}, createdAt: now }, { id: 'v3', body: 'Old body', version: 3, actor: {}, createdAt: earlier }] })
    if (path.endsWith('/execution-events')) return route.fulfill({ json: { more: false, items: [] } })
    if (path.endsWith('/automation') && method === 'GET') return route.fulfill({ json: { column: { id: 'refine', name: 'Technical refinement', role: 'normal' }, policyId: null, cardVersion: current.version, config: {}, effective: {}, override: null, overrideVersion: 0, renderedPrompt: '', blocked: false, active: false, runners: [] } })
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' })
    return route.fulfill({ json: [] })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await page.getByRole('button', { name: card.title, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('textbox', { name: L('Title'), exact: true })).toHaveValue(card.title)
  await expect(dialog.locator('.cd-subtask')).toHaveCount(3)
  await expect(dialog.locator('.cd-attachment')).toHaveCount(2)
  await expect(dialog.getByRole('list', { name: L('Assignees'), exact: true })).toContainText('Jorge Cunha')

  // Sidebar/head positions must not move when the priority or the tab changes.
  const tops = () => dialog.evaluate((el) => [...el.querySelectorAll('.cd-head, .cd-tabs, .cd-side-block')].map((n) => Math.round(n.getBoundingClientRect().top)))
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
  const before = await tops()
  await dialog.getByRole('combobox', { name: L('Priority'), exact: true }).click()
  await page.getByRole('option', { name: L('urgent'), exact: true }).click()
  await dialog.getByRole('tab', { name: new RegExp('^' + L('Activity')) }).click()
  await expect(dialog.locator('.comment-entry')).toHaveCount(2)
  await expect(dialog.locator('.timeline-entry')).toHaveCount(3)
  await dialog.getByRole('radio', { name: L('Comments'), exact: true }).click()
  await expect(dialog.locator('.timeline-entry')).toHaveCount(0)
  expect(await tops()).toEqual(before)

  // Searchable multi-select for assignees.
  await dialog.getByRole('button', { name: L('Add assignee'), exact: true }).click()
  const picker = page.getByRole('dialog', { name: L('Choose assignees'), exact: true })
  await expect(picker.getByRole('option')).toHaveCount(12)
  await picker.getByRole('combobox').fill('mar')
  await expect(picker.getByRole('option')).toHaveCount(2)
  await picker.getByRole('combobox').press('Enter')
  await picker.getByRole('button', { name: L('Done'), exact: true }).click()
  await expect(dialog.getByRole('list', { name: L('Assignees'), exact: true })).toContainText('Marina Prado')
  await dialog.getByRole('button', { name: L('Save changes'), exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText(L('Changes saved.'))
  expect(patches[0]).toMatchObject({ priority: 'urgent', assigneeUserIds: ['jc', 'mp'] })

  await dialog.getByRole('tab', { name: new RegExp('^' + L('Executions')) }).click()
  await expect(dialog.locator('.cd-exec-hero')).toContainText(L('failed'))
  await expect(dialog.locator('.cd-run')).toHaveCount(2)
  await dialog.getByRole('tab', { name: L('Details'), exact: true }).click()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme)
      await page.screenshot({ path: info.outputPath('card-dialog-' + width + '-' + theme + '.png'), animations: 'disabled' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
  // Subtasks open in place with a back breadcrumb.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await dialog.getByRole('button', { name: /Consent screen in onboarding/ }).click()
  await expect(dialog.getByRole('button', { name: translate('Back to {title}', info.project.name as Locale, { title: card.title }), exact: true })).toBeVisible()
})
