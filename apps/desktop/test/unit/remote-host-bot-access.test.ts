import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BotInventory } from '@maestrly/protocol'
import type { FleetHostDesktopCallRequest, FleetHostDesktopLink } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { LocalBotService } from '../../src/main/bot/local-service'
import { type DesktopBridgeHost, fleetClientPrefix } from '../../src/main/fleet/client/desktop-bridge'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import {
  createInstanceControlServer,
  type InstanceEnvironment,
  InstanceEvents,
} from '../../src/main/fleet/instance/server'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import { HostBotAccess, registerEnvironmentBotAccessIpc } from '../../src/main/remote-host/server/bot-access'
import type { EnvironmentBotAccessInput } from '../../src/shared/fleet-desktop-access'

beforeEach(freshDb)
afterEach(closeDb)

const ENVIRONMENT = 'personal'
const BOT = 'scout'
const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex')
const at = '2026-10-17T10:00:00.000Z'

const servers: http.Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

function inventory(workspaceIds: string[]): BotInventory {
  return {
    capability: 'bot:conversations:v1',
    enabled: true,
    workspaces: workspaceIds.map((workspaceId) => ({
      workspaceId,
      label: 'Project ' + workspaceId,
      branches: ['main'],
      defaultBranch: 'main',
    })),
    selections: [
      {
        selectionId: 'model',
        label: 'Model',
        providerLabel: 'Provider',
        reasoningEfforts: [],
        fastMode: false,
        modes: ['agent'],
        permissionModes: ['ask'],
      },
    ],
  }
}

/** The host's local bot service, reduced to what the bridge asks of it. */
function hostOf(service: LocalBotService): DesktopBridgeHost {
  return {
    fleetConnections: (prefix) => service.connectionsByClientPrefix(prefix),
    async saveFleetConnection(prefix, input) {
      const active = service.connectionsByClientPrefix(prefix).find((connection) => !connection.revokedAt)
      if (active) {
        service.setGrants(active.id, input.workspaceIds, input.actions)
        service.saveInventory(active.id, inventory(input.workspaceIds))
        return { connection: service.requireConnection(active.id), created: false }
      }
      const connection = service.createConnection({
        name: input.name,
        clientId: prefix + randomUUID(),
        workspaceIds: input.workspaceIds,
        actions: input.actions,
        providerIds: input.providerIds,
        selections: input.selections,
        permissionCeiling: input.permissionCeiling,
      })
      service.saveInventory(connection.id, inventory(input.workspaceIds))
      return { connection, created: true }
    },
    async revokeFleetConnection(connectionId) {
      service.revokeConnection(connectionId)
    },
    callFleetTool: (connectionId, name, input, signal) => service.callTool(connectionId, name, input, signal),
    localDesktopId: () => service.desktopId(),
  }
}

/** The internal API of the gateway as a workspaces host reaches it: the links its token holds, one per bot. */
async function gateway() {
  const state = {
    links: [] as FleetHostDesktopLink[],
    requests: [] as Array<{ method: string; path: string; authorization: string | undefined; body: unknown }>,
  }
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString()
    const body = raw ? JSON.parse(raw) : undefined
    const path = new URL(req.url ?? '/', 'http://gateway').pathname
    state.requests.push({ method: req.method ?? '', path, authorization: req.headers.authorization, body })
    const send = (status: number, value?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(value === undefined ? undefined : JSON.stringify(value))
    }
    if (req.headers.authorization !== 'Bearer ' + HOST_TOKEN) return send(401, { code: 'UNAUTHORIZED', message: 'No' })
    if (path === '/internal/v1/host/desktop-links' && req.method === 'GET') return send(200, { links: state.links })
    const bot = /^\/internal\/v1\/host\/bots\/([^/]+)\/desktop-link$/.exec(path)?.[1]
    if (bot && req.method === 'PUT') {
      const existing = state.links.find((link) => link.botId === bot)
      const link: FleetHostDesktopLink = {
        desktopId: existing?.desktopId ?? 'dsk_' + randomBytes(12).toString('base64url'),
        name: body.name,
        kind: 'environment',
        online: true,
        lastSeenAt: null,
        linkedAt: at,
        self: true,
        environmentId: ENVIRONMENT,
        botId: bot,
      }
      state.links = [...state.links.filter((item) => item.botId !== bot), link]
      return send(200, link)
    }
    if (bot && req.method === 'DELETE') {
      state.links = state.links.filter((item) => item.botId !== bot)
      res.writeHead(204)
      return res.end()
    }
    send(404, { code: 'NOT_FOUND', message: 'Route not found' })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const access: EnvironmentBotAccessInput = {
  macName: 'Personal',
  botName: 'Scout',
  workspaceIds: ['w-1'],
  actions: ['chats:read', 'chats:write', 'chats:control', 'chats:answer'],
  selections: [{ providerId: 'provider', modelId: 'model' }],
  permissionCeiling: 'auto',
}

async function setup() {
  const service = new LocalBotService()
  const server = await gateway()
  const notified: string[] = []
  const bots = new HostBotAccess(
    { gateway: { url: server.url, token: HOST_TOKEN }, environmentId: ENVIRONMENT },
    hostOf(service),
    (botId) => notified.push(botId)
  )
  return { service, server, bots, notified }
}

const callOf = (
  desktopId: string,
  op: FleetHostDesktopCallRequest['op'],
  input: Record<string, unknown> = {},
  extra: Partial<FleetHostDesktopCallRequest> = {}
): FleetHostDesktopCallRequest => ({
  callId: randomUUID(),
  botId: BOT,
  desktopId,
  op,
  input,
  expiresAt: new Date(Date.now() + 20_000).toISOString(),
  ...extra,
})

describe('a workspaces host giving bots access', () => {
  it('links itself with its host token and keeps the access under a connection of its own', async () => {
    const { service, server, bots, notified } = await setup()
    expect(bots.available).toBe(true)
    const view = await bots.save(BOT, access)
    expect(view).toMatchObject({
      availability: 'ready',
      access: { macName: 'Personal', workspaceIds: ['w-1'], permissionCeiling: 'auto' },
      links: [expect.objectContaining({ name: 'Personal', self: true })],
    })
    // The host linked itself, with its own token, and named only the bot: never which environment it is.
    const put = server.state.requests.find((request) => request.method === 'PUT')!
    expect(put).toEqual({
      method: 'PUT',
      path: `/internal/v1/host/bots/${BOT}/desktop-link`,
      authorization: 'Bearer ' + HOST_TOKEN,
      body: { name: 'Personal' },
    })
    const [connection] = service.connectionsByClientPrefix(fleetClientPrefix(ENVIRONMENT, BOT))
    expect(connection).toMatchObject({ name: 'Scout', workspaceIds: ['w-1'], revokedAt: null })
    expect(notified).toContain(BOT)
    // Saving again changes the same connection and the same link.
    await bots.save(BOT, { ...access, macName: 'Home' })
    expect(service.connectionsByClientPrefix(fleetClientPrefix(ENVIRONMENT, BOT))).toHaveLength(1)
    expect(server.state.links).toEqual([expect.objectContaining({ name: 'Home', botId: BOT })])
  })

  it('runs the calls the gateway posts as its own tools, and answers for what it does not hold', async () => {
    const { service, server, bots } = await setup()
    await bots.save(BOT, access)
    const desktopId = server.state.links[0].desktopId
    const local = service.desktopId()
    const listed = await bots.call(callOf(desktopId, 'listWorkspaces'))
    expect(listed).toMatchObject({
      ok: true,
      value: {
        desktop: { id: desktopId, name: 'Personal' },
        workspaces: [expect.objectContaining({ workspaceId: 'w-1' })],
      },
    })
    expect(JSON.stringify(listed)).not.toContain(local)
    // A workspace the owner did not grant is refused with the host's own reason.
    const refused = await bots.call(
      callOf(desktopId, 'createChat', {
        workspaceId: 'w-2',
        name: 'Fix',
        baseBranch: 'main',
        selection: { selectionId: 'model' },
        idempotencyKey: randomUUID(),
      })
    )
    expect(refused).toMatchObject({ ok: false, error: { code: 'desktop_refused' } })
    // A call for another link, one the gateway gave up on, or one already run is never run here.
    const notLinked = {
      ok: false,
      error: { code: 'desktop_not_linked', message: expect.stringContaining('environment') },
    }
    expect(await bots.call(callOf('dsk_otherotherotherother', 'listChats'))).toMatchObject(notLinked)
    expect(
      await bots.call(callOf(desktopId, 'listChats', {}, { expiresAt: new Date(Date.now() - 1).toISOString() }))
    ).toMatchObject(notLinked)
    const once = callOf(desktopId, 'listChats')
    expect((await bots.call(once)).ok).toBe(true)
    expect(await bots.call(once)).toMatchObject(notLinked)
    // A bot this host never gave access to is told so.
    expect(await bots.call({ ...callOf(desktopId, 'listChats'), botId: 'other' })).toMatchObject(notLinked)
  })

  it('takes the access back once the server dropped the link, and drops a link it holds no access for', async () => {
    const { service, server, bots } = await setup()
    await bots.save(BOT, access)
    const [connection] = service.connectionsByClientPrefix(fleetClientPrefix(ENVIRONMENT, BOT))
    // Removed from one of the owner's computers: the gateway tells the host, which checks its side.
    server.state.links = []
    await bots.linksChanged(BOT)
    expect(service.requireConnection(connection.id).revokedAt).not.toBeNull()

    // A link the server still holds for a bot this host has no access for is removed when the host starts.
    server.state.links = [
      {
        desktopId: 'dsk_leftleftleftleftleft',
        name: 'Personal',
        kind: 'environment',
        online: true,
        lastSeenAt: null,
        linkedAt: at,
        self: true,
        environmentId: ENVIRONMENT,
        botId: 'leftover',
      },
    ]
    // Connections that are not this environment's are revoked at once (a stray one names another environment).
    const stray = service.createConnection({
      name: 'Stray',
      clientId: 'fleet:other-environment:scout:' + randomUUID(),
      workspaceIds: ['w-1'],
      actions: ['chats:read'],
      providerIds: ['provider'],
      selections: [{ providerId: 'provider', modelId: 'model' }],
      permissionCeiling: 'ask',
    })
    await bots.start()
    expect(service.requireConnection(stray.id).revokedAt).not.toBeNull()
    expect(server.state.links).toEqual([])

    const disabled = await bots.disable(BOT)
    expect(disabled.access).toBeNull()
    expect(server.state.requests.filter((request) => request.method === 'DELETE').map((r) => r.path)).toContain(
      `/internal/v1/host/bots/${BOT}/desktop-link`
    )
  })

  it('says it needs a newer server when the gateway gave it no host token', async () => {
    const service = new LocalBotService()
    const bots = new HostBotAccess(null, hostOf(service))
    expect(bots.available).toBe(false)
    expect(await bots.state(BOT)).toMatchObject({ availability: 'gateway-update', access: null, links: null })
    await expect(bots.save(BOT, access)).rejects.toThrow('Update the bot server')
    expect(await bots.call(callOf('dsk_selfselfselfselfself', 'listChats'))).toMatchObject({
      ok: false,
      error: { code: 'desktop_not_linked' },
    })
    expect(service.connections()).toEqual([])
  })
})

describe('the channels of environment bot access', () => {
  function registrar() {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const reg: IpcRegistrar = {
      handle: (channel, fn) => handlers.set(channel, fn),
      mhandle: (channel, fn) => handlers.set(channel, fn),
      on: () => {},
      mon: () => {},
    }
    return { reg, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) }
  }

  it('answers only on a workspaces host, and checks what the computer sends', async () => {
    const local = registrar()
    registerEnvironmentBotAccessIpc(local.reg, () => null)
    expect(() => local.invoke('environment-bot-access:get', BOT)).toThrow('Only a workspaces environment')

    const { bots } = await setup()
    const host = registrar()
    registerEnvironmentBotAccessIpc(host.reg, () => bots)
    expect(() => host.invoke('environment-bot-access:get', 'Not A Bot')).toThrow()
    expect(() => host.invoke('environment-bot-access:save', BOT, { ...access, botName: undefined })).toThrow()
    expect(() => host.invoke('environment-bot-access:save', BOT, { ...access, workspacePaths: ['/srv'] })).toThrow()
    expect(await host.invoke('environment-bot-access:save', BOT, access)).toMatchObject({ availability: 'ready' })
    expect(await host.invoke('environment-bot-access:get', BOT)).toMatchObject({ access: { macName: 'Personal' } })
    expect(await host.invoke('environment-bot-access:disable', BOT)).toMatchObject({ access: null })
  })
})

describe('the control server routes of bots’ calls', () => {
  const token = randomBytes(32).toString('base64url')
  const config = parseBotInstanceConfig({
    MAESTRLY_BOT_MODE: '1',
    MAESTRLY_BOT_CONTROL_TOKEN: token,
    MAESTRLY_BOT_CONTROL_HOST: '127.0.0.1',
    MAESTRLY_BOT_CONTROL_PORT: '0',
  })!
  const environment = { events: new InstanceEvents() } as unknown as InstanceEnvironment

  async function listen(withCalls: boolean) {
    const calls: FleetHostDesktopCallRequest[] = []
    const changed: string[] = []
    const server = createInstanceControlServer(
      config,
      environment,
      withCalls
        ? {
            desktopCalls: {
              call: async (request) => {
                calls.push(request)
                return { ok: true, value: { op: request.op } }
              },
              linksChanged: async (botId) => {
                changed.push(botId)
              },
            },
          }
        : {}
    )
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = (route: string, body: unknown, auth = true) =>
      fetch(origin + route, {
        method: 'POST',
        headers: {
          'X-Maestrly-Fleet-Protocol': '1',
          'content-type': 'application/json',
          ...(auth ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      })
    return { post, calls, changed }
  }

  it('runs a posted call and hears of link changes, with the control token only', async () => {
    const { post, calls, changed } = await listen(true)
    const request = callOf('dsk_selfselfselfselfself', 'readChat', { conversationId: 'c-1' })
    const answered = await post('/v1/host/desktop-calls', request)
    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual({ ok: true, value: { op: 'readChat' } })
    expect(calls).toEqual([request])
    expect((await post('/v1/host/desktop-links/changed', { botId: BOT })).status).toBe(204)
    expect(changed).toEqual([BOT])
    expect((await post('/v1/host/desktop-calls', request, false)).status).toBe(401)
    expect((await post('/v1/host/desktop-calls', { ...request, op: 'approvePlan' })).status).toBe(400)
    expect(calls).toHaveLength(1)
  })

  it('has no such routes on an environment that takes no bots’ calls', async () => {
    const { post } = await listen(false)
    const request = callOf('dsk_selfselfselfselfself', 'readChat')
    expect((await post('/v1/host/desktop-calls', request)).status).toBe(404)
    expect((await post('/v1/host/desktop-links/changed', { botId: BOT })).status).toBe(404)
  })
})
