import { describe, expect, it, vi } from 'vitest'
import { createTestRegistrar } from './ipc-registrar-test-utils'

const h = vi.hoisted(() => ({ prepare: vi.fn(), confirm: vi.fn() }))
vi.mock('../../src/main/local-conversation/service', () => ({
  prepareLocalConversation: h.prepare,
  confirmLocalConversation: h.confirm,
}))

import { registerLocalConversationIpc } from '../../src/main/local-conversation/ipc'

describe('local conversation ipc', () => {
  it('registers prepare/confirm as mutators and forwards valid payloads', async () => {
    const { reg, mhandles } = createTestRegistrar()
    registerLocalConversationIpc(reg)
    expect([...mhandles.keys()].sort()).toEqual(['conversation:local-confirm', 'conversation:local-prepare'])
    const input = {
      workspaceId: 'ws',
      intent: { type: 'create-from-head', branch: 'feature/x' },
    }
    await mhandles.get('conversation:local-prepare')?.({} as never, input)
    expect(h.prepare).toHaveBeenCalledWith(input)
  })

  it('rejects cwd, internal fields, and tokens with extra fields before calling the service', async () => {
    h.prepare.mockClear()
    h.confirm.mockClear()
    const { reg, mhandles } = createTestRegistrar()
    registerLocalConversationIpc(reg)
    expect(() =>
      mhandles.get('conversation:local-prepare')?.({} as never, {
        workspaceId: 'ws',
        cwd: '/tmp/pwn',
        attach: {},
        intent: { type: 'create-from-head', branch: 'x' },
      })
    ).toThrow('Invalid payload')
    expect(() => mhandles.get('conversation:local-confirm')?.({} as never, { token: 'x', source: 'external' })).toThrow(
      'Invalid payload'
    )
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.confirm).not.toHaveBeenCalled()
  })
})
