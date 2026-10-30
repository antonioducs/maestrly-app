/**
 * Subagents and the image interpreter follow the active-account selection: the virtual `builtin_*@~active` id is
 * resolved to the pool's physical account before any manager is looked up. The managers reject `~`, so an
 * unresolved id would fail loudly instead of reaching a wrong account; these fakes reject it the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const h = vi.hoisted(() => {
  const codexModel = (id: string) => ({
    id,
    model: id,
    hidden: false,
    inputModalities: ['text', 'image'],
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    serviceTiers: [],
    contextWindow: 200_000,
  })
  return {
    codexModel,
    codexAccountIds: [] as Array<string | null>,
    claudeAccountIds: [] as Array<string | null>,
    codexAuthenticated: true,
    claudeAuthenticated: true,
    codexModels: [] as Array<ReturnType<typeof codexModel>>,
    assertRealAccount(accountId: string | null): void {
      if (accountId !== null && !/^[A-Za-z0-9_-]+$/.test(accountId)) throw new Error(`Invalid account id: ${accountId}`)
    },
  }
})

vi.mock('../../src/main/chat/codex-subscription/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/codex-subscription/manager')>()),
  getCodexSubscriptionManager: (accountId: string | null) => {
    h.codexAccountIds.push(accountId)
    h.assertRealAccount(accountId)
    return {
      getStatus: async () => ({ authenticated: h.codexAuthenticated }),
      getStatusSnapshot: () => ({ authenticated: h.codexAuthenticated }),
      listModels: async () => h.codexModels,
    }
  },
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/claude-agent-sdk/manager')>()),
  getClaudeSubscriptionManager: (accountId: string | null) => {
    h.claudeAccountIds.push(accountId)
    h.assertRealAccount(accountId)
    return {
      status: async () => ({ authenticated: h.claudeAuthenticated }),
      getStatusSnapshot: () => ({
        authenticated: h.claudeAuthenticated,
        accountFingerprint: 'sha256:claude-work',
        accountEpoch: 1,
      }),
      listModels: async () => [{ value: 'sonnet', supportsEffort: true, supportedEffortLevels: ['high'] }],
      getObservedModelContextWindow: () => undefined,
    }
  },
}))

import { runClaudeSubagent } from '../../src/main/chat/claude-agent-sdk/subagent-runner'
import type {
  ClaudeSubscriptionAccountIdentity,
  ClaudeSubscriptionManager,
} from '../../src/main/chat/claude-agent-sdk/manager'
import type { ClaudeRuntimeTarget } from '../../src/main/chat/subscription-failover/claude-adapter'
import { addSubscriptionAccount, subscriptionProviderIdFor } from '../../src/main/chat/catalog'
import { hasConfiguredImageInterpreter, setImageInterpreter } from '../../src/main/chat/image-interpreter'
import {
  subagentModelCatalog,
  subagentModelMeta,
  subagentProviderStatus,
} from '../../src/main/chat/subagent-provider-runtime'
import { setAccountPool } from '../../src/main/chat/subscription-failover/account-pool'
import { setHiddenChatModels } from '../../src/main/store'
import { activeAccountProviderId } from '../../src/shared/chat'
import { closeDb, freshDb } from '../helpers/db'

const CODEX_VIRTUAL = activeAccountProviderId('codex-subscription')
const CLAUDE_VIRTUAL = activeAccountProviderId('claude-subscription')

interface Account {
  accountId: string
  providerId: string
}

let codexWork: Account
let claudeWork: Account

function addAccount(kind: 'codex-subscription' | 'claude-subscription', label: string): Account {
  const account = addSubscriptionAccount(kind, label)
  return { accountId: account.id, providerId: subscriptionProviderIdFor(kind, account.id) }
}

beforeEach(() => {
  freshDb()
  h.codexAccountIds.length = 0
  h.claudeAccountIds.length = 0
  h.codexAuthenticated = true
  h.claudeAuthenticated = true
  h.codexModels = [h.codexModel('gpt-work')]
  codexWork = addAccount('codex-subscription', 'Work')
  claudeWork = addAccount('claude-subscription', 'Work')
  setAccountPool({ kind: 'codex-subscription', activeProviderId: codexWork.providerId })
  setAccountPool({ kind: 'claude-subscription', activeProviderId: claudeWork.providerId })
})
afterEach(closeDb)

describe('subagent provider runtime on the active-account selection', () => {
  it('resolves the virtual Codex selection to the active account for status, catalog and metadata', async () => {
    await expect(subagentProviderStatus(CODEX_VIRTUAL)).resolves.toBe('available')
    await expect(subagentModelCatalog(CODEX_VIRTUAL)).resolves.toEqual({ status: 'available', models: ['gpt-work'] })
    await expect(subagentModelMeta(CODEX_VIRTUAL, 'gpt-work')).resolves.toMatchObject({
      status: 'available',
      meta: { vision: true },
    })

    expect(h.codexAccountIds).toHaveLength(3)
    expect(new Set(h.codexAccountIds)).toEqual(new Set([codexWork.accountId]))
  })

  it('resolves the virtual Claude selection to the active account', async () => {
    await expect(subagentProviderStatus(CLAUDE_VIRTUAL)).resolves.toBe('available')
    await expect(subagentModelCatalog(CLAUDE_VIRTUAL)).resolves.toEqual({ status: 'available', models: ['sonnet'] })
    await expect(subagentModelMeta(CLAUDE_VIRTUAL, 'sonnet')).resolves.toMatchObject({ status: 'available' })

    expect(h.claudeAccountIds.length).toBeGreaterThan(0)
    expect(new Set(h.claudeAccountIds)).toEqual(new Set([claudeWork.accountId]))
  })

  it('applies the model visibility of the active physical account', async () => {
    h.codexModels = [h.codexModel('gpt-work'), h.codexModel('gpt-hidden')]
    setHiddenChatModels(codexWork.providerId, ['gpt-hidden'])

    await expect(subagentModelCatalog(CODEX_VIRTUAL)).resolves.toEqual({ status: 'available', models: ['gpt-work'] })
  })

  it('follows the pointer when another account becomes active', async () => {
    const other = addAccount('codex-subscription', 'Other')
    setAccountPool({ kind: 'codex-subscription', activeProviderId: other.providerId })

    await expect(subagentProviderStatus(CODEX_VIRTUAL)).resolves.toBe('available')

    expect(h.codexAccountIds).toEqual([other.accountId])
  })

  it('reports a signed-out active account as disconnected', async () => {
    h.codexAuthenticated = false

    await expect(subagentProviderStatus(CODEX_VIRTUAL)).resolves.toBe('disconnected')
    await expect(subagentModelCatalog(CODEX_VIRTUAL)).resolves.toEqual({ status: 'unavailable', models: [] })
  })

  it('keeps an individual selection on its own account even when it is not the active one', async () => {
    const other = addAccount('codex-subscription', 'Other')

    await expect(subagentProviderStatus(other.providerId)).resolves.toBe('available')

    expect(h.codexAccountIds).toEqual([other.accountId])
  })
})

describe('image interpreter on the active-account selection', () => {
  it('is configured through the active Codex account and never looks the virtual id up', () => {
    setImageInterpreter({ providerId: CODEX_VIRTUAL, modelId: 'gpt-work' })

    expect(hasConfiguredImageInterpreter()).toBe(true)
    expect(h.codexAccountIds).toEqual([codexWork.accountId])

    h.codexAuthenticated = false
    expect(hasConfiguredImageInterpreter()).toBe(false)
  })

  it('is configured through the active Claude account', () => {
    setImageInterpreter({ providerId: CLAUDE_VIRTUAL, modelId: 'sonnet' })

    expect(hasConfiguredImageInterpreter()).toBe(true)
    expect(h.claudeAccountIds).toEqual([claudeWork.accountId])
  })
})

const identity: ClaudeSubscriptionAccountIdentity = { fingerprint: 'sha256:claude-work', epoch: 1 }

function assistant(text: string): SDKMessage {
  return {
    type: 'assistant',
    uuid: 'assistant-uuid',
    session_id: 'child-session',
    parent_tool_use_id: null,
    message: {
      id: 'anthropic-message',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  } as unknown as SDKMessage
}

function result(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'result-uuid',
    session_id: 'child-session',
    duration_ms: 20,
    duration_api_ms: 15,
    is_error: false,
    num_turns: 1,
    result: 'Done.',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage
}

class FakeQuery implements AsyncIterable<SDKMessage> {
  readonly close = vi.fn()
  readonly interrupt = vi.fn(async () => {})
  readonly initializationResult = vi.fn(async () => ({ account: { apiProvider: 'firstParty' } }))

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    yield assistant('Done.')
    yield result()
  }
}

class FakeManager {
  readonly assertAccountIdentity = vi.fn()
  readonly assertSubscriptionRuntimeAccount = vi.fn()
  readonly createQuery = vi.fn(() => new FakeQuery())
}

describe('Claude subagent runner on the active-account selection', () => {
  const run = (manager: FakeManager, targets: ClaudeRuntimeTarget[] = []) =>
    runClaudeSubagent({
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      conversationId: 'conversation',
      cwd: '/repo',
      profile: {
        version: 1,
        agentName: 'reviewer',
        effective: {
          providerId: CLAUDE_VIRTUAL,
          modelId: 'sonnet',
          configuredEffort: 'high',
          sentEffort: 'high',
          source: 'parent',
          fastMode: false,
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: { name: 'reviewer', description: 'Reviews code', prompt: 'Review carefully.', source: 'test' },
      signal: new AbortController().signal,
      agentName: 'reviewer',
      task: 'Review the change.',
      readOnly: false,
      tools: {},
      prepareTarget: (target) => {
        targets.push(target)
        return { task: 'Review the change.' }
      },
    })

  it('runs an injected manager of the active account and attributes the physical account', async () => {
    const manager = Object.assign(new FakeManager(), { accountId: claudeWork.accountId })
    const targets: ClaudeRuntimeTarget[] = []

    await expect(run(manager, targets)).resolves.toMatchObject({
      text: 'Done.',
      model: { providerId: claudeWork.providerId, modelId: 'sonnet' },
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ providerId: claudeWork.providerId, accountId: claudeWork.accountId })
    expect(manager.createQuery).toHaveBeenCalledOnce()
  })

  it('derives the physical account of an injected manager that does not report one', async () => {
    const targets: ClaudeRuntimeTarget[] = []

    await run(new FakeManager(), targets)

    expect(targets[0]).toMatchObject({ providerId: claudeWork.providerId, accountId: claudeWork.accountId })
  })

  it('rejects an injected manager of an account other than the active one', async () => {
    const other = addAccount('claude-subscription', 'Other')
    const manager = Object.assign(new FakeManager(), { accountId: other.accountId })

    await expect(run(manager)).rejects.toThrow('Injected Claude manager account does not match')
    expect(manager.createQuery).not.toHaveBeenCalled()
  })
})
