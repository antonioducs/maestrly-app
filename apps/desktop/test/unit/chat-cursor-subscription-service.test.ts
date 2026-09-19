import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorSubscriptionStatus } from '../../src/main/chat/cursor-subscription/manager'

const h = vi.hoisted(() => {
  const managers = new Map<string | null, ReturnType<typeof makeManager>>()
  function makeManager(accountId: string | null) {
    const listeners = new Set<() => void>()
    const state: { status: CursorSubscriptionStatus } = {
      status: {
        state: 'ready',
        available: true,
        authenticated: true,
        connected: true,
        account: { email: 'cursor@example.test', userId: 1, apiKeyName: 'test' },
        storageMode: 'secure',
        accountFingerprint: `account:${accountId}`,
        accountEpoch: 1,
        error: null,
      },
    }
    return {
      accountId,
      state,
      listeners,
      getStatus: vi.fn(async () => state.status),
      getStatusSnapshot: vi.fn(() => state.status),
      getAccountIdentity: vi.fn(() => ({
        fingerprint: state.status.accountFingerprint,
        epoch: state.status.accountEpoch,
      })),
      assertAccountIdentity: vi.fn(),
      listModels: vi.fn(async () => [{ id: 'composer-2.5', parameters: [] }]),
      resolveModelSelection: vi.fn(async () => ({ modelId: 'composer-2.5', params: [] })),
      onAuthUpdated: vi.fn((listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
      startLogin: vi.fn(async () => ({
        loginId: 'login-1',
        loginUrl: 'https://cursor.com/login',
        state: 'pending',
        completion: null,
      })),
      waitForLogin: vi.fn(async () => ({ loginId: 'login-1', success: true, error: null })),
      cancelPendingLogins: vi.fn(),
      logout: vi.fn(async () => {
        state.status = { ...state.status, authenticated: false, accountFingerprint: null }
      }),
      deleteAgent: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    }
  }
  const managerFor = vi.fn((id: string | null = null) => {
    let manager = managers.get(id)
    if (!manager) {
      manager = makeManager(id)
      managers.set(id, manager)
    }
    return manager
  })
  return {
    managers,
    managerFor,
    supported: vi.fn(() => true),
    run: vi.fn<(opts: any) => Promise<{ planSubmitted: boolean }>>(async () => ({ planSubmitted: false })),
    summarize: vi.fn(async () => ({ text: 'Cursor summary' })),
    genericRun: vi.fn(),
    send: vi.fn(),
  }
})
vi.mock('../../src/main/chat/cursor-subscription/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/cursor-subscription/manager')>()),
  getCursorSubscriptionManager: h.managerFor,
  listCursorSubscriptionManagers: () => [...h.managers.values()],
  disposeCursorSubscriptionManagers: vi.fn(async () => {}),
}))
vi.mock('../../src/main/chat/cursor-sdk/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/cursor-sdk/platform')>()),
  isCursorSdkPlatformSupported: h.supported,
}))
vi.mock('../../src/main/chat/cursor-subscription/runner', () => ({ runCursorSubscriptionChat: h.run }))
vi.mock('../../src/main/chat/cursor-subscription/portable-summarizer', () => ({
  summarizeWithCursorRuntime: h.summarize,
}))
vi.mock('../../src/main/window-ipc', () => ({ getMainWebContents: () => ({ isDestroyed: () => false, send: h.send }) }))
vi.mock('../../src/main/chat/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/runner')>()),
  runChat: h.genericRun,
}))

import { CursorServiceAuth } from '../../src/main/chat/cursor-subscription/service-auth'
import {
  registerChatIpc,
  resolveReviewLoopSelection,
  revalidateReviewLoopSelection,
  listChatExecutionModels,
  type ChatIpcDeps,
} from '../../src/main/chat/service'
import { addSubscriptionAccount, subscriptionProviderIdFor } from '../../src/main/chat/catalog'
import { patchConvUiPrefs } from '../../src/main/store'
import { upsertChatMessage, listChatMessages } from '../../src/main/chat/chat-store'
import {
  putCursorAgentBinding,
  getCursorAgentBinding,
  CURSOR_HARNESS_PROFILE,
} from '../../src/main/chat/cursor-subscription/session-store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function register() {
  const handlers = new Map<string, (...args: any[]) => any>()
  registerChatIpc({
    mhandle: (name, fn) => {
      handlers.set(name, fn)
    },
    mon: vi.fn(),
    emitStatus: vi.fn(),
  } as ChatIpcDeps)
  return handlers
}
function conversation(modelId = 'composer-2.5') {
  const conv = makeConversation(makeWorkspace().id)
  patchConvUiPrefs(conv.id, { chat: { providerId: 'builtin_cursor_subscription', modelId } })
  return conv
}

beforeEach(() => {
  freshDb()
  vi.clearAllMocks()
  h.supported.mockReturnValue(true)
})
afterEach(() => {
  closeDb()
})

describe('Cursor authentication lifecycle', () => {
  it('keeps passive snapshots lazy', () => {
    const auth = new CursorServiceAuth({ reset: vi.fn(), broadcast: vi.fn() })
    auth.snapshot()
    expect(h.managerFor).not.toHaveBeenCalled()
  })
  it('reports when account credentials are memory-only', async () => {
    const auth = new CursorServiceAuth({ reset: vi.fn(async () => {}), broadcast: vi.fn() })
    h.managerFor('memory-slot').state.status.storageMode = 'memory'
    await expect(auth.status(false, 'memory-slot')).resolves.toMatchObject({
      authenticated: true, storageMode: 'memory',
    })
    await auth.dispose()
  })

  it('deduplicates refreshes per account without blocking other accounts', async () => {
    const auth = new CursorServiceAuth({ reset: vi.fn(async () => {}), broadcast: vi.fn() })
    const wait = deferred<CursorSubscriptionStatus>()
    const manager = h.managerFor('refresh-slot')
    manager.getStatus.mockReturnValueOnce(wait.promise)
    const first = auth.status(true, 'refresh-slot')
    const second = auth.status(true, 'refresh-slot')
    await expect(auth.status(true, 'other-slot')).resolves.toMatchObject({ authenticated: true })
    expect(manager.getStatus).toHaveBeenCalledTimes(1)
    wait.resolve(manager.state.status)
    await Promise.all([first, second])
    await auth.dispose()
  })
  it('does not deadlock a status refresh on the active turn it just aborted', async () => {
    const reset = deferred<void>()
    const auth = new CursorServiceAuth({ reset: vi.fn(() => reset.promise), broadcast: vi.fn() })
    await auth.status(true, 'changed-slot')
    const manager = h.managerFor('changed-slot')
    manager.state.status = { ...manager.state.status, accountFingerprint: 'changed' }
    await expect(auth.status(true, 'changed-slot')).resolves.toMatchObject({ authenticated: false })
    expect(auth.busy('changed-slot')).toBe(true)
    reset.resolve()
    await auth.dispose()
  })
  it('prevents an old login from starting after logout supersedes its reset', async () => {
    const reset = deferred<void>()
    const auth = new CursorServiceAuth({ reset: vi.fn(() => reset.promise), broadcast: vi.fn() })
    const login = auth.login('superseded-slot')
    const logout = auth.logout('superseded-slot')
    reset.resolve()
    await expect(login).resolves.toMatchObject({ ok: false, error: 'superseded' })
    await logout
    expect(h.managerFor('superseded-slot').startLogin).not.toHaveBeenCalled()
    await auth.dispose()
  })
  it('publishes a connected snapshot after login completes', async () => {
    const snapshots: boolean[] = []
    const auth = new CursorServiceAuth({
      reset: vi.fn(async () => {}),
      broadcast: (status) => {
        if (status.state === 'signed-in') snapshots.push(auth.snapshot('published-slot').authenticated)
      },
    })
    await auth.login('published-slot')
    await vi.waitFor(() => expect(snapshots).toEqual([true]))
    await auth.dispose()
  })

  it('stops the account before login or logout changes credentials', async () => {
    const reset = deferred<void>()
    const auth = new CursorServiceAuth({ reset: vi.fn(() => reset.promise), broadcast: vi.fn() })
    const manager = h.managerFor('transition-slot')
    const login = auth.login('transition-slot')
    expect(auth.busy('transition-slot')).toBe(true)
    expect(manager.startLogin).not.toHaveBeenCalled()
    reset.resolve()
    await expect(login).resolves.toMatchObject({ ok: true, authUrl: 'https://cursor.com/login' })
    await vi.waitFor(() => expect(auth.busy('transition-slot')).toBe(false))
    await auth.logout('transition-slot')
    expect(manager.logout).toHaveBeenCalledTimes(1)
    await auth.dispose()
  })
  it('aborts only the changed account when a manager reports expired credentials', async () => {
    const reset = vi.fn(async () => {})
    const broadcast = vi.fn()
    const auth = new CursorServiceAuth({ reset, broadcast })
    await auth.status(false, 'expired-slot')
    const manager = h.managerFor('expired-slot')
    manager.state.status = { ...manager.state.status, authenticated: false, accountFingerprint: null }
    for (const listener of manager.listeners) listener()
    await vi.waitFor(() =>
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'expired-slot', authenticated: false })
      )
    )
    expect(reset).toHaveBeenCalledExactlyOnceWith('expired-slot')
    await auth.dispose()
  })
})

describe('Cursor service integration', () => {
  it('does not load Cursor while registering IPC or reading configuration', async () => {
    h.managerFor.mockClear()
    const handlers = register()
    handlers.get('chat:config')!({})
    expect(h.managerFor).not.toHaveBeenCalled()
  })
  it('rejects malformed and wrong-provider account IDs before accessing a manager', async () => {
    const handlers = register()
    const wrong = addSubscriptionAccount('grok-subscription', 'Wrong provider')
    h.managerFor.mockClear()
    for (const accountId of ['', false, 123, {}, '../escape', wrong.id]) {
      await expect(handlers.get('chat:cursor-subscription:login')!({}, { accountId })).resolves.toMatchObject({
        ok: false,
      })
      await expect(handlers.get('chat:cursor-subscription:logout')!({}, { accountId })).resolves.toMatchObject({
        ok: false,
      })
    }
    expect(h.managerFor).not.toHaveBeenCalled()
  })
  it('returns explicit unavailable status without creating a manager on unsupported platforms', async () => {
    h.supported.mockReturnValue(false)
    const handlers = register()
    h.managerFor.mockClear()
    await expect(handlers.get('chat:cursor-subscription:status')!({})).resolves.toMatchObject({
      state: 'unavailable',
      authenticated: false,
    })
    expect(h.managerFor).not.toHaveBeenCalled()
  })
  it('publishes additional-account models through the executable runner catalog', async () => {
    const account = addSubscriptionAccount('cursor-subscription', 'Cursor slot')
    const result = await listChatExecutionModels({ refreshSubscriptionAuth: true, portableExecutionOnly: true })
    expect(result).toContainEqual({
      id: subscriptionProviderIdFor('cursor-subscription', account.id),
      name: expect.any(String),
      models: ['composer-2.5'],
    })
  })
  it('rejects unavailable model selections instead of using generic model fallback', async () => {
    const handlers = register()
    const conv = conversation()
    await expect(
      handlers.get('chat:set-selection')!({}, conv.id, {
        providerId: 'builtin_cursor_subscription',
        modelId: 'missing',
      })
    ).resolves.toMatchObject({ ok: false, error: 'no-model' })
    expect(h.genericRun).not.toHaveBeenCalled()
  })
  it('freezes Cursor model parameters and rejects later changes', async () => {
    const conv = conversation()
    const frozen = await resolveReviewLoopSelection(conv.id)
    expect(frozen.ok).toBe(true)
    if (!frozen.ok) throw new Error(frozen.error)
    expect(frozen.selection.cursorModelSelection).toEqual({ modelId: 'composer-2.5', params: [] })
    h.managerFor(null).resolveModelSelection.mockResolvedValueOnce({ modelId: 'different', params: [] })
    await expect(revalidateReviewLoopSelection(frozen.selection)).resolves.toEqual({
      ok: false,
      error: 'executor-unavailable',
    })
  })
  it('routes a turn through Cursor with current permissions and aborts it before logout', async () => {
    const account = addSubscriptionAccount('cursor-subscription', 'Active slot')
    const conv = conversation()
    patchConvUiPrefs(conv.id, {
      chat: {
        providerId: subscriptionProviderIdFor('cursor-subscription', account.id),
        modelId: 'composer-2.5',
        permMode: 'ask',
        mode: 'agent',
      },
    })
    h.run.mockImplementationOnce(
      (opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
    )
    const handlers = register()
    const sender = { isDestroyed: () => false, send: h.send }
    await expect(
      handlers.get('chat:send')!({ sender }, { conversationId: conv.id, text: 'Run this.' })
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1))
    const args = h.run.mock.calls[0][0]
    expect(args.permMode).toBe('ask')
    expect(args.harness).toBeDefined()
    expect(args.canPersistSession()).toBe(true)
    expect(h.genericRun).not.toHaveBeenCalled()
    const manager = h.managerFor(account.id)
    manager.logout.mockImplementationOnce(async () => {
      expect(args.signal.aborted).toBe(true)
      expect(args.canPersistSession()).toBe(false)
    })
    await expect(
      handlers.get('chat:cursor-subscription:logout')!({}, { accountId: account.id })
    ).resolves.toMatchObject({ ok: true })
    expect(manager.logout).toHaveBeenCalledTimes(1)
  })
  it('compacts through Cursor and retires the old native binding', async () => {
    const conv = conversation()
    upsertChatMessage({
      id: 'cursor-user',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 'u', text: 'Implement the feature.' }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'cursor-answer',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'a', text: 'Work completed.' }],
      model: { providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5' },
      createdAt: 2,
    })
    putCursorAgentBinding({
      conversationId: conv.id,
      agentId: 'old-agent',
      modelId: 'composer-2.5',
      modelParams: [],
      cwd: conv.cwd,
      harnessProfile: CURSOR_HARNESS_PROFILE,
      instructionHash: 'old',
      toolSignature: 'old',
      lastMessageId: 'cursor-answer',
      accountFingerprint: 'account:null',
      accountId: null,
      usageJson: '{}',
    })
    const handlers = register()
    await expect(handlers.get('chat:compact')!({}, conv.id)).resolves.toMatchObject({
      ok: true,
      summary: 'Cursor summary',
    })
    expect(h.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'composer-2.5', accountIdentity: { fingerprint: 'account:null', epoch: 1 } })
    )
    expect(h.managerFor(null).deleteAgent).toHaveBeenCalledWith('old-agent')
    expect(getCursorAgentBinding(conv.id)).toBeNull()
    expect(listChatMessages(conv.id).at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: 'compaction', text: 'Cursor summary' })
    )
  })
  it('requires an explicit model for a frozen Cursor execution', async () => {
    await expect(resolveReviewLoopSelection(conversation('').id)).resolves.toEqual({ ok: false, error: 'no-model' })
  })
})
