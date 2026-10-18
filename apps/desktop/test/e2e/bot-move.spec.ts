import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, type Locator, type Page, test } from '@playwright/test'
import {
  FLEET_BOT_MOVE_FEATURE,
  FLEET_GATEWAY_ROUTES,
  fleetBotMoveSchema,
  fleetBotSchema,
  fleetConversationCallRequestSchema,
  fleetEnvironmentSchema,
  fleetGatewayEventSchema,
  fleetHostInfoSchema,
  type FleetBot,
  type FleetBotMove,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const now = () => new Date().toISOString()
const GB = 1024 ** 3
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A tab of the bot settings, by its label; its name may go on to say it has unsaved changes. */
const settingsTab = (settings: Locator, label: string) =>
  settings
    .getByRole('tablist', { name: 'Seções dos ajustes', exact: true })
    .getByRole('tab', { name: new RegExp(`^${label}\\b`) })

// The owner moves bots between environments of their server: by dropping a bot on another environment in the sidebar,
// which asks before anything moves, and from the bot's settings. The app follows the move in the bot's `move` until
// the bot runs in its new environment, and says why a move that failed left it where it was. The server is a fixture
// that plays the gateway's move through the protocol's schemas.
test('moves a bot to another environment from the sidebar and from its settings', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-bot-move-e2e-'))
  const requests: Array<{ key: string; body: unknown; path: string }> = []
  const streams = new Set<ServerResponse>()
  const emit = (event: unknown) => {
    const valid = fleetGatewayEventSchema.parse(event)
    for (const stream of streams) stream.write(`event: fleet\ndata: ${JSON.stringify(valid)}\n\n`)
  }
  const capable = ['provisioning', 'environments', 'video-screens', FLEET_BOT_MOVE_FEATURE]
  const makeEnvironment = (id: string, name: string, botIds: string[], patch: Record<string, unknown> = {}) =>
    fleetEnvironmentSchema.parse({
      id,
      name,
      lifecycle: 'running',
      setup: { step: 'ready', error: null, errorMessage: null },
      resources: { memoryBytes: GB, memoryLimitBytes: 4 * GB, cpuPercent: 6, startedAt: now() },
      memoryLimitBytes: null,
      appVersion: '0.21.0',
      capabilities: capable,
      botIds,
      createdAt: now(),
      updatedAt: now(),
      ...patch,
    })
  const makeBot = (id: string, name: string, environmentId: string) =>
    fleetBotSchema.parse({
      id,
      name,
      environmentId,
      capabilities: capable,
      role: '',
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
      accounts: { connected: true, providers: [] },
      takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
      resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
      screen: { width: 1280, height: 800, display: ':1' },
      appVersion: '0.21.0',
      createdAt: now(),
      updatedAt: now(),
    })
  const environments: FleetEnvironment[] = [
    makeEnvironment('acme', 'Acme', ['scout', 'ghost']),
    makeEnvironment('casa', 'Casa', ['cleo']),
    // An environment on an older image takes no bot until it restarts.
    makeEnvironment('legado', 'Legado', [], { capabilities: ['provisioning', 'environments'] }),
  ]
  const bots: FleetBot[] = [makeBot('scout', 'Scout', 'acme'), makeBot('ghost', 'Ghost', 'acme')]
  bots.push(makeBot('cleo', 'Cleo', 'casa'))
  const moves = new Map<string, FleetBotMove>()
  const host = fleetHostInfoSchema.parse({
    hostname: 'moves.example',
    os: 'Linux',
    kernel: '6.8',
    arch: 'x64',
    cpus: 4,
    cpuPercent: 12,
    memory: { totalBytes: 16 * GB, usedBytes: 4 * GB, botsBytes: 2 * GB },
    disk: { totalBytes: 100 * GB, usedBytes: 20 * GB },
    uptimeSeconds: 7200,
    gatewayVersion: '0.21.0',
    botImage: 'test-image',
    botImageVersion: '0.21.0',
    dockerVersion: '28',
  })
  /** Plays a move as the gateway does: its phases in the bot, then the bot where it ended, or back where it was. */
  async function play(bot: FleetBot, move: FleetBotMove, fails: boolean) {
    const phases: FleetBotMove['phase'][] = ['freezing', 'exporting', 'importing', 'verifying', 'committing']
    for (const phase of fails ? phases.slice(0, 4) : phases) {
      await sleep(250)
      Object.assign(move, { phase, updatedAt: now() })
      emit({ type: 'bot.updated', at: now(), bot: { ...bot, move } })
    }
    await sleep(250)
    if (fails) {
      Object.assign(move, {
        state: 'failed',
        error: { code: 'INTERNAL', message: 'The bot arrived different from how it left. It stays where it was.' },
      })
      emit({ type: 'bot.updated', at: now(), bot: { ...bot, move: null } })
      return
    }
    const from = environments.find((item) => item.id === move.fromEnvironmentId)!
    const to = environments.find((item) => item.id === move.toEnvironmentId)!
    from.botIds = from.botIds.filter((id) => id !== bot.id)
    to.botIds = [...to.botIds, bot.id]
    bot.environmentId = to.id
    Object.assign(move, { phase: 'completed', state: 'completed', updatedAt: now() })
    emit({ type: 'environment.updated', at: now(), environment: from })
    emit({ type: 'environment.updated', at: now(), environment: to })
    emit({ type: 'bot.updated', at: now(), bot: { ...bot, move: null } })
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
      ([, route]) =>
        route.method === request.method && new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
    )
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    const refuse = (code: string, message: string) => send(code === 'NOT_FOUND' ? 404 : 409, { code, message })
    if (!entry) return refuse('NOT_FOUND', 'Unknown route')
    const [key, route] = entry
    if (request.headers['x-maestrly-fleet-protocol'] !== '1')
      return send(426, { code: 'PROTOCOL_INCOMPATIBLE', message: 'Bad protocol' })
    if (!['meta', 'pair'].includes(key) && request.headers.authorization !== 'Bearer fixture-token')
      return send(401, { code: 'UNAUTHORIZED', message: 'Bad token' })
    let body: unknown
    if (route.body) {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      try {
        body = route.body.parse(JSON.parse(Buffer.concat(chunks).toString()))
      } catch {
        return send(400, { code: 'INVALID_REQUEST', message: 'Bad body' })
      }
    }
    requests.push({ key, body, path: url.pathname })
    if (key === 'events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      streams.add(response)
      response.write(': connected\n\n')
      request.on('close', () => streams.delete(response))
      return
    }
    const bot = bots.find((item) => item.id === url.pathname.match(/^\/v1\/bots\/([^/]+)/)?.[1])
    let value: unknown
    switch (key) {
      case 'meta':
        value = {
          protocol: 1,
          features: capable.filter((feature) => feature !== FLEET_BOT_MOVE_FEATURE),
          moreFeatures: [FLEET_BOT_MOVE_FEATURE],
          gatewayVersion: '0.21.0',
          botImage: 'test-image',
          botImageVersion: '0.21.0',
        }
        break
      case 'pair':
        value = { deviceId: 'device-move-e2e', token: 'fixture-token' }
        break
      case 'host':
        value = host
        break
      case 'botsList':
        value = { bots: bots.map((item) => ({ ...item, move: null })) }
        break
      case 'environmentsList':
        value = { environments }
        break
      case 'inbox':
        value = { items: [] }
        break
      case 'peerMessages':
        value = { messages: [] }
        break
      case 'botGet':
        if (!bot) return refuse('NOT_FOUND', 'Bot not found')
        value = bot
        break
      case 'botTranscript':
        value = { items: [], before: null }
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
      case 'botDesktopLinksList':
        value = { links: [] }
        break
      case 'botConversationCall': {
        const op = fleetConversationCallRequestSchema.parse(body).op
        value = {
          result:
            op === 'chatSkillsState'
              ? { skills: [], groups: [], selection: { kind: 'all' }, selectedGroupMissing: false, hasOverrides: false }
              : op === 'chatCommands'
                ? { prompts: [], project: [], skills: [] }
                : op === 'chatSubagentProfilesGetConversation'
                  ? { rules: null, diagnostics: [], enabled: true, subagentsEnabled: true }
                  : op === 'chatGetConvTools'
                    ? { app: true, imageGen: true, mcpDisabled: [] }
                    : { ok: true },
        }
        break
      }
      case 'archivedBotsList':
        value = { bots: [] }
        break
      case 'archivedEnvironmentsList':
        value = { environments: [] }
        break
      case 'botMove': {
        if (!bot) return refuse('NOT_FOUND', 'Bot not found')
        const input = body as { environmentId?: string; newEnvironment?: { name: string } }
        let toEnvironmentId = input.environmentId
        if (input.newEnvironment) {
          const created = makeEnvironment(input.newEnvironment.name.toLowerCase(), input.newEnvironment.name, [])
          environments.push(created)
          emit({ type: 'environment.updated', at: now(), environment: created })
          toEnvironmentId = created.id
        }
        const move = fleetBotMoveSchema.parse({
          id: randomUUID(),
          botId: bot.id,
          fromEnvironmentId: bot.environmentId,
          toEnvironmentId,
          newEnvironment: !!input.newEnvironment,
          phase: 'prepared',
          state: 'running',
          error: null,
          startedAt: now(),
          updatedAt: now(),
        })
        moves.set(bot.id, move)
        emit({ type: 'bot.updated', at: now(), bot: { ...bot, move } })
        // Ghost's package never arrives whole: its move fails and Ghost stays where it was.
        void play(bot, move, bot.id === 'ghost')
        return send(202, move)
      }
      case 'botMoveGet': {
        const move = bot && moves.get(bot.id)
        if (!move) return refuse('NOT_FOUND', 'This bot has not moved')
        value = move
        break
      }
      default:
        return refuse('NOT_FOUND', 'Not found')
    }
    try {
      if (route.response) value = route.response.parse(value)
      if (!route.response) {
        response.writeHead(204)
        response.end()
      } else send(200, value)
    } catch (error) {
      console.error('[fake gateway]', error)
      send(500, { code: 'INTERNAL', message: 'The fake gateway failed; see the test output' })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_E2E_SKILLS_HOME: root,
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'bot-move-e2e',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'pt-BR',
        ELECTRON_RENDERER_URL: '',
      },
    })
    const page: Page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await page.getByRole('button', { name: 'Pular', exact: true }).click()
    await page.evaluate(
      (url) => (window as any).api.fleetConnect({ url, code: 'ABCD-EFGH', deviceName: 'Mac' }),
      `http://127.0.0.1:${address.port}`
    )
    await page.getByRole('tab', { name: 'Bots' }).click()
    const group = (name: string) => page.getByRole('group', { name, exact: true, includeHidden: true })
    const row = (environment: string, name: string) =>
      group(environment).getByRole('button', { name: new RegExp(`\\b${name}\\b`), includeHidden: true })
    await expect(row('Acme', 'Scout')).toBeVisible()

    // Dropping Scout on its own environment, or on one that cannot take it, opens nothing.
    await row('Acme', 'Scout').dragTo(group('Legado'))
    await row('Acme', 'Scout').dragTo(group('Acme'))
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Dropped on Casa, the move asks first, with Casa chosen and what goes and stays said.
    await row('Acme', 'Scout').dragTo(group('Casa'))
    const dialog = page.getByRole('dialog', { name: 'Mover Scout' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('radio', { name: /Ambiente existente/ })).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.getByRole('button', { name: 'Ambiente', exact: true })).toContainText('Casa')
    await expect(dialog).toContainText('Vai junto')
    await expect(dialog).toContainText('O navegador, com os logins de sites')
    await expect(dialog).toContainText('Fica em Acme')
    await expect(dialog).toContainText('As contas de modelo')
    expect(requests.filter((item) => item.key === 'botMove')).toEqual([])
    // An environment on an older image cannot be chosen, and says why.
    await dialog.getByRole('button', { name: 'Ambiente', exact: true }).click()
    const legado = page.getByRole('option', { name: /Legado/ })
    await expect(legado).toHaveAttribute('aria-disabled', 'true')
    await expect(legado).toContainText('Reinicie este ambiente para atualizá-lo antes')
    await page.keyboard.press('Escape')

    await dialog.getByRole('button', { name: 'Mover', exact: true }).click()
    await expect
      .poll(() => requests.filter((item) => item.key === 'botMove').map((item) => [item.path, item.body]))
      .toEqual([['/v1/bots/scout/move', { environmentId: 'casa', idempotencyKey: expect.any(String) }]])
    // Its steps go by, and the sidebar, behind the dialog, shows it moving meanwhile.
    await expect(dialog.getByRole('list', { name: 'Andamento da mudança' })).toBeVisible()
    await expect(group('Acme').getByRole('button', { name: /\bScout\b/, includeHidden: true })).toContainText(
      'Movendo…'
    )
    await expect(dialog).toContainText('Scout agora está em Casa.', { timeout: 20_000 })
    await expect(row('Casa', 'Scout')).toBeVisible()
    await expect(group('Acme').getByRole('button', { name: /\bScout\b/, includeHidden: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).first().click()

    // From its settings, a move that fails says why, and the bot stays where it was.
    await row('Acme', 'Ghost').click()
    await page.getByRole('button', { name: 'Ajustes do bot', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Ajustes do Ghost' })
    await settingsTab(settings, 'Ambiente').click()
    await settings.getByRole('button', { name: 'Mover para…', exact: true }).click()
    const ghostDialog = page.getByRole('dialog', { name: 'Mover Ghost' })
    await ghostDialog.getByRole('radio', { name: /Novo ambiente/ }).click()
    await ghostDialog.getByLabel('Nome do novo ambiente').fill('Lab')
    await ghostDialog.getByRole('button', { name: 'Mover', exact: true }).click()
    await expect(ghostDialog.getByRole('alert')).toContainText('Ghost não pôde ser movido. Ele continua em Acme.', {
      timeout: 20_000,
    })
    await expect(ghostDialog.getByRole('alert')).toContainText(
      'O bot chegou diferente de como saiu, então continua onde estava.'
    )
    expect(await page.locator('body').innerText()).not.toContain('arrived different')
    expect(requests.filter((item) => item.key === 'botMove').at(-1)?.body).toEqual({
      newEnvironment: { name: 'Lab' },
      idempotencyKey: expect.any(String),
    })
    await expect(ghostDialog.getByRole('button', { name: 'Tentar de novo' })).toBeVisible()
  } finally {
    await app?.close()
    for (const stream of streams) stream.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
