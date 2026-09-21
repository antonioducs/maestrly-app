import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const desktop = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Setting a bot up from the request that asked for access, in the real application.
 *
 * Nothing is offered to fill in before a bot asks: the form belongs to one waiting request, arrives with
 * that client's name, and approving it creates the bot and answers that request. The waiting requests are
 * seeded straight into the profile database while the application is closed, so this suite exercises the
 * screen and the owner's decision; the separate bot-relay suite drives the real OAuth flow end to end.
 */
test('a bot is set up from the request that asked for it, and a dismissed request carries nothing over', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-bot-setup-'))
  const profile = path.join(root, 'profile')
  const repo = path.join(root, 'repo')
  let app: ElectronApplication | undefined
  let page!: Page
  let models: Server | undefined
  const call = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
  const launch = async () => {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'bot-setup',
        AGENTS_USERDATA: profile,
        AGENTS_LOCALE: 'pt-BR',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  }
  const shutdown = async () => {
    const running = app
    app = undefined
    await running?.close()
  }
  const dismissed = randomUUID()
  const accepted = randomUUID()
  const stale = randomUUID()

  try {
    await mkdir(repo)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '-b', 'main')
    await writeFile(path.join(repo, 'README.md'), 'Synthetic bot setup fixture\n')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture')
    // Only the catalog of this account is needed: no conversation and no turn ever runs in this suite.
    models = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'bot-fixture', object: 'model' }] }))
    })
    await new Promise<void>((resolve) => models?.listen(0, '127.0.0.1', resolve))
    const modelPort = (models.address() as { port: number }).port

    await launch()
    await call('setOnboardingDone', true)
    const workspace = (await call('addWorkspace', repo)) as { id: string; name: string }
    const provider = (await call('chatAddProvider', {
      name: 'Conta de teste',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${modelPort}/v1`,
    })) as { ok: boolean; id: string }
    expect(provider.ok).toBe(true)
    expect(((await call('botSettings')) as any).pendingAuthorizations).toEqual([])
    await shutdown()

    // ---- Two bots ask for access while the application is closed, and one request already expired ----
    const db = new DatabaseSync(path.join(profile, 'maestrly-agents.db'))
    try {
      const addClient = db.prepare(
        'INSERT INTO bot_oauth_clients(client_id,client_name,redirect_uris,created_at) VALUES(?,?,?,?)'
      )
      const addRequest = db.prepare(
        `INSERT INTO bot_oauth_requests
          (id,client_id,redirect_uri,state,scope,code_challenge,poll_hash,status,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?,'pending',?,?)`
      )
      const ask = (id: string, clientName: string, expiresAt: number) => {
        const clientId = randomUUID()
        const redirectUri = `https://${clientName.toLowerCase().replace(/[^a-z]+/g, '-')}.example.test/callback`
        addClient.run(clientId, clientName, JSON.stringify([redirectUri]), Date.now())
        addRequest.run(
          id,
          clientId,
          redirectUri,
          null,
          'api:read api:write',
          createHash('sha256').update(id).digest('base64url'),
          createHash('sha256').update(`poll-${id}`).digest('hex'),
          Date.now(),
          expiresAt
        )
      }
      ask(dismissed, 'Bot que some', Date.now() + 10 * 60_000)
      ask(accepted, 'Bot de pesquisa', Date.now() + 10 * 60_000)
      ask(stale, 'Bot atrasado', Date.now() - 60_000)
    } finally {
      db.close()
    }

    await launch()
    await page
      .getByRole('button', { name: /Configurações/ })
      .first()
      .click()
    await page.getByRole('button', { name: 'Bots', exact: true }).click()
    const settings = page.getByTestId('bot-settings')
    await expect(settings.getByRole('heading', { name: 'Seu bot, neste Maestrly' })).toBeVisible()

    // ---- Nothing is offered to fill in on its own: a bot is only ever set up from its own request ----
    await expect(settings.getByTestId('bot-setup')).toHaveCount(0)
    await expect(settings.getByLabel('Nome do bot')).toHaveCount(0)
    await expect(settings.getByRole('button', { name: 'Conectar bot', exact: true })).toHaveCount(0)
    await expect(settings.getByTestId('bot-connection')).toHaveCount(0)

    // ---- Only the requests still waiting are actionable ----------------------------------------------
    const requests = settings.getByTestId('bot-pending-request')
    await expect(requests).toHaveCount(2)
    await expect(settings.getByText('Bot atrasado')).toHaveCount(0)
    const leaving = requests.filter({ hasText: 'Bot que some' })
    const asking = requests.filter({ hasText: 'Bot de pesquisa' })
    await expect(asking).toContainText('Retorna para https://bot-de-pesquisa.example.test/callback')
    await page.screenshot({ path: test.info().outputPath('bot-requests-waiting.png'), fullPage: true })

    // ---- A setup whose request stops waiting is discarded, never applied to the next request ---------
    await leaving.getByRole('button', { name: 'Configurar este bot' }).click()
    const abandoned = leaving.getByTestId('bot-setup')
    await expect(abandoned.getByLabel('Nome do bot')).toHaveValue('Bot que some')
    await abandoned.getByLabel('Nome do bot').fill('Nome que se perde')
    await abandoned.getByLabel(workspace.name, { exact: true }).check()
    await abandoned.getByLabel('bot-fixture', { exact: true }).check()
    // The request stops waiting while its setup is open, exactly as an expiry or another answer would.
    await call('botAuthorize', dismissed, false, '')
    await expect(settings.getByTestId('bot-setup')).toHaveCount(0)
    await expect(requests).toHaveCount(1)
    await expect(settings.getByRole('alert')).toContainText('não está mais aguardando')
    await expect(settings.getByTestId('bot-connection')).toHaveCount(0)

    // ---- The request that is answered gets its own bot, named after the client and editable ----------
    await asking.getByRole('button', { name: 'Configurar este bot' }).click()
    const setup = asking.getByTestId('bot-setup')
    await expect(setup.getByLabel('Nome do bot')).toHaveValue('Bot de pesquisa')
    const approve = setup.getByRole('button', { name: 'Criar bot e aprovar' })
    await expect(approve).toBeDisabled()
    // A disabled approval always says what is still missing instead of leaving the person guessing.
    const blockers = setup.getByTestId('bot-setup-blockers')
    await expect(blockers).toContainText('Selecione pelo menos um projeto')
    await expect(blockers).toContainText('Selecione pelo menos um modelo')
    await setup.getByLabel('Nome do bot').fill('Bot de pesquisa renomeado')
    await setup.getByLabel(workspace.name, { exact: true }).check()
    await expect(blockers).not.toContainText('Selecione pelo menos um projeto')
    await setup.getByLabel('bot-fixture', { exact: true }).check()
    await setup.getByLabel('Cancelar suas execuções', { exact: true }).uncheck()
    await expect(setup.getByTestId('bot-setup-blockers')).toHaveCount(0)
    await expect(approve).toBeEnabled()
    // How far the bot goes on its own is decided here, and it starts on the middle choice.
    const ceiling = setup.getByTestId('bot-setup-ceiling')
    await expect(ceiling.getByLabel('Aprovar por mim', { exact: true })).toBeChecked()
    await expect(ceiling.getByLabel('Pedir aprovação', { exact: true })).not.toBeChecked()
    await expect(setup.getByTestId('bot-setup-ceiling-warning')).toHaveCount(0)
    // Unrestricted execution says plainly what it means before it is chosen.
    await ceiling.getByLabel('Acesso total', { exact: true }).check()
    await expect(setup.getByTestId('bot-setup-ceiling-warning')).toContainText('sem perguntar')
    await ceiling.getByLabel('Pedir aprovação', { exact: true }).check()
    await page.screenshot({ path: test.info().outputPath('bot-setup-from-request.png'), fullPage: true })
    await approve.click()

    await expect(requests).toHaveCount(0)
    await expect(settings.getByTestId('bot-pending-empty')).toHaveText('Nenhum pedido aguardando.')
    const connections = settings.getByTestId('bot-connection')
    await expect(connections).toHaveCount(1)
    await expect(connections).toContainText('Bot de pesquisa renomeado')
    await expect(connections).toContainText(workspace.name)
    const saved = (await call('botSettings')) as any
    expect(saved.connections).toHaveLength(1)
    expect([...saved.connections[0].actions].sort()).toEqual(['chats:answer', 'chats:read', 'chats:write'])
    expect(saved.connections[0].workspaceIds).toEqual([workspace.id])
    expect(saved.connections[0].name).toBe('Bot de pesquisa renomeado')
    // The approval choice is saved with the rest of the access and shown on the bot's own card.
    expect(saved.connections[0].permissionCeiling).toBe('ask')
    await expect(connections.getByTestId('bot-connection-ceiling')).toHaveAttribute('data-ceiling', 'ask')
    await expect(connections.getByTestId('bot-connection-ceiling')).toContainText('Pedir aprovação')
    await page.screenshot({ path: test.info().outputPath('bot-connected-after-approval.png'), fullPage: true })
    await shutdown()

    // ---- Exactly one request was approved, and it is the one that was set up -------------------------
    const audit = new DatabaseSync(path.join(profile, 'maestrly-agents.db'))
    try {
      const rows = audit
        .prepare('SELECT id,status,connection_id AS connectionId FROM bot_oauth_requests')
        .all() as unknown as Array<{ id: string; status: string; connectionId: string | null }>
      const byId = new Map(rows.map((row) => [row.id, row]))
      expect(byId.get(accepted)).toMatchObject({ status: 'approved', connectionId: saved.connections[0].id })
      expect(byId.get(dismissed)).toMatchObject({ status: 'denied', connectionId: null })
      expect(byId.get(stale)).toMatchObject({ status: 'pending', connectionId: null })
    } finally {
      audit.close()
    }
  } finally {
    await shutdown().catch(() => {})
    await new Promise<void>((resolve) => (models ? models.close(() => resolve()) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
