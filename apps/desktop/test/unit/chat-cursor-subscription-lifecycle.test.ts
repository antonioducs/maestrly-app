import { withCursorAccountRun } from '../../src/main/chat/cursor-subscription/account-runs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteAllManagedCursorAgents,
  deleteCursorAgentForConversation,
  drainCursorAgentCleanup,
  resetCursorSubscriptionAccount,
  wipeAllCursorSubscriptionState,
} from '../../src/main/chat/cursor-subscription/lifecycle'
import {
  clearAllCursorAgentCleanup,
  getCursorAgentBinding,
  listCursorAgentBindings,
  listCursorAgentCleanup,
  putCursorAgentBinding,
  queueCursorAgentCleanup,
} from '../../src/main/chat/cursor-subscription/session-store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  getCursorSubscriptionManager,
  listCursorSubscriptionManagers,
} from '../../src/main/chat/cursor-subscription/manager'

interface ManagerMock {
  deleteAgent: ReturnType<typeof vi.fn>
  resetLocalData: ReturnType<typeof vi.fn>
}

const managerMocks = new Map<string, ManagerMock>()

function makeManagerMock(): ManagerMock {
  return { deleteAgent: vi.fn(async () => undefined), resetLocalData: vi.fn(async () => undefined) }
}

function getManagerMockFor(accountId: string | null): ManagerMock {
  const key = accountId ?? ''
  let mock = managerMocks.get(key)
  if (!mock) {
    mock = makeManagerMock()
    managerMocks.set(key, mock)
  }
  return mock
}

vi.mock('../../src/main/chat/cursor-subscription/manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/cursor-subscription/manager')>()
  return {
    ...actual,
    getCursorSubscriptionManager: vi.fn((accountId: string | null) => getManagerMockFor(accountId)),
    listCursorSubscriptionManagers: vi.fn(() => [...managerMocks.values()]),
  }
})

function getCursorSubscriptionManagerMock(accountId: string | null = null): ManagerMock {
  return getManagerMockFor(accountId)
}

function bind(conversationId: string, agentId: string, accountId: string | null = null): void {
  putCursorAgentBinding({
    conversationId,
    agentId,
    modelId: 'composer-2.5',
    cwd: '/repo',
    harnessProfile: 'cursor-subscription-v1',
    instructionHash: 'h',
    toolSignature: 's',
    lastMessageId: 'last',
    accountFingerprint: 'user:1',
    accountId,
    usageJson: '{}',
  })
}

describe('Cursor subscription lifecycle', () => {
  beforeEach(() => {
    freshDb()
    managerMocks.clear()
    vi.mocked(getCursorSubscriptionManager).mockClear()
    vi.mocked(listCursorSubscriptionManagers).mockClear()
  })
  afterEach(closeDb)

  it('removes the binding and tombstone after successful deletion', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'agent-1')
    await deleteCursorAgentForConversation(conversation.id)
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(listCursorAgentCleanup()).toHaveLength(0)
  })

  it('keeps a tombstone with retry details after deletion fails', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'agent-1')
    vi.mocked(getCursorSubscriptionManagerMock().deleteAgent).mockRejectedValueOnce(new Error('store locked'))
    await deleteCursorAgentForConversation(conversation.id)
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    const cleanup = listCursorAgentCleanup()
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]).toMatchObject({ agentId: 'agent-1', attempts: 1 })
  })

  it('cancels ephemeral account work before bulk cleanup even without conversation bindings', async () => {
    const manager = getCursorSubscriptionManagerMock('acc_A')
    const parent = new AbortController()
    let childSignal!: AbortSignal
    const work = withCursorAccountRun({ manager, signal: parent.signal }, async (signal) => {
      childSignal = signal
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    try {
      await deleteAllManagedCursorAgents({ accountId: 'acc_A' })
      expect(childSignal.aborted).toBe(true)
      expect(parent.signal.aborted).toBe(false)
    } finally {
      parent.abort()
      await work
    }
  })

  it('scopes bulk deletion by account', async () => {
    const workspace = makeWorkspace()
    const a = makeConversation(workspace.id, {})
    const b = makeConversation(workspace.id, {})
    bind(a.id, 'agent-default')
    bind(b.id, 'agent-a', 'acc_A')
    await deleteAllManagedCursorAgents({ accountId: 'acc_A' })
    expect(getCursorAgentBinding(b.id)).toBeNull()
    expect(getCursorAgentBinding(a.id)).not.toBeNull()
  })

  it('clears account bindings and tombstones after reset', async () => {
    const workspace = makeWorkspace()
    const a = makeConversation(workspace.id, {})
    const b = makeConversation(workspace.id, {})
    bind(a.id, 'agent-default')
    bind(b.id, 'agent-a', 'acc_A')
    await resetCursorSubscriptionAccount('acc_A')
    expect(getCursorAgentBinding(b.id)).toBeNull()
    expect(getCursorAgentBinding(a.id)).not.toBeNull()
    expect(listCursorAgentCleanup()).toHaveLength(0)
  })

  it('retries tombstones after the store becomes available', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'agent-1')

    vi.mocked(getCursorSubscriptionManagerMock().deleteAgent).mockRejectedValue(new Error('store unavailable'))
    await deleteCursorAgentForConversation(conversation.id)

    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    let cleanup = listCursorAgentCleanup()
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]).toMatchObject({ agentId: 'agent-1', attempts: 1, lastError: 'store unavailable' })

    await drainCursorAgentCleanup()
    cleanup = listCursorAgentCleanup()
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]).toMatchObject({ agentId: 'agent-1', attempts: 2 })

    vi.mocked(getCursorSubscriptionManagerMock().deleteAgent).mockResolvedValue(undefined)
    await drainCursorAgentCleanup()
    expect(listCursorAgentCleanup()).toHaveLength(0)
    void clearAllCursorAgentCleanup
  })

  it('wipes accounts with durable state even without live managers', async () => {
    const workspace = makeWorkspace()
    const a = makeConversation(workspace.id, {})
    const b = makeConversation(workspace.id, {})
    bind(a.id, 'agent-default')
    bind(b.id, 'agent-a', 'acc_A')
    queueCursorAgentCleanup(null, 'agent-orphan', '/repo', 'acc_B')

    expect(listCursorSubscriptionManagers()).toHaveLength(0)
    await wipeAllCursorSubscriptionState()

    expect(getCursorSubscriptionManagerMock().resetLocalData).toHaveBeenCalled()
    expect(getCursorSubscriptionManagerMock('acc_A').resetLocalData).toHaveBeenCalled()
    expect(getCursorSubscriptionManagerMock('acc_B').resetLocalData).toHaveBeenCalled()
    expect(getCursorAgentBinding(a.id)).toBeNull()
    expect(getCursorAgentBinding(b.id)).toBeNull()
    expect(listCursorAgentCleanup()).toHaveLength(0)
  })

  it('waits for every account reset before reporting a wipe failure', async () => {
    let release!: () => void
    getCursorSubscriptionManagerMock().resetLocalData.mockRejectedValueOnce(new Error('default busy'))
    getCursorSubscriptionManagerMock('acc_A').resetLocalData.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    let settled = false
    const wipe = wipeAllCursorSubscriptionState(['acc_A']).catch((error: unknown) => {
      settled = true
      return error
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    release()
    expect(await wipe).toBeInstanceOf(AggregateError)
  })

  it('augments account enumeration with explicit account IDs and always includes default', async () => {
    const workspace = makeWorkspace()
    const a = makeConversation(workspace.id, {})
    const b = makeConversation(workspace.id, {})
    bind(a.id, 'agent-default')
    bind(b.id, 'agent-a', 'acc_A')
    await wipeAllCursorSubscriptionState(['acc_X'])

    expect(getCursorSubscriptionManagerMock('acc_X').resetLocalData).toHaveBeenCalled()
    expect(getCursorSubscriptionManagerMock().resetLocalData).toHaveBeenCalled()
    expect(getCursorSubscriptionManagerMock('acc_A').resetLocalData).toHaveBeenCalled()

    expect(getCursorAgentBinding(a.id)).toBeNull()
    expect(getCursorAgentBinding(b.id)).toBeNull()
  })

  it('resets the default account after restart even without durable bindings', async () => {
    expect(listCursorSubscriptionManagers()).toHaveLength(0)
    expect(listCursorAgentBindings()).toHaveLength(0)
    expect(listCursorAgentCleanup()).toHaveLength(0)
    await wipeAllCursorSubscriptionState()

    expect(getCursorSubscriptionManagerMock().resetLocalData).toHaveBeenCalled()
  })
  it('persists cleanup intent before waiting and retires the binding only after leases drain', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'leased-agent')
    let release!: () => void
    getManagerMockFor(null).deleteAgent.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const deletion = deleteCursorAgentForConversation(conversation.id)
    expect(getCursorAgentBinding(conversation.id)?.agentId).toBe('leased-agent')
    expect(listCursorAgentCleanup()[0]?.agentId).toBe('leased-agent')
    release()
    await deletion
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(listCursorAgentCleanup()).toHaveLength(0)
  })

  it('completes a retirement intent left before binding removal by a process restart', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'pending-retirement')
    queueCursorAgentCleanup(conversation.id, 'pending-retirement', '/repo')
    await drainCursorAgentCleanup()
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(listCursorAgentCleanup()).toHaveLength(0)
  })
})
