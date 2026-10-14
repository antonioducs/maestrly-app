import { createHash, randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { WebSocketServer } from 'ws'
import { desktop, fixtureModel, instanceEnv, launchHost, listen, portOf } from './helpers/remote-host'

const HOST_ID = 'direct/host'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * Starts a host in server mode with its workspaces folder under `root`, and a person's desktop connected straight to
 * it (the development-only direct host), past its first-run screen.
 */
async function connect(root: string, hostEnv: Record<string, string> = {}) {
  const workspacesRoot = path.join(root, 'srv')
  await mkdir(workspacesRoot)
  const launched = await launchHost(path.join(root, 'host-profile'), workspacesRoot, hostEnv)
  let client: ElectronApplication
  try {
    client = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...instanceEnv(path.join(root, 'client-profile'), 'remote-client-e2e'),
        MAESTRLY_DEV_DIRECT_HOST: `http://${launched.token}@127.0.0.1:${launched.port}`,
      },
    })
  } catch (error) {
    await launched.app.close().catch(() => undefined)
    throw error
  }
  const page = await client.firstWindow()
  await page.waitForFunction(() => Boolean((window as any).api))
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  const local = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
  const remote = (name: string, ...args: unknown[]) =>
    page.evaluate(({ hostId, name, args }) => (window as any).api.hostApi(hostId)[name](...args), {
      hostId: HOST_ID,
      name,
      args,
    })
  return { host: launched.app, controlPort: launched.port, client, page, workspacesRoot, local, remote }
}

/** A panel page of the client's drawer, once it is open. */
async function panelOf(client: ElectronApplication, panel: string) {
  const find = () => client.windows().find((window) => window.url().includes(`panel.html?panel=${panel}`)) ?? null
  await expect.poll(find).not.toBeNull()
  return find()!
}

/** Shows the host's chats in the sidebar, which lists one machine at a time, and starts a chat there. */
async function newChatOnHost(page: Page, controlPort: number) {
  await page.getByRole('tab', { name: 'Chats' }).click()
  await page.locator(`[data-host-shortcut="${HOST_ID}"]`).click()
  await expect(page.locator('[data-host-switcher]')).toHaveAttribute('data-host-switcher', HOST_ID)
  await page.getByRole('button', { name: `New chat on 127.0.0.1:${controlPort}`, exact: true }).click()
}

// Two real Electron instances of the built app on this machine: one hosts workspaces in server mode, the other is a
// person's desktop connected straight to it (the development-only direct host). No gateway, Docker or account.
test('remote host: mixed sidebar, a chat turn and a terminal that run on the host', async () => {
  test.setTimeout(240_000)
  // A workspaces host is the app in a Linux container; this test runs one on the machine itself, which the host's
  // shell and folders allow on Linux and macOS only.
  test.skip(process.platform === 'win32', 'The host side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-remote-hosts-')))
  const model = fixtureModel()
  let host: ElectronApplication | undefined
  let client: ElectronApplication | undefined
  let page!: Page
  let local!: Awaited<ReturnType<typeof connect>>['local']
  let remote!: Awaited<ReturnType<typeof connect>>['remote']
  const chatsPanel = () => page.locator('#sidebar-panel-chats')
  const remoteSection = () => chatsPanel().locator(`[data-host-section="${HOST_ID}"]`)

  try {
    await listen(model.server)
    const connected = await connect(root)
    ;({ host, client, page, local, remote } = connected)
    const { controlPort, workspacesRoot } = connected

    // The window lists this computer and the host, which it reaches.
    await expect
      .poll(async () => (await local('hostsList')).map((item: { id: string; state: string }) => [item.id, item.state]))
      .toEqual([
        ['local', 'online'],
        [HOST_ID, 'online'],
      ])
    const [, hostView] = await local('hostsList')
    expect(hostView).toMatchObject({ remote: true, desktopEffects: false, editor: true, browser: true, epoch: 1 })

    // Mixed sidebar: one machine at a time, chosen in a switcher that offers both, in the Chats and Workspaces tabs.
    await page.getByRole('tab', { name: 'Chats' }).click()
    const switcher = page.locator('[data-host-switcher]')
    await expect(switcher).toHaveAttribute('data-host-switcher', 'local')
    await expect(switcher).toContainText('This computer')
    await expect(chatsPanel().locator('[data-host-section="local"]')).toHaveCount(1)
    await expect(remoteSection()).toHaveCount(0)
    await expect(page.locator('[data-host-status]')).toHaveCount(0)
    await switcher.click()
    await expect(page.locator('[data-host-option]')).toHaveCount(2)
    await expect(page.locator(`[data-host-option="${HOST_ID}"]`)).toContainText(`127.0.0.1:${controlPort}`)
    await page.keyboard.press('Escape')
    await page.locator(`[data-host-shortcut="${HOST_ID}"]`).click()
    await expect(switcher).toHaveAttribute('data-host-switcher', HOST_ID)
    await expect(switcher).toContainText(`127.0.0.1:${controlPort}`)
    await expect(chatsPanel().locator('[data-host-section="local"]')).toHaveCount(0)
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

    // A chat started while the host is shown is created on the host and opens here.
    await page.getByRole('button', { name: `New chat on 127.0.0.1:${controlPort}`, exact: true }).click()
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

    // Its drawer offers the tools this computer can show of a host: its streamed browser and its editor among them.
    await page.getByTitle(/^Toggle drawer/).click()
    await page.getByTitle('Open a tool').click()
    const palette = page.getByRole('dialog', { name: 'Open a tool' })
    await expect(palette.getByText('Terminal', { exact: true })).toBeVisible()
    await expect(palette.getByText('Notes', { exact: true })).toBeVisible()
    await expect(palette.getByText('Files', { exact: true })).toBeVisible()
    await expect(palette.getByText('Browser', { exact: true })).toBeVisible()
    await expect(palette.getByText('Code', { exact: true })).toBeVisible()
    await palette.getByText('Terminal', { exact: true }).click()

    // The terminal is a shell of the host, shown by a panel of this window that reaches the host on its own.
    await expect.poll(async () => (await remote('getTerminalState', chat.id)).terminals.length).toBe(1)
    const terminalId = (await remote('getTerminalState', chat.id)).terminals[0].id as string
    const panel = await panelOf(client, 'terminal')
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

    // A workspace is added from the host's folders, browsed in a dialog of this window. The host stays chosen across
    // tabs.
    await page.getByRole('tab', { name: 'Workspaces' }).click()
    await expect(switcher).toHaveAttribute('data-host-switcher', HOST_ID)
    const workspacesSection = page.locator(`#sidebar-panel-workspaces [data-host-section="${HOST_ID}"]`)
    await expect(workspacesSection).toContainText('No workspaces in this environment.')
    await page.getByRole('button', { name: `Add workspace on 127.0.0.1:${controlPort}`, exact: true }).click()
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

    // The host goes away: the switcher says so, its section keeps its list and creates nothing there; this
    // computer's chats are untouched.
    await host.close()
    host = undefined
    await page.getByRole('tab', { name: 'Chats' }).click()
    await expect(switcher.locator('[data-host-status]')).toHaveAttribute('data-host-status', 'reconnecting')
    await expect(remoteSection().locator('.conv-item')).toHaveCount(1)
    await expect(page.locator('[data-host-overlay="reconnecting"]')).toBeVisible()
    await expect(page.getByRole('button', { name: `New chat on 127.0.0.1:${controlPort}`, exact: true })).toBeDisabled()
    await page.locator('[data-host-shortcut="local"]').click()
    await expect(switcher).toHaveAttribute('data-host-switcher', 'local')
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await expect.poll(async () => (await local('listStandaloneConversations', true)).length).toBe(1)
  } finally {
    await client?.close().catch(() => undefined)
    await host?.close().catch(() => undefined)
    await new Promise((resolve) => model.server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('without a remote host the sidebar has no host switcher', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-remote-hosts-local-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: instanceEnv(path.join(root, 'profile'), 'remote-none-e2e'),
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    expect(await page.evaluate(() => (window as any).api.hostsList())).toHaveLength(1)
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await expect(page.locator('.conv-item')).toHaveCount(1)
    await expect(page.locator('[data-host-switcher]')).toHaveCount(0)
    await expect(page.locator('[data-host-section]')).toHaveCount(0)
  } finally {
    await app?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

// Files of a host, moved to and from this computer through the host's control server, as the gateway would carry them.
test('remote host files: browse, preview, rename, delete, upload and download', async () => {
  test.setTimeout(240_000)
  test.skip(process.platform === 'win32', 'The host side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-remote-files-')))
  let host: ElectronApplication | undefined
  let client: ElectronApplication | undefined
  try {
    const connected = await connect(root)
    ;({ host, client } = connected)
    const { page, remote, workspacesRoot, controlPort } = connected
    const report = Buffer.from('id,name,amount\n1,alpha,10\n2,beta,20\n'.repeat(140_000))
    await writeFile(path.join(workspacesRoot, 'report.csv'), report)
    await writeFile(path.join(workspacesRoot, 'notes.txt'), 'hello from the host\n')
    // Outside the host's folders, on this computer: 5 upload chunks and 2 download ranges.
    const big = randomBytes(70 * 1024 * 1024)
    const bigPath = path.join(root, 'local', 'big.bin')
    await mkdir(path.dirname(bigPath))
    await writeFile(bigPath, big)
    const downloads = path.join(root, 'downloads')
    await mkdir(downloads)
    await client.evaluate(({ app }, dir) => app.setPath('downloads', dir), downloads)

    // A chat on the host, and its drawer's Files tab: a panel of this window that reaches the host on its own.
    await newChatOnHost(page, controlPort)
    await expect.poll(async () => (await remote('listStandaloneConversations', true)).length).toBe(1)
    const [chat] = await remote('listStandaloneConversations', true)
    await page.getByTitle(/^Toggle drawer/).click()
    await page.getByTitle('Open a tool').click()
    await page.getByRole('dialog', { name: 'Open a tool' }).getByText('Files', { exact: true }).click()
    const panel = await panelOf(client, 'files')
    const panelUrl = new URL(panel.url())
    expect([panelUrl.searchParams.get('conv'), panelUrl.searchParams.get('host')]).toEqual([chat.id, HOST_ID])

    // The chat's folder is outside the host's folders here, so the panel opens on the workspaces folder.
    await expect(panel.getByTestId('files-path')).toHaveText(workspacesRoot)
    await expect(panel.locator('[data-file-entry="report.csv"]')).toBeVisible()
    await expect(panel.locator('[data-file-entry="notes.txt"]')).toBeVisible()

    const more = (name: string) => panel.getByRole('button', { name: `More actions: ${name}` })
    await more('notes.txt').click()
    await panel.getByRole('menuitem', { name: 'Preview' }).click()
    await expect(panel.getByTestId('file-preview')).toContainText('hello from the host')
    await panel.keyboard.press('Escape')
    await expect(panel.getByTestId('file-preview')).toHaveCount(0)

    await more('notes.txt').click()
    await panel.getByRole('menuitem', { name: 'Rename' }).click()
    await panel.getByLabel('New name').fill('memo.txt')
    await panel.keyboard.press('Enter')
    await expect(panel.locator('[data-file-entry="memo.txt"]')).toBeVisible()
    await access(path.join(workspacesRoot, 'memo.txt'))

    await more('memo.txt').click()
    await panel.getByRole('menuitem', { name: 'Delete' }).click()
    await panel.getByRole('dialog', { name: 'Delete memo.txt?' }).getByRole('button', { name: 'Delete' }).click()
    await expect(panel.locator('[data-file-entry="memo.txt"]')).toHaveCount(0)
    expect(await readdir(workspacesRoot)).not.toContain('memo.txt')

    // Upload: the file comes from this computer's file dialog, and lands in the folder on screen.
    await client.evaluate(
      ({ dialog }, files) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as typeof dialog.showOpenDialog
      },
      [bigPath]
    )
    await panel.getByRole('button', { name: 'Upload…' }).click()
    await expect(panel.locator('[data-transfer="big.bin"][data-transfer-state="done"]')).toHaveCount(1, {
      timeout: 120_000,
    })
    expect(sha(await readFile(path.join(workspacesRoot, 'big.bin')))).toBe(sha(big))
    expect((await readdir(workspacesRoot)).filter((name) => name.endsWith('.part'))).toEqual([])
    await expect(panel.locator('[data-file-entry="big.bin"]')).toBeVisible()

    // Download to this computer's Downloads folder, checked whole.
    await panel.getByRole('button', { name: 'Download to this computer: big.bin' }).click()
    await panel.getByRole('button', { name: 'Download to this computer: report.csv' }).click()
    await expect
      .poll(async () => (await readdir(downloads)).sort(), { timeout: 120_000 })
      .toEqual(['big.bin', 'report.csv'])
    await expect(panel.locator('[data-transfer="big.bin"][data-transfer-state="done"]')).toHaveCount(2, {
      timeout: 120_000,
    })
    await expect(panel.locator('[data-transfer="report.csv"][data-transfer-state="done"]')).toHaveCount(1)
    expect(sha(await readFile(path.join(downloads, 'big.bin')))).toBe(sha(big))
    expect(sha(await readFile(path.join(downloads, 'report.csv')))).toBe(sha(report))
    await panel.setViewportSize({ width: 520, height: 760 }).catch(() => undefined)

    // Open on this computer: downloaded into a folder of its own, then opened there.
    await client.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as typeof globalThis & { __opened: string[] }).__opened = opened
      shell.openPath = (async (file: string) => {
        opened.push(file)
        return ''
      }) as typeof shell.openPath
    })
    await more('report.csv').click()
    await panel.getByRole('menuitem', { name: 'Open on this computer' }).click()
    const opened = await expect
      .poll(() => client!.evaluate(() => (globalThis as typeof globalThis & { __opened: string[] }).__opened), {
        timeout: 60_000,
      })
      .toHaveLength(1)
      .then(() => client!.evaluate(() => (globalThis as typeof globalThis & { __opened: string[] }).__opened[0]))
    expect(opened).toContain(`${path.sep}maestrly-remote-files${path.sep}`)
    expect(path.basename(opened)).toBe('report.csv')
    expect(sha(await readFile(opened))).toBe(sha(report))
  } finally {
    await client?.close().catch(() => undefined)
    await host?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

// The browser of a host's conversation, streamed into this window's drawer: its frames are drawn here, and what the
// person types and copies goes to the page on the host.
test('remote host browser: streamed live, typed into and copied from', async () => {
  test.setTimeout(240_000)
  test.skip(process.platform === 'win32', 'The host side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-remote-browser-')))
  // A page whose one field fills the viewport: a click anywhere on the frame lands in it, and its title follows it.
  const site = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(
      '<!doctype html><html><head><title>remote-start</title></head><body style="margin:0">' +
        '<input id="field" autocomplete="off" style="position:fixed;inset:0;width:100%;height:100%;font-size:32px"' +
        ' oninput="document.title = this.value"></body></html>'
    )
  })
  let host: ElectronApplication | undefined
  let client: ElectronApplication | undefined
  try {
    await listen(site)
    const pageUrl = `http://127.0.0.1:${portOf(site)}/field`
    const connected = await connect(root)
    ;({ host, client } = connected)
    const { page, remote, controlPort } = connected
    await newChatOnHost(page, controlPort)
    await expect.poll(async () => (await remote('listStandaloneConversations', true)).length).toBe(1)
    const [chat] = await remote('listStandaloneConversations', true)

    // The Browser tab streams the host's page into a canvas of this window.
    await page.getByTitle(/^Toggle drawer/).click()
    await page.getByTitle('Open a tool').click()
    await page.getByRole('dialog', { name: 'Open a tool' }).getByText('Browser', { exact: true }).click()
    const canvas = page.getByTestId('remote-browser-canvas')
    await expect(canvas).toHaveAttribute('data-live', 'true', { timeout: 60_000 })
    await expect(page.getByRole('button', { name: /developer tools/i })).toHaveCount(0)
    // On the host the page is shown in its stream window, at the size of this window's surface.
    const box = await canvas.boundingBox()
    const presented = await host.evaluate(
      (_electron, id) => (globalThis as any).__maestrlyE2EInspectBrowserView(id),
      chat.id as string
    )
    expect(presented).toMatchObject({ ownerCount: 1, ownerVisible: true })
    expect(presented.bounds.x).toBe(0)
    expect(
      Math.abs(presented.bounds.width - Math.min(1280, Math.max(480, Math.round(box!.width))))
    ).toBeLessThanOrEqual(1)

    // The address bar drives the host's browser.
    const address = page.getByPlaceholder('Search or type a URL')
    await address.fill(pageUrl)
    // The page's own events while the person types (here the start page reloading on the host) leave the typed text.
    await remote('drawerReload', chat.id)
    await page.waitForTimeout(1_500)
    await expect(address).toHaveValue(pageUrl)
    await address.press('Enter')
    await expect
      .poll(async () => (await remote('getBrowserState', chat.id)).tabs[0]?.url, { timeout: 30_000 })
      .toBe(pageUrl)
    await expect
      .poll(async () => (await remote('getBrowserState', chat.id)).tabs[0]?.title, { timeout: 30_000 })
      .toBe('remote-start')

    // Typing reaches the page: accents arrive as text, the way the hidden field composed them.
    await canvas.click({ position: { x: box!.width / 2, y: box!.height / 2 } })
    await expect(page.getByTestId('remote-browser-keyboard')).toBeFocused()
    await page.keyboard.type('ação ok')
    await expect
      .poll(async () => (await remote('getBrowserState', chat.id)).tabs[0]?.title, { timeout: 30_000 })
      .toBe('ação ok')

    // Copying selects and copies on the host, and the text lands on this computer's clipboard.
    const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
    await client.evaluate(({ clipboard }) => clipboard.writeText('before'))
    await page.keyboard.press(`${accel}+A`)
    await page.keyboard.press(`${accel}+C`)
    await expect
      .poll(() => client!.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 15_000 })
      .toBe('ação ok')
  } finally {
    await client?.close().catch(() => undefined)
    await host?.close().catch(() => undefined)
    await new Promise((resolve) => site.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

// The editor of a host's conversation: VS Code's serve-web on the host (here a stand-in the test runs, so no editor is
// downloaded), opened in a native view of this window's drawer through this computer's proxy and the host's.
test("remote host editor: opened through both proxies, which keep each side's credentials to themselves", async () => {
  test.setTimeout(240_000)
  test.skip(process.platform === 'win32', 'The host side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-remote-editor-')))
  const editorToken = randomBytes(16).toString('hex')
  const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = []
  const upgrades: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = []
  // serve-web in miniature: a workbench page that opens the editor's WebSocket and shows what it answered.
  const serveWeb = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // Without the token cookie serve-web sets on its page: the host gives the page its token itself.
      'set-cookie': ['vscode-cli-secret-half=half; Path=/'],
    })
    res.end(
      '<!doctype html><html><head><title>editor-loading</title></head><body><script>' +
        "const ws = new WebSocket('ws://' + location.host + '/stable-fake?reconnectionToken=r1');" +
        "ws.onopen = () => ws.send('hello'); ws.onmessage = (e) => { document.title = 'editor:' + e.data };" +
        '</script></body></html>'
    )
  })
  const wss = new WebSocketServer({ server: serveWeb })
  wss.on('connection', (socket, req) => {
    upgrades.push({ url: req.url ?? '', headers: req.headers })
    socket.on('message', (data) => socket.send('echo:' + String(data)))
  })
  let host: ElectronApplication | undefined
  let client: ElectronApplication | undefined
  try {
    await listen(serveWeb)
    const connected = await connect(root, { MAESTRLY_E2E_VSCODE_SERVER: `${portOf(serveWeb)}:${editorToken}` })
    ;({ host, client } = connected)
    const { page, remote, controlPort } = connected
    await newChatOnHost(page, controlPort)
    await expect.poll(async () => (await remote('listStandaloneConversations', true)).length).toBe(1)
    const [chat] = await remote('listStandaloneConversations', true)
    await writeFile(path.join(chat.cwd, 'hello.js'), 'console.log("hello from the host")\n')

    // The Code tab opens the host's editor in the chat's folder, at this computer's origin for the host.
    await page.getByTitle(/^Toggle drawer/).click()
    await page.getByTitle('Open a tool').click()
    await page.getByRole('dialog', { name: 'Open a tool' }).getByText('Code', { exact: true }).click()
    // The editor's view as this computer's main process knows it: Playwright may keep the first page a view showed.
    const editorView = () =>
      client!.evaluate(({ webContents }) => {
        const view = webContents.getAllWebContents().find((contents) => contents.getURL().includes('folder='))
        return view ? { id: view.id, url: view.getURL() } : null
      })
    const inEditor = async (script: string): Promise<string> => {
      const view = await editorView()
      if (!view) return ''
      return client!
        .evaluate(
          ({ webContents }, [id, code]) => webContents.fromId(id as number)!.executeJavaScript(code as string),
          [view.id, script]
        )
        .catch(() => '')
    }
    // What every page of this computer shows, said when the editor is not found.
    const views = () =>
      client!.evaluate(({ webContents }) =>
        webContents.getAllWebContents().map((contents) => {
          const url = contents.getURL()
          return url.startsWith('data:') ? 'data: ' + contents.getTitle() : url
        })
      )
    try {
      await expect.poll(editorView, { timeout: 60_000 }).not.toBeNull()
    } catch (error) {
      console.log('Editor view not found; pages:', JSON.stringify(await views().catch(String)))
      throw error
    }
    const editorUrl = new URL((await editorView())!.url)
    expect(editorUrl.hostname).toBe('127.0.0.1')
    expect(editorUrl.searchParams.get('folder')).toBe(chat.cwd)
    // Its WebSocket reaches the editor through both proxies.
    await expect.poll(() => inEditor('document.title'), { timeout: 30_000 }).toBe('editor:echo:hello')

    // The editor got the token from the host, and nothing of this computer's proxy or of the control server.
    // (The host also asks serve-web directly whether it is ready, with the token in the address.)
    const first = requests.find((request) => request.url.startsWith('/?folder='))!
    expect(first.url).toBe(`/?folder=${encodeURIComponent(chat.cwd)}`)
    expect(first.headers.cookie).toContain(`vscode-tkn=${editorToken}`)
    expect(first.headers.cookie).not.toContain('maestrly-editor-access')
    expect(first.headers.authorization).toBeUndefined()
    expect(first.headers['x-forwarded-host']).toBe(editorUrl.host)
    expect(upgrades[0].url).toBe('/stable-fake?reconnectionToken=r1')
    expect(upgrades[0].headers.cookie).toContain(`vscode-tkn=${editorToken}`)
    expect(upgrades[0].headers.authorization).toBeUndefined()
    // The page holds the token, which VS Code's page sends to authenticate its connection, and the editor's cookies;
    // the proxy's access cookie is out of its reach.
    const cookies = await inEditor('document.cookie')
    expect(cookies).toContain(`vscode-tkn=${editorToken}`)
    expect(cookies).toContain('vscode-cli-secret-half=half')
    expect(cookies).not.toContain('maestrly-editor-access')
    // Another program of this computer cannot use the proxy: it lacks the view's access cookie.
    expect((await fetch(editorUrl.origin + '/')).status).toBe(403)

    // A Plan file chip of the host's conversation opens its file in the editor: the Code tab comes back.
    await page.getByTitle('Open a tool').click()
    await page.getByRole('dialog', { name: 'Open a tool' }).getByText('Notes', { exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Code Close Code', exact: true })).toHaveAttribute(
      'aria-selected',
      'false'
    )
    await remote('openPlanFile', chat.id, 'hello.js', 1)
    await expect(page.getByRole('tab', { name: 'Code Close Code', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    const sidecar = JSON.parse(await readFile(path.join(chat.cwd, '.maestrly', 'agent-open-file.json'), 'utf8'))
    expect(sidecar).toMatchObject({ rel: 'hello.js', line: 1 })

    // What the person sends from the editor becomes a reference in this window's composer.
    await writeFile(
      path.join(chat.cwd, '.maestrly', 'agent-selection.json'),
      JSON.stringify({
        kind: 'selection',
        path: path.join(chat.cwd, 'hello.js'),
        startLine: 1,
        endLine: 2,
        ts: Date.now(),
      })
    )
    // The composer shows the reference as a chip of the file and its lines.
    await expect(page.locator('.chat-input:visible')).toContainText('hello.js:L1-2')
  } finally {
    await client?.close().catch(() => undefined)
    await host?.close().catch(() => undefined)
    for (const socket of wss.clients) socket.terminate()
    await new Promise((resolve) => serveWeb.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

// The personal memory of the host's chats lives in the host's profile, apart from this computer's: the memory center
// shows either one, and what is written there stays on its own side.
test("remote host personal memory: shown, written and kept apart from this computer's", async () => {
  test.setTimeout(180_000)
  test.skip(process.platform === 'win32', 'The host side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-remote-memory-')))
  let host: ElectronApplication | undefined
  let client: ElectronApplication | undefined
  try {
    const connected = await connect(root)
    ;({ host, client } = connected)
    const { page, local, remote, controlPort } = connected
    const server = `127.0.0.1:${controlPort}`
    const memory = (title: string) => ({ title, content: `${title}: synthetic content.`, type: 'reference' })
    await remote('createPersonalMemory', memory('Server synthetic memory'))
    await local('createPersonalMemory', memory('Local synthetic memory'))
    const titles = async (api: typeof local) =>
      ((await api('listPersonalMemories')) as Array<{ title: string }>).map((item) => item.title).sort()

    // From the host's chat settings, Manage opens the memory center on the host's personal memory.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settingsHost = page.locator('[data-settings-host]')
    await settingsHost.getByRole('combobox').click()
    await page.getByRole('option', { name: server }).click()
    await expect(settingsHost.getByRole('combobox')).toContainText(server)
    await page.getByRole('tab', { name: 'Models & agents', exact: true }).click()
    await page.getByRole('button', { name: 'Manage personal memory', exact: true }).click()
    const panel = page.getByTestId('personal-memory-panel')
    const memoryHost = panel.locator('[data-memory-host]').getByRole('combobox', { name: 'Memories of' })
    await expect(memoryHost).toContainText(server)
    const rows = panel.getByTestId('personal-memory-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Server synthetic memory')

    // A memory written there is the host's.
    await panel.getByRole('button', { name: 'New memory', exact: true }).first().click()
    await page.getByPlaceholder('Title', { exact: true }).fill('Written from this computer')
    await page.getByPlaceholder('Durable content', { exact: true }).fill('Kept in the server profile.')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => titles(remote)).toEqual(['Server synthetic memory', 'Written from this computer'])
    expect(await titles(local)).toEqual(['Local synthetic memory'])
    await page
      .getByRole('dialog', { name: 'Memory details', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click()
    await expect(rows).toHaveCount(2)

    // A change made on the host by anyone shows here as it happens.
    await remote('createPersonalMemory', memory('Added by the agent on the server'))
    await expect(rows).toHaveCount(3)

    // This computer's personal memory is a choice away, and holds only its own.
    await memoryHost.click()
    await page.getByRole('option', { name: 'This computer' }).click()
    await expect(memoryHost).toContainText('This computer')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Local synthetic memory')
    await memoryHost.click()
    await page.getByRole('option', { name: server }).click()
    await expect(rows).toHaveCount(3)

    // Its settings dialog is the host's too.
    await panel.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Personal memory settings' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('checkbox', { name: /Enable personal memory/ }).uncheck()
    await dialog.getByRole('button', { name: 'Save memory settings', exact: true }).click()
    await expect.poll(async () => (await remote('getPersonalMemorySettings')).enabled).toBe(false)
    expect((await local('getPersonalMemorySettings')).enabled).toBe(true)
    await expect(panel.getByRole('checkbox', { name: 'Enable personal memory' })).not.toBeChecked()
  } finally {
    await client?.close().catch(() => undefined)
    await host?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
