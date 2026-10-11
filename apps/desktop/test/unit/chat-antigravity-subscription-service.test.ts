import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSubscriptionAuthStatus } from '../../src/shared/chat'

const h = vi.hoisted(() => {
  const calls: string[] = []
  const managers = new Map<string | null, ReturnType<typeof makeManager>>()
  const MODELS = [
    {
      id: 'gemini-3.1-pro',
      displayName: 'Gemini 3.1 Pro',
      efforts: { high: 'gemini-pro-agent', low: 'gemini-3.1-pro-low' },
      defaultEffort: 'high',
    },
    {
      id: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      efforts: { high: 'gemini-3.8-flash-high' },
      defaultEffort: 'high',
    },
  ]
  function makeManager(accountId: string | null) {
    const listeners = new Set<() => void>()
    const state = { authenticated: true, fingerprint: `project:${accountId}` as string | null, epoch: 1 }
    return {
      accountId,
      state,
      getStatus: vi.fn(
        (): ChatSubscriptionAuthStatus =>
          state.authenticated
            ? { state: 'signed-in', authenticated: true }
            : { state: 'signed-out', authenticated: false }
      ),
      getAccountIdentity: vi.fn(() => ({
        fingerprint: state.authenticated ? state.fingerprint : null,
        epoch: state.epoch,
      })),
      assertAccountIdentity: vi.fn(),
      listModels: vi.fn(async () => MODELS),
      login: vi.fn(async () => {
        calls.push(`login:${accountId}`)
        state.authenticated = true
        return { ok: true, status: { state: 'signed-in', authenticated: true } }
      }),
      cancelLogin: vi.fn(),
      logout: vi.fn(async () => {
        state.authenticated = false
      }),
      onAuthChanged: vi.fn((listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
      closeSessions: vi.fn(async () => {}),
      dropLiveSession: vi.fn(),
      deleteSession: vi.fn(async () => {}),
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
    calls,
    managers,
    managerFor,
    run: vi.fn<(opts: any) => Promise<{ planSubmitted: boolean; sessionId: string | null }>>(async () => ({
      planSubmitted: false,
      sessionId: null,
    })),
    ensure: vi.fn(async (id: string) => {
      calls.push(`ensure:${id}`)
      return { id, state: 'ready', path: '/managed' }
    }),
    genericRun: vi.fn(),
    send: vi.fn(),
    summarize: vi.fn(async () => ({ text: 'Gemini summary' })),
  }
})

vi.mock('../../src/main/chat/antigravity-subscription/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/antigravity-subscription/manager')>()),
  getAntigravitySubscriptionManager: h.managerFor,
  listAntigravitySubscriptionManagers: () => [...h.managers.values()],
  disposeAntigravitySubscriptionManager: vi.fn(async () => {}),
  disposeAllAntigravitySubscriptionManagers: vi.fn(async () => {}),
}))
vi.mock('../../src/main/chat/antigravity-subscription/runner', () => ({ runAntigravitySubscriptionChat: h.run }))
vi.mock('../../src/main/chat/antigravity-subscription/isolated-prompt', () => ({
  runAntigravityIsolatedPrompt: vi.fn(),
  summarizeWithAntigravityRuntime: h.summarize,
}))
vi.mock('../../src/main/runtime-assets/app-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/runtime-assets/app-service')>()),
  ensureRuntimeAsset: h.ensure,
}))
vi.mock('../../src/main/window-ipc', () => ({ getMainWebContents: () => ({ isDestroyed: () => false, send: h.send }) }))
vi.mock('../../src/main/chat/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/runner')>()),
  runChat: h.genericRun,
}))

import {
  getAntigravitySessionBinding,
  putAntigravitySessionBinding,
} from '../../src/main/chat/antigravity-subscription/session-store'
import { addSubscriptionAccount, subscriptionProviderIdFor } from '../../src/main/chat/catalog'
import { type ChatIpcDeps, registerChatIpc } from '../../src/main/chat/service'
import { listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import { patchConvUiPrefs } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

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

beforeEach(() => {
  freshDb()
  vi.clearAllMocks()
  h.calls.length = 0
  h.managers.clear()
  delete process.env.MAESTRLY_ANTIGRAVITY_ACP_DIR
})
afterEach(() => closeDb())

describe('Google AI subscription service', () => {
  it('reports the status of the requested account and rejects malformed account ids', async () => {
    const handlers = register()
    const account = addSubscriptionAccount('antigravity-subscription', 'Work')
    h.managerFor(account.id).state.authenticated = false
    await expect(handlers.get('chat:antigravity-subscription:status')!({}, {})).resolves.toEqual({
      state: 'signed-in',
      authenticated: true,
    })
    await expect(handlers.get('chat:antigravity-subscription:status')!({}, { accountId: account.id })).resolves.toEqual(
      { state: 'signed-out', authenticated: false, accountId: account.id }
    )
    const wrong = addSubscriptionAccount('cursor-subscription', 'Other provider')
    h.managerFor.mockClear()
    for (const accountId of ['', false, 123, {}, '../escape', wrong.id]) {
      await expect(handlers.get('chat:antigravity-subscription:login')!({}, { accountId })).resolves.toMatchObject({
        ok: false,
      })
      await expect(handlers.get('chat:antigravity-subscription:logout')!({}, { accountId })).resolves.toMatchObject({
        ok: false,
      })
    }
    expect(h.managerFor).not.toHaveBeenCalled()
  })

  it('installs the ACP server before signing in and broadcasts the result', async () => {
    const handlers = register()
    h.managerFor(null).state.authenticated = false
    await expect(handlers.get('chat:antigravity-subscription:login')!({}, {})).resolves.toEqual({
      ok: true,
      status: { state: 'signing-in', authenticated: false },
    })
    await vi.waitFor(() => expect(h.calls).toEqual(['ensure:antigravity-acp-runtime', 'login:null']))
    await vi.waitFor(() =>
      expect(h.send).toHaveBeenCalledWith(
        'chat:antigravity-subscription:auth-changed',
        expect.objectContaining({ state: 'signed-in', authenticated: true })
      )
    )
    expect(h.send).toHaveBeenCalledWith(
      'chat:antigravity-subscription:auth-changed',
      expect.objectContaining({ state: 'signing-in' })
    )
  })

  it('signs out and forgets only that account sessions', async () => {
    const handlers = register()
    const account = addSubscriptionAccount('antigravity-subscription', 'Work')
    const workspace = makeWorkspace()
    const own = makeConversation(workspace.id)
    const other = makeConversation(workspace.id)
    const bind = (conversationId: string, accountId: string | null) =>
      putAntigravitySessionBinding({
        conversationId,
        accountId,
        accountFingerprint: 'project:x',
        sessionId: `s-${conversationId}`,
        modelValue: 'gemini-pro-agent',
        toolSignature: 't',
        instructionHash: 'i',
        lastMessageId: null,
      })
    bind(own.id, account.id)
    bind(other.id, null)
    await expect(
      handlers.get('chat:antigravity-subscription:logout')!({}, { accountId: account.id })
    ).resolves.toMatchObject({ ok: true, status: { authenticated: false } })
    expect(h.managerFor(account.id).logout).toHaveBeenCalledTimes(1)
    expect(getAntigravitySessionBinding(own.id)).toBeUndefined()
    expect(getAntigravitySessionBinding(other.id)).toBeDefined()
  })

  it('routes a turn through Antigravity with the admitted identity and effort, and aborts it on logout', async () => {
    const account = addSubscriptionAccount('antigravity-subscription', 'Work')
    const conv = makeConversation(makeWorkspace().id)
    patchConvUiPrefs(conv.id, {
      chat: {
        providerId: subscriptionProviderIdFor('antigravity-subscription', account.id),
        modelId: 'gemini-3.1-pro',
        reasoning: 'low',
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
    await expect(handlers.get('chat:send')!({ sender }, { conversationId: conv.id, text: 'Hi' })).resolves.toEqual({
      ok: true,
    })
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1))
    const args = h.run.mock.calls[0][0]
    expect(args.reasoningEffort).toBe('low')
    expect(args.accountIdentity).toEqual({ fingerprint: `project:${account.id}`, epoch: 1 })
    expect(args.manager).toBe(h.managerFor(account.id))
    expect(args.harness).toBeDefined()
    expect(args.permMode).toBe('ask')
    expect(args.canPersistSession()).toBe(true)
    expect(h.genericRun).not.toHaveBeenCalled()
    const manager = h.managerFor(account.id)
    manager.logout.mockImplementationOnce(async () => {
      expect(args.signal.aborted).toBe(true)
      expect(args.canPersistSession()).toBe(false)
    })
    await expect(
      handlers.get('chat:antigravity-subscription:logout')!({}, { accountId: account.id })
    ).resolves.toMatchObject({ ok: true })
  })

  it('refuses to send when the account is signed out', async () => {
    const conv = makeConversation(makeWorkspace().id)
    patchConvUiPrefs(conv.id, { chat: { providerId: 'builtin_antigravity_subscription', modelId: 'gemini-3.1-pro' } })
    h.managerFor(null).state.authenticated = false
    const handlers = register()
    const sender = { isDestroyed: () => false, send: h.send }
    await expect(handlers.get('chat:send')!({ sender }, { conversationId: conv.id, text: 'Hi' })).resolves.toEqual({
      ok: false,
      error: 'no-key',
    })
    expect(h.run).not.toHaveBeenCalled()
  })

  it('reports quota usage as unsupported', async () => {
    const handlers = register()
    await expect(
      handlers.get('chat:subscription-usage')!({}, { providerKind: 'antigravity-subscription' })
    ).resolves.toMatchObject({ state: 'unsupported', providerKind: 'antigravity-subscription' })
  })

  it('lists the account models for the picker, and none while signed out', async () => {
    const handlers = register()
    await expect(handlers.get('chat:models')!({}, 'builtin_antigravity_subscription')).resolves.toEqual([
      'gemini-3.1-pro',
      'gemini-3.8-flash',
    ])
    h.managerFor(null).state.authenticated = false
    await expect(handlers.get('chat:models')!({}, 'builtin_antigravity_subscription', true)).resolves.toEqual([])
  })

  it('compacts through Antigravity and retires the old ACP session', async () => {
    const conv = makeConversation(makeWorkspace().id)
    patchConvUiPrefs(conv.id, {
      chat: { providerId: 'builtin_antigravity_subscription', modelId: 'gemini-3.1-pro', reasoning: 'low' },
    })
    upsertChatMessage({
      id: 'agy-user',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 'u', text: 'Implement the feature.' }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'agy-answer',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'a', text: 'Work completed.' }],
      model: { providerId: 'builtin_antigravity_subscription', modelId: 'gemini-3.1-pro' },
      createdAt: 2,
    })
    putAntigravitySessionBinding({
      conversationId: conv.id,
      accountId: null,
      accountFingerprint: 'project:null',
      sessionId: 'old-session',
      modelValue: 'gemini-3.1-pro-low',
      toolSignature: 't',
      instructionHash: 'i',
      lastMessageId: 'agy-answer',
    })
    const handlers = register()
    await expect(handlers.get('chat:compact')!({}, conv.id)).resolves.toMatchObject({
      ok: true,
      summary: 'Gemini summary',
    })
    expect(h.summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gemini-3.1-pro',
        reasoningEffort: 'low',
        accountIdentity: { fingerprint: 'project:null', epoch: 1 },
      })
    )
    expect(h.managerFor(null).deleteSession).toHaveBeenCalledWith('old-session')
    expect(getAntigravitySessionBinding(conv.id)).toBeUndefined()
    expect(listChatMessages(conv.id).at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: 'compaction', text: 'Gemini summary' })
    )
  })
})
