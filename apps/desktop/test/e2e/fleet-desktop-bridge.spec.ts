import { createServer, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import { createDesktopBridgeGateway, OTHER_DESKTOP_ID } from './helpers/desktop-bridge-gateway'

const desktop = fileURLToPath(new URL('../..', import.meta.url))

/** A tab of the bot settings, by its label; its name may go on to say it has unsaved changes. */
const settingsTab = (settings: Locator, label: string) =>
  settings
    .getByRole('tablist', { name: 'Seções dos ajustes', exact: true })
    .getByRole('tab', { name: new RegExp(`^${label}\\b`) })

/**
 * A bot of the owner's bot server works in the projects this computer gave it, through this computer's own event
 * stream: the real desktop application answers the bot's calls from a server fixture, starts the conversation in a
 * worktree of its own with the bot's badge, ignores a call for another computer, and stops answering once its access
 * ends. Only synthetic repositories, accounts and servers take part.
 */
test('a fleet bot starts conversations in the projects this computer gave it, and loses them with the access', async () => {
  test.setTimeout(300_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-fleet-bridge-'))
  const repo = path.join(root, 'repo')
  const profile = path.join(root, 'profile')
  const gateway = await createDesktopBridgeGateway()
  let app: ElectronApplication | undefined
  let model: Server | undefined
  try {
    // ---- A repository and a model provider that exist only for this run ------------------------------------------
    await mkdir(repo, { recursive: true })
    await writeFile(path.join(repo, 'source.txt'), 'fleet-bridge-source\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture')
    const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'fleet-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fleet-fixture',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      )
    model = createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'fleet-fixture', object: 'model' }] }))
        return
      }
      if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end()
      for await (const _part of req) void _part
      res.setHeader('content-type', 'text/event-stream')
      chunk(res, { role: 'assistant', content: 'Bot evidence for proof-fleet.' })
      chunk(res, {}, 'stop')
      res.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => model!.listen(0, '127.0.0.1', resolve))
    const modelPort = (model.address() as { port: number }).port

    // ---- The owner's computer: a project, an account, and its pairing with the bot server -------------------------
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'fleet-desktop-bridge',
        AGENTS_USERDATA: profile,
        AGENTS_LOCALE: 'pt-BR',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    const page: Page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    const call = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
    const workspace = (await call('addWorkspace', repo)) as { id: string; name: string }
    const provider = (await call('chatAddProvider', {
      name: 'Fleet fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${modelPort}/v1`,
    })) as { ok: boolean; id: string }
    expect(provider.ok).toBe(true)
    await call('chatSetDefault', { providerId: provider.id, modelId: 'fleet-fixture' })
    await call('fleetConnect', { url: gateway.url, code: 'ABCD-EFGH', deviceName: 'MacBook do teste' })
    // This computer's stream says it takes desktop calls.
    await expect.poll(() => gateway.bridges(), { timeout: 30_000 }).toBe(1)

    // ---- The owner gives Scout access to one project, from Scout's settings ----------------------------------------
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await page.getByRole('button', { name: /Scout/ }).first().click()
    await page.getByRole('button', { name: 'Ajustes do bot', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Ajustes do Scout' })
    await settingsTab(settings, 'Este computador').click()
    const section = settings.getByTestId('fleet-desktop-access')
    await expect(settings.getByRole('heading', { name: 'Workspaces deste computador', level: 2 })).toBeVisible()
    // Another computer already gave Scout access; it is offline, and listed with what may be done from here.
    const other = section.getByTestId('fleet-desktop-other').filter({ hasText: 'iMac da sala' })
    await expect(other).toContainText('Offline')
    await section.getByRole('switch', { name: 'Dar a este bot acesso a este computador' }).click()
    const macName = section.getByLabel('Nome com que este computador aparece para o bot')
    await expect(macName).toHaveValue('MacBook do teste')
    await macName.fill('MacBook de teste')
    // Nothing is granted until the owner chooses it.
    await expect(section.getByTestId('fleet-desktop-access-blockers')).toBeVisible()
    await expect(section.getByTestId('fleet-desktop-access-save')).toBeDisabled()
    await section.getByLabel(workspace.name, { exact: true }).check()
    await section.getByLabel('fleet-fixture', { exact: true }).check()
    await expect(section.getByTestId('fleet-desktop-access-blockers')).toHaveCount(0)
    await section.getByTestId('fleet-desktop-access-save').click()
    await expect(section).toContainText('Este computador dá acesso como “MacBook de teste”.')
    expect(gateway.requests.filter((request) => request.key === 'botDesktopLinkPut').map((item) => item.body)).toEqual([
      { name: 'MacBook de teste' },
    ])
    const self = gateway.selfLink()
    expect(self?.desktopId).toMatch(/^dsk_/)
    await page.screenshot({ path: test.info().outputPath('fleet-desktop-access.png') })
    await settings.getByRole('button', { name: 'Fechar ajustes', exact: true }).click()

    // ---- Scout lists what this computer gave it: names, branches and models, never a path or this computer's id ----
    const listed = await gateway.call('listWorkspaces')
    expect(listed).toMatchObject({
      ok: true,
      value: {
        desktop: { id: self!.desktopId, name: 'MacBook de teste' },
        workspaces: [
          expect.objectContaining({ workspaceId: workspace.id, branches: expect.arrayContaining(['main']) }),
        ],
      },
    })
    const listedText = JSON.stringify(listed)
    for (const local of [repo, profile, root]) expect(listedText).not.toContain(local)
    const selectionId = (listed as { value: { selections: Array<{ selectionId: string }> } }).value.selections[0]
      .selectionId

    // ---- Scout starts a development conversation; it runs here, in its own worktree, with Scout's badge ------------
    const created = await gateway.call('createChat', {
      workspaceId: workspace.id,
      name: 'Conversa do Scout',
      baseBranch: 'main',
      selection: { selectionId },
      message: 'Report the evidence for proof-fleet.',
      idempotencyKey: randomUUID(),
    })
    expect(created).toMatchObject({ ok: true, value: { conversation: { name: 'Conversa do Scout' } } })
    const conversations = async () =>
      (await call('listConversations', workspace.id)) as Array<{
        id: string
        name: string
        cwd: string
        botOrigin?: { botName: string }
        botManagementState?: string
      }>
    await expect
      .poll(async () => (await conversations()).find((item) => item.name === 'Conversa do Scout')?.botOrigin?.botName, {
        timeout: 60_000,
      })
      .toBe('Scout')
    const conversation = (await conversations()).find((item) => item.name === 'Conversa do Scout')!
    expect(conversation.cwd).not.toBe(repo)
    await page.getByRole('tab', { name: 'Workspaces', exact: true }).click()
    const row = page.locator('.conv-item').filter({ hasText: 'Conversa do Scout' }).first()
    await expect(row.getByTestId('conversation-bot-badge')).toContainText('Scout')
    await row.click()
    await expect(page.getByText('Bot evidence for proof-fleet.', { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })
    await page.screenshot({ path: test.info().outputPath('fleet-desktop-conversation.png') })

    // ---- A call addressed to another computer is never answered from here ------------------------------------------
    expect(await gateway.call('listChats', {}, { desktopId: OTHER_DESKTOP_ID, timeoutMs: 3_000 })).toBe('timeout')

    // ---- Another computer removes this one's link: the access ends here at once ------------------------------------
    gateway.removeSelf()
    await expect
      .poll(async () => (await conversations()).find((item) => item.id === conversation.id)?.botManagementState, {
        timeout: 30_000,
      })
      .toBe('revoked')
    expect(await gateway.call('listChats')).toMatchObject({ ok: false, error: { code: 'desktop_not_linked' } })
    // The conversation and its worktree stay on this computer.
    expect((await conversations()).map((item) => item.id)).toContain(conversation.id)

    // ---- The owner gives access again, then turns it off from here; and removes the other computer ----------------
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await page.getByRole('button', { name: /Scout/ }).first().click()
    await page.getByRole('button', { name: 'Ajustes do bot', exact: true }).click()
    await settingsTab(settings, 'Este computador').click()
    await expect(section.getByRole('switch', { name: 'Dar a este bot acesso a este computador' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    await section.getByRole('switch', { name: 'Dar a este bot acesso a este computador' }).click()
    await section.getByLabel(workspace.name, { exact: true }).check()
    await section.getByLabel('fleet-fixture', { exact: true }).check()
    await section.getByTestId('fleet-desktop-access-save').click()
    await expect(section).toContainText('Este computador dá acesso como “MacBook do teste”.')
    expect(await gateway.call('listChats')).toMatchObject({ ok: true, value: { conversations: [] } })
    await section.getByRole('switch', { name: 'Acesso deste computador' }).click()
    await page
      .getByRole('dialog', { name: 'Desligar o acesso deste computador?' })
      .getByRole('button', { name: 'Desligar' })
      .click()
    await expect(section.getByRole('switch', { name: 'Dar a este bot acesso a este computador' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(gateway.requests.some((request) => request.key === 'botDesktopLinkDelete')).toBe(true)
    expect(gateway.selfLink()).toBeNull()
    await other.getByRole('button', { name: 'Remover acesso' }).click()
    await page
      .getByRole('dialog', { name: 'Remover o acesso de iMac da sala?' })
      .getByRole('button', { name: 'Remover' })
      .click()
    await expect(section.getByTestId('fleet-desktop-other')).toHaveCount(0)
    expect(
      gateway.requests.filter((request) => request.key === 'botDesktopLinkRemove').map((item) => item.path)
    ).toEqual([`/v1/bots/scout/desktop-links/${OTHER_DESKTOP_ID}`])
    expect(gateway.errors, 'every payload follows the protocol').toEqual([])
  } finally {
    await app?.close().catch(() => undefined)
    await gateway.close()
    await new Promise<void>((resolve) => (model ? model.close(() => resolve()) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
