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
  type FleetBot,
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
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 2 * 1024 ** 3, botsBytes: 1024 ** 3 },
    disk: { totalBytes: 100 * 1024 ** 3, usedBytes: 20 * 1024 ** 3 },
    uptimeSeconds: 3600,
    gatewayVersion: '0.9.2',
    botImage: 'test-image',
    botImageVersion: '0.9.2',
    dockerVersion: '28',
  })
  const base = {
    role: 'Helps with orders',
    instructions: 'Check incoming orders',
    tint: '#6688aa',
    ceiling: 'auto',
    selection: null,
    talksTo: [],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'waiting',
    activity: { kind: 'permission', title: 'Run ls' },
    pendingCount: 1,
    accounts: { connected: false, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: 1024 ** 3, memoryLimitBytes: 2 * 1024 ** 3, cpuPercent: 9, startedAt: now() },
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
      state: 'pending',
      resolvedAt: null,
    },
  ]
  const routines: FleetRoutine[] = []
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
        value = { protocol: 1, gatewayVersion: '0.9.2', botImage: 'test-image', botImageVersion: '0.9.2' }
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
        const input = body as { name: string; instructions: string; ceiling: string; talksTo: string[] }
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
      case 'botSelections':
        value = { options: [], current: null }
        break
      case 'botApiKeyAccountAdd': {
        value = { providerId: 'prov_e2e' }
        if (bot) {
          const input = body as { name: string }
          const updated = fleetBotSchema.parse({
            ...bot,
            status: 'idle',
            accounts: { connected: true, providers: [{ id: 'prov_e2e', label: input.name }] },
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
        transcript.push({ id: randomUUID(), at: now(), kind: 'user', text: input.text, source: 'owner', queued: false })
        value = { inputId: randomUUID(), itemId: randomUUID(), queued: false }
        break
      }
      case 'botInteractionResolve': {
        inbox = inbox.filter((item) => item.id !== 'perm-1')
        const item = transcript[0] as Record<string, unknown>
        item.state = 'approved'
        item.resolvedAt = now()
        emit({ type: 'inbox.updated', at: now(), items: inbox.map((interaction) => ({ botId: 'scout', interaction })) })
        break
      }
      case 'inbox':
        value = { items: inbox.map((interaction) => ({ botId: 'scout', interaction })) }
        break
      case 'peerMessages':
        value = { messages: [] }
        break
      case 'activity':
        value = { entries: [], lastSeq: 0 }
        break
      case 'botTakeover': {
        value = { state: 'human', deviceId: 'device-e2e', deviceName: 'Mac', since: now() }
        if (bot) {
          const updated = fleetBotSchema.parse({ ...bot, takeover: value, status: 'human' })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
        }
        break
      }
      case 'botTakeoverRelease': {
        value = { state: 'none', deviceId: null, deviceName: null, since: null }
        if (bot) {
          const updated = fleetBotSchema.parse({ ...bot, takeover: value, status: 'idle' })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
        }
        break
      }
      case 'botScreenTicket':
        value = { ticket: 'ticket-e2e', path: '/v1/screen?ticket=ticket-e2e', expiresAt: now() }
        break
      case 'botRoutinesList':
        value = { routines }
        break
      case 'botRoutinesCreate': {
        const input = body as { title: string; prompt: string; schedule: unknown; enabled: boolean }
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
    await page.getByPlaceholder('Mensagem para Scout…').fill('Check the orders')
    await page.getByRole('button', { name: 'Enviar mensagem' }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botMessageSend').length).toBe(1)
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
    await expect.poll(() => requests.filter((item) => item.key === 'botTakeover').length).toBe(1)
    await page.getByRole('button', { name: 'Devolver ao Orders' }).click()
    await page.getByPlaceholder('Opcional').fill('Signed in')
    await page.getByRole('button', { name: 'Devolver', exact: true }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botTakeoverRelease').length).toBe(1)
    expect(requests.find((item) => item.key === 'botTakeoverRelease')?.body).toMatchObject({
      note: 'Signed in',
      continue: true,
    })
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
