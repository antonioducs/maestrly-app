import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const desktop = fileURLToPath(new URL('../..', import.meta.url))

// UI-only fixtures seed metadata while Electron is closed. The separate bot-relay-e2e suite proves
// actual authenticated creation, execution and ownership through the server and desktop runtime.
test('bot identity remains clear in the sidebar, transcript, paused chat and Bots settings', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-bot-ui-'))
  const profile = path.join(root, 'profile')
  const repo = path.join(root, 'repo')
  let app: ElectronApplication | undefined
  let page!: Page
  const call = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
  const launch = async () => {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'bot-visual',
        AGENTS_USERDATA: profile,
        AGENTS_LOCALE: 'pt-BR',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(await realpath(profile))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 850))
  }
  try {
    await mkdir(repo)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '-b', 'main')
    await writeFile(path.join(repo, 'README.md'), 'Synthetic visual fixture\n')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture')
    await launch()
    await call('setOnboardingDone', true)
    const workspace = await call('addWorkspace', repo)
    const active = await call('createConversation', {
      workspaceId: workspace.id,
      branch: 'bot-visual-active',
      isNewBranch: true,
      mode: 'worktree',
      name: 'Revisão do Grok com um título suficientemente longo para truncar',
    })
    const paused = await call('createConversation', {
      workspaceId: workspace.id,
      branch: 'bot-visual-paused',
      isNewBranch: true,
      mode: 'worktree',
      name: 'Conversa pausada do Grok',
    })
    await call('createConversation', {
      workspaceId: workspace.id,
      branch: 'human-visual',
      isNewBranch: true,
      mode: 'worktree',
      name: 'Minha conversa',
    })
    await app!.close()
    app = undefined
    const db = new DatabaseSync(path.join(profile, 'maestrly-agents.db'))
    try {
      const origin = JSON.stringify({ kind: 'bot', connectionId: randomUUID(), botName: 'Grok Bot' })
      db.prepare("UPDATE conversations SET bot_origin=?,bot_management_state='active',pinned_at=? WHERE id=?").run(
        origin,
        Date.now(),
        active.id
      )
      db.prepare("UPDATE conversations SET bot_origin=?,bot_management_state='paused' WHERE id=?").run(
        origin,
        paused.id
      )
      const insert = db.prepare(
        'INSERT INTO chat_messages(id,conversation_id,role,parts_json,meta_json,seq,created_at) VALUES(?,?,?,?,?,?,?)'
      )
      insert.run(
        randomUUID(),
        active.id,
        'user',
        JSON.stringify([{ type: 'text', id: 'bot-text', text: 'Revise o projeto e execute os testes.' }]),
        JSON.stringify({ botName: 'Grok Bot' }),
        1,
        Date.now()
      )
      insert.run(
        randomUUID(),
        active.id,
        'assistant',
        JSON.stringify([{ type: 'text', id: 'reply', text: 'A revisão está disponível nesta conversa.' }]),
        '{}',
        2,
        Date.now()
      )
      insert.run(
        randomUUID(),
        active.id,
        'user',
        JSON.stringify([{ type: 'text', id: 'human-text', text: 'Minha observação como pessoa.' }]),
        '{}',
        3,
        Date.now()
      )
      // A connection saved by the release that relayed through a server: it may only be reconnected here.
      db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run(
        'bot.connections.v1',
        JSON.stringify([
          {
            id: randomUUID(),
            name: 'Bot antigo',
            clientId: 'legacy-client',
            desktopId: 'legacy-desktop',
            workspaceIds: [],
            revokedAt: null,
            mcpConfig: '{}',
            actions: ['chats:read'],
          },
        ])
      )
    } finally {
      db.close()
    }
    await launch()
    const row = (name: string) => page.locator('.conv-item').filter({ hasText: name }).first()
    const activeRow = row('Revisão do Grok')
    await expect(activeRow).toBeVisible()
    await expect(activeRow.getByTestId('conversation-bot-badge')).toBeVisible()
    await activeRow.hover()
    await expect(activeRow.getByTestId('conversation-bot-badge')).toBeVisible()
    await expect(activeRow.getByTestId('conversation-bot-badge')).toHaveAttribute('aria-label', /Grok Bot/)
    await expect(row('Minha conversa').getByTestId('conversation-bot-badge')).toHaveCount(0)
    await activeRow.click()
    await expect(page.getByTestId('chat-bot-badge')).toContainText('Gerenciada por Grok Bot')
    await expect(page.getByTestId('bot-message-author')).toHaveCount(1)
    await expect(page.getByTestId('bot-message-author')).toHaveText('Enviada por Grok Bot')
    await expect(page.locator('.chat-input:visible')).toHaveAttribute('data-placeholder', 'Gerenciada por Grok Bot')
    await expect(page.getByRole('button', { name: 'Pausar bot', exact: true })).toBeVisible()
    // The bot notice shares the composer's centered column, including at wider window sizes.
    const notice = page.getByTestId('bot-manual-chat')
    await expect(notice).toContainText('Libere o chat para escrever nela também.')
    for (const width of [1280, 1800]) {
      await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 850), width)
      await expect(notice).toBeVisible()
      await expect(async () => {
        const noticeBox = await notice.boundingBox()
        const composerBox = await page.locator('.chat-composer-shell:visible').boundingBox()
        expect(noticeBox).not.toBeNull()
        expect(composerBox).not.toBeNull()
        expect(Math.abs(noticeBox!.x - composerBox!.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(noticeBox!.width - composerBox!.width)).toBeLessThanOrEqual(1)
      }).toPass()
    }

    // ---- Releasing the chat is the person's explicit, reversible choice ------------------------------
    const release = page.getByRole('button', { name: 'Liberar chat', exact: true })
    await release.click()
    const confirmation = page.getByRole('dialog')
    await expect(confirmation).toContainText('Liberar este chat para as suas mensagens?')
    await expect(confirmation).toContainText('pode enviar a qualquer momento')
    await expect(confirmation).toContainText('reler a conversa')
    // Escape cancels, and nothing about the chat moved.
    await page.keyboard.press('Escape')
    await expect(confirmation).toHaveCount(0)
    await expect(page.locator('.chat-input:visible')).toHaveAttribute('data-placeholder', 'Gerenciada por Grok Bot')

    await release.click()
    await confirmation.getByRole('button', { name: 'Liberar chat', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    // The composer takes what the person writes, and the bot is still the one running the chat.
    await expect(notice).toContainText('Compartilhado com Grok Bot')
    await expect(page.getByTestId('chat-bot-badge')).toContainText('Gerenciada por Grok Bot')
    await expect(page.getByRole('button', { name: 'Pausar bot', exact: true })).toBeVisible()
    // Nothing about the bot closes the composer any more; this fixture has no account, which is its own
    // ordinary reason. Actually writing and sending in a released chat is proven in bot-relay-e2e.
    await expect(page.locator('.chat-input:visible')).not.toHaveAttribute(
      'data-placeholder',
      'Gerenciada por Grok Bot'
    )

    // The choice survives a restart, and the other bot chat is untouched by it.
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await activeRow.click()
    await expect(page.getByTestId('bot-manual-chat')).toContainText('Compartilhado com Grok Bot')

    // Blocking again needs no confirmation and does not pause the bot either.
    await page.getByRole('button', { name: 'Bloquear minhas mensagens', exact: true }).click()
    await expect(page.getByTestId('bot-manual-chat')).toContainText('Libere o chat para escrever nela também.')
    await expect(page.locator('.chat-input:visible')).toHaveAttribute('data-placeholder', 'Gerenciada por Grok Bot')
    await expect(page.getByRole('button', { name: 'Pausar bot', exact: true })).toBeVisible()
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 850))
    await page.mouse.move(600, 200)
    await page.screenshot({ path: test.info().outputPath('bot-sidebar-and-chat.png'), fullPage: true })

    await row('Conversa pausada do Grok').click()
    await expect(page.getByTestId('chat-bot-badge')).toContainText('Criada por Grok Bot')
    await expect(page.getByTestId('chat-bot-badge')).toContainText('Pausado')
    await expect(page.getByRole('button', { name: 'Retomar bot', exact: true })).toBeVisible()
    await call('archiveConversation', paused.id, true)
    await page.reload()
    await page.getByRole('button', { name: /Mostrar arquivadas/ }).click()
    await expect(row('Conversa pausada do Grok').getByTestId('conversation-bot-badge')).toBeVisible()

    await page
      .getByRole('button', { name: /Configurações/ })
      .first()
      .click()
    await page.getByRole('button', { name: 'Bots', exact: true }).click()
    const settings = page.getByTestId('bot-settings')
    await expect(settings.getByRole('heading', { name: 'Seu bot, neste Maestrly' })).toBeVisible()
    await expect(settings.locator('select')).toHaveCount(0)
    // The three moves are named, and the first one is the one still to do.
    const steps = settings.getByTestId('bot-steps')
    await expect(steps.locator('[data-step="publish"]')).toHaveAttribute('data-state', 'current')
    await expect(steps.locator('[data-step="approve"]')).toHaveAttribute('data-state', 'todo')
    // The connector is added inside the person's own bot: nothing here sends them to a website.
    const guide = settings.getByTestId('bot-grok-guide')
    await expect(guide).toContainText('No chat do seu bot')
    await expect(guide).toContainText('Pedidos de autorização')
    await expect(guide.getByTestId('bot-grok-message')).toContainText('/mcp/bots')
    await expect(guide.getByRole('button', { name: /conectores/i })).toHaveCount(0)
    await expect(guide.getByRole('link')).toHaveCount(0)
    // A bot is set up from its own request, so nothing here offers to connect one out of the blue.
    await expect(settings.getByTestId('bot-setup')).toHaveCount(0)
    await expect(settings.getByLabel('Nome do bot')).toHaveCount(0)
    await expect(settings.getByRole('button', { name: 'Conectar bot', exact: true })).toHaveCount(0)
    // The embedded server replaces the bridge account: status, address and the warning about a remote bot.
    await expect(settings.getByTestId('bot-server-status')).toHaveText('Parado')
    await expect(settings.getByTestId('bot-server-endpoint')).toHaveText(/^https?:\/\/[^/]+\/mcp\/bots$/)
    const warning = settings.getByTestId('bot-server-warning')
    await expect(warning).toContainText('localhost e 127.0.0.1 nunca funcionam')
    await expect(warning).toContainText('mantenha o Maestrly aberto')
    await expect(settings.getByText(/só é acessível neste computador/)).toBeVisible()
    const save = settings.getByRole('button', { name: 'Salvar conexão', exact: true })
    await expect(save).toBeDisabled()
    const address = settings.getByLabel('Endereço público (HTTPS)')
    // An address that exists on this machine alone is refused where it is typed, not after saving.
    await address.fill('http://localhost:14310')
    await expect(settings.getByTestId('bot-server-address-error')).toContainText('localhost')
    await address.fill('https://bot.example.test/')
    await expect(settings.getByTestId('bot-server-address-error')).toHaveCount(0)
    await expect(settings.getByTestId('bot-server-endpoint')).toHaveText('https://bot.example.test/mcp/bots')
    // The message the person pastes into their bot carries that same endpoint.
    await expect(guide.getByTestId('bot-grok-message')).toContainText('https://bot.example.test/mcp/bots')
    await expect(settings.getByText(/só é acessível neste computador/)).toHaveCount(0)
    await expect(save).toBeEnabled()
    // Approvals happen here instead of a device-code sign-in; with no bot connected the queue is empty.
    await expect(settings.getByTestId('bot-pending-authorizations')).toContainText('Nenhum pedido aguardando.')
    // The relay-era connection stays visible but inert: reconnecting or revoking is all it offers.
    const legacyCard = settings.getByTestId('bot-connection').filter({ hasText: 'Bot antigo' })
    await expect(legacyCard).toHaveAttribute('data-legacy', 'true')
    await expect(legacyCard).toContainText('Reconexão necessária')
    await expect(legacyCard).toContainText('Conecte este bot novamente neste computador')
    await expect(legacyCard.getByRole('button', { name: /Copiar configura/ })).toHaveCount(0)
    await expect(legacyCard.getByRole('button', { name: 'Alterar projetos' })).toHaveCount(0)
    await expect(legacyCard.getByRole('button', { name: 'Revogar acesso' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('bot-settings.png'), fullPage: true })
  } finally {
    await app?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
