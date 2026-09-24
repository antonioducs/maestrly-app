import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron } from '@playwright/test'
import {
  FLEET_GATEWAY_ROUTES,
  fleetBotSchema,
  fleetGatewayEventSchema,
  fleetHostInfoSchema,
  fleetPendingInteractionSchema,
  fleetRoutineSchema,
  fleetSendMessageRequestSchema,
  fleetConversationCallRequestSchema,
  type FleetBot,
  type FleetSelection,
  type FleetRoutine,
} from '@maestrly/bot-fleet-protocol'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const now = () => new Date().toISOString()

test('fleet UI pairs, handles requests, creates a bot, controls its screen, and schedules a routine', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-fleet-e2e-'))
  const requests: Array<{ key: string; body: unknown }> = []
  const streams = new Set<ServerResponse>()
  const host = fleetHostInfoSchema.parse({
    hostname: 'fleet-e2e-host',
    os: 'Linux',
    kernel: '6.8',
    arch: 'x64',
    cpus: 4,
    cpuPercent: 23,
    memory: {
      totalBytes: 8 * 1024 ** 3,
      usedBytes: 2 * 1024 ** 3,
      botsBytes: 1024 ** 3,
    },
    disk: { totalBytes: 100 * 1024 ** 3, usedBytes: 20 * 1024 ** 3 },
    uptimeSeconds: 3600,
    gatewayVersion: '0.9.2',
    botImage: 'test-image',
    botImageVersion: '0.9.2',
    dockerVersion: '28',
  })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
    'base64'
  )
  const base = {
    role: 'Helps with orders',
    instructions: 'Check incoming orders',
    tint: '#6688aa',
    ceiling: 'auto',
    selection: null,
    usage: {
      contextUsedTokens: 22600,
      contextWindowTokens: 828400,
      contextQuality: 'estimated',
      costUsd: 0.12,
      updatedAt: now(),
    },
    talksTo: [],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'waiting',
    activity: { kind: 'permission', title: 'Run ls' },
    pendingCount: 1,
    accounts: { connected: false, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: {
      memoryBytes: 1024 ** 3,
      memoryLimitBytes: 2 * 1024 ** 3,
      cpuPercent: 9,
      startedAt: now(),
    },
    screen: { width: 1280, height: 800, display: ':1' },
    appVersion: '0.9.2',
    createdAt: now(),
    updatedAt: now(),
  }
  const bots: FleetBot[] = [fleetBotSchema.parse({ ...base, id: 'scout', name: 'Scout' })]
  let inbox = [
    fleetPendingInteractionSchema.parse({
      kind: 'permission',
      id: 'perm-1',
      at: now(),
      title: 'Run ls',
      detail: '$ ls',
      tool: { name: 'bash', target: 'ls -la' },
      itemId: 'item-1',
    }),
    fleetPendingInteractionSchema.parse({
      kind: 'help',
      id: 'help-1',
      at: now(),
      reason: 'Sign in',
      itemId: 'item-help',
    }),
  ]
  const transcript: unknown[] = [
    {
      id: 'item-1',
      at: now(),
      kind: 'permission',
      requestId: 'perm-1',
      title: 'Run ls',
      detail: '$ ls',
      tool: { name: 'bash', target: 'ls -la' },
      state: 'pending',
      resolvedAt: null,
    },
  ]
  transcript.push({
    id: 'image-tool',
    at: now(),
    kind: 'tool',
    name: 'browser_screenshot',
    target: null,
    state: 'done',
    output: null,
    images: [{ id: 'shot-1', mediaType: 'image/png', byteSize: png.length, name: 'Screenshot' }],
  })
  const routines: FleetRoutine[] = []
  let currentSelection: FleetSelection = {
    providerId: 'prov_e2e',
    modelId: 'model-e2e',
    reasoning: 'medium',
    fastMode: false,
  }
  let conversationTools = { app: true, imageGen: true, mcpDisabled: [] as string[] }
  let skillOverride: 'on' | 'off' | undefined
  let skillSelection: { kind: 'all' | 'none' } = { kind: 'all' }
  let subagentsEnabled = true
  let subagentProfilesEnabled = true
  let takeoverConflicts = 1
  const rendererPayloads: string[] = []
  function emit(event: unknown) {
    const valid = fleetGatewayEventSchema.parse(event)
    rendererPayloads.push(JSON.stringify(valid))
    const frame = `event: fleet\ndata: ${JSON.stringify(valid)}\n\n`
    for (const stream of streams) stream.write(frame)
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
      ([, route]) =>
        route.method === request.method && new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
    )
    const send = (status: number, value: unknown) => {
      rendererPayloads.push(JSON.stringify(value))
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (!entry) {
      send(404, { code: 'NOT_FOUND', message: 'Unknown route' })
      return
    }
    const [key, route] = entry
    if (request.headers['x-maestrly-fleet-protocol'] !== '1') {
      send(426, { code: 'PROTOCOL_INCOMPATIBLE', message: 'Bad protocol' })
      return
    }
    if (!['meta', 'pair'].includes(key) && request.headers.authorization !== 'Bearer fixture-token') {
      send(401, { code: 'UNAUTHORIZED', message: 'Bad token' })
      return
    }
    let body: unknown
    if (route.body) {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      try {
        body = route.body.parse(JSON.parse(Buffer.concat(chunks).toString()))
      } catch {
        send(400, { code: 'INVALID_REQUEST', message: 'Bad body' })
        return
      }
    }
    requests.push({ key, body })
    if (key === 'botMessageSend') body = fleetSendMessageRequestSchema.parse(body)
    if (key === 'events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      streams.add(response)
      response.write(': connected\n\n')
      request.on('close', () => streams.delete(response))
      return
    }
    const id = url.pathname.match(/^\/v1\/bots\/([^/]+)/)?.[1] ?? ''
    const bot = bots.find((item) => item.id === id)
    let value: unknown
    switch (key) {
      case 'meta':
        value = {
          protocol: 1,
          gatewayVersion: '0.9.2',
          botImage: 'test-image',
          botImageVersion: '0.9.2',
        }
        break
      case 'pair':
        value = { deviceId: 'device-e2e', token: 'fixture-token' }
        break
      case 'host':
        value = host
        break
      case 'botsList':
        value = { bots }
        break
      case 'botGet':
        value = bot
        break
      case 'botsCreate': {
        const input = body as {
          name: string
          instructions: string
          ceiling: string
          talksTo: string[]
        }
        const created = fleetBotSchema.parse({
          ...base,
          id: 'new-bot',
          name: input.name,
          instructions: input.instructions,
          ceiling: input.ceiling,
          talksTo: input.talksTo,
          status: 'starting',
          pendingCount: 0,
          activity: null,
          lifecycle: 'starting',
          setup: { step: 'container', error: null, errorMessage: null },
        })
        bots.push(created)
        value = created
        setTimeout(() => {
          const ready = fleetBotSchema.parse({
            ...created,
            status: 'idle',
            lifecycle: 'running',
            setup: { step: 'ready', error: null, errorMessage: null },
          })
          bots[bots.findIndex((item) => item.id === created.id)] = ready
          emit({ type: 'bot.updated', at: now(), bot: ready })
        }, 800)
        break
      }
      case 'botConversationCall': {
        const input = fleetConversationCallRequestSchema.parse(body)
        const profileState = () => ({
          rules: null,
          diagnostics: [],
          enabled: subagentProfilesEnabled,
          subagentsEnabled,
        })
        const skillsState = () => ({
          skills: [
            {
              name: 'order-check',
              description: 'Check orders',
              source: 'fixture',
              dir: '/skills/order-check',
              scope: 'global',
              modelInvocable: true,
              userInvocable: true,
              resources: { scripts: 0, references: 0, assets: 0 },
              enabled: skillOverride !== 'off',
              baseEnabled: true,
              enabledGlobally: true,
              override: skillOverride,
              groupIds: [],
              inSelectedGroup: true,
            },
          ],
          groups: [],
          selection: skillSelection,
          selectedGroupMissing: false,
          hasOverrides: skillOverride !== undefined,
        })
        let result: unknown
        switch (input.op) {
          case 'chatConfig':
            result = {
              mcpServers: [{ id: 'fixture-mcp', name: 'Fixture MCP', transport: 'http', enabled: true }],
              appToolsEnabled: true,
              imageGenEnabled: true,
            }
            break
          case 'chatGetConvTools':
            result = conversationTools
            break
          case 'chatSetConvTools':
            conversationTools = { ...conversationTools, ...(input.args[0] as Partial<typeof conversationTools>) }
            result = { ok: true }
            break
          case 'chatSubagentProfilesGetConversation':
            result = profileState()
            break
          case 'chatSubagentProfilesSetConversationEnabled':
            subagentProfilesEnabled = input.args[0] as boolean
            result = { ok: true, value: profileState() }
            break
          case 'chatSubagentsSetConversationEnabled':
            subagentsEnabled = input.args[0] as boolean
            result = { ok: true, value: profileState() }
            break
          case 'chatSkillsState':
            result = skillsState()
            break
          case 'chatSkillSetOverride':
            skillOverride = input.args[1] === 'inherit' ? undefined : (input.args[1] as 'on' | 'off')
            result = { ok: true }
            break
          case 'chatSkillResetOverrides':
            skillOverride = undefined
            result = { ok: true }
            break
          case 'chatSkillSetSelection':
            skillSelection = input.args[0] as typeof skillSelection
            result = { ok: true }
            break
          case 'chatCommands':
            result = {
              prompts: [],
              project: [],
              skills:
                skillOverride === 'off'
                  ? []
                  : [{ name: 'order-check', description: 'Check orders', source: 'fixture' }],
            }
            break
        }
        value = { result }
        break
      }
      case 'botSelections':
        value = {
          options: [
            {
              id: 'prov_e2e::model-e2e',
              providerId: 'prov_e2e',
              providerLabel: 'Fake',
              modelId: 'model-e2e',
              modelLabel: 'Model',
              efforts: ['medium', 'high'],
              fastMode: true,
            },
            {
              id: 'prov_e2e::model-plus',
              providerId: 'prov_e2e',
              providerLabel: 'Fake',
              modelId: 'model-plus',
              modelLabel: 'Plus',
              efforts: ['high'],
              fastMode: false,
            },
          ],
          current: currentSelection,
        }
        break
      case 'botPatch': {
        if (bot) {
          const patch = body as Partial<FleetBot>
          if (patch.selection) currentSelection = patch.selection
          const updated = fleetBotSchema.parse({ ...bot, ...patch })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
          value = updated
        }
        break
      }
      case 'botImage':
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'X-Content-Type-Options': 'nosniff',
          'Content-Length': String(png.length),
        })
        response.end(png)
        return
      case 'botApiKeyAccountAdd': {
        value = { providerId: 'prov_e2e' }
        if (bot) {
          const input = body as { name: string }
          const updated = fleetBotSchema.parse({
            ...bot,
            status: 'idle',
            accounts: {
              connected: true,
              providers: [{ id: 'prov_e2e', label: input.name }],
            },
          })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
        }
        break
      }
      case 'botAccountRemove': {
        if (bot) {
          const updated = fleetBotSchema.parse({
            ...bot,
            status: 'setup',
            accounts: { connected: false, providers: [] },
          })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
        }
        break
      }
      case 'botTranscript':
        value = { items: id === 'scout' ? transcript : [], before: null }
        break
      case 'botMessageSend': {
        const input = body as { text: string }
        transcript.push({
          id: randomUUID(),
          at: now(),
          kind: 'user',
          text: input.text,
          source: 'owner',
          queued: false,
        })
        value = { inputId: randomUUID(), itemId: randomUUID(), queued: false }
        break
      }
      case 'botInteractionResolve': {
        inbox = inbox.filter((item) => item.id !== 'perm-1')
        const item = transcript[0] as Record<string, unknown>
        item.state = 'approved'
        item.resolvedAt = now()
        emit({
          type: 'inbox.updated',
          at: now(),
          items: inbox.map((interaction) => ({ botId: 'scout', interaction })),
        })
        break
      }
      case 'inbox':
        value = {
          items: inbox.map((interaction) => ({ botId: 'scout', interaction })),
        }
        break
      case 'peerMessages':
        value = { messages: [] }
        break
      case 'activity':
        value = { entries: [], lastSeq: 0 }
        break
      case 'botTakeover': {
        if (takeoverConflicts-- > 0) {
          send(409, { code: 'CONFLICT', message: 'Bot is finishing a step' })
          return
        }
        value = {
          state: 'human',
          deviceId: 'device-e2e',
          deviceName: 'Mac',
          since: now(),
        }
        if (bot) {
          const updated = fleetBotSchema.parse({
            ...bot,
            takeover: value,
            status: 'human',
          })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
        }
        break
      }
      case 'botTakeoverRelease': {
        value = {
          state: 'none',
          deviceId: null,
          deviceName: null,
          since: null,
        }
        if (bot) {
          const updated = fleetBotSchema.parse({
            ...bot,
            takeover: value,
            status: 'idle',
          })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
        }
        break
      }
      case 'botScreenTicket':
        value = {
          ticket: 'ticket-e2e',
          path: '/v1/screen?ticket=ticket-e2e',
          expiresAt: now(),
        }
        break
      case 'botRoutinesList':
        value = { routines }
        break
      case 'botRoutinesCreate': {
        const input = body as {
          title: string
          prompt: string
          schedule: unknown
          enabled: boolean
        }
        const created = fleetRoutineSchema.parse({
          ...input,
          id: 'routine-e2e',
          botId: id,
          nextRunAt: null,
          lastRunAt: null,
          lastOutcome: null,
          createdAt: now(),
          updatedAt: now(),
        })
        routines.push(created)
        value = created
        break
      }
      case 'screen':
        send(404, { code: 'NOT_FOUND', message: 'No websocket in fixture' })
        return
    }
    try {
      if (route.response) value = route.response.parse(value)
      if (!route.response) {
        response.writeHead(204)
        response.end()
      } else send(200, value)
    } catch (error) {
      send(500, { code: 'INTERNAL', message: String(error) })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  const url = `http://127.0.0.1:${address.port}`
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'fleet-e2e',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'pt-BR',
        ELECTRON_RENDERER_URL: '',
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('button', { name: 'Servidor de bots' }).first().click()
    await page.getByLabel('Endereço do servidor').fill(url)
    await page.getByLabel('Código de pareamento').fill('ABCD-EFGH')
    await page.getByRole('button', { name: 'Conectar', exact: true }).click()
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Conectado' })).toContainText(
      'fleet-e2e-host'
    )
    await page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    await page.getByRole('tab', { name: 'Bots' }).click()
    await expect(page.getByRole('button', { name: /fleet-e2e-host/ })).toBeVisible()
    await page.getByRole('button', { name: /Scout/ }).first().click()
    await expect(page.getByRole('heading', { name: 'Scout' })).toBeVisible()
    await expect(page.getByText('Scout quer rodar um comando')).toBeVisible()
    await expect(page.getByText('ls -la')).toBeVisible()
    await expect(page.getByText('~22.6k/828.4k 2.7% · ~$0.120')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Abrir Screenshot' })).toBeVisible()
    await expect.poll(() => requests.filter((item) => item.key === 'botImage').length).toBe(1)
    await page.getByRole('button', { name: 'Abrir Screenshot' }).click()
    await expect(page.getByRole('dialog').getByAltText('Screenshot')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTitle('Adicionar').click()
    await expect(page.getByText('Fixture MCP')).toBeVisible()
    await page.getByRole('switch', { name: 'Fixture MCP' }).click()
    await expect
      .poll(
        () =>
          (
            requests
              .filter(
                (item) => item.key === 'botConversationCall' && (item.body as { op: string }).op === 'chatSetConvTools'
              )
              .at(-1)?.body as { args: [{ mcpDisabled?: string[] }] } | undefined
          )?.args[0].mcpDisabled
      )
      .toEqual(['fixture-mcp'])
    await page.getByTitle('Adicionar').click()
    await page.locator('[data-placeholder="Mensagem para Scout…"]').fill('/order')
    await expect(page.getByText('/order-check')).toBeVisible()
    await page.locator('[data-placeholder="Mensagem para Scout…"]').fill('')
    await page.getByTitle('Skills', { exact: true }).click()
    await expect(page.getByText('/order-check')).toBeVisible()
    await page.getByRole('button', { name: 'Desligada' }).click()
    await expect
      .poll(
        () =>
          (
            requests
              .filter(
                (item) =>
                  item.key === 'botConversationCall' && (item.body as { op: string }).op === 'chatSkillSetOverride'
              )
              .at(-1)?.body as { args: string[] } | undefined
          )?.args
      )
      .toEqual(['order-check', 'off'])
    await page.getByTitle('Skills', { exact: true }).click()
    await page.getByRole('button', { name: 'medium' }).first().click()
    await page.getByRole('button', { name: 'high', exact: true }).click()
    await expect
      .poll(
        () =>
          (requests.filter((item) => item.key === 'botPatch').at(-1)?.body as { selection?: { reasoning?: string } })
            ?.selection?.reasoning
      )
      .toBe('high')
    await page.getByRole('button', { name: 'Fast', exact: true }).click()
    await expect
      .poll(
        () =>
          (requests.filter((item) => item.key === 'botPatch').at(-1)?.body as { selection?: { fastMode?: boolean } })
            ?.selection?.fastMode
      )
      .toBe(true)
    await expect(page.getByTitle(/Trocar modelo/)).toHaveClass(/rounded-md/)
    // Closed, the chip names the provider by its label (as the desktop does), never by its internal id.
    await expect(page.getByTitle(/Trocar modelo/)).toContainText('Fake · model-e2e')
    await expect(page.getByTitle(/Trocar modelo/)).not.toContainText('prov_e2e')
    await page.getByTitle(/Trocar modelo/).click()
    await expect(page.getByRole('button', { name: 'model-plus' })).toBeVisible()
    await page.getByRole('button', { name: 'model-plus' }).click()
    await expect
      .poll(
        () =>
          (requests.filter((item) => item.key === 'botPatch').at(-1)?.body as { selection?: { modelId?: string } })
            ?.selection?.modelId
      )
      .toBe('model-plus')
    await page.getByRole('button', { name: 'Aprovar por mim' }).click()
    await page.getByRole('button', { name: 'Acesso completo' }).last().click()
    await expect
      .poll(() => (requests.filter((item) => item.key === 'botPatch').at(-1)?.body as { ceiling?: string })?.ceiling)
      .toBe('full')
    await page
      .locator('input[type="file"][accept^="image/*"]')
      .setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: png })
    await expect(page.getByAltText('test.png')).toBeVisible()
    await page.locator('[data-placeholder="Mensagem para Scout…"]').fill('Check the orders')
    await page.getByRole('button', { name: 'Enviar', exact: true }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botMessageSend').length).toBe(1)
    const sent = requests.find((item) => item.key === 'botMessageSend')?.body as {
      text: string
      attachments: { mediaType: string; name: string; dataBase64: string }[]
    }
    expect(sent.text).toBe('Check the orders')
    expect(sent.attachments).toHaveLength(1)
    expect(sent.attachments[0]).toMatchObject({ name: 'test.png', mediaType: 'image/png' })
    expect(Buffer.from(sent.attachments[0].dataBase64, 'base64')).toEqual(png)
    await page.getByRole('button', { name: 'Aprovar uma vez' }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botInteractionResolve').length).toBe(1)
    await page.getByRole('tab', { name: 'Bots' }).click()
    await page.getByRole('button', { name: /Aguardando você/ }).click()
    await expect(page.getByRole('heading', { name: 'Aguardando você' })).toBeVisible()
    await page.getByRole('tab', { name: 'Bots' }).click()
    await page.getByRole('button', { name: 'Criar bot' }).first().click()
    await page.getByRole('dialog', { name: 'Criar bot' }).getByLabel('Nome').fill('Orders')
    await page.getByRole('dialog', { name: 'Criar bot' }).getByRole('button', { name: 'Criar bot' }).click()
    await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible()
    await page.getByRole('tab', { name: 'Tela' }).click()
    await expect(page.getByRole('region', { name: 'Tela do Orders' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'Tela indisponível' })).toBeVisible()
    await page.getByRole('button', { name: 'Assumir controle' }).click()
    await page
      .getByRole('dialog', { name: 'Assumir a tela do Orders?' })
      .getByRole('button', { name: 'Assumir' })
      .click()
    await expect(page.getByRole('alert')).toContainText('O bot está terminando um passo')
    await page.getByRole('button', { name: 'Assumir controle' }).click()
    await page
      .getByRole('dialog', { name: 'Assumir a tela do Orders?' })
      .getByRole('button', { name: 'Assumir' })
      .click()
    await expect.poll(() => requests.filter((item) => item.key === 'botTakeover').length).toBe(2)
    await page.getByRole('button', { name: 'Devolver ao Orders' }).click()
    await page.getByPlaceholder('Opcional').fill('Signed in')
    await page.getByRole('button', { name: 'Devolver', exact: true }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botTakeoverRelease').length).toBe(1)
    expect(requests.find((item) => item.key === 'botTakeoverRelease')?.body).toMatchObject({
      note: 'Signed in',
      continue: true,
    })
    const orders = bots.find((item) => item.id === 'new-bot')!
    const foreign = fleetBotSchema.parse({
      ...orders,
      status: 'human',
      takeover: {
        state: 'human',
        deviceId: 'other-device',
        deviceName: 'Office Mac',
        since: now(),
      },
    })
    bots[bots.indexOf(orders)] = foreign
    emit({ type: 'bot.updated', at: now(), bot: foreign })
    await expect(page.getByRole('status', { name: 'Quem controla a tela: Office Mac' })).toBeVisible()
    await expect(page.getByText('Office Mac está controlando a tela.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Assumir controle' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Devolver ao Orders' })).toHaveCount(0)
    await expect
      .poll(() => requests.filter((item) => item.key === 'botScreenTicket').at(-1)?.body)
      .toEqual({ mode: 'view' })
    expect(requests.filter((item) => item.key === 'botTakeoverRelease')).toHaveLength(1)
    await page.getByRole('tab', { name: 'Ajustes' }).click()
    const apiKey = 'fleet-e2e-secret-key-123'
    await page.getByLabel('Nome da conta').fill('Fake model')
    await page.getByLabel('Chave de API').fill(apiKey)
    await page.getByText('Avançado').click()
    await page.getByLabel('URL base (opcional)').fill('http://fake-model:8080/v1')
    await page.getByRole('button', { name: 'Adicionar conta' }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botApiKeyAccountAdd').length).toBe(1)
    expect(requests.find((item) => item.key === 'botApiKeyAccountAdd')?.body).toEqual({
      kind: 'openai',
      name: 'Fake model',
      key: apiKey,
      baseURL: 'http://fake-model:8080/v1',
    })
    await expect(page.getByText('Fake model')).toBeVisible()
    expect(rendererPayloads.some((payload) => payload.includes(apiKey))).toBe(false)
    await expect(page.getByLabel('Chave de API')).toHaveValue('')
    await page.getByRole('button', { name: 'Remover', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Remover conta de modelo?' })
      .getByRole('button', { name: 'Remover' })
      .click()
    await expect.poll(() => requests.filter((item) => item.key === 'botAccountRemove').length).toBe(1)
    await page.getByRole('button', { name: 'Adicionar rotina' }).click()
    await page.getByRole('dialog', { name: 'Adicionar rotina' }).getByLabel('Título').fill('Daily orders')
    await page.getByRole('dialog', { name: 'Adicionar rotina' }).getByLabel('Instrução').fill('Check the orders')
    await page.getByRole('button', { name: 'Salvar rotina' }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botRoutinesCreate').length).toBe(1)
  } finally {
    await app?.close()
    for (const stream of streams) stream.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
