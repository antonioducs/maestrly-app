import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, type ElectronApplication, type TestInfo } from '@playwright/test'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const toolConversationId = 'e2e-design-mode-browser-tools'

type ChatMode = 'agent' | 'design' | 'plan' | 'ask'

interface Conversation {
  id: string
  name: string
  branch: string
  experience: 'standard' | 'maestro'
}

interface WorkspaceWithConversations {
  id: string
  name: string
  conversations: Conversation[]
}

interface Api {
  getOnboardingDone(): Promise<boolean>
  listWorkspaces(includeArchived?: boolean): Promise<WorkspaceWithConversations[]>
  chatAddProvider(input: {
    name: string
    baseURL: string
    key: string
    kind: 'openai'
  }): Promise<{ ok: boolean; id?: string; error?: string }>
  chatGetMode(conversationId: string): Promise<ChatMode>
  chatSetMode(conversationId: string, mode: ChatMode): Promise<{ ok: boolean; error?: string }>
}

declare const window: { api: Api }

interface ToolResult {
  text: string
  isError: boolean
  images: Array<{ data: string; mediaType: string; byteSize: number }>
}

interface SnapshotElement {
  ref: number
  tag: string
  type: string
  name: string
}

type AppWindow = Awaited<ReturnType<ElectronApplication['firstWindow']>>

let fixtureServer: Server | undefined
let fixtureUrl = ''
let rootDir = ''
let modeUserData = ''
let toolUserData = ''
let projectDir = ''

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function launch(userData: string, instanceId: string, projectPickers: string[] = []): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: instanceId,
      AGENTS_USERDATA: userData,
      AGENTS_LOCALE: 'en',
      AGENTS_E2E_PROJECT_PICKERS: JSON.stringify(projectPickers),
      ELECTRON_RENDERER_URL: '',
    },
  })
}

async function ready(win: AppWindow): Promise<void> {
  await win.waitForFunction(() => typeof window.api !== 'undefined')
  if (await win.evaluate(() => window.api.getOnboardingDone())) return
  await expect(win.getByText('Welcome to Maestrly', { exact: true })).toBeVisible()
  await win.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(win.getByText('Welcome to Maestrly', { exact: true })).toHaveCount(0)
}

async function addWorkspaceThroughUi(win: AppWindow, workspaceName: string): Promise<void> {
  await win.getByRole('button', { name: 'Add workspace', exact: true }).first().click()
  await expect(win.getByRole('heading', { name: 'Add project', exact: true })).toBeVisible()
  await win.getByRole('button', { name: 'Choose…', exact: true }).click()
  await win.getByRole('button', { name: 'Open project', exact: true }).click()
  await expect(win.locator('[data-workspace-id]').filter({ hasText: workspaceName })).toBeVisible()
}

function conversationRow(win: AppWindow, name: string) {
  return win.locator('li.conv-item:visible').filter({ hasText: name })
}

async function createStandardConversationThroughUi(
  win: AppWindow,
  workspaceName: string,
  branch: string
): Promise<Conversation> {
  const workspace = win.locator('[data-workspace-id]').filter({ hasText: workspaceName })
  await workspace.locator('[data-workspace-header]').hover()
  await workspace
    .getByTitle('New conversation', { exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  const dialog = win.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: /^Standard\b/ }).click()
  await dialog.getByLabel('New branch name', { exact: true }).fill(branch)
  await expect(dialog.getByRole('button', { name: 'main', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Create chat', exact: true }).click()

  await expect(dialog).toHaveCount(0)
  await expect(conversationRow(win, branch)).toBeVisible()
  await expect(modeTrigger(win)).toBeVisible()
  const conversations = (await win.evaluate(() => window.api.listWorkspaces(true))).flatMap(
    (item) => item.conversations
  )
  const created = conversations.find((item) => item.branch === branch)
  if (!created) throw new Error(`Conversation was not persisted after UI creation: ${branch}`)
  expect(created.experience).toBe('standard')
  return created
}

function modeTrigger(win: AppWindow) {
  return win.locator('button[title^="Chat mode"]:visible')
}

async function chooseMode(win: AppWindow, mode: Exclude<ChatMode, 'agent'>): Promise<void> {
  const labels: Record<Exclude<ChatMode, 'agent'>, RegExp> = {
    design: /^Design\b/,
    plan: /^Plan\b/,
    ask: /^Ask\b/,
  }
  await modeTrigger(win).click()
  const option = win.getByRole('button', { name: labels[mode] })
  await expect(option).toBeVisible()
  await option.click()
}

async function expectMode(win: AppWindow, conversationId: string, mode: ChatMode): Promise<void> {
  const labels: Record<ChatMode, string> = { agent: 'Agent', design: 'Design', plan: 'Plan', ask: 'Ask' }
  await expect.poll(() => win.evaluate((id) => window.api.chatGetMode(id), conversationId)).toBe(mode)
  await expect(modeTrigger(win)).toContainText(labels[mode])
}

function callDesignAppTool(
  app: ElectronApplication,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  return app.evaluate(
    async (_electron, input) => {
      const call = globalThis.__maestrlyE2ECallAppTool
      if (!call) throw new Error('E2E app-tool bridge was not installed.')
      return call(input)
    },
    { conversationId: toolConversationId, mode: 'design' as const, name, arguments: args }
  )
}

async function callDesignSnapshot(app: ElectronApplication): Promise<ToolResult> {
  let latest: ToolResult | undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    latest = await callDesignAppTool(app, 'browser_snapshot')
    if (!latest.isError || !latest.text.includes('Object has been destroyed')) return latest
  }
  return latest!
}

function snapshotElements(result: ToolResult): SnapshotElement[] {
  const match = /\n(\[[\s\S]*\])$/.exec(result.text)
  if (!match) throw new Error(`Browser snapshot did not contain an element list: ${result.text}`)
  return JSON.parse(match[1]) as SnapshotElement[]
}

function snapshotRef(result: ToolResult, name: string): number {
  const element = snapshotElements(result).find((candidate) => candidate.name === name)
  if (!element) throw new Error(`Browser snapshot did not contain ${JSON.stringify(name)}: ${result.text}`)
  return element.ref
}

function saveScreenshot(testInfo: TestInfo, name: string, result: ToolResult): { path: string; hash: string } {
  expect(result.isError, result.text).toBe(false)
  expect(result.images).toHaveLength(1)
  expect(result.images[0]).toMatchObject({ mediaType: 'image/png' })
  expect(result.images[0]!.byteSize).toBeGreaterThan(1_000)
  const data = Buffer.from(result.images[0]!.data, 'base64')
  const target = testInfo.outputPath(name)
  writeFileSync(target, data)
  return { path: target, hash: createHash('sha256').update(data).digest('hex') }
}

function fixturePage(route: '/' | '/details'): string {
  if (route === '/') {
    return `<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><title>Aurora Projects</title><style>
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; background: #21153f; color: #fff; font: 18px system-ui, sans-serif; }
        main { width: min(760px, calc(100% - 48px)); margin: 0 auto; padding: 72px 0; }
        .eyebrow { color: #c4adff; text-transform: uppercase; letter-spacing: .18em; }
        h1 { font-size: 52px; margin: 12px 0; }
        .card { margin-top: 40px; padding: 28px; border: 1px solid #755db0; border-radius: 20px; background: #33245b; }
        a { display: inline-block; margin-top: 18px; padding: 12px 18px; border-radius: 999px; background: #f1d35a; color: #21153f; font-weight: 750; text-decoration: none; }
      </style></head><body data-view="projects"><main>
        <div class="eyebrow">Fictional design workspace</div>
        <h1>Aurora Projects</h1>
        <p>Local fixture data only. No account or network service is used.</p>
        <section class="card"><h2>Nova Lamp</h2><p>Concept code NX-42 · Research complete</p>
          <a href="/details">View Aurora brief</a>
        </section>
      </main></body></html>`
  }
  return `<!doctype html>
    <html lang="en"><head><meta charset="utf-8"><title>Nova Lamp Brief</title><style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #103b3c; color: #effffc; font: 18px system-ui, sans-serif; }
      main { width: min(800px, calc(100% - 48px)); margin: 0 auto; padding: 60px 0; }
      nav a { color: #a7ffea; }
      h1 { font-size: 50px; margin-bottom: 12px; }
      .metric { display: inline-block; margin: 20px 12px 32px 0; padding: 14px; border-radius: 12px; background: #175354; }
      button { border: 0; border-radius: 999px; padding: 13px 19px; background: #ff9676; color: #2c1610; font: inherit; font-weight: 750; cursor: pointer; }
      dialog { width: min(560px, calc(100% - 48px)); border: 2px solid #f4d45f; border-radius: 22px; padding: 32px; background: #fff7d6; color: #30280e; }
      dialog::backdrop { background: rgba(5, 19, 20, .82); }
      dialog button { margin-top: 18px; background: #2c6564; color: white; }
    </style></head><body data-view="details" data-state="brief"><main>
      <nav><a href="/">Back to project list</a></nav>
      <h1>Nova Lamp Brief</h1>
      <p>Fictional Aurora Console · state: ready for prototype review.</p>
      <div class="metric">8 research notes</div><div class="metric">2 local views</div>
      <div><button id="open-prototype" type="button">Open prototype</button></div>
      <dialog id="prototype" aria-labelledby="prototype-title">
        <h2 id="prototype-title">Fictional prototype preview</h2>
        <p>Warm light scene selected. This content exists only in the local test fixture.</p>
        <button id="close-prototype" type="button">Close prototype</button>
      </dialog>
    </main><script>
      const modal = document.querySelector('#prototype')
      document.querySelector('#open-prototype').addEventListener('click', () => {
        document.body.dataset.state = 'prototype-open'
        modal.showModal()
      })
      document.querySelector('#close-prototype').addEventListener('click', () => modal.close())
      modal.addEventListener('close', () => { document.body.dataset.state = 'brief' })
    </script></body></html>`
}

test.beforeAll(async () => {
  rootDir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'maestrly-design-mode-e2e-')))
  modeUserData = path.join(rootDir, 'mode-user-data')
  toolUserData = path.join(rootDir, 'tool-user-data')
  projectDir = path.join(rootDir, 'design-project')
  mkdirSync(modeUserData)
  mkdirSync(toolUserData)
  mkdirSync(projectDir)
  git(projectDir, ['init', '-q', '-b', 'main'])
  git(projectDir, ['config', 'user.name', 'E2E'])
  git(projectDir, ['config', 'user.email', 'e2e@test.local'])
  writeFileSync(path.join(projectDir, 'README.md'), '# Design E2E fixture\n')
  git(projectDir, ['add', 'README.md'])
  git(projectDir, ['commit', '-q', '-m', 'init'])

  fixtureServer = createServer((request, response) => {
    const route = request.url?.split('?')[0] ?? '/'
    response.setHeader('cache-control', 'no-store')
    if (route === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'fixture-design-model', object: 'model', created: 0, owned_by: 'local-fixture' }],
        })
      )
      return
    }
    if (route === '/' || route === '/details') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(fixturePage(route))
      return
    }
    response.statusCode = 404
    response.end('Not found')
  })
  await new Promise<void>((resolve) => fixtureServer!.listen(0, '127.0.0.1', resolve))
  const address = fixtureServer.address()
  if (!address || typeof address === 'string') throw new Error('Could not start the Design mode fixture server.')
  fixtureUrl = `http://127.0.0.1:${address.port}/`
})

test.afterAll(async () => {
  if (fixtureServer?.listening) {
    await new Promise<void>((resolve, reject) => fixtureServer!.close((error) => (error ? reject(error) : resolve())))
  }
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
})

test('Standard conversations persist independent modes and cycle Design through the composer shortcut', async (
  { browserName: _browserName },
  testInfo
) => {
  let app: ElectronApplication | null = null
  try {
    app = await launch(modeUserData, 'design-mode-ui', [projectDir])
    let win = await app.firstWindow()
    await ready(win)

    const effectiveUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    expect(realpathSync(effectiveUserData)).toBe(realpathSync(modeUserData))

    const provider = await win.evaluate(
      (baseURL) =>
        window.api.chatAddProvider({
          name: 'Local Design fixture',
          baseURL: `${baseURL}v1`,
          key: 'sk-local-fictional',
          kind: 'openai',
        }),
      fixtureUrl
    )
    expect(provider.ok, provider.error).toBe(true)

    await addWorkspaceThroughUi(win, path.basename(projectDir))
    const primary = await createStandardConversationThroughUi(win, path.basename(projectDir), 'design-e2e-primary')
    await expectMode(win, primary.id, 'agent')

    await chooseMode(win, 'design')
    await expectMode(win, primary.id, 'design')
    const designSurface = win.locator('.chat-design-ambient')
    await expect(designSurface).toBeVisible()
    await expect(designSurface).toHaveCSS('background-image', /radial-gradient/)
    await expect(win.locator('.chat-composer-shell')).toHaveCSS('border-color', /rgba?\(/)
    await testInfo.attach('design-chat-ambient', {
      body: await designSurface.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    })

    await win.locator('button[title="Add"]:visible').click()
    const plusMenu = win.getByRole('menu')
    await expect(plusMenu).toBeVisible()
    await expect(plusMenu.getByText(/keeps these toggles active, but exposes only/i)).toHaveCount(0)
    await expect(plusMenu.getByText('Maestrly tools', { exact: true })).toBeVisible()
    await win.keyboard.press('Escape')

    const composer = win.locator('main [role="textbox"]:visible')
    await expect(composer).toHaveAttribute('contenteditable', 'true')
    await composer.click()
    for (const expected of ['plan', 'ask', 'agent', 'design'] as const) {
      await win.keyboard.press('Shift+Tab')
      await expectMode(win, primary.id, expected)
    }

    const secondary = await createStandardConversationThroughUi(win, path.basename(projectDir), 'design-e2e-secondary')
    await expectMode(win, secondary.id, 'agent')
    await chooseMode(win, 'plan')
    await expectMode(win, secondary.id, 'plan')

    await conversationRow(win, primary.name).click()
    await expectMode(win, primary.id, 'design')
    await conversationRow(win, secondary.name).click()
    await expectMode(win, secondary.id, 'plan')

    const rejected = await createStandardConversationThroughUi(win, path.basename(projectDir), 'design-e2e-rejected')
    await expectMode(win, rejected.id, 'agent')
    const db = new DatabaseSync(path.join(modeUserData, 'maestrly-agents.db'))
    db.exec('PRAGMA foreign_keys = ON;')
    db.prepare('DELETE FROM conversations WHERE id = ?').run(rejected.id)
    db.close()
    await chooseMode(win, 'design')
    await expect(win.getByRole('alert')).toContainText('The mode could not be saved')
    await expect(modeTrigger(win)).toContainText('Agent')

    const missingId = 'missing-design-mode-conversation'
    expect(await win.evaluate((id) => window.api.chatSetMode(id, 'design'), missingId)).toEqual({
      ok: false,
      error: 'invalid-conversation',
    })
    expect(await win.evaluate((id) => window.api.chatGetMode(id), missingId)).toBe('agent')

    await app.close()
    app = null

    app = await launch(modeUserData, 'design-mode-ui')
    win = await app.firstWindow()
    await ready(win)
    await expect
      .poll(() =>
        win.evaluate(
          async ({ primaryId, secondaryId }) => [
            await window.api.chatGetMode(primaryId),
            await window.api.chatGetMode(secondaryId),
          ],
          { primaryId: primary.id, secondaryId: secondary.id }
        )
      )
      .toEqual(['design', 'plan'])

    await expect(conversationRow(win, primary.name)).toBeVisible()
    await conversationRow(win, primary.name).click()
    await expectMode(win, primary.id, 'design')
    await conversationRow(win, secondary.name).click()
    await expectMode(win, secondary.id, 'plan')
  } finally {
    await app?.close().catch(() => {})
  }
})

test('Design app tools navigate a local prototype and capture fresh state evidence', async ({
  browserName: _browserName,
}, testInfo) => {
  const app = await launch(toolUserData, 'design-mode-browser-tools')
  try {
    const win = await app.firstWindow()
    await win.waitForFunction(() => typeof window.api !== 'undefined')

    await expect(callDesignAppTool(app, 'browser_navigate', { url: fixtureUrl })).resolves.toMatchObject({
      isError: false,
    })
    await expect(
      callDesignAppTool(app, 'browser_wait_for', { text: 'Aurora Projects', timeout_ms: 5_000 })
    ).resolves.toMatchObject({ isError: false, text: expect.stringMatching(/^OK:/) })

    const overview = await callDesignSnapshot(app)
    expect(overview.isError, overview.text).toBe(false)
    expect(overview.text).toContain(fixtureUrl)
    await expect(
      callDesignAppTool(app, 'browser_click', { ref: snapshotRef(overview, 'View Aurora brief') })
    ).resolves.toMatchObject({ isError: false })
    await expect(
      callDesignAppTool(app, 'browser_wait_for', { text: 'Fictional Aurora Console', timeout_ms: 5_000 })
    ).resolves.toMatchObject({ isError: false, text: expect.stringMatching(/^OK:/) })

    const details = await callDesignSnapshot(app)
    expect(details.isError, details.text).toBe(false)
    expect(details.text).toContain(`${fixtureUrl}details`)
    expect(snapshotElements(details).map((element) => element.name)).toEqual(
      expect.arrayContaining(['Back to project list', 'Open prototype'])
    )
    const detailsText = await callDesignAppTool(app, 'browser_read_text')
    expect(detailsText.text).toContain('Nova Lamp Brief')
    expect(detailsText.text).toContain('8 research notes')

    const before = saveScreenshot(testInfo, 'design-brief.png', await callDesignAppTool(app, 'browser_screenshot'))
    await expect(
      callDesignAppTool(app, 'browser_click', { ref: snapshotRef(details, 'Open prototype') })
    ).resolves.toMatchObject({ isError: false })
    await expect(
      callDesignAppTool(app, 'browser_wait_for', { text: 'Fictional prototype preview', timeout_ms: 5_000 })
    ).resolves.toMatchObject({ isError: false, text: expect.stringMatching(/^OK:/) })

    const modalOpen = await callDesignSnapshot(app)
    expect(snapshotElements(modalOpen).map((element) => element.name)).toContain('Close prototype')
    const after = saveScreenshot(
      testInfo,
      'design-prototype-open.png',
      await callDesignAppTool(app, 'browser_screenshot')
    )
    expect(after.hash).not.toBe(before.hash)

    await expect(
      callDesignAppTool(app, 'browser_click', { ref: snapshotRef(modalOpen, 'Close prototype') })
    ).resolves.toMatchObject({ isError: false })
    const modalClosed = await callDesignSnapshot(app)
    expect(snapshotElements(modalClosed).map((element) => element.name)).not.toContain('Close prototype')
    expect(snapshotElements(modalClosed).map((element) => element.name)).toContain('Open prototype')

    await expect(
      callDesignAppTool(app, 'browser_click', { ref: snapshotRef(modalClosed, 'Back to project list') })
    ).resolves.toMatchObject({ isError: false })
    await expect(
      callDesignAppTool(app, 'browser_wait_for', { text: 'Aurora Projects', timeout_ms: 5_000 })
    ).resolves.toMatchObject({ isError: false, text: expect.stringMatching(/^OK:/) })
    const returned = await callDesignSnapshot(app)
    expect(returned.text).toContain(fixtureUrl)
    expect(snapshotElements(returned).map((element) => element.name)).toContain('View Aurora brief')
    const consoleErrors = await callDesignAppTool(app, 'browser_console_logs', { level: 'error', limit: 20 })
    expect(consoleErrors).toMatchObject({ isError: false, text: '(no console logs captured)' })
    const networkErrors = await callDesignAppTool(app, 'browser_network_logs', { onlyErrors: true, limit: 20 })
    expect(networkErrors).toMatchObject({ isError: false, text: '(no requests captured)' })
    testInfo.annotations.push({ type: 'screenshots', description: `${before.path}\n${after.path}` })
  } finally {
    await app.close().catch(() => {})
  }
})
