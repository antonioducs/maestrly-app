import { describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import { fleetIpcRegistrar } from '../../src/main/fleet/client/scoped-ipc'
import { FLEET_SERVER_UNKNOWN, type FleetServerId } from '../../src/shared/fleet-servers'

const A = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId

function registrar() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const register = (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  }
  const reg = { handle: register, mhandle: register, on: vi.fn(), mon: vi.fn() } as unknown as IpcRegistrar
  return { reg, handlers }
}

describe('fleetIpcRegistrar', () => {
  it("gives the handler the named server's client and the remaining arguments", async () => {
    const { reg, handlers } = registrar()
    const client = { name: 'A' }
    const resolve = vi.fn(() => client as never)
    fleetIpcRegistrar(reg, resolve).mhandle('fleet:getBot', (fleet, _event, botId) => [fleet, botId])
    expect(await handlers.get('fleet:getBot')!({}, A, 'alex')).toEqual([client, 'alex'])
    expect(resolve).toHaveBeenCalledWith(A)
  })
  it('refuses a call without a valid server before resolving it', () => {
    const { reg, handlers } = registrar()
    const resolve = vi.fn()
    fleetIpcRegistrar(reg, resolve).handle('fleet:getBot', () => 'never')
    expect(() => handlers.get('fleet:getBot')!({}, '../alex')).toThrow(FLEET_SERVER_UNKNOWN)
    expect(() => handlers.get('fleet:getBot')!({})).toThrow(FLEET_SERVER_UNKNOWN)
    expect(resolve).not.toHaveBeenCalled()
  })
})
