import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerChatIpc } from '../../src/main/chat/service'
import {
  getCursorSubscriptionManager,
  listCursorSubscriptionManagers,
} from '../../src/main/chat/cursor-subscription/manager'
import { listCursorAgentCleanup, queueCursorAgentCleanup } from '../../src/main/chat/cursor-subscription/session-store'
import { closeDb, freshDb } from '../helpers/db'

interface ManagerMock {
  deleteAgent: ReturnType<typeof vi.fn>
  onAuthUpdated: ReturnType<typeof vi.fn>
}

const managerMocks = new Map<string, ManagerMock>()

function makeManagerMock(): ManagerMock {
  return { deleteAgent: vi.fn(async () => undefined), onAuthUpdated: vi.fn(() => vi.fn()) }
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

function chatDeps(): Parameters<typeof registerChatIpc>[0] {
  return {
    mhandle: vi.fn(),
    mon: vi.fn(),
    emitStatus: vi.fn(),
  }
}

describe('Cursor cleanup drain at chat startup', () => {
  beforeEach(() => {
    freshDb()
    managerMocks.clear()
    vi.mocked(getCursorSubscriptionManager).mockClear()
    vi.mocked(listCursorSubscriptionManagers).mockClear()
  })

  afterEach(closeDb)

  it('drains boot cleanup successfully with account isolation', async () => {
    queueCursorAgentCleanup(null, 'agent-default', '/repo')
    queueCursorAgentCleanup(null, 'agent-acc', '/repo', 'acc_A')

    registerChatIpc(chatDeps())

    await vi.waitFor(() => expect(listCursorAgentCleanup()).toHaveLength(0))
    expect(getManagerMockFor(null).deleteAgent).toHaveBeenCalledWith('agent-default')
    expect(getManagerMockFor('acc_A').deleteAgent).toHaveBeenCalledWith('agent-acc')
  })

  it('keeps failed boot cleanup pending with a sanitized error and retry count', async () => {
    queueCursorAgentCleanup(null, 'agent-1', '/repo')
    const secret = 'crsr_live_AbCdEf1234567890'
    getManagerMockFor(null).deleteAgent.mockRejectedValue(new Error(`store locked: Authorization: Bearer ${secret}`))

    registerChatIpc(chatDeps())

    await vi.waitFor(() => {
      const row = listCursorAgentCleanup()[0]
      expect(row?.attempts).toBeGreaterThanOrEqual(1)
    })
    const row = listCursorAgentCleanup()[0]
    expect(row).toMatchObject({ agentId: 'agent-1' })
    expect(row?.lastError).not.toContain(secret)
    expect(row?.lastError).toContain('[REDACTED]')
  })
})
