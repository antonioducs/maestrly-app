import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestRegistrar } from './ipc-registrar-test-utils'

vi.mock('../../src/main/channel', () => ({
  getChannelInfo: vi.fn(() => ({ channel: 'dev', productName: 'Maestrly' })),
  getInstanceId: vi.fn(() => 'instance-id'),
}))

vi.mock('../../src/main/i18n', () => ({
  tMain: vi.fn(() => (key: string) => key),
}))

vi.mock('../../src/main/open-external', () => ({
  getOpenTargets: vi.fn(),
  openExternal: vi.fn(),
}))

vi.mock('../../src/main/store', () => ({
  getConversation: vi.fn(),
  getWorkspace: vi.fn(),
}))

import { registerAppIpc } from '../../src/main/app-ipc'

describe('registerAppIpc', () => {
  afterEach(() => {
    delete process.env.AGENTS_HIDE_CHANNEL_BADGE
  })

  it('registers external opening and app identity with the expected registrars', () => {
    const { reg, handles, mhandles, ons, mons } = createTestRegistrar()

    registerAppIpc(reg)

    expect([...handles.keys()].sort()).toEqual(['app:info', 'open:targets'])
    expect([...mhandles.keys()].sort()).toEqual(['open:external', 'open:url'])
    expect(ons.size).toBe(0)
    expect(mons.size).toBe(0)
  })

  it('hides the badge only when the local recording flag is enabled', () => {
    const { reg, handles } = createTestRegistrar()
    registerAppIpc(reg)
    const appInfo = handles.get('app:info')
    expect(appInfo).toBeDefined()

    expect(appInfo!({} as never)).toMatchObject({
      channel: 'dev',
      instanceId: 'instance-id',
      hideChannelBadge: false,
    })

    process.env.AGENTS_HIDE_CHANNEL_BADGE = '1'
    expect(appInfo!({} as never)).toMatchObject({
      channel: 'dev',
      instanceId: 'instance-id',
      hideChannelBadge: true,
    })
  })
})
