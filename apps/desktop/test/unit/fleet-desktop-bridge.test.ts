import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotInventory } from '@maestrly/protocol'
import type { FleetDesktopCallEvent, FleetDesktopCallResult, FleetDesktopLinkView } from '@maestrly/bot-fleet-protocol'
import { closeDb, freshDb } from '../helpers/db'
import { LocalBotService } from '../../src/main/bot/local-service'
import {
  FleetDesktopBridge,
  fleetClientPrefix,
  type DesktopBridgeGateway,
  type DesktopBridgeHost,
} from '../../src/main/fleet/client/desktop-bridge'
import type { FleetDesktopAccessInput } from '../../src/shared/fleet-desktop-access'

beforeEach(freshDb)
afterEach(closeDb)

const BOT = 'scout'
const SELF = 'dsk_selfselfselfselfself'
const OTHER = 'dsk_otherotherotherother'
const at = '2026-10-05T10:00:00.000Z'

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

/** This Mac's personal-bot host, reduced to the real local service and what the bridge asks of it. */
function hostOf(service: LocalBotService) {
  const revoked: string[] = []
  const host: DesktopBridgeHost = {
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
      revoked.push(connectionId)
      service.revokeConnection(connectionId)
    },
    callFleetTool: (connectionId, name, input, signal) => service.callTool(connectionId, name, input, signal),
    localDesktopId: () => service.desktopId(),
  }
  return { host, revoked }
}

/** The bot server as this Mac reaches it: one bot, the links it holds, and the answers this Mac posts. */
function gatewayOf(deviceId = 'device-a') {
  const state = {
    deviceId: deviceId as string | null,
    links: [] as FleetDesktopLinkView[],
    answers: [] as Array<{ callId: string; result: FleetDesktopCallResult }>,
    unlinks: 0,
    failLink: false,
  }
  const self = (name: string): FleetDesktopLinkView => ({
    desktopId: SELF,
    name,
    online: true,
    lastSeenAt: null,
    linkedAt: at,
    self: true,
  })
  const gateway: DesktopBridgeGateway = {
    deviceId: () => state.deviceId,
    deviceName: () => 'Antonio’s MacBook',
    availability: () => 'ready',
    botName: () => 'Scout',
    links: async () => state.links,
    async link(_botId, name) {
      if (state.failLink) throw new Error('The bot server is unreachable.')
      const link = self(name)
      state.links = [...state.links.filter((item) => !item.self), link]
      return link
    },
    async unlink() {
      state.unlinks++
      state.links = state.links.filter((item) => !item.self)
    },
    async remove(_botId, desktopId) {
      state.links = state.links.filter((item) => item.desktopId !== desktopId)
    },
    async answer(callId, result) {
      state.answers.push({ callId, result })
    },
  }
  return { gateway, state, self }
}

const access: FleetDesktopAccessInput = {
  macName: 'Work MacBook',
  workspaceIds: ['w-1'],
  actions: ['chats:read', 'chats:write', 'chats:control', 'chats:answer'],
  selections: [{ providerId: 'provider', modelId: 'model' }],
  permissionCeiling: 'auto',
}
const call = (
  op: FleetDesktopCallEvent['op'],
  input: Record<string, unknown> = {},
  extra: Partial<FleetDesktopCallEvent> = {}
): FleetDesktopCallEvent => ({
  type: 'desktop.call',
  at,
  callId: randomUUID(),
  botId: BOT,
  desktopId: SELF,
  op,
  input,
  expiresAt: new Date(Date.now() + 20_000).toISOString(),
  ...extra,
})
const createInput = (workspaceId: string) => ({
  workspaceId,
  name: 'Fix the build',
  baseBranch: 'main',
  selection: { selectionId: 'model' },
  message: 'Fix it.',
  idempotencyKey: randomUUID(),
})

function setup(deviceId = 'device-a') {
  const service = new LocalBotService()
  const { host, revoked } = hostOf(service)
  const { gateway, state, self } = gatewayOf(deviceId)
  const notified: string[] = []
  const bridge = new FleetDesktopBridge(gateway, host, (botId) => notified.push(botId))
  return { service, host, revoked, gateway, state, self, bridge, notified }
}

describe('fleet desktop bridge', () => {
  it('gives a bot access under a name of its own, and holds it as a connection of that pairing', async () => {
    const { bridge, service, state } = setup()
    const view = await bridge.save(BOT, access)
    expect(view).toMatchObject({
      availability: 'ready',
      access: { ...access },
      defaultName: 'Antonio’s MacBook',
      links: [expect.objectContaining({ desktopId: SELF, name: 'Work MacBook', self: true })],
    })
    const [connection] = service.connectionsByClientPrefix(fleetClientPrefix('device-a', BOT))
    expect(connection).toMatchObject({
      name: 'Scout',
      workspaceIds: ['w-1'],
      permissionCeiling: 'auto',
      revokedAt: null,
    })
    // Saving again changes the same connection instead of minting another.
    await bridge.save(BOT, { ...access, macName: 'Renamed' })
    expect(service.connectionsByClientPrefix(fleetClientPrefix('device-a', BOT))).toHaveLength(1)
    expect(state.links.find((link) => link.self)?.name).toBe('Renamed')
  })

  it("runs a call as this Mac's own tool, under its grants, and names this Mac only as the bot knows it", async () => {
    const { bridge, service, state } = setup()
    await bridge.save(BOT, access)
    const local = service.desktopId()

    await bridge.call(call('listWorkspaces'))
    const listed = state.answers.at(-1)!.result
    expect(listed).toMatchObject({
      ok: true,
      value: {
        desktop: { id: SELF, name: 'Work MacBook' },
        workspaces: [expect.objectContaining({ workspaceId: 'w-1' })],
      },
    })
    expect(JSON.stringify(listed)).not.toContain(local)

    // A workspace this Mac never granted is refused with the Mac's own reason.
    await bridge.call(call('createChat', createInput('w-2')))
    expect(state.answers.at(-1)!.result).toEqual({
      ok: false,
      error: { code: 'desktop_refused', message: 'The connection grant was changed or revoked.' },
    })
    // An input the tool rejects says what is wrong, and runs nothing.
    await bridge.call(call('createChat', { workspaceId: 'w-1' }))
    expect(state.answers.at(-1)!.result).toMatchObject({ ok: false, error: { code: 'desktop_refused' } })

    await bridge.call(call('createChat', createInput('w-1')))
    const created = state.answers.at(-1)!.result as { ok: true; value: { conversation: { desktopId: string } } }
    expect(created.ok).toBe(true)
    expect(created.value.conversation.desktopId).toBe(SELF)
    expect(JSON.stringify(created)).not.toContain(local)

    // Taking away the action takes away the call.
    await bridge.save(BOT, { ...access, actions: ['chats:read'] })
    await bridge.call(call('createChat', createInput('w-1')))
    expect(state.answers.at(-1)!.result).toMatchObject({ ok: false, error: { code: 'desktop_refused' } })
  })

  it('ignores a call for another Mac, never runs one the server gave up on, and runs each call once', async () => {
    const { bridge, service, state } = setup()
    await bridge.save(BOT, access)
    const [connection] = service.connectionsByClientPrefix(fleetClientPrefix('device-a', BOT))
    const chats = () => service.callTool(connection.id, 'bot_list_chats', {}, new AbortController().signal)

    await bridge.call(call('createChat', createInput('w-1'), { desktopId: OTHER }))
    await bridge.call(call('createChat', createInput('w-1'), { expiresAt: new Date(Date.now() - 1).toISOString() }))
    expect(state.answers).toEqual([])
    expect(await chats()).toEqual({ conversations: [] })

    const once = call('createChat', createInput('w-1'))
    await bridge.call(once)
    await bridge.call(once)
    expect(state.answers.filter((answer) => answer.callId === once.callId)).toHaveLength(1)
    expect(((await chats()) as { conversations: unknown[] }).conversations).toHaveLength(1)
  })

  it('takes the access here away once another Mac removed the link, and tells the bot afterwards', async () => {
    const { bridge, service, state, revoked } = setup()
    await bridge.save(BOT, access)
    // Another Mac removed this one's link: the server now lists none for it.
    state.links = []
    await bridge.links(BOT, [])
    const [connection] = service.connectionsByClientPrefix(fleetClientPrefix('device-a', BOT))
    expect(revoked).toEqual([connection.id])
    expect(service.requireConnection(connection.id).revokedAt).not.toBeNull()
    await bridge.call(call('listWorkspaces'))
    expect(state.answers.at(-1)!.result).toMatchObject({ ok: false, error: { code: 'desktop_not_linked' } })
  })

  it('checks a stale event with the server instead of acting on it', async () => {
    const { bridge, service, revoked } = setup()
    await bridge.save(BOT, access)
    // An event sent before this Mac linked itself arrives late: the server still lists the link.
    await bridge.links(BOT, [])
    expect(revoked).toEqual([])
    expect(service.connectionsByClientPrefix(fleetClientPrefix('device-a', BOT))[0].revokedAt).toBeNull()
  })

  it('removes a link this Mac holds no access for', async () => {
    const { bridge, state, self } = setup()
    state.links = [self('Forgotten')]
    await bridge.links(BOT, state.links)
    expect(state.unlinks).toBe(1)
    expect(state.links).toEqual([])
  })

  it('leaves no access behind when the server could not record the link', async () => {
    const { bridge, service, state } = setup()
    state.failLink = true
    await expect(bridge.save(BOT, access)).rejects.toThrow('unreachable')
    expect(service.connectionsByClientPrefix(fleetClientPrefix('device-a', BOT)).every((item) => item.revokedAt)).toBe(
      true
    )
  })

  it('turns access off here first, removes the other Macs only through the server, and ends with the pairing', async () => {
    const { bridge, service, state, gateway } = setup()
    await bridge.save(BOT, access)
    const other = { ...state.links[0], desktopId: OTHER, name: 'iMac', self: false }
    state.links = [...state.links, other]
    await expect(bridge.removeOther(BOT, SELF)).rejects.toThrow('this computer instead')
    expect((await bridge.removeOther(BOT, OTHER)).links?.map((link) => link.desktopId)).toEqual([SELF])
    const disabled = await bridge.disable(BOT)
    expect(disabled.access).toBeNull()
    expect(state.unlinks).toBe(1)

    await bridge.save(BOT, access)
    await bridge.unpaired('device-a')
    expect(service.connectionsByClientPrefix('fleet:device-a:').every((item) => item.revokedAt)).toBe(true)

    // A new pairing of this Mac revokes whatever an earlier one left behind.
    await bridge.save(BOT, access)
    expect(gateway.deviceId()).toBe('device-a')
    state.deviceId = 'device-b'
    await bridge.connected()
    expect(service.connectionsByClientPrefix('fleet:').every((item) => item.revokedAt)).toBe(true)
  })
})
