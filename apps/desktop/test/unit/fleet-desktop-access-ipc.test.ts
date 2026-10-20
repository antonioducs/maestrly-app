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
vi.mock('../../src/main/fleet/client/settings', () => ({ readFleetSettings: () => ({ deviceName: null }) }))
vi.mock('../../src/main/window-ipc', () => ({
  broadcast: (channel: string, payload: unknown) => state.broadcasts.push({ channel, payload }),
}))

import { registerFleetDesktopBridgeIpc } from '../../src/main/fleet/client/desktop-bridge-ipc'
import { fleetIpcRegistrar } from '../../src/main/fleet/client/scoped-ipc'
import type { FleetClientService } from '../../src/main/fleet/client/service'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'

describe('desktop access IPC', () => {
  it("reaches the bridge of the server a call names, and tells the windows which server's bot changed", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
    const reg = { handle: register, mhandle: register, on: vi.fn(), mon: vi.fn() } as unknown as IpcRegistrar
    const client = { serverId: SERVER, desktopBridge: null } as unknown as FleetClientService
    const scoped = fleetIpcRegistrar(reg, (serverId) => {
      if (serverId !== SERVER) throw new Error('FLEET_SERVER_UNKNOWN')
      return client
    })
    registerFleetDesktopBridgeIpc(scoped, client)
    const [bridge] = state.bridges
    expect(client.desktopBridge).toBe(bridge)
    expect(await handlers.get('fleet:desktopAccess:get')!({}, SERVER, 'scout')).toEqual({ botId: 'scout' })
    expect(bridge.state).toHaveBeenCalledExactlyOnceWith('scout')
    expect(() => handlers.get('fleet:desktopAccess:disable')!({}, OTHER, 'scout')).toThrow('FLEET_SERVER_UNKNOWN')
    expect(bridge.disable).not.toHaveBeenCalled()
    bridge.notify('scout')
    expect(state.broadcasts).toEqual([
      { channel: 'fleet:desktop-access', payload: { serverId: SERVER, botId: 'scout' } },
    ])
  })
})
