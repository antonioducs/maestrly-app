import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
  },
}))

vi.mock('../../src/main/conversation-migration/store', () => ({
  assertConversationMigrationMutationAllowed: vi.fn(),
}))

vi.mock('../../src/main/workspace-service', () => ({
  addWorkspace: vi.fn(),
  listWorkspacesWithConversations: vi.fn(),
  getBranches: vi.fn(),
  fetchBranches: vi.fn(),
  removeWorkspace: vi.fn(),
  deleteConversation: vi.fn(),
}))

vi.mock('../../src/main/store', () => ({
  listConversations: vi.fn(),
  listConvIdsByWorkspaceRepo: vi.fn(),
  setWorkspaceDefaultBranch: vi.fn(),
  setWorkspaceOrder: vi.fn(),
  setWorkspaceCollapsed: vi.fn(),
  listWorkspaceGroups: vi.fn(),
  createWorkspaceGroup: vi.fn(),
  renameWorkspaceGroup: vi.fn(),
  deleteWorkspaceGroup: vi.fn(),
  setGroupOrder: vi.fn(),
  setWorkspaceGroupAndOrder: vi.fn(),
  setGroupCollapsed: vi.fn(),
}))

vi.mock('../../src/main/i18n', () => ({
  tMain: () => (key: string, vars?: { count?: number }) => (vars?.count == null ? key : `${key}:${vars.count}`),
}))

vi.mock('../../src/main/plan-broker', () => ({
  clearPlan: vi.fn(),
}))

vi.mock('../../src/main/terminal-manager', () => ({
  disposeShellTerminals: vi.fn(),
}))

vi.mock('../../src/main/floating-manager', () => ({
  disposeConversation: vi.fn(),
}))

vi.mock('../../src/main/popup-manager', () => ({
  disposeConversation: vi.fn(),
}))

vi.mock('../../src/main/drawer-manager', () => ({
  disposeConversation: vi.fn(),
}))

vi.mock('../../src/main/notes/notes-service', () => ({
  unwatchNotes: vi.fn(),
  unwatchProject: vi.fn(),
}))

vi.mock('../../src/main/memory-service', () => ({
  unwatchMemory: vi.fn(),
}))

import { registerWorkspaceIpc } from '../../src/main/workspace-ipc'
import { deleteConversation, removeWorkspace } from '../../src/main/workspace-service'
import { listConversations, listConvIdsByWorkspaceRepo } from '../../src/main/store'
import { clearPlan } from '../../src/main/plan-broker'
import { disposeShellTerminals } from '../../src/main/terminal-manager'
import * as floatingManager from '../../src/main/floating-manager'
import * as popupManager from '../../src/main/popup-manager'
import { disposeConversation } from '../../src/main/drawer-manager'
import { unwatchNotes, unwatchProject } from '../../src/main/notes/notes-service'
import { unwatchMemory } from '../../src/main/memory-service'

type HandleFn = Parameters<IpcRegistrar['handle']>[1]
type OnFn = Parameters<IpcRegistrar['on']>[1]

function createRegistrar(): { reg: IpcRegistrar; handles: Map<string, HandleFn>; listeners: Map<string, OnFn> } {
  const handles = new Map<string, HandleFn>()
  const listeners = new Map<string, OnFn>()
  const reg: IpcRegistrar = {
    handle: (channel, fn) => void handles.set(channel, fn),
    mhandle: (channel, fn) => void handles.set(channel, fn),
    on: (channel, fn) => void listeners.set(channel, fn),
    mon: (channel, fn) => void listeners.set(channel, fn),
  }
  return { reg, handles, listeners }
}

function setupWorkspaceRemove(): {
  remove: HandleFn
  stopChat: ReturnType<typeof vi.fn>
} {
  const { reg, handles } = createRegistrar()
  const stopChat = vi.fn()
  registerWorkspaceIpc(reg, {
    getMainWindow: () => null,
    stopChat,
  })
  const remove = handles.get('workspace:remove')
  expect(remove).toBeTypeOf('function')
  return { remove: remove!, stopChat }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('registerWorkspaceIpc', () => {
  it('workspace:remove blocks workspaces used as secondary repositories by multi-repository conversations', async () => {
    vi.mocked(listConversations).mockReturnValue([{ id: 'own' }] as never)
    vi.mocked(listConvIdsByWorkspaceRepo).mockReturnValue(['own', 'foreign'])
    const { remove } = setupWorkspaceRemove()

    await expect(remove({} as never, 'ws-1')).rejects.toThrow('dialog.multiRepoInUse:1')

    expect(removeWorkspace).not.toHaveBeenCalled()
    expect(deleteConversation).not.toHaveBeenCalled()
  })

  it('workspace:remove closes conversation resources before removing watchers and the workspace', async () => {
    const calls: string[] = []
    vi.mocked(listConversations).mockReturnValue([{ id: 'c1' }, { id: 'c2' }] as never)
    vi.mocked(listConvIdsByWorkspaceRepo).mockReturnValue(['c1', 'c2'])
    vi.mocked(clearPlan).mockImplementation((id: string) => void calls.push(`clearPlan:${id}`))
    vi.mocked(disposeShellTerminals).mockImplementation((id: string) => void calls.push(`terminals:${id}`))
    vi.mocked(floatingManager.disposeConversation).mockImplementation((id: string) => void calls.push(`floating:${id}`))
    vi.mocked(popupManager.disposeConversation).mockImplementation((id: string) => void calls.push(`popup:${id}`))
    vi.mocked(disposeConversation).mockImplementation((id: string) => void calls.push(`drawer:${id}`))
    vi.mocked(unwatchNotes).mockImplementation((id: string) => {
      calls.push(`notes:${id}`)
      return Promise.resolve()
    })
    vi.mocked(deleteConversation).mockImplementation(async (id: string) => void calls.push(`delete:${id}`))
    vi.mocked(unwatchProject).mockImplementation((id: string) => {
      calls.push(`project:${id}`)
      return Promise.resolve()
    })
    vi.mocked(unwatchMemory).mockImplementation((id: string) => void calls.push(`memory:${id}`))
    vi.mocked(removeWorkspace).mockImplementation((id: string) => void calls.push(`remove:${id}`))
    const { remove, stopChat } = setupWorkspaceRemove()
    stopChat.mockImplementation((id: string) => void calls.push(`chat:${id}`))

    await remove({} as never, 'ws-1')

    expect(calls).toEqual([
      'clearPlan:c1',
      'chat:c1',
      'terminals:c1',
      'floating:c1',
      'popup:c1',
      'drawer:c1',
      'notes:c1',
      'delete:c1',
      'clearPlan:c2',
      'chat:c2',
      'terminals:c2',
      'floating:c2',
      'popup:c2',
      'drawer:c2',
      'notes:c2',
      'delete:c2',
      'project:ws-1',
      'memory:ws-1',
      'remove:ws-1',
    ])
  })
})
