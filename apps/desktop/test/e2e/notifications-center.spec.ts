import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  fleetBotSchema,
  fleetGatewayEventSchema,
  fleetInteractionResolutionSchema,
  fleetRoutineRunSchema,
  type FleetBot,
  type FleetInboxItem,
  type FleetInteractionResolution,
} from '@maestrly/bot-fleet-protocol'
import { desktop, instanceEnv, listen, portOf } from './helpers/remote-host'

/**
 * An OpenAI-compatible model. Asked to deploy, it runs a command, which waits for approval, and answers a few seconds
 * after it ran: long enough for the owner to look elsewhere before the turn ends.
 */
function deployModel() {
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'notify-fixture', object: 'model' }] }))
    }
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }
    res.setHeader('content-type', 'text/event-stream')
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'notify-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'notify-fixture',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      )
    const lastUser = input.messages.map((message) => message.role).lastIndexOf('user')
    const ran = input.messages.slice(lastUser + 1).some((message) => message.role === 'tool')
    if (!ran) {
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_deploy',
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command: 'echo NOTIFY-OK' }) },
          },
        ],
      })
      chunk({}, 'tool_calls')
    } else {
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      chunk({ role: 'assistant', content: 'DEPLOY-DONE' })
      chunk({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
  return { server }
}

const bot = (id: string, name: string, tint: string): FleetBot => {
  const at = new Date().toISOString()
  return fleetBotSchema.parse({
    id,
    name,
    role: '',
    instructions: '',
    tint,
    ceiling: 'auto',
    selection: null,
    talksTo: [],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'idle',
    activity: null,
    pendingCount: 0,
    accounts: { connected: false, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: at },
    screen: { width: 1280, height: 800, display: ':1' },
    appVersion: '0.21.0',
    capabilities: [FLEET_ROUTINE_CONVERSATIONS_FEATURE],
    createdAt: at,
    updatedAt: at,
  })
}

/** A gateway with two bots: Atlas waits for an approval, and Nova's routine run fails while the app watches. */
function notifyGateway() {
  const bots = [bot('atlas', 'Atlas', '#6688aa'), bot('nova', 'Nova', '#aa6688')]
  const startedAt = new Date(Date.now() - 60_000).toISOString()
  let inbox: FleetInboxItem[] = [
    {
      botId: 'atlas',
      interaction: {
        kind: 'permission',
        id: 'perm-rollout',
        at: startedAt,
        title: 'Run kubectl rollout restart',
        detail: null,
        tool: null,
        itemId: 'item-rollout',
      },
    },
  ]
  const failedRun = fleetRoutineRunSchema.parse({
    id: 'run-nightly',
    routineId: 'routine-nightly',
    routineTitle: 'Nightly sync',
    botId: 'nova',
    trigger: 'schedule',
    status: 'failed',
    deliveredAt: startedAt,
    finishedAt: new Date().toISOString(),
    report: null,
    finalText: null,
    conversation: 'own',
  })
  const resolutions: Array<{ botId: string; id: string; resolution: FleetInteractionResolution }> = []
  const failures: string[] = []
  const streams = new Set<ServerResponse>()
  const emit = (event: unknown) => {
    const frame = `event: fleet\ndata: ${JSON.stringify(fleetGatewayEventSchema.parse(event))}\n\n`
    for (const stream of streams) stream.write(frame)
  }
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
        ([, route]) =>
          route.method === request.method &&
          new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
      )
      if (!entry) return send(404, { code: 'NOT_FOUND', message: 'Unknown fixture route' })
      const [key, route] = entry
      if (!['meta', 'pair'].includes(key) && request.headers.authorization !== 'Bearer fixture-notify-token') {
        failures.push(`Missing authentication: ${key}`)
        return send(401, { code: 'UNAUTHORIZED', message: 'Bad token' })
      }
      let body: unknown
      if (route.body) {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        body = route.body.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      }
      const botId = url.pathname.match(/^\/v1\/bots\/([^/]+)/)?.[1]
      let value: unknown
      switch (key) {
        case 'meta':
          value = {
            protocol: 1,
            gatewayVersion: '0.21.0',
            botImage: 'fixture',
            botImageVersion: null,
            features: [FLEET_ROUTINE_CONVERSATIONS_FEATURE],
          }
          break
        case 'pair':
          value = { deviceId: 'fixture-device', token: 'fixture-notify-token' }
          break
        case 'events':
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          streams.add(response)
          response.write(': connected\n\n')
          request.on('close', () => streams.delete(response))
          return
        case 'host':
          value = {
            hostname: 'notify-fixture',
            os: 'Linux',
            kernel: '6.8',
            arch: 'x64',
            cpus: 4,
            cpuPercent: 0,
            memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 0, botsBytes: 0 },
            disk: { totalBytes: 80 * 1024 ** 3, usedBytes: 0 },
            uptimeSeconds: 60,
            gatewayVersion: '0.21.0',
            botImage: 'fixture',
            botImageVersion: null,
            dockerVersion: '28',
          }
          break
        case 'botsList':
          value = { bots }
          break
        case 'botGet':
          value = bots.find((item) => item.id === botId)
          break
        case 'inbox':
          value = { items: inbox }
          break
        case 'botInteractionResolve': {
          const id = url.pathname.split('/').pop()!
          resolutions.push({ botId: botId!, id, resolution: fleetInteractionResolutionSchema.parse(body) })
          inbox = inbox.filter((item) => item.interaction.id !== id)
          emit({ type: 'inbox.updated', at: new Date().toISOString(), items: inbox })
          response.writeHead(204)
          response.end()
          return
        }
        case 'peerMessages':
          value = { messages: [] }
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
        case 'botTranscript':
        case 'botRunTranscript':
          value = { items: [], before: null }
          break
        case 'botRuns':
          value = { runs: botId === 'nova' ? [failedRun] : [], before: null }
          break
        case 'botRunGet':
          value = failedRun
          break
        case 'botConversationCall':
          value = { result: { ok: true } }
          break
        default:
          return send(404, { code: 'NOT_FOUND', message: `Unused fixture route: ${key}` })
      }
      send(200, route.response ? route.response.parse(value) : value)
    } catch (error) {
      failures.push(String(error))
      send(500, { code: 'INTERNAL', message: 'Invalid fixture response' })
    }
  })
  const failRun = () =>
    emit({
      type: 'activity',
      at: new Date().toISOString(),
      entry: {
        seq: 7,
        at: new Date().toISOString(),
        botId: 'nova',
        environmentId: null,
        kind: 'turn_failed',
        summary: 'The sync token expired',
        data: { source: 'routine', runId: 'run-nightly' },
      },
    })
  return { server, resolutions, failures, failRun, connected: () => streams.size > 0 }
}

// The real built application, a local OpenAI-compatible model and a fixture bot gateway. No network or account.
test('notifications center: gathers what needs the owner, answers it from the list, and keeps its place', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-notifications-'))
  const model = deployModel()
  const gateway = notifyGateway()
  let app: ElectronApplication | undefined
  try {
    await listen(model.server)
    await listen(gateway.server)
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: instanceEnv(path.join(root, 'profile'), 'notifications-e2e'),
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const api = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })

    const provider = await api('chatAddProvider', {
      name: 'Notify fixture',
      kind: 'openai',
      key: 'synthetic-fixture-key',
      baseURL: `http://127.0.0.1:${portOf(model.server)}/v1`,
    })
    expect(provider.ok).toBe(true)
    await api('chatSetDefault', { providerId: provider.id, modelId: 'notify-fixture' })
    const chat = await api('createStandaloneConversation', { name: 'Deploy chat' })
    await api('chatSetSelection', chat.id, { providerId: provider.id, modelId: 'notify-fixture' })
    await api('chatSetPermMode', chat.id, 'ask')
    expect((await api('chatSetMode', chat.id, 'agent')).ok).toBe(true)
    await api('fleetConnect', { url: `http://127.0.0.1:${portOf(gateway.server)}`, code: 'ABCD-EFGH' })
    // The chat was created through the API: reload so the sidebar lists it.
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await expect.poll(gateway.connected).toBe(true)

    const tab = page.getByRole('tab', { name: /^Notifications/ })
    const panel = page.locator('#sidebar-panel-inbox')
    const waiting = panel.getByRole('region', { name: 'Waiting for you' })
    const fresh = panel.getByRole('region', { name: 'New' })
    const read = panel.getByRole('region', { name: 'Read' })
    const row = (key: string) => panel.locator('li', { has: page.locator(`[data-inbox-row="${key}"]`) })
    const atlas = row('request:' + (await api('fleetServers'))[0].id + '/atlas/perm-rollout')
    const badge = page.getByTestId('sidebar-inbox-count')

    // A bot's request waits for the owner as soon as the server lists it.
    await tab.click()
    await expect(waiting.locator('li')).toHaveCount(1)
    await expect(atlas).toContainText('Atlas')
    await expect(atlas).toContainText('Needs your approval · Run kubectl rollout restart')
    await expect(badge).toHaveText(/^1/)

    // A routine run that fails is new, with what the bot said.
    gateway.failRun()
    const nova = fresh.locator('li', { hasText: 'Nova' })
    await expect(nova).toContainText('Routine')
    await expect(nova).toContainText('Failed · The sync token expired')
    await expect(badge).toHaveText(/^2/)

    // A conversation that asks to run a command waits for approval, here and in its own tab.
    await page.getByRole('tab', { name: 'Chats', exact: true }).click()
    await page.locator('li.conv-item', { hasText: 'Deploy chat' }).first().click()
    const input = page.locator('.chat-input[contenteditable="true"]:visible')
    await input.fill('Deploy now')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(
      page.locator('#sidebar-panel-chats').getByRole('img', { name: /Waiting for your approval/ })
    ).toBeVisible()
    await tab.click()
    const deploy = row(`conversation:${chat.id}`)
    await expect(waiting).toContainText('Deploy chat')
    await expect(deploy).toContainText('Needs your approval')
    // Finished transitions: the rail's colors move to the new tab over a moment.
    const screenshot = (name: string) =>
      page.screenshot({ path: path.join(test.info().outputDir, `${name}.png`), animations: 'disabled' })
    await screenshot('notifications-waiting')

    // Approving from the list lets the turn go on; opening a bot meanwhile keeps the sidebar on the center.
    await deploy.getByRole('button', { name: 'Allow once' }).click()
    await expect(deploy.getByRole('button', { name: 'Allow once' })).toHaveCount(0)
    await nova.locator('[data-inbox-row]').click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(nova).toHaveClass(/conv-selected/)

    // The turn ends while the owner looks at the bot: the conversation is new, unread, and no longer tells what it
    // asked. The row's actions take the place of its dot under the pointer.
    const deployed = fresh.locator('li', { hasText: 'Deploy chat' })
    await expect(deployed).toBeVisible({ timeout: 30_000 })
    await page.mouse.move(1000, 700)
    await expect(deployed.getByRole('img', { name: 'Unread' })).toBeVisible()
    await expect(deployed).toContainText('Finished')
    await expect(deployed).not.toContainText('NOTIFY-OK')

    // Answering the bot's request from the list resolves it on its server, and the request leaves the list.
    await atlas.getByRole('button', { name: 'Allow once' }).click()
    await expect
      .poll(() => gateway.resolutions)
      .toEqual([{ botId: 'atlas', id: 'perm-rollout', resolution: { kind: 'permission', reply: 'once' } }])
    await expect(waiting).toHaveCount(0)

    // Marking as read from the keyboard moves the conversation to Read; the opened bot is read, and stays in place.
    await fresh.locator('li', { hasText: 'Deploy chat' }).locator('[data-inbox-row]').focus()
    await page.keyboard.press('e')
    await expect(read.locator('li', { hasText: 'Deploy chat' })).toBeVisible()
    await expect(nova.getByRole('img', { name: 'Unread' })).toHaveCount(0)
    await expect(badge).toHaveCount(0)

    // The source filter narrows the list, and says what it hides.
    await panel.getByRole('button', { name: /^Bots, / }).click()
    await expect(panel.locator('[data-inbox-row]')).toHaveCount(1)
    await panel.getByRole('button', { name: /^Chats, / }).click()
    await expect(panel.locator('[data-inbox-row]')).toHaveCount(1)
    await panel.getByRole('button', { name: /^Workspaces, / }).click()
    await expect(panel).toContainText('Nothing matches')
    await panel.getByRole('button', { name: 'Show everything' }).click()
    await expect(panel.locator('[data-inbox-row]')).toHaveCount(2)

    // Dismissing hides an item until something newer happens, and can be undone.
    await read.locator('li', { hasText: 'Deploy chat' }).hover()
    await read.locator('li', { hasText: 'Deploy chat' }).getByRole('button', { name: 'Dismiss' }).click()
    await expect(panel.locator('[data-inbox-row]')).toHaveCount(1)
    await panel.getByRole('button', { name: 'Undo' }).click()
    await expect(panel.locator('[data-inbox-row]')).toHaveCount(2)
    await screenshot('notifications-read')

    // What the owner read survives a restart of the window.
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('tab', { name: /^Notifications/ }).click()
    await expect(read.locator('li', { hasText: 'Deploy chat' })).toBeVisible()
    expect(gateway.failures).toEqual([])
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise((resolve) => model.server.close(resolve))
    gateway.server.closeAllConnections()
    await new Promise((resolve) => gateway.server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
