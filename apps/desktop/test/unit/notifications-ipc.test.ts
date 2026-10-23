import { describe, expect, it, vi } from 'vitest'
import { registerNotificationsIpc } from '../../src/main/notifications/ipc'
import type { AppNotifications } from '../../src/main/notifications/app-notifications'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001'

function setup(notifications: AppNotifications | null) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    handlers.set(channel, fn)
  }
  registerNotificationsIpc(
    { handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar,
    () => notifications
  )
  return handlers
}

describe('notifications IPC', () => {
  it('lists bot marks and takes the visible bot only when it is a valid server bot', () => {
    const setVisibleBot = vi.fn()
    const list = vi.fn(() => [{ serverId: SERVER, botId: 'alex' }])
    const handlers = setup({ setVisibleBot, botAttention: { list } } as unknown as AppNotifications)
    expect(handlers.get('fleet:listBotAttention')!({})).toEqual([{ serverId: SERVER, botId: 'alex' }])
    const visible = handlers.get('fleet:visibleBot')!
    visible({}, { serverId: SERVER, botId: 'alex' })
    visible({}, { serverId: 'Not A Server', botId: 'alex' })
    visible({}, { serverId: SERVER, botId: 'x'.repeat(201) })
    visible({}, null)
    expect(setVisibleBot.mock.calls).toEqual([[{ serverId: SERVER, botId: 'alex' }], [null], [null], [null]])
  })

  it('lists no marks on an instance without notifications', () => {
    const handlers = setup(null)
    expect(handlers.get('fleet:listBotAttention')!({})).toEqual([])
    expect(() => handlers.get('fleet:visibleBot')!({}, null)).not.toThrow()
  })
})
