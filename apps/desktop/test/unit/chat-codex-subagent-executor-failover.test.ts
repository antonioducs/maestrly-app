import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeSubagent } from '../../src/main/chat/subagent-executor'
import { PermissionBroker } from '../../src/main/chat/permission'
import { QuestionBroker } from '../../src/main/chat/question-broker'
import { CodexSubagentQuotaError } from '../../src/main/chat/codex-subscription/subagent-runner'
import {
  getSubscriptionFailoverRouter,
  resetSubscriptionFailoverRouterForTests,
} from '../../src/main/chat/subscription-failover/router'

const PRIMARY = 'builtin_codex_subscription'
const FALLBACK = 'builtin_codex_subscription@acc_fallback'

const h = vi.hoisted(() => ({
  runCodex: vi.fn(),
  resolve: vi.fn(),
  chain: vi.fn(),
  directManager: vi.fn(),
}))
vi.mock('../../src/main/chat/codex-subscription/subagent-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/codex-subscription/subagent-runner')>()),
  runCodexSubagent: h.runCodex,
}))
vi.mock('../../src/main/chat/codex-subscription/runner', () => ({
  approvalConfig: () => ({ approvalPolicy: 'never', sandbox: 'read-only' }),
  registerCodexSubagentRequestRoute: () => ({ addThread: () => true, removeThread: () => {}, remove: () => {} }),
  sandboxPolicyFor: () => ({ type: 'readOnly' }),
  toolSetRuntimes: async () => [],
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({ getCodexSubscriptionManager: h.directManager }))
vi.mock('../../src/main/chat/subscription-failover/codex-adapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/subscription-failover/codex-adapter')>()),
  resolveCodexRuntimeTarget: h.resolve,
}))
vi.mock('../../src/main/chat/subscription-failover/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/subscription-failover/config')>()),
  freezeFailoverChain: h.chain,
}))
vi.mock('../../src/main/chat/harness/flags', () => ({ captureHarnessFlags: () => ({}) }))
vi.mock('../../src/main/chat/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/catalog')>()),
  getProvider: () => undefined,
}))
vi.mock('../../src/main/chat/tools', () => ({
  ALL_TOOL_NAMES: [],
  buildTools: () => ({}),
  selectSubagentToolNames: () => new Set(),
}))
vi.mock('../../src/main/chat/subagent-ownership', () => ({
  withSubagentMessageOwnership: (input: { execute: () => Promise<unknown> }) => input.execute(),
}))

const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheCreate: 0, totalInput: input })

function target(providerId: string, accountId: string | null) {
  return {
    providerId,
    accountId,
    client: { id: `client-${providerId}` },
    manager: { getRateLimits: vi.fn(async () => null) },
    serviceTier: 'default',
    runtimeModelId: 'worker-model',
  }
}

function args(progress = vi.fn()): Parameters<typeof executeSubagent>[0] {
  return {
    conversationId: 'conversation',
    projectId: 'project',
    cwd: '/tmp/project',
    parentMessageId: 'message',
    mode: 'agent',
    permMode: 'ask',
    agentName: 'general-purpose',
    task: 'Fix the failing test.',
    readOnly: false,
    definition: { name: 'general-purpose', description: 'Worker', prompt: 'Do the task.', source: 'test' },
    profile: {
      version: 1,
      agentName: 'general-purpose',
      attempts: [],
      effective: {
        providerId: PRIMARY,
        modelId: 'worker-model',
        configuredEffort: 'high',
        sentEffort: 'high',
        fastMode: false,
        source: 'conversation-default',
        candidateIndex: 0,
      },
    },
    broker: new PermissionBroker({ rulesetFor: () => [] }),
    questionBroker: new QuestionBroker(),
    signal: new AbortController().signal,
    progress,
    account: { parentProviderId: 'builtin_claude_subscription' },
  }
}

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset()
  resetSubscriptionFailoverRouterForTests()
  h.chain.mockReturnValue([PRIMARY, FALLBACK])
  h.resolve.mockImplementation(async (input: { attemptedProviderIds: ReadonlySet<string> }) => ({
    ok: true,
    target: input.attemptedProviderIds.has(PRIMARY) ? target(FALLBACK, 'acc_fallback') : target(PRIMARY, null),
  }))
})
afterEach(() => resetSubscriptionFailoverRouterForTests())

describe('Codex subagent delegated by a non-Codex parent', () => {
  it('continues the same task on the fallback account after a quota and marks the primary exhausted', async () => {
    h.runCodex
      .mockRejectedValueOnce(
        new CodexSubagentQuotaError('UsageLimitExceeded: weekly quota exhausted', {
          text: 'Half done.',
          usage: usage(100, 10),
          checkpoint: { commands: ['npm test'] },
        })
      )
      .mockResolvedValueOnce({ text: 'Fixed.', usage: usage(50, 5) })
    const progress = vi.fn()

    const result = await executeSubagent(args(progress))

    expect(result).toMatchObject({ text: 'Fixed.', usage: usage(150, 15) })
    expect(h.runCodex).toHaveBeenCalledTimes(2)
    const [first, second] = h.runCodex.mock.calls.map(([input]) => input)
    expect(first).toMatchObject({ client: { id: `client-${PRIMARY}` }, physicalProviderId: PRIMARY })
    expect(second).toMatchObject({ client: { id: `client-${FALLBACK}` }, physicalProviderId: FALLBACK })
    expect(second.task).toContain('Fix the failing test.')
    expect(second.task).toContain('npm test')
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('hit limit; continuing on'))
    expect(getSubscriptionFailoverRouter().getHealth(PRIMARY)).toMatchObject({
      state: 'exhausted',
      exhaustion: { reason: expect.stringContaining('UsageLimitExceeded') },
    })
    expect(h.directManager).not.toHaveBeenCalled()
  })

  it('reports the exhausted chain with the partial work when no account is left', async () => {
    h.runCodex.mockRejectedValueOnce(
      new CodexSubagentQuotaError('UsageLimitExceeded: weekly quota exhausted', {
        text: 'Half done.',
        usage: usage(8, 2),
      })
    )
    h.resolve
      .mockImplementationOnce(async () => ({ ok: true, target: target(PRIMARY, null) }))
      .mockImplementationOnce(async () => ({
        ok: false,
        error: 'no-eligible-account',
        reason: 'quota-exhausted',
        message: 'exhausted',
      }))

    await expect(executeSubagent(args())).resolves.toMatchObject({
      text: 'Half done.',
      errorCode: 'agent-unavailable',
      error: expect.stringContaining('exhausted'),
      usage: usage(8, 2),
    })
  })

  it('keeps the direct single-account path when the account has no fallback route', async () => {
    h.chain.mockReturnValue([PRIMARY])
    const client = { id: 'direct' }
    h.directManager.mockReturnValue({ preferredServiceTier: vi.fn(), getClient: vi.fn(async () => client) })
    h.runCodex.mockResolvedValueOnce({ text: 'Direct.' })

    await expect(executeSubagent(args())).resolves.toMatchObject({ text: 'Direct.' })
    expect(h.resolve).not.toHaveBeenCalled()
    expect(h.runCodex.mock.calls[0][0]).toMatchObject({ client })
  })
})
