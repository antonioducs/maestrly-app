import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/chat/service', () => ({
  stopChatAndWait: vi.fn(),
}))
vi.mock('../../src/main/drawer-manager', () => ({
  disposeConversation: vi.fn(),
}))
vi.mock('../../src/main/floating-manager', () => ({
  disposeConversation: vi.fn(),
}))
vi.mock('../../src/main/notes/notes-service', () => ({
  unwatchNotesAtCwd: vi.fn(),
}))
vi.mock('../../src/main/plan-broker', () => ({
  clearPlan: vi.fn(),
}))
vi.mock('../../src/main/popup-manager', () => ({
  disposeConversation: vi.fn(),
}))
vi.mock('../../src/main/pty-manager', () => ({
  killPtyAndWait: vi.fn(),
}))
vi.mock('../../src/main/selection-bridge', () => ({
  unwatchConversation: vi.fn(),
}))
vi.mock('../../src/main/terminal-manager', () => ({
  disposeShellTerminalsAndWait: vi.fn(),
}))
vi.mock('../../src/main/cwd-activity-coordinator', () => ({
  setOwnedCwdActivity: vi.fn(),
  waitForCwdActivityDrain: vi.fn(),
}))

import { stopChatAndWait } from '../../src/main/chat/service'
import { disposeConversation as disposeDrawer } from '../../src/main/drawer-manager'
import * as floatingManager from '../../src/main/floating-manager'
import { unwatchNotesAtCwd } from '../../src/main/notes/notes-service'
import { clearPlan } from '../../src/main/plan-broker'
import * as popupManager from '../../src/main/popup-manager'
import { killPtyAndWait } from '../../src/main/pty-manager'
import { unwatchConversation } from '../../src/main/selection-bridge'
import { disposeShellTerminalsAndWait } from '../../src/main/terminal-manager'
import { setOwnedCwdActivity, waitForCwdActivityDrain } from '../../src/main/cwd-activity-coordinator'
import { quiesceConversation } from '../../src/main/conversation-migration/quiesce'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(killPtyAndWait).mockResolvedValue(true)
  vi.mocked(disposeShellTerminalsAndWait).mockResolvedValue(true)
  vi.mocked(stopChatAndWait).mockResolvedValue(true)
  vi.mocked(waitForCwdActivityDrain).mockResolvedValue(true)
})

describe('conversation migration quiesce', () => {
  it('waits for PTY, Chat, and terminals before discarding surfaces for the old cwd', async () => {
    await expect(quiesceConversation('conv', '/source')).resolves.toEqual({ ok: true, failed: [] })

    expect(clearPlan).toHaveBeenCalledWith('conv')
    expect(killPtyAndWait).toHaveBeenCalledWith('conv')
    expect(stopChatAndWait).toHaveBeenCalledWith('conv')
    expect(disposeShellTerminalsAndWait).toHaveBeenCalledWith('conv')
    expect(setOwnedCwdActivity).toHaveBeenCalledWith('pty:conv', '/source', 'pty', false)
    expect(setOwnedCwdActivity).toHaveBeenCalledWith('chat:conv', '/source', 'chat', false)
    expect(waitForCwdActivityDrain).toHaveBeenCalledWith('/source', ['pty', 'chat', 'terminal'])
    expect(floatingManager.disposeConversation).toHaveBeenCalledWith('conv')
    expect(popupManager.disposeConversation).toHaveBeenCalledWith('conv')
    expect(disposeDrawer).toHaveBeenCalledWith('conv')
    expect(unwatchNotesAtCwd).toHaveBeenCalledWith('/source')
    expect(unwatchConversation).toHaveBeenCalledWith('conv', '/source')
  })

  it('fails closed when any runtime does not confirm the barrier', async () => {
    vi.mocked(killPtyAndWait).mockResolvedValue(false)
    vi.mocked(disposeShellTerminalsAndWait).mockResolvedValue(false)
    vi.mocked(stopChatAndWait).mockResolvedValue(false)

    await expect(quiesceConversation('conv', '/source')).resolves.toEqual({
      ok: false,
      failed: ['pty', 'terminal', 'chat'],
    })
    expect(setOwnedCwdActivity).not.toHaveBeenCalled()
  })

  it('fails closed when an already admitted creation does not finish', async () => {
    vi.mocked(waitForCwdActivityDrain).mockResolvedValue(false)

    await expect(quiesceConversation('conv', '/source')).resolves.toEqual({
      ok: false,
      failed: ['runtime-activity'],
    })
  })
})
