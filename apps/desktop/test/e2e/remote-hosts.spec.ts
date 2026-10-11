import { createHash, randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { desktop, fixtureModel, instanceEnv, launchHost, listen, portOf } from './helpers/remote-host'

const HOST_ID = 'direct/host'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * Starts a host in server mode with its workspaces folder under `root`, and a person's desktop connected straight to
 * it (the development-only direct host), past its first-run screen.
 */
async function connect(root: string) {
  const workspacesRoot = path.join(root, 'srv')
  await mkdir(workspacesRoot)
  const launched = await launchHost(path.join(root, 'host-profile'), workspacesRoot)
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
    await expect(palette.getByText('Files', { exact: true })).toBeVisible()
    await expect(palette.getByText('Browser', { exact: true })).toHaveCount(0)
    await expect(palette.getByText('Code', { exact: true })).toHaveCount(0)
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
      env: instanceEnv(path.join(root, 'profile'), 'remote-none-e2e'),
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
    await page.getByRole('tab', { name: 'Chats' }).click()
    await page
      .locator(`#sidebar-panel-chats [data-host-section="${HOST_ID}"]`)
      .getByRole('button', { name: `New chat on 127.0.0.1:${controlPort}` })
      .click()
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
