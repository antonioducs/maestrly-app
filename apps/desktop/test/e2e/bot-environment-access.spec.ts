import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { createEnvironmentAccessGateway } from './helpers/environment-access-gateway'
import {
  desktop,
  fixtureModel,
  instanceEnv,
  type LaunchedHost,
  launchHost,
  listen,
  portOf,
} from './helpers/remote-host'

// A fleet bot works in a workspaces environment of its server without any of the owner's computers in the way: the
// owner gives Scout access from the bot's settings, over the host's bridge; the host links itself to Scout with its own
// token; Scout's calls reach the host's control server, which starts the conversation in a worktree of the host, with
// the bot's badge, under the grants the owner chose. The host is the built app in server mode; the server is a fixture.
test('a fleet bot starts conversations in a workspaces environment the owner gave it, from the bot settings', async () => {
  test.setTimeout(300_000)
  test.skip(process.platform === 'win32', 'The host side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-environment-access-')))
  const workspacesRoot = path.join(root, 'srv')
  const repo = path.join(workspacesRoot, 'site')
  const hostToken = randomBytes(32).toString('base64url')
  let host: LaunchedHost | null = null
  let client: ElectronApplication | undefined
  const gateway = await createEnvironmentAccessGateway(() => host, hostToken)
  const model = fixtureModel()
  try {
    // ---- A repository on the host, the host itself, and the owner's computer paired with the server ----------------
    await mkdir(repo, { recursive: true })
    await writeFile(path.join(repo, 'README.md'), 'environment-access-source\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture')
    await listen(model.server)
    host = await launchHost(path.join(root, 'host-profile'), workspacesRoot, {
      MAESTRLY_BOT_GATEWAY_URL: gateway.url,
      MAESTRLY_HOST_GATEWAY_TOKEN: hostToken,
    })
    // A host with its token says it takes bots' calls; it keeps the token from what it starts.
    const health = await fetch(`http://127.0.0.1:${host.port}/v1/health`, {
      headers: { 'X-Maestrly-Fleet-Protocol': '1', Authorization: `Bearer ${host.token}` },
    })
    expect(((await health.json()) as { capabilities: string[] }).capabilities).toContain('host-desktop-calls')
    expect(await host.app.evaluate(() => process.env.MAESTRLY_HOST_GATEWAY_TOKEN ?? null)).toBeNull()

    client = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: instanceEnv(path.join(root, 'client-profile'), 'environment-access-e2e'),
    })
    const page: Page = await client.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const local = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
    await local('fleetConnect', { url: gateway.url, code: 'ABCD-EFGH', deviceName: 'MacBook' })
    let hostId = ''
    await expect
      .poll(
        async () => {
          const remote = ((await local('hostsList')) as Array<{ id: string; remote: boolean; state: string }>).find(
            (item) => item.remote
          )
          hostId = remote?.state === 'online' ? remote.id : ''
          return hostId
        },
        { timeout: 60_000 }
      )
      .toMatch(/\/workspaces$/)
    const remote = (name: string, ...args: unknown[]) =>
      page.evaluate(({ hostId, name, args }) => (window as any).api.hostApi(hostId)[name](...args), {
        hostId,
        name,
        args,
      })
    const provider = (await remote('chatAddProvider', {
      name: 'Host fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${portOf(model.server)}/v1`,
    })) as { ok: boolean; id: string }
    expect(provider.ok).toBe(true)
    await remote('chatSetDefault', { providerId: provider.id, modelId: 'remote-fixture' })
    const workspace = (await remote('addWorkspace', repo)) as { id: string; name: string }
    // This computer gives Scout nothing of its own here: the environment does.
    expect(await local('listWorkspaces')).toEqual([])

    // ---- The owner gives Scout access to the environment's project, from Scout's settings ---------------------------
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await page.getByRole('button', { name: /Scout/ }).first().click()
    await page.getByRole('button', { name: 'Bot settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Scout settings' })
    await settings
      .getByRole('tablist', { name: 'Settings sections', exact: true })
      .getByRole('tab', { name: /^Projects\b/ })
      .click()
    await expect(settings.getByRole('heading', { name: 'Workspaces on the server', level: 2 })).toBeVisible()
    const card = settings.getByTestId('fleet-environment-access').filter({ hasText: 'Personal' })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('switch', { name: 'Give this bot access to this environment' }).click()
    const name = card.getByLabel('Name this environment shows the bot')
    await expect(name).toHaveValue('Personal')
    // Nothing is granted until the owner chooses it: the host's projects and models are the ones offered.
    await expect(card.getByTestId('fleet-environment-access-blockers')).toContainText('Choose at least one project.')
    await expect(card.getByText('Projects of this environment')).toBeVisible()
    await card.getByLabel(workspace.name, { exact: true }).check()
    await card.getByLabel('remote-fixture', { exact: true }).check()
    await card.getByTestId('fleet-environment-access-save').click()
    await expect(card).toContainText('This environment gives access as “Personal”.')
    // The host linked itself with its own token, naming nothing but the name the bot sees.
    expect(
      gateway.requests
        .filter((request) => request.key === 'hostDesktopLinkPut')
        .map(({ body, auth }) => ({ body, auth }))
    ).toEqual([{ body: { name: 'Personal' }, auth: `Bearer ${hostToken}` }])
    const link = gateway.link()
    expect(link?.desktopId).toMatch(/^dsk_/)
    // Among the bot's other links, the environment shows as one of the server's.
    const other = settings.getByTestId('fleet-desktop-other').filter({ hasText: 'Personal' })
    await expect(other).toHaveAttribute('data-kind', 'environment')
    await expect(other).toContainText('Server environment')
    await page.screenshot({ path: test.info().outputPath('bot-environment-access.png') })
    await settings.getByRole('heading', { name: 'Workspaces on the server', level: 2 }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('bot-environment-access-section.png') })
    await settings.getByRole('button', { name: 'Close settings', exact: true }).click()

    // ---- Scout lists what the environment gave it: names, branches and models, never a host path -------------------
    const listed = await gateway.call('listWorkspaces')
    expect(listed).toMatchObject({
      ok: true,
      value: {
        desktop: { id: link!.desktopId, name: 'Personal' },
        workspaces: [
          expect.objectContaining({ workspaceId: workspace.id, branches: expect.arrayContaining(['main']) }),
        ],
      },
    })
    expect(JSON.stringify(listed)).not.toContain(workspacesRoot)
    const selectionId = (listed as { value: { selections: Array<{ selectionId: string }> } }).value.selections[0]
      .selectionId

    // ---- Scout starts a conversation; it runs on the host, in a worktree of its own, with Scout's badge -------------
    const created = await gateway.call('createChat', {
      workspaceId: workspace.id,
      name: 'Scout on the server',
      baseBranch: 'main',
      selection: { selectionId },
      message: 'Report from the environment.',
      idempotencyKey: randomUUID(),
    })
    expect(created).toMatchObject({ ok: true, value: { conversation: { name: 'Scout on the server' } } })
    const conversationId = (created as { value: { conversation: { id: string } } }).value.conversation.id
    const conversations = async () =>
      (await remote('listConversations', workspace.id)) as Array<{
        id: string
        name: string
        cwd: string
        botOrigin?: { botName: string }
        botManagementState?: string
      }>
    await expect
      .poll(
        async () => (await conversations()).find((item) => item.name === 'Scout on the server')?.botOrigin?.botName,
        {
          timeout: 60_000,
        }
      )
      .toBe('Scout')
    const conversation = (await conversations()).find((item) => item.name === 'Scout on the server')!
    expect(conversation.cwd).not.toBe(repo)
    // The host's model ran Scout's instruction.
    await expect
      .poll(() => model.requests.some((request) => JSON.stringify(request).includes('Report from the environment.')), {
        timeout: 60_000,
      })
      .toBe(true)

    // ---- The owner pauses it from this computer: Scout sees it paused, then active again ----------------------------
    const state = async () =>
      (
        (await gateway.call('listChats')) as {
          value: { conversations: Array<{ id: string; managementState: string }> }
        }
      ).value.conversations.find((item) => item.id === conversationId)?.managementState
    expect(await state()).toBe('active')
    await remote('botSetManagement', conversation.id, 'paused')
    await expect.poll(state).toBe('paused')
    await remote('botSetManagement', conversation.id, 'active')
    await expect.poll(state).toBe('active')

    // ---- Turned off on the host, Scout loses the environment at once ------------------------------------------------
    expect(await remote('environmentBotAccessDisable', 'scout')).toMatchObject({ access: null })
    expect(gateway.requests.some((request) => request.key === 'hostDesktopLinkDelete')).toBe(true)
    expect(gateway.link()).toBeNull()
    expect(await gateway.call('listWorkspaces')).toMatchObject({ ok: false, error: { code: 'desktop_not_linked' } })
    expect(gateway.errors).toEqual([])
  } finally {
    await client?.close().catch(() => undefined)
    await host?.app.close().catch(() => undefined)
    await gateway.close()
    await new Promise((resolve) => model.server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
