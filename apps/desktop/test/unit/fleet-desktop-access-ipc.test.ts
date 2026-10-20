import { describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'

const state = vi.hoisted(() => ({
  bridges: [] as Array<{
    notify: (botId: string) => void
    state: ReturnType<typeof vi.fn>
    disable: ReturnType<typeof vi.fn>
  }>,
  broadcasts: [] as Array<{ channel: string; payload: unknown }>,
}))
vi.mock('../../src/main/fleet/client/desktop-bridge', () => ({
  FleetDesktopBridge: class {
    notify: (botId: string) => void
    state = vi.fn(async (botId: string) => ({ botId }))
    disable = vi.fn(async (botId: string) => ({ botId }))
    save = vi.fn()
    removeOther = vi.fn()
    constructor(_gateway: unknown, _host: unknown, notify: (botId: string) => void) {
      this.notify = notify
      state.bridges.push(this)
    }
  },
}))
vi.mock('../../src/main/bot/host', () => ({ botHost: {} }))
vi.mock('../../src/main/window-ipc', () => ({
  broadcast: (channel: string, payload: unknown) => state.broadcasts.push({ channel, payload }),
}))

import { registerFleetDesktopBridgeIpc } from '../../src/main/fleet/client/desktop-bridge-ipc'
import { fleetIpcRegistrar } from '../../src/main/fleet/client/scoped-ipc'
import type { FleetClientService } from '../../src/main/fleet/client/service'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'

describe('desktop access IPC', () => {
  it("gives each server's client a bridge of its own, reaches the one a call names, and names it in pushes", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
    const reg = { handle: register, mhandle: register, on: vi.fn(), mon: vi.fn() } as unknown as IpcRegistrar
    const client = { serverId: SERVER, desktopBridge: null } as unknown as FleetClientService
    const other = { serverId: OTHER, desktopBridge: null } as unknown as FleetClientService
    const scoped = fleetIpcRegistrar(reg, (serverId) => {
      if (serverId === SERVER) return client
      if (serverId === OTHER) return other
      throw new Error('FLEET_SERVER_UNKNOWN')
    })
    const setups: Array<(client: FleetClientService) => void> = []
    registerFleetDesktopBridgeIpc(scoped, {
      setupClients: (setup) => {
        setups.push(setup)
        setup(client)
      },
      clients: () => [client, other],
    })
    // A server paired later gets its bridge before its client starts.
    for (const setup of setups) setup(other)
    const [bridge, otherBridge] = state.bridges
    expect(client.desktopBridge).toBe(bridge)
    expect(other.desktopBridge).toBe(otherBridge)
    expect(await handlers.get('fleet:desktopAccess:get')!({}, SERVER, 'scout')).toEqual({ botId: 'scout' })
    expect(bridge.state).toHaveBeenCalledExactlyOnceWith('scout')
    await handlers.get('fleet:desktopAccess:disable')!({}, OTHER, 'scout')
    expect(otherBridge.disable).toHaveBeenCalledExactlyOnceWith('scout')
    expect(bridge.disable).not.toHaveBeenCalled()
    expect(() => handlers.get('fleet:desktopAccess:get')!({}, 'cccccccc-0000-4000-8000-000000000003', 'scout')).toThrow(
      'FLEET_SERVER_UNKNOWN'
    )
    bridge.notify('scout')
    expect(state.broadcasts).toEqual([
      { channel: 'fleet:desktop-access', payload: { serverId: SERVER, botId: 'scout' } },
    ])
  })
})
