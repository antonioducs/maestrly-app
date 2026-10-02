import { execFileSync } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import {
  FLEET_GATEWAY_ROUTES,
  fleetBotSchema,
  fleetGatewayEventSchema,
  fleetHostInfoSchema,
  fleetPendingInteractionSchema,
  fleetTranscriptItemSchema,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const primaryModel = 'detached-fixture'
const secondaryModel = 'detached-secondary'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='
const editor = (page: Page) => page.locator('.chat-input[contenteditable="true"]:visible')
// Detached documents intentionally have no independent preload/runtime. Always invoke APIs here.
const api = (page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
const row = (page: Page, name: string) => page.locator('.conv-item').filter({ hasText: name }).first()

function chunk(response: ServerResponse, text: string, finish: string | null = null) {
  response.write(
    `data: ${JSON.stringify({
      id: 'detached-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: primaryModel,
      choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
    })}\n\n`
  )
}
function finish(response: ServerResponse, text = 'complete.') {
  chunk(response, text)
  chunk(response, '', 'stop')
  response.end('data: [DONE]\n\n')
}

interface Session {
  root: string
  app: ElectronApplication
  page: Page
  providerId: string
  requests: Array<{ model: string; messages: unknown[] }>
  held: () => ServerResponse
  newChat: (name: string) => Promise<string>
}
const test = base.extend<{ session: Session }>({
  session: async ({ playwright }, use) => {
    await access(path.join(desktop, 'out/main/index.js'))
    const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-detached-e2e-'))
    const requests: Session['requests'] = []
    const streams = new Set<ServerResponse>()
    let held: ServerResponse | undefined
    let app: ElectronApplication | undefined
    const model = createServer(async (request, response) => {
      if (request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ data: [primaryModel, secondaryModel].map((id) => ({ id, object: 'model' })) }))
        return
      }
      if (request.url !== '/v1/chat/completions') return void response.writeHead(404).end()
      let body = ''
      for await (const part of request) body += part
      const input = JSON.parse(body) as Session['requests'][number]
      requests.push(input)
      response.setHeader('content-type', 'text/event-stream')
      streams.add(response)
      response.on('close', () => streams.delete(response))
      if (requests.length === 1 && JSON.stringify(input.messages).includes('hold-detached-turn')) {
        held = response
        chunk(response, 'Detached streaming proof: ')
      } else finish(response, `Detached reply ${requests.length}.`)
    })
    try {
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
      const profile = path.join(root, 'profile')
      app = await playwright._electron.launch({
        args: [path.join(desktop, 'out/main/index.js')],
        env: {
          ...process.env,
          AGENTS_E2E: '1',
          AGENTS_CHANNEL: 'dev',
          AGENTS_INSTANCE: 'detached-e2e',
          AGENTS_USERDATA: profile,
          AGENTS_LOCALE: 'en',
          ELECTRON_RENDERER_URL: '',
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
        },
      })
      const page = await app.firstWindow()
      await page.waitForFunction(() => Boolean((window as any).api))
      expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(await realpath(profile))
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      const provider = await api(page, 'chatAddProvider', {
        name: 'Detached fixture',
        kind: 'openai',
        key: 'fixture-key',
        baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
      })
      expect(provider.ok).toBe(true)
      await api(page, 'chatSetDefault', { providerId: provider.id, modelId: primaryModel })
      await use({
        root,
        app,
        page,
        providerId: provider.id,
        requests,
        held: () => {
          if (!held) throw new Error('The synthetic provider has no held response')
          return held
        },
        newChat: async (name) => {
          const before = (await api(page, 'listStandaloneConversations', true)) as Array<{ id: string }>
          await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
          await expect
            .poll(async () => (await api(page, 'listStandaloneConversations', true)).length)
            .toBe(before.length + 1)
          const conversations = (await api(page, 'listStandaloneConversations', true)) as Array<{
            id: string
            name: string
          }>
          const created = conversations.find((conversation) => !before.some((old) => old.id === conversation.id))!
          await row(page, created.name).click({ button: 'right' })
          await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
          const input = page.locator('.conv-item input')
          await input.fill(name)
          await input.press('Enter')
          await expect(row(page, name)).toBeVisible()
          await api(page, 'chatSetSelection', created.id, { providerId: provider.id, modelId: primaryModel })
          await expect(editor(page)).toBeVisible()
          return created.id
        },
      })
    } finally {
      for (const response of streams) response.destroy()
      await app?.close().catch(() => undefined)
      model.closeAllConnections()
      await new Promise<void>((resolve) => model.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
})

async function detach(session: Session) {
  const nextWindow = session.app.waitForEvent('window')
  await session.page.getByRole('button', { name: 'Open chat in new window', exact: true }).click()
  const child = await nextWindow
  await expect(child.getByRole('button', { name: 'Return to app', exact: true })).toBeVisible()
  await expect(editor(child)).toBeVisible()
  await expect(
    session.page.getByText('This conversation is open in another window.', { exact: true }).filter({ visible: true })
  ).toBeVisible()
  return child
}
async function send(page: Page, text: string) {
  await editor(page).fill(text)
  // Enter goes through the real editor key handler, including its streaming queue path.
  await editor(page).press('Enter')
}
async function pasteImage(page: Page) {
  await editor(page).evaluate((element, data) => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], 'detached-pixel.png', {
        type: 'image/png',
      })
    )
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, png)
  await expect(page.getByRole('img', { name: 'detached-pixel.png', exact: true })).toBeVisible()
}
async function returnToApp(child: Page) {
  const closed = child.waitForEvent('close')
  await child
    .getByRole('button', { name: 'Return to app', exact: true })
    .click()
    .catch((error: unknown) => {
      // Electron may destroy the target before acknowledging the mouse-up to Playwright.
      if (
        !child.isClosed() ||
        !(error instanceof Error) ||
        !error.message.includes('Target page, context or browser has been closed')
      )
        throw error
    })
  await closed
}

test('detached standalone stream survives navigation, background source and native close with queued images', async ({
  session,
}) => {
  const { app, page, requests } = session
  const id = await session.newChat('Live detached chat')
  await send(page, 'hold-detached-turn')
  await expect(page.getByText('Detached streaming proof:', { exact: false })).toBeVisible()
  await editor(page).fill('image draft')
  await pasteImage(page)
  let child = await detach(session)
  await expect(editor(child)).toHaveText('image draft')
  await expect(child.getByRole('img', { name: 'detached-pixel.png', exact: true })).toBeVisible()
  await expect(child.getByRole('img', { name: 'detached-pixel.png' })).toHaveJSProperty('naturalWidth', 1)
  await editor(child).press('End')
  await editor(child).pressSequentially(' edited')
  await editor(child).press('Enter')
  await expect(child.getByText('1 queued', { exact: true })).toBeVisible()
  await child.getByTitle('Edit (back to the field)', { exact: true }).click()
  await expect(editor(child)).toHaveText('image draft edited')
  await editor(child).press('Enter')
  await expect(child.getByText('1 queued', { exact: true })).toBeVisible()
  await editor(child).fill('unsent native-close draft')

  // Both the header and placeholder focus actions must reuse the existing BrowserWindow.
  const windows = app.windows().length
  for (const focus of await page.getByRole('button', { name: 'Focus chat window', exact: true }).all()) {
    await focus.click()
    await expect(editor(child)).toHaveText('unsent native-close draft')
    expect(app.windows()).toHaveLength(windows)
  }
  await returnToApp(child)
  await expect(editor(page)).toHaveText('unsent native-close draft')
  await expect(page.getByText('1 queued', { exact: true })).toBeVisible()
  child = await detach(session)
  await session.newChat('Main navigation chat')
  await expect(editor(page)).toHaveText('')
  const mainWindow = await app.browserWindow(page)
  // Xvfb has no window manager to honor minimization. Keep native minimize coverage on
  // macOS/Windows, and exercise an explicitly hidden source window on every platform.
  if (process.platform !== 'linux') {
    await mainWindow.evaluate((window) => window.minimize())
    await expect.poll(() => mainWindow.evaluate((window) => window.isMinimized())).toBe(true)
    chunk(session.held(), 'while main is minimized ')
    await expect(child.getByText('Detached streaming proof: while main is minimized', { exact: false })).toBeVisible()
  }
  await mainWindow.evaluate((window) => window.hide())
  await expect.poll(() => mainWindow.evaluate((window) => window.isVisible())).toBe(false)
  const nativeChild = await app.browserWindow(child)
  await expect.poll(() => nativeChild.evaluate((window) => window.isVisible())).toBe(true)
  chunk(session.held(), 'while main is hidden ')
  await expect(child.getByText('while main is hidden', { exact: false })).toBeVisible()
  await expect(child.locator('button[title="Stop"]:visible')).toBeVisible()

  // Native close must request reattachment; destroying/closing the Page directly bypasses this handshake.
  const closed = child.waitForEvent('close')
  await nativeChild.evaluate((window) => window.close())
  await closed
  await expect.poll(() => mainWindow.evaluate((window) => window.isVisible())).toBe(true)
  await expect.poll(() => mainWindow.evaluate((window) => window.isMinimized())).toBe(false)
  await expect(editor(page)).toHaveText('unsent native-close draft')
  await expect(page.getByText('1 queued', { exact: true })).toBeVisible()
  finish(session.held())
  await expect.poll(() => requests.length).toBe(2)
  await expect(page.getByText('Detached reply 2.', { exact: true })).toBeVisible()
  await expect(page.locator('button[title="Stop"]:visible')).toHaveCount(0)
  expect(JSON.stringify(requests[1].messages)).toContain('image draft edited')
  expect(JSON.stringify(requests[1].messages)).toContain('data:image/png;base64,')
  await expect(editor(page)).toHaveText('unsent native-close draft')
  await expect.poll(async () => (await api(page, 'chatRuntime', id)).streaming).toBe(false)
})

test('two detached chats keep independent titles, scoped search, keyboard model selection and explicit return', async ({
  session,
}) => {
  const { page, app, requests } = session
  await session.newChat('Alpha window')
  await send(page, 'alpha-search-marker')
  await expect(page.getByText('Detached reply 1.', { exact: true })).toBeVisible()
  const alpha = await detach(session)
  await session.newChat('Beta window')
  await send(page, 'beta-search-marker')
  await expect(page.getByText('Detached reply 2.', { exact: true })).toBeVisible()
  const beta = await detach(session)
  await expect(alpha).toHaveTitle('Alpha window')
  await expect(beta).toHaveTitle('Beta window')
  expect(app.windows()).toHaveLength(3)
  await alpha.bringToFront()
  await editor(alpha).click()
  await alpha.keyboard.press('ControlOrMeta+f')
  const search = alpha.getByPlaceholder('Search conversation…')
  await expect(search).toBeFocused()
  await search.fill('alpha-search-marker')
  await expect(alpha.getByText('1 of 1', { exact: true })).toBeVisible()
  await expect(beta.getByPlaceholder('Search conversation…')).toHaveCount(0)
  await expect(page.getByPlaceholder('Search conversation…')).toHaveCount(0)
  await search.press('Escape')

  await alpha.locator('button[title^="Change model"]:visible').click()
  const modelSearch = alpha.getByPlaceholder('Search models…')
  await expect(modelSearch).toBeFocused()
  await expect(page.getByPlaceholder('Search models…')).toHaveCount(0)
  await modelSearch.fill(secondaryModel)
  await modelSearch.press('ArrowDown')
  await modelSearch.press('Enter')
  await expect(modelSearch).toHaveCount(0)
  await alpha.locator('button[title^="Change model"]:visible').click()
  await alpha.getByPlaceholder('Search models…').press('Escape')
  await expect(alpha.getByPlaceholder('Search models…')).toHaveCount(0)
  await pasteImage(alpha)
  await send(alpha, 'child model and paste proof')
  await expect(alpha.getByText('Detached reply 3.', { exact: true })).toBeVisible()
  expect(requests[2].model).toBe(secondaryModel)
  expect(JSON.stringify(requests[2].messages)).toContain('data:image/png;base64,')
  expect(JSON.stringify(requests[2].messages)).not.toContain('beta-search-marker')
  await editor(alpha).fill('alpha return draft')
  await editor(beta).fill('beta independent draft')
  await returnToApp(alpha)
  await expect(editor(page)).toHaveText('alpha return draft')
  await expect(editor(beta)).toHaveText('beta independent draft')
  await returnToApp(beta)
  await expect(editor(page)).toHaveText('beta independent draft')
  await row(page, 'Alpha window').click()
  await expect(editor(page)).toHaveText('alpha return draft')
})

test('detached dialog isolates focus and scroll locking and retains its unsaved form on native return', async ({
  session,
}) => {
  const { page, app } = session
  await session.newChat('Dialog window')
  await editor(page).fill('dialog composer draft')
  const child = await detach(session)
  await child.getByTitle('Add', { exact: true }).click()
  await child.getByRole('menuitem', { name: /Subagent execution profiles/ }).click()
  const dialog = child.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked')
  await dialog.getByRole('button', { name: 'Add fallback', exact: true }).first().click()
  await expect(dialog.getByTitle('Remove', { exact: true })).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Close', exact: true }).focus()
  await child.keyboard.press('Tab')
  await expect
    .poll(() =>
      child.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        return !!dialog?.contains(document.activeElement)
      })
    )
    .toBe(true)
  // A modal in one native window must not trap focus or suppress interaction in another.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await expect(dialog).toBeVisible()
  const closed = child.waitForEvent('close')
  const nativeChild = await app.browserWindow(child)
  await nativeChild.evaluate((window) => window.close())
  await closed
  const restoredDialog = page.getByRole('dialog')
  await expect(restoredDialog).toBeVisible()
  await expect(restoredDialog.getByTitle('Remove', { exact: true })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(restoredDialog).toHaveCount(0)
  await expect(editor(page)).toHaveText('dialog composer draft')
})

async function addWorkspaceFixture(session: Session) {
  const { root, page } = session
  const repo = path.join(root, 'detached-workspace')
  await mkdir(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ])
  const workspace = await api(page, 'addWorkspace', repo)
  return workspace
}

test('main and detached dialogs keep independent focus traps when the child dialog opens last', async ({ session }) => {
  const { page } = session
  await addWorkspaceFixture(session)
  await page.reload()
  await page.getByRole('tab', { name: 'Chats', exact: true }).click()
  await session.newChat('Concurrent dialogs')
  const child = await detach(session)
  await page.getByRole('tab', { name: 'Workspaces', exact: true }).click()
  await page.getByRole('button', { name: 'New conversation', exact: true }).press('Enter')
  const mainDialog = page.getByRole('dialog')
  await expect(mainDialog).toBeVisible()
  await child.getByTitle('Add', { exact: true }).click()
  await child.getByRole('menuitem', { name: /Subagent execution profiles/ }).click()
  const childDialog = child.getByRole('dialog')
  await expect(childDialog).toBeVisible()
  for (const [view, dialog] of [
    [page, mainDialog],
    [child, childDialog],
  ] as const) {
    await dialog.getByRole('button', { name: 'Close', exact: true }).focus()
    await view.keyboard.press('Tab')
    await expect
      .poll(() => view.evaluate(() => !!document.querySelector('[role="dialog"]')?.contains(document.activeElement)))
      .toBe(true)
  }
  await child.keyboard.press('Escape')
  await expect(childDialog).toHaveCount(0)
  await expect(mainDialog).toBeVisible()
  await mainDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(mainDialog).toHaveCount(0)
  await returnToApp(child)
})

test('workspace chat detaches with workspace title and opens its tools in the source window', async ({ session }) => {
  const { page, providerId } = session
  const workspace = await addWorkspaceFixture(session)
  const conversation = await api(page, 'createConversation', {
    workspaceId: workspace.id,
    branch: 'detached-agent',
    isNewBranch: true,
    mode: 'worktree',
    name: 'Workspace window',
  })
  await api(page, 'chatSetSelection', conversation.id, { providerId, modelId: primaryModel })
  // Reload before opening any child to load the synthetic workspace through the normal startup path.
  await page.reload()
  await page.getByRole('tab', { name: 'Workspaces', exact: true }).click()
  await row(page, 'Workspace window').click()
  await editor(page).fill('workspace retained draft')
  const child = await detach(session)
  await expect(child).toHaveTitle(`${workspace.name} · Workspace window`)
  await expect(editor(child)).toHaveText('workspace retained draft')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await child.getByTitle('Open tools in main window', { exact: true }).click()
  await expect(page.getByText('This conversation is open in another window.', { exact: true })).toBeVisible()
  await expect(page.getByRole('complementary')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open a tool', exact: true })).toBeVisible()
  await expect(editor(child)).toHaveText('workspace retained draft')
  await returnToApp(child)
  await expect(editor(page)).toHaveText('workspace retained draft')
  await send(page, 'workspace restored send')
  await expect(page.getByText('Detached reply 1.', { exact: true })).toBeVisible()
})

test('detached fleet bot keeps its draft and receives transcript and question updates while another bot is selected', async ({
  session,
}) => {
  const { page } = session
  const now = () => new Date().toISOString()
  const streams = new Set<ServerResponse>()
  const failures: string[] = []
  const resolutions: unknown[] = []
  const makeBot = (id: string, name: string) =>
    fleetBotSchema.parse({
      id,
      name,
      role: 'Synthetic detached fixture',
      instructions: '',
      tint: '#6688aa',
      ceiling: 'auto',
      selection: null,
      talksTo: [],
      paused: false,
      lifecycle: 'running',
      setup: { step: 'ready', error: null, errorMessage: null },
      status: 'idle',
      activity: null,
      pendingCount: 0,
      accounts: { connected: true, providers: [{ id: 'fixture-provider', label: 'Fixture' }] },
      takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
      resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
      screen: { width: 1280, height: 800, display: ':1' },
      appVersion: '0.9.3',
      createdAt: now(),
      updatedAt: now(),
    })
  const bots = [makeBot('scout', 'Detached Scout'), makeBot('partner', 'Fixture Partner')]
  const host = fleetHostInfoSchema.parse({
    hostname: 'detached-fleet-fixture',
    os: 'Linux',
    kernel: '6.8',
    arch: 'x64',
    cpus: 4,
    cpuPercent: 0,
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 0, botsBytes: 0 },
    disk: { totalBytes: 100 * 1024 ** 3, usedBytes: 0 },
    uptimeSeconds: 1,
    gatewayVersion: '0.9.3',
    botImage: 'fixture-image',
    botImageVersion: '0.9.3',
    dockerVersion: '28',
  })
  const transcript: FleetTranscriptItem[] = []
  let inbox: Array<{ botId: string; interaction: ReturnType<typeof fleetPendingInteractionSchema.parse> }> = []
  const emit = (input: unknown) => {
    const event = fleetGatewayEventSchema.parse(input)
    for (const stream of streams) stream.write(`event: fleet\ndata: ${JSON.stringify(event)}\n\n`)
  }
  const upsert = (input: unknown) => {
    const item = fleetTranscriptItemSchema.parse(input)
    const index = transcript.findIndex((entry) => entry.id === item.id)
    if (index === -1) transcript.push(item)
    else transcript[index] = item
    emit({ type: 'transcript.upsert', at: now(), botId: 'scout', item })
  }
  const conversationResult = (op: string) => {
    switch (op) {
      case 'chatConfig':
        return { mcpServers: [], appToolsEnabled: true, imageGenEnabled: true }
      case 'chatGetConvTools':
        return { app: true, imageGen: true, mcpDisabled: [] }
      case 'chatSubagentProfilesGetConversation':
        return { rules: null, diagnostics: [], enabled: true, subagentsEnabled: true }
      case 'chatSkillsState':
        return { skills: [], groups: [], selection: { kind: 'all' }, selectedGroupMissing: false, hasOverrides: false }
      case 'chatCommands':
        return { prompts: [], project: [], skills: [] }
      default:
        return { ok: true }
    }
  }
  const gateway = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
      ([, route]) =>
        route.method === request.method && new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
    )
    const sendJson = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (!entry) return sendJson(404, { code: 'NOT_FOUND', message: 'Unknown fixture route' })
    const [key, route] = entry
    if (request.headers['x-maestrly-fleet-protocol'] !== '1')
      return sendJson(426, { code: 'PROTOCOL_INCOMPATIBLE', message: 'Bad protocol' })
    if (!['meta', 'pair'].includes(key) && request.headers.authorization !== 'Bearer fixture-token')
      return sendJson(401, { code: 'UNAUTHORIZED', message: 'Bad token' })
    try {
      let body: any
      if (route.body) {
        let raw = ''
        for await (const part of request) raw += part
        body = route.body.parse(JSON.parse(raw))
      }
      if (key === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.write(': connected\n\n')
        streams.add(response)
        response.on('close', () => streams.delete(response))
        return
      }
      const botId = url.pathname.match(/^\/v1\/bots\/([^/]+)/)?.[1]
      let value: unknown
      switch (key) {
        case 'meta':
          value = {
            protocol: 1,
            features: [],
            gatewayVersion: '0.9.3',
            botImage: 'fixture-image',
            botImageVersion: '0.9.3',
          }
          break
        case 'pair':
          value = { deviceId: 'detached-device', token: 'fixture-token' }
          break
        case 'host':
          value = host
          break
        case 'botsList':
          value = { bots }
          break
        case 'botGet':
          value = bots.find((bot) => bot.id === botId)
          break
        case 'environmentsList':
          value = { environments: [] }
          break
        case 'inbox':
          value = { items: inbox }
          break
        case 'peerMessages':
          value = { messages: [] }
          break
        case 'ownerMemoryList':
          value = { revision: 0, activeChars: 0, entries: [] }
          break
        case 'botTranscript':
          value = { items: botId === 'scout' ? transcript : [], before: null }
          break
        case 'botSelections':
          value = { options: [], current: null }
          break
        case 'botRoutinesList':
          value = { routines: [] }
          break
        case 'botMemoriesList':
          value = { memories: [] }
          break
        case 'botAccountsList':
          value = { apiKeys: [], subscriptions: [] }
          break
        case 'botSkillsList':
          value = { skills: [] }
          break
        case 'botMcpServersList':
          value = { servers: [] }
          break
        case 'botConversationCall':
          value = { result: conversationResult(body.op) }
          break
        case 'botInteractionResolve': {
          resolutions.push({ botId, body })
          const question = transcript.find((item) => item.kind === 'question')!
          upsert({ ...question, state: 'answered', answers: body.answers })
          inbox = []
          emit({ type: 'inbox.updated', at: now(), items: inbox })
          break
        }
        default:
          failures.push(`Unhandled gateway route: ${key}`)
          return sendJson(404, { code: 'NOT_FOUND', message: 'Unsupported fixture route' })
      }
      if (route.response) sendJson(200, route.response.parse(value))
      else response.writeHead(204).end()
    } catch (error) {
      failures.push(`${key}: ${String(error)}`)
      sendJson(500, { code: 'INTERNAL', message: 'Invalid synthetic gateway fixture' })
    }
  })
  try {
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    await api(page, 'fleetConnect', {
      url: `http://127.0.0.1:${(gateway.address() as { port: number }).port}`,
      code: 'ABCDEFGH',
      deviceName: 'Detached test',
    })
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await page
      .getByRole('button', { name: /Detached Scout/ })
      .first()
      .click()
    await expect(page.getByRole('heading', { name: 'Detached Scout', exact: true })).toBeVisible()
    await editor(page).fill('fleet draft survives navigation')
    const child = await detach(session)
    await expect(child).toHaveTitle('Detached Scout')
    await page
      .getByRole('button', { name: /Fixture Partner/ })
      .first()
      .click()
    await expect(page.getByRole('heading', { name: 'Fixture Partner', exact: true })).toBeVisible()
    await expect.poll(() => streams.size).toBeGreaterThan(0)
    upsert({ id: 'detached-answer', at: now(), kind: 'assistant', text: 'Fleet incremental', streaming: true })
    await expect(child.getByText('Fleet incremental', { exact: true })).toBeVisible()
    upsert({
      id: 'detached-answer',
      at: now(),
      kind: 'assistant',
      text: 'Fleet incremental complete.',
      streaming: false,
    })
    await expect(child.getByText('Fleet incremental complete.', { exact: true })).toBeVisible()
    await expect(page.getByText('Fleet incremental complete.', { exact: true })).not.toBeVisible()
    const questions = [
      {
        question: 'Which fixture result?',
        header: 'Result',
        options: [
          { label: 'Keep fixture', description: null },
          { label: 'Discard fixture', description: null },
        ],
        multiSelect: false,
      },
    ]
    inbox = [
      {
        botId: 'scout',
        interaction: fleetPendingInteractionSchema.parse({
          kind: 'question',
          id: 'detached-question',
          at: now(),
          questions,
          itemId: 'question-item',
        }),
      },
    ]
    upsert({
      id: 'question-item',
      at: now(),
      kind: 'question',
      toolCallId: 'detached-question',
      questions,
      state: 'pending',
      answers: null,
    })
    emit({ type: 'inbox.updated', at: now(), items: inbox })
    await child.getByRole('button', { name: /Keep fixture/ }).click()
    await child.getByRole('button', { name: 'Next', exact: true }).click()
    await child.getByRole('button', { name: 'Send', exact: true }).filter({ hasText: 'Send' }).click()
    await expect
      .poll(() => resolutions)
      .toEqual([{ botId: 'scout', body: { kind: 'question', answers: [['Keep fixture']] } }])
    await expect(child.getByText('Answered', { exact: false })).toBeVisible()
    await expect(editor(child)).toHaveText('fleet draft survives navigation')
    await returnToApp(child)
    await expect(page.getByRole('heading', { name: 'Detached Scout', exact: true })).toBeVisible()
    await expect(editor(page)).toHaveText('fleet draft survives navigation')
    await expect(page.getByText('Fleet incremental complete.', { exact: true })).toBeVisible()
    expect(failures).toEqual([])
  } finally {
    await api(page, 'fleetDisconnect').catch(() => undefined)
    for (const response of streams) response.destroy()
    gateway.closeAllConnections()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
  }
})
