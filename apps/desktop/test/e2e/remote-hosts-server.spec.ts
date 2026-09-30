import { randomUUID } from 'node:crypto'
import http, { createServer, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import {
  FLEET_GATEWAY_ROUTES,
  fleetBotSchema,
  fleetEnvironmentSchema,
  fleetGatewayEventSchema,
  fleetHostInfoSchema,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import { desktop, instanceEnv, launchHost, type LaunchedHost, listen, portOf } from './helpers/remote-host'

const GB = 1024 ** 3
const now = () => new Date().toISOString()

/**
 * A bot server with one bots environment, able to host workspaces. Its bridge is the real gateway's in miniature: a
 * one-use ticket for a paired device, then the WebSocket handshake passed through to the host with the control token
 * the gateway holds. The host it passes to is a real instance of the app in server mode.
 */
function fakeGateway(host: () => LaunchedHost | null) {
  const requests: Array<{ key: string; body: unknown }> = []
  const streams = new Set<ServerResponse>()
  const tickets = new Set<string>()
  const bridges = new Set<Duplex>()
  const emit = (event: unknown) => {
    const valid = fleetGatewayEventSchema.parse(event)
    for (const stream of streams) stream.write(`event: fleet\ndata: ${JSON.stringify(valid)}\n\n`)
  }
  const capabilities = ['provisioning', 'environments']
  const environment = (id: string, name: string, patch: Record<string, unknown> = {}) =>
    fleetEnvironmentSchema.parse({
      id,
      name,
      lifecycle: 'running',
      setup: { step: 'ready', error: null, errorMessage: null },
      resources: { memoryBytes: GB, memoryLimitBytes: 4 * GB, cpuPercent: 6, startedAt: now() },
      memoryLimitBytes: null,
      appVersion: '0.9.3',
      capabilities,
      update: { available: false, pendingSince: null },
      botIds: [],
      createdAt: now(),
      updatedAt: now(),
      ...patch,
    })
  const environments: FleetEnvironment[] = [environment('acme', 'Acme', { botIds: ['scout'] })]
  const bots = [
    fleetBotSchema.parse({
      id: 'scout',
      name: 'Scout',
      environmentId: 'acme',
      capabilities,
      role: '',
      instructions: 'Synthetic bot',
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
      appVersion: '0.9.3',
      createdAt: now(),
      updatedAt: now(),
    }),
  ]
  const upsert = (next: FleetEnvironment) => {
    const index = environments.findIndex((item) => item.id === next.id)
    if (index >= 0) environments[index] = next
    else environments.push(next)
    emit({ type: 'environment.updated', at: now(), environment: next })
    return next
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
    if (!entry) return send(404, { code: 'NOT_FOUND', message: 'Unknown route' })
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
        body = route.body.parse(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
      } catch {
        return send(400, { code: 'INVALID_REQUEST', message: 'Bad body' })
      }
    }
    requests.push({ key, body })
    if (key === 'events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      streams.add(response)
      response.write(': connected\n\n')
      request.on('close', () => streams.delete(response))
      return
    }
    const found = environments.find((item) => item.id === url.pathname.match(/^\/v1\/environments\/([^/]+)/)?.[1])
    switch (key) {
      case 'meta':
        return send(200, {
          protocol: 1,
          features: ['provisioning', 'environments', 'environment-updates', 'workspaces-host'],
          gatewayVersion: '0.9.3',
          botImage: 'test-image',
          botImageVersion: '0.9.3',
        })
      case 'pair':
        return send(200, { deviceId: 'device-workspaces-e2e', token: 'fixture-token' })
      case 'host':
        return send(
          200,
          fleetHostInfoSchema.parse({
            hostname: 'fleet-workspaces-host',
            os: 'Linux',
            kernel: '6.8',
            arch: 'x64',
            cpus: 4,
            cpuPercent: 12,
            memory: { totalBytes: 16 * GB, usedBytes: 4 * GB, botsBytes: 2 * GB },
            disk: { totalBytes: 100 * GB, usedBytes: 20 * GB },
            uptimeSeconds: 7200,
            gatewayVersion: '0.9.3',
            botImage: 'test-image',
            botImageVersion: '0.9.3',
            dockerVersion: '28',
          })
        )
      case 'botsList':
        return send(200, { bots })
      case 'environmentsList':
        return send(200, { environments })
      case 'inbox':
        return send(200, { items: [] })
      case 'peerMessages':
        return send(200, { messages: [] })
      case 'archivedBotsList':
        return send(200, { bots: [] })
      case 'archivedEnvironmentsList':
        return send(200, { environments: [] })
      case 'environmentsCreate': {
        const input = body as { name: string; kind: 'bots' | 'workspaces' }
        if (input.kind === 'workspaces' && environments.some((item) => item.kind === 'workspaces'))
          return send(409, { code: 'CONFLICT', message: 'This server already hosts workspaces.' })
        const created = upsert(
          environment(input.name.toLowerCase(), input.name, {
            kind: input.kind,
            lifecycle: 'starting',
            setup: { step: 'desktop', error: null, errorMessage: null },
            capabilities: [...capabilities, 'workspaces-host'],
          })
        )
        // Its Maestrly answers a moment later, as a container's does.
        setTimeout(
          () => upsert({ ...created, lifecycle: 'running', setup: { step: 'ready', error: null, errorMessage: null } }),
          600
        )
        return send(201, created)
      }
      case 'environmentStop':
      case 'environmentStart': {
        if (!found) return send(404, { code: 'NOT_FOUND', message: 'Not found' })
        const stopping = key === 'environmentStop'
        // A stopped container's bridges are gone with it.
        if (stopping) for (const socket of [...bridges]) socket.destroy()
        return send(200, upsert({ ...found, lifecycle: stopping ? 'stopped' : 'running' }))
      }
      case 'environmentBridgeTicket': {
        if (!found) return send(404, { code: 'NOT_FOUND', message: 'Not found' })
        if (found.kind !== 'workspaces')
          return send(409, { code: 'CONFLICT', message: 'This environment does not host workspaces.' })
        if (found.lifecycle !== 'running') return send(409, { code: 'BOT_NOT_RUNNING', message: 'Not running' })
        const ticket = randomUUID().replaceAll('-', '')
        tickets.add(ticket)
        return send(201, { ticket, path: `/v1/bridge?ticket=${ticket}`, expiresAt: new Date(Date.now() + 30_000) })
      }
      case 'environmentAccountsList':
        return send(200, { apiKeys: [], subscriptions: [] })
      case 'environmentSkillsList':
        return send(200, { skills: [] })
      case 'environmentMcpServersList':
        return send(200, { servers: [] })
      default:
        return send(404, { code: 'NOT_FOUND', message: `The fake gateway has no ${key}` })
    }
  })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const target = host()
    const refuse = (status: number) => socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`)
    if (url.pathname !== '/v1/bridge' || request.headers.origin !== undefined) return refuse(403)
    // One use, as the real gateway's.
    if (!tickets.delete(url.searchParams.get('ticket') ?? '')) return refuse(403)
    if (!target) return refuse(503)
    const headers: Record<string, string> = {
      'X-Maestrly-Fleet-Protocol': '1',
      Authorization: `Bearer ${target.token}`,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
    }
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'])
      if (typeof request.headers[name] === 'string') headers[name] = request.headers[name]
    const upstream = http.request({ host: '127.0.0.1', port: target.port, path: '/v1/bridge', headers })
    upstream.on('upgrade', (answer, tcp, extra) => {
      const lines = ['HTTP/1.1 101 Switching Protocols']
      for (let index = 0; index < answer.rawHeaders.length; index += 2)
        lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (extra.length) socket.write(extra)
      if (head.length) tcp.write(head)
      bridges.add(socket)
      const done = () => {
        bridges.delete(socket)
        tcp.destroy()
        socket.destroy()
      }
      for (const end of [tcp, socket]) end.on('close', done).on('error', done)
      socket.pipe(tcp).pipe(socket)
    })
    upstream.on('response', () => refuse(502))
    upstream.on('error', () => refuse(502))
    upstream.end()
  })
  return { server, requests, environments, tickets, bridges }
}

// The path a person's server takes: the desktop paired with a gateway sets up workspaces on it from the Server page,
// reaches the host through a bridge ticket of the gateway, and follows the environment as it stops and starts.
test('server page sets up workspaces, and the sidebar follows the host through the gateway', async () => {
  test.setTimeout(240_000)
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-remote-server-')))
  const workspacesRoot = path.join(root, 'srv')
  await mkdir(workspacesRoot)
  let host: LaunchedHost | null = null
  let client: ElectronApplication | undefined
  let page!: Page
  const gateway = fakeGateway(() => host)
  const local = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
  try {
    await listen(gateway.server)
    host = await launchHost(path.join(root, 'host-profile'), workspacesRoot)
    client = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: instanceEnv(path.join(root, 'client-profile'), 'remote-server-e2e'),
    })
    page = await client.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const connection = await local('fleetConnect', {
      url: `http://127.0.0.1:${portOf(gateway.server)}`,
      code: 'ABCD-EFGH',
    })
    expect(connection.features).toContain('workspaces-host')

    // A server with bots only adds no host: the sidebar has no headings.
    expect(await local('hostsList')).toHaveLength(1)
    await expect(page.locator('[data-host-section-header]')).toHaveCount(0)

    // The Server page offers to set up workspaces, apart from the environments bots run in.
    await page.getByRole('tab', { name: 'Bots' }).click()
    await page
      .getByRole('button', { name: /fleet-workspaces-host/ })
      .first()
      .click()
    const section = page.getByTestId('server-workspaces')
    await expect(section).toContainText('Runs your chats and workspaces on this server')
    await section.getByRole('button', { name: 'Set up workspaces on this server' }).click()
    await expect
      .poll(() => gateway.requests.find((item) => item.key === 'environmentsCreate')?.body)
      .toMatchObject({ name: 'Workspaces', kind: 'workspaces', memoryLimitBytes: null })

    // Its page is the environment's, without what belongs to bots: no bot list, no screen, no compaction default.
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true, level: 1 })).toBeVisible()
    await expect(page.getByText('Chats and workspaces', { exact: true })).toBeVisible()
    await expect(page.getByText('Used by every chat and workspace on this server.')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Environment accounts', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New bot in this environment' })).toBeHidden()
    await expect(page.getByRole('tab', { name: 'Screen' })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Open environment screen' })).toBeHidden()

    // Bot lists and pickers never show it.
    const botsPanel = page.locator('#sidebar-panel-bots')
    await expect(botsPanel.getByRole('button', { name: /Acme/ }).first()).toBeVisible()
    await expect(botsPanel.getByText('Workspaces', { exact: true })).toHaveCount(0)

    // Once it runs, this computer reaches it through a ticket of the gateway, and lists it in the sidebar.
    const hostId = await expect
      .poll(async () => {
        const hosts = (await local('hostsList')) as Array<{ id: string; state: string; remote: boolean }>
        const remote = hosts.find((item) => item.remote)
        return remote?.state === 'online' ? remote.id : null
      })
      .not.toBeNull()
      .then(async () => ((await local('hostsList')) as Array<{ id: string }>)[1].id)
    expect(hostId).toMatch(/^[0-9a-f-]{36}\/workspaces$/)
    expect(gateway.requests.some((item) => item.key === 'environmentBridgeTicket')).toBe(true)
    // The ticket was spent on the bridge that is open now.
    expect(gateway.tickets.size).toBe(0)
    expect(gateway.bridges.size).toBe(1)
    const [, view] = await local('hostsList')
    expect(view).toMatchObject({
      label: 'fleet-workspaces-host',
      desktopEffects: false,
      environment: { id: 'workspaces', lifecycle: 'running' },
    })

    await page.getByRole('tab', { name: 'Chats' }).click()
    const chats = page.locator('#sidebar-panel-chats')
    const remoteHeader = chats.locator(`[data-host-section-header="${hostId}"]`)
    await expect(remoteHeader).toContainText('fleet-workspaces-host')
    await expect(chats.locator('[data-host-section-header="local"]')).toContainText('This computer')
    await chats.getByRole('button', { name: 'New chat on fleet-workspaces-host' }).click()
    const remoteChats = () =>
      page.evaluate((id) => (window as any).api.hostApi(id).listStandaloneConversations(true), hostId)
    await expect.poll(async () => (await remoteChats()).length).toBe(1)
    await expect(chats.locator(`[data-host-section="${hostId}"] .conv-item`)).toHaveCount(1)
    await expect(page.locator('.chat-input:visible')).toBeFocused()

    // Settings of a profile can be the host's: its accounts are not this computer's.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const selector = page.locator('[data-settings-host]')
    await expect(selector).toBeVisible()
    await selector.getByRole('combobox').click()
    await page.getByRole('option', { name: 'fleet-workspaces-host' }).click()
    await expect(selector.getByRole('combobox')).toContainText('fleet-workspaces-host')
    // Sections about this computer's window have no selector.
    await page.getByRole('button', { name: 'Updates', exact: true }).click()
    await expect(selector).toHaveCount(0)

    // Stopped on the server: the section says so and offers to start it; starting it brings the chat back.
    await page.getByRole('tab', { name: 'Chats' }).click()
    await chats.locator(`[data-host-section="${hostId}"] .conv-item`).click()
    await local('fleetEnvironmentAction', 'workspaces', 'stop')
    await expect(remoteHeader.locator('[data-host-status]')).toHaveAttribute('data-host-status', 'stopped')
    await expect(page.locator('[data-host-overlay="stopped"]')).toBeVisible()
    await expect(chats.locator(`[data-host-section="${hostId}"] .conv-item`)).toHaveCount(1)
    await page.locator('[data-host-overlay="stopped"]').getByRole('button', { name: 'Start' }).click()
    await expect.poll(() => gateway.requests.filter((item) => item.key === 'environmentStart').length).toBe(1)
    await expect(remoteHeader.locator('[data-host-status]')).toHaveCount(0)
    await expect(page.locator('[data-host-overlay]')).toHaveCount(0)
    const [, again] = await local('hostsList')
    expect(again).toMatchObject({ id: hostId, state: 'online', epoch: 2 })
    await expect(page.locator('.chat-input:visible')).toBeVisible()

    // Disconnecting the server removes its host from the window.
    await local('fleetDisconnect')
    await expect.poll(async () => (await local('hostsList')).length).toBe(1)
    await expect(page.locator('[data-host-section-header]')).toHaveCount(0)
    await expect(page.locator('.conv-item')).toHaveCount(0)
  } finally {
    await client?.close().catch(() => undefined)
    await host?.app.close().catch(() => undefined)
    gateway.server.closeAllConnections()
    await new Promise((resolve) => gateway.server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
