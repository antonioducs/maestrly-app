import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'

const mocks = vi.hoisted(() => ({
  call: vi.fn(async () => undefined),
  screens: { openScreen: vi.fn(), send: vi.fn(), close: vi.fn() },
}))
vi.mock('../../src/main/fleet/client/service', () => ({
  fleetClientService: {
    start: vi.fn(),
    stop: vi.fn(),
    getConnection: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getSnapshot: vi.fn(),
    refresh: vi.fn(),
    getDigest: vi.fn(),
    ackDigest: vi.fn(),
    call: mocks.call,
    screens: mocks.screens,
    idempotencyKey: () => '550e8400-e29b-41d4-a716-446655440000',
  },
}))
import { registerFleetClientIpc } from '../../src/main/fleet/client/ipc'

afterEach(() => {
  delete process.env.MAESTRLY_BOT_MODE
  vi.clearAllMocks()
})

describe('fleet IPC validation', () => {
  it('rejects invalid bot IDs, creation bodies, actions, resolutions, and screen frames before dispatch', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const invoke = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)?.({ sender: {} }, ...args)
    expect(() => invoke('fleet:getBot', '../bad')).toThrow()
    expect(() => invoke('fleet:createBot', { name: '', instructions: '', ceiling: 'ask', talksTo: [] })).toThrow()
    expect(() => invoke('fleet:botAction', 'bot', 'delete')).toThrow()
    expect(() => invoke('fleet:resolveInteraction', 'bot', 'id', { kind: 'permission', reply: 'forever' })).toThrow()
    expect(() => invoke('fleet:screenSend', 'channel', 'text')).toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    await invoke('fleet:createBot', { name: 'Valid', instructions: '', ceiling: 'ask', talksTo: [] })
    expect(mocks.call).toHaveBeenCalledWith('botsCreate', {
      body: {
        name: 'Valid',
        instructions: '',
        ceiling: 'ask',
        talksTo: [],
        idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
      },
    })
  })
})
