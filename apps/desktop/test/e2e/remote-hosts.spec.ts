import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const HOST_ID = 'direct/host'

const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const portOf = (server: Server) => (server.address() as AddressInfo).port
async function freePort(): Promise<number> {
  const probe = createServer()
  await listen(probe)
  const port = portOf(probe)
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** An OpenAI-compatible model that answers every turn with one fixed sentence, and records who asked. */
function fixtureModel() {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'remote-fixture', object: 'model' }] }))
    }
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    let body = ''
    for await (const part of req) body += part
    requests.push(JSON.parse(body))
    res.setHeader('content-type', 'text/event-stream')
    const chunk = (content: string, finish: string | null) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'remote-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'remote-fixture',
          choices: [{ index: 0, delta: { content }, finish_reason: finish }],
        })}\n\n`
      )
    chunk(`Answered on the host, turn ${requests.length}.`, null)
    chunk('', 'stop')
    res.end('data: [DONE]\n\n')
  })
  return { server, requests }
}

const baseEnv = (profile: string, instance: string) => ({
  ...process.env,
  AGENTS_E2E: '1',
  AGENTS_CHANNEL: 'dev',
  AGENTS_INSTANCE: instance,
  AGENTS_USERDATA: profile,
  AGENTS_LOCALE: 'en',
  ELECTRON_RENDERER_URL: '',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  MAESTRLY_BOT_MODE: '',
  MAESTRLY_SERVER_MODE: '',
  MAESTRLY_DEV_DIRECT_HOST: '',
})

// Two real Electron instances of the built app on this machine: one hosts workspaces in server mode, the other is a
// person's desktop connected straight to it (the development-only direct host). No gateway, Docker or account.
test('remote host: mixed sidebar, a chat turn and a terminal that run on the host', async () => {
  test.setTimeout(240_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-remote-hosts-')))
  const workspacesRoot = path.join(root, 'srv')
  await mkdir(workspacesRoot)
  const token = randomBytes(32).toString('base64url')
  const controlPort = await freePort()
  const model = fixtureModel()
  let host: ElectronApplication | undefined
  let client: ElectronApplication | undefined
  let page!: Page

  const local = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
  const remote = (name: string, ...args: unknown[]) =>
    page.evaluate(({ hostId, name, args }) => (window as any).api.hostApi(hostId)[name](...args), {
      hostId: HOST_ID,
      name,
      args,
    })
  const chatsPanel = () => page.locator('#sidebar-panel-chats')
  const remoteSection = () => chatsPanel().locator(`[data-host-section="${HOST_ID}"]`)

  try {
    await listen(model.server)
    host = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...baseEnv(path.join(root, 'host-profile'), 'remote-host-e2e'),
        MAESTRLY_SERVER_MODE: '1',
        MAESTRLY_ENVIRONMENT_ID: 'workspaces',
        MAESTRLY_BOT_CONTROL_HOST: '127.0.0.1',
        MAESTRLY_BOT_CONTROL_PORT: String(controlPort),
        MAESTRLY_BOT_CONTROL_TOKEN: token,
        MAESTRLY_WORKSPACES_ROOT: workspacesRoot,
      },
    })
    // The host answers its health check once its control server listens.
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${controlPort}/v1/health`, {
              headers: { 'X-Maestrly-Fleet-Protocol': '1', Authorization: `Bearer ${token}` },
            })
            return response.ok ? ((await response.json()) as { ready?: boolean; busy?: boolean }) : null
          } catch {
            return null
          }
        },
        { timeout: 60_000 }
      )
      .toMatchObject({ ready: true, busy: false })

    client = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...baseEnv(path.join(root, 'client-profile'), 'remote-client-e2e'),
        MAESTRLY_DEV_DIRECT_HOST: `http://${token}@127.0.0.1:${controlPort}`,
      },
    })
    page = await client.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()

    // The window lists this computer and the host, which it reaches.
    await expect
      .poll(async () => (await local('hostsList')).map((item: { id: string; state: string }) => [item.id, item.state]))
      .toEqual([
        ['local', 'online'],
        [HOST_ID, 'online'],
      ])
    const [, hostView] = await local('hostsList')
    expect(hostView).toMatchObject({ remote: true, desktopEffects: false, editor: false, browser: false, epoch: 1 })

    // Mixed sidebar: one section per host under its heading, in the Chats and in the Workspaces tab.
    await page.getByRole('tab', { name: 'Chats' }).click()
    await expect(chatsPanel().locator('[data-host-section-header]')).toHaveCount(2)
    await expect(chatsPanel().locator('[data-host-section-header="local"]')).toContainText('This computer')
    await expect(chatsPanel().locator(`[data-host-section-header="${HOST_ID}"]`)).toContainText(
      `127.0.0.1:${controlPort}`
    )
    await expect(chatsPanel().locator('[data-host-status]')).toHaveCount(0)
    await expect(remoteSection()).toContainText('No chats yet')

    // The host has its own accounts: the model is configured there, through the bridge.
    const provider = await remote('chatAddProvider', {
      name: 'Remote fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${portOf(model.server)}/v1`,
    })
    expect(provider.ok).toBe(true)
    await remote('chatSetDefault', { providerId: provider.id, modelId: 'remote-fixture' })
    const providersOf = async (call: typeof local) =>
      ((await call('chatConfig')).providers as Array<{ name: string }>).map((item) => item.name)
    expect(await providersOf(remote)).toContain('Remote fixture')
    expect(await providersOf(local)).not.toContain('Remote fixture')

    // A chat started from the host's section is created on the host and opens here.
    await remoteSection()
      .getByRole('button', { name: `New chat on 127.0.0.1:${controlPort}` })
      .click()
    await expect.poll(async () => (await remote('listStandaloneConversations', true)).length).toBe(1)
    expect(await local('listStandaloneConversations', true)).toEqual([])
    const [chat] = await remote('listStandaloneConversations', true)
    expect(chat.cwd.startsWith(path.join(root, 'host-profile'))).toBe(true)
    await expect(remoteSection().locator('.conv-item')).toHaveCount(1)
    await expect(page.locator('.chat-input:visible')).toBeFocused()
    await remote('chatSetSelection', chat.id, { providerId: provider.id, modelId: 'remote-fixture' })

    // The turn runs on the host: its model answers, and the answer streams into this window.
    await page.locator('.chat-input[contenteditable="true"]:visible').fill('hello from this computer')
    await page.locator('button[title="Send"]:visible').click()
    await expect(page.getByText('Answered on the host, turn 1.', { exact: false })).toBeVisible()
    await expect(page.locator('button[title="Stop"]:visible')).toHaveCount(0)
    expect(model.requests).toHaveLength(1)
    expect(JSON.stringify(model.requests[0].messages)).toContain('hello from this computer')
    expect(JSON.stringify(await remote('chatHistoryPage', chat.id))).toContain('Answered on the host, turn 1.')

    // Its drawer offers the tools this computer can show of a host: no browser and no editor yet.
    await page.getByTitle(/^Toggle drawer/).click()
    await page.getByTitle('Open a tool').click()
    const palette = page.getByRole('dialog', { name: 'Open a tool' })
    await expect(palette.getByText('Terminal', { exact: true })).toBeVisible()
    await expect(palette.getByText('Notes', { exact: true })).toBeVisible()
    await expect(palette.getByText('Browser', { exact: true })).toHaveCount(0)
    await expect(palette.getByText('Code', { exact: true })).toHaveCount(0)
    await palette.getByText('Terminal', { exact: true }).click()

    // The terminal is a shell of the host, shown by a panel of this window that reaches the host on its own.
    await expect.poll(async () => (await remote('getTerminalState', chat.id)).terminals.length).toBe(1)
    const terminalId = (await remote('getTerminalState', chat.id)).terminals[0].id as string
    const panel = await expect
      .poll(() => client!.windows().find((window) => window.url().includes('panel.html?panel=terminal')) ?? null)
      .not.toBeNull()
      .then(() => client!.windows().find((window) => window.url().includes('panel.html?panel=terminal'))!)
    const panelUrl = new URL(panel.url())
    expect(panelUrl.searchParams.get('conv')).toBe(chat.id)
    expect(panelUrl.searchParams.get('host')).toBe(HOST_ID)
    const typed = panel.locator('.xterm-helper-textarea')
    await expect(typed).toHaveCount(1)
    await typed.focus()
    await panel.keyboard.type('echo remote-$((40+2))-shell && pwd')
    await panel.keyboard.press('Enter')
    await expect
      .poll(async () => (await remote('readTerminal', terminalId)).data as string, { timeout: 30_000 })
      .toContain('remote-42-shell')
    expect((await remote('readTerminal', terminalId)).data).toContain(chat.cwd)

    // A workspace is added from the host's folders, browsed in a dialog of this window.
    await page.getByRole('tab', { name: 'Workspaces' }).click()
    const workspacesSection = page.locator(`#sidebar-panel-workspaces [data-host-section="${HOST_ID}"]`)
    await expect(workspacesSection).toContainText('No workspaces on this server.')
    await workspacesSection.getByRole('button', { name: `Add workspace on 127.0.0.1:${controlPort}` }).click()
    await page.getByRole('button', { name: 'Create new', exact: true }).click()
    await page.getByRole('button', { name: 'Choose…', exact: true }).click()
    const folders = page.getByRole('dialog', { name: 'Choose where to create the project on the server' })
    await expect(folders.getByTestId('host-folder-path')).toHaveText(workspacesRoot)
    await expect(folders.getByRole('button', { name: 'Home', exact: true })).toBeVisible()
    await folders.getByRole('button', { name: 'Choose this folder' }).click()
    await page.getByLabel('Project name').fill('remote-project')
    await page.getByRole('button', { name: 'Create project', exact: true }).click()
    await expect(workspacesSection.locator('[data-workspace-id]')).toHaveCount(1)
    await expect(workspacesSection).toContainText('remote-project')
    const workspaces = await remote('listWorkspaces', true)
    expect(workspaces.map((item: { path: string }) => item.path)).toEqual([path.join(workspacesRoot, 'remote-project')])
    await access(path.join(workspacesRoot, 'remote-project', '.git'))
    expect(await local('listWorkspaces', true)).toEqual([])

    // What needs the host's own desktop is refused there, and what is this computer's never goes to the host.
    await expect(remote('pickFolder')).rejects.toThrow(/not available on a remote host/)

    // The host goes away: its section says so and keeps its list; this computer's chats are untouched.
    await host.close()
    host = undefined
    await page.getByRole('tab', { name: 'Chats' }).click()
    await expect(chatsPanel().locator(`[data-host-section-header="${HOST_ID}"] [data-host-status]`)).toHaveAttribute(
      'data-host-status',
      'reconnecting'
    )
    await expect(remoteSection().locator('.conv-item')).toHaveCount(1)
    await expect(page.locator('[data-host-overlay="reconnecting"]')).toBeVisible()
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await expect.poll(async () => (await local('listStandaloneConversations', true)).length).toBe(1)
  } finally {
    await client?.close().catch(() => undefined)
    await host?.close().catch(() => undefined)
    await new Promise((resolve) => model.server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('without a remote host the sidebar has no host headings', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-remote-hosts-local-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: baseEnv(path.join(root, 'profile'), 'remote-none-e2e'),
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    expect(await page.evaluate(() => (window as any).api.hostsList())).toHaveLength(1)
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await expect(page.locator('.conv-item')).toHaveCount(1)
    await expect(page.locator('[data-host-section-header]')).toHaveCount(0)
    await expect(page.locator('[data-host-section]')).toHaveCount(0)
  } finally {
    await app?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
