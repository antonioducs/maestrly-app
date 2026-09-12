import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRegistrar } from './ipc-registrar-test-utils'

const h = vi.hoisted(() => ({
  createConversation: vi.fn(),
  setConversationArchived: vi.fn(),
  stopChat: vi.fn(),
}))

vi.mock('../../src/main/conversation-branch-service', () => ({
  getConversationBranchInfo: vi.fn(),
}))

vi.mock('../../src/main/conversation-migration/store', () => ({
  assertConversationMigrationMutationAllowed: vi.fn(),
}))

vi.mock('../../src/main/floating-manager', () => ({
  disposeConversation: vi.fn(),
  refreshFloatingTitles: vi.fn(),
}))

vi.mock('../../src/main/popup-manager', () => ({
  disposeConversation: vi.fn(),
}))

vi.mock('../../src/main/drawer-manager', () => ({
  disposeConversation: vi.fn(),
}))

vi.mock('../../src/main/notes/notes-service', () => ({
  unwatchNotes: vi.fn(),
}))

vi.mock('../../src/main/plan-broker', () => ({
  clearPlan: vi.fn(),
}))

vi.mock('../../src/main/selection-bridge', () => ({
  unwatchConversation: vi.fn(),
}))

vi.mock('../../src/main/store', () => ({
  countOtherActiveConversationsInCwd: vi.fn(),
  getConversation: vi.fn(),
  getLocale: vi.fn(),
  listConversations: vi.fn(),
  patchConvUiPrefs: vi.fn(),
  setConversationOrder: vi.fn(),
  setConversationPinned: vi.fn(),
}))

vi.mock('../../src/main/terminal-manager', () => ({
  disposeShellTerminals: vi.fn(),
}))

vi.mock('../../src/main/workspace-service', () => ({
  createConversation: h.createConversation,
  createSiblingConversation: vi.fn(),
  deleteConversation: vi.fn(),
  renameConversation: vi.fn(),
  setConversationArchived: h.setConversationArchived,
}))

import { registerConversationIpc } from '../../src/main/conversation-ipc'
import { setConversationPinned } from '../../src/main/store'

describe('registerConversationIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks() // Clear spies between tests to prevent previous calls from satisfying assertions.
  })

  it('registers conversation channels with the expected registrars', () => {
    const { reg, handles, mhandles, ons, mons } = createTestRegistrar()

    registerConversationIpc(reg, { stopChat: h.stopChat })

    expect([...handles.keys()].sort()).toEqual(['conversation:branch-info', 'conversation:list'])
    expect([...mhandles.keys()].sort()).toEqual([
      'conversation:archive',
      'conversation:create',
      'conversation:createSibling',
      'conversation:delete',
      'conversation:pin',
      'conversation:rename',
      'conversation:reorder',
    ])
    expect([...ons.keys()]).toEqual([])
    expect([...mons.keys()]).toEqual(['conv:set-main-tab-order'])
  })

  it('accepts only the public worktree subset and rejects local mode and internal fields', async () => {
    const { reg, mhandles } = createTestRegistrar()
    registerConversationIpc(reg, { stopChat: h.stopChat })
    const valid = {
      workspaceId: 'ws',
      branch: 'feature/x',
      isNewBranch: true,
      mode: 'worktree',
    }
    await mhandles.get('conversation:create')?.({} as never, valid)
    expect(h.createConversation).toHaveBeenCalledWith(valid)
    await mhandles.get('conversation:create')?.({} as never, { ...valid, experience: 'maestro' })
    expect(h.createConversation).toHaveBeenLastCalledWith({ ...valid, experience: 'maestro' })
    expect(() =>
      mhandles.get('conversation:create')?.({} as never, {
        ...valid,
        mode: 'local',
        cwd: '/tmp/pwn',
      })
    ).toThrow('Invalid payload')
  })

  it('forwards pin state to the store and returns its canonical value', async () => {
    const { reg, mhandles } = createTestRegistrar()
    const pinnedAt = 1_700_000_000_000
    vi.mocked(setConversationPinned).mockReturnValueOnce(pinnedAt)
    registerConversationIpc(reg, { stopChat: h.stopChat })

    const result = await mhandles.get('conversation:pin')?.({} as never, 'conv-1', true)

    expect(setConversationPinned).toHaveBeenCalledWith('conv-1', true)
    expect(result).toBe(pinnedAt)
  })

  it('unpins with pinned=false and returns null', async () => {
    const { reg, mhandles } = createTestRegistrar()
    vi.mocked(setConversationPinned).mockReturnValueOnce(null)
    registerConversationIpc(reg, { stopChat: h.stopChat })

    const result = await mhandles.get('conversation:pin')?.({} as never, 'conv-2', false)

    expect(setConversationPinned).toHaveBeenCalledWith('conv-2', false)
    expect(result).toBeNull()
  })

  it('stops Maestrly Chat before archiving the conversation', async () => {
    const { reg, mhandles } = createTestRegistrar()
    h.stopChat.mockResolvedValueOnce(undefined)
    registerConversationIpc(reg, { stopChat: h.stopChat })

    await mhandles.get('conversation:archive')?.({} as never, 'conv-chat', true)

    expect(h.setConversationArchived).toHaveBeenCalledWith('conv-chat', true)
    expect(h.stopChat).toHaveBeenCalledWith('conv-chat')
    expect(h.stopChat.mock.invocationCallOrder[0]).toBeLessThan(h.setConversationArchived.mock.invocationCallOrder[0])
  })

})
