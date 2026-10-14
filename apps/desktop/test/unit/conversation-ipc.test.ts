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
  clearConversationAttention: vi.fn(),
  listConversationAttention: vi.fn(),
  countOtherActiveConversationsInCwd: vi.fn(),
  getConversation: vi.fn(),
  getLocale: vi.fn(),
  listConversations: vi.fn(),
  listStandaloneConversations: vi.fn(),
  setStandaloneConversationOrder: vi.fn(),
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
import {
  clearConversationAttention,
  listConversationAttention,
  listStandaloneConversations,
  setStandaloneConversationOrder,
  setConversationPinned,
} from '../../src/main/store'

describe('registerConversationIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks() // Clear spies between tests to prevent previous calls from satisfying assertions.
  })

  it('registers conversation channels with the expected registrars', () => {
    const { reg, handles, mhandles, ons, mons } = createTestRegistrar()

    registerConversationIpc(reg, { stopChat: h.stopChat })

    expect([...handles.keys()].sort()).toEqual([
      'conversation-dispatch:status',
      'conversation:attention-list',
      'conversation:branch-info',
      'conversation:list',
      'conversation:list-standalone',
    ])
    expect([...mhandles.keys()].sort()).toEqual([
      'conversation-dispatch:retry',
      'conversation:archive',
      'conversation:attention-clear',
      'conversation:create',
      'conversation:create-standalone',
      'conversation:createSibling',
      'conversation:delete',
      'conversation:pin',
      'conversation:rename',
      'conversation:reorder',
      'conversation:reorder-standalone',
    ])
    expect([...ons.keys()]).toEqual([])
    expect([...mons.keys()]).toEqual(['conv:set-main-tab-order', 'conv:set-open-tabs'])
  })

  it('validates standalone listing and ordering payloads', () => {
    const { reg, handles, mhandles } = createTestRegistrar()
    registerConversationIpc(reg, { stopChat: h.stopChat })
    handles.get('conversation:list-standalone')!({} as never, true)
    expect(listStandaloneConversations).toHaveBeenCalledWith(true)
    expect(() => handles.get('conversation:list-standalone')!({} as never, 'true')).toThrow()
    const ids = ['c5d5d8ee-1bd2-4fd3-a17c-2e36d3751a6e']
    mhandles.get('conversation:reorder-standalone')!({} as never, ids)
    expect(setStandaloneConversationOrder).toHaveBeenCalledWith(ids)
    expect(() => mhandles.get('conversation:reorder-standalone')!({} as never, ['../unsafe'])).toThrow()
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

  it('lists the host attention marks and tells every window only when a clear changed one', async () => {
    const { reg, handles, mhandles } = createTestRegistrar()
    const emitAttention = vi.fn()
    vi.mocked(listConversationAttention).mockReturnValueOnce(['conv-1'])
    registerConversationIpc(reg, { stopChat: h.stopChat, emitAttention })

    expect(handles.get('conversation:attention-list')!({} as never)).toEqual(['conv-1'])

    vi.mocked(clearConversationAttention).mockReturnValueOnce(true)
    await mhandles.get('conversation:attention-clear')!({} as never, 'conv-1')
    expect(clearConversationAttention).toHaveBeenCalledWith('conv-1')
    expect(emitAttention).toHaveBeenCalledWith('conv-1', false)

    emitAttention.mockClear()
    vi.mocked(clearConversationAttention).mockReturnValueOnce(false)
    await mhandles.get('conversation:attention-clear')!({} as never, 'conv-1')
    expect(emitAttention).not.toHaveBeenCalled()

    expect(() => mhandles.get('conversation:attention-clear')!({} as never, 42)).toThrow()
  })

  it('clears the attention mark of an archived conversation everywhere', async () => {
    const { reg, mhandles } = createTestRegistrar()
    const emitAttention = vi.fn()
    vi.mocked(clearConversationAttention).mockReturnValueOnce(true)
    registerConversationIpc(reg, { stopChat: h.stopChat, emitAttention })

    await mhandles.get('conversation:archive')?.({} as never, 'conv-chat', true)

    expect(clearConversationAttention).toHaveBeenCalledWith('conv-chat')
    expect(emitAttention).toHaveBeenCalledWith('conv-chat', false)
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
