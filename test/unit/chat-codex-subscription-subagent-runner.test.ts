import { describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerRpcError,
  type CodexAppServerClient,
  type CodexRequestOptions,
} from '../../src/main/chat/codex-subscription/client'
import type {
  CodexAccountRateLimitsReadResponse,
  CodexNotification,
} from '../../src/main/chat/codex-subscription/protocol'
import {
  CodexSubagentQuotaError,
  runCodexSubagent,
  type RunCodexSubagentArgs,
} from '../../src/main/chat/codex-subscription/subagent-runner'

vi.mock('../../src/main/chat/tools', () => ({ isSubagentToolAllowed: () => true }))
vi.mock('../../src/main/chat/usage-diagnostics', () => ({ recordModelCallUsage: vi.fn() }))

const model = { providerId: 'builtin_codex_subscription:account-b', modelId: 'gpt-5.6-mini' }
const usage = { input: 80, output: 12, cacheRead: 20, cacheCreate: 0, totalInput: 100 }

function harness(message = 'Rate limit reached') {
  const controller = new AbortController()
  const listeners = new Set<(notification: CodexNotification) => void>()
  const emit = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners) listener({ method, params: { threadId: 'child', ...params } })
  }
  const client = {
    startThread: vi.fn(async () => ({ thread: { id: 'child' } })),
    startTurn: vi.fn(async () => {
      emit('item/agentMessage/delta', { itemId: 'answer', delta: 'Partial findings' })
      emit('thread/tokenUsage/updated', {
        tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 12 } },
      })
      emit('item/completed', { item: { type: 'commandExecution', command: 'rg quota src' } })
      emit('item/completed', { item: { type: 'fileChange', changes: [{ path: 'src/fix.ts' }] } })
      emit('item/completed', {
        item: { type: 'dynamicToolCall', id: 'read-item', callId: 'read-call', tool: 'read', arguments: { path: 'a' } },
      })
      emit('item/started', {
        item: { type: 'dynamicToolCall', id: 'edit-item', callId: 'edit-call', tool: 'edit', arguments: { path: 'b' } },
      })
      emit('turn/completed', { turn: { id: 'turn', status: 'failed', error: { message } } })
      return { turn: { id: 'turn' } }
    }),
    request: vi.fn(
      async (
        _method: string,
        _params: unknown,
        _options?: CodexRequestOptions
      ): Promise<CodexAccountRateLimitsReadResponse> => ({ rateLimits: { limitReached: true } })
    ),
    interruptTurn: vi.fn(async () => {}),
    onNotification: (listener: (notification: CodexNotification) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    waitForExit: () => new Promise<never>(() => {}),
  }
  const args: RunCodexSubagentArgs = {
    client: client as unknown as CodexAppServerClient,
    cwd: '/workspace',
    profile: {
      version: 1,
      agentName: 'worker',
      effective: {
        providerId: 'builtin_codex_subscription',
        modelId: model.modelId,
        configuredEffort: 'high',
        sentEffort: 'high',
        source: 'conversation-agent',
        candidateIndex: 0,
      },
      attempts: [],
    },
    definition: { name: 'worker', description: 'Worker', prompt: 'Complete the task.', source: 'test' },
    signal: controller.signal,
    agentName: 'worker',
    task: 'Inspect quota handling.',
    readOnly: false,
    serviceTier: 'default',
    approvalPolicy: 'untrusted',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    dynamicTools: [],
    registerThread: vi.fn(() => true),
    removeThread: vi.fn(),
    physicalProviderId: model.providerId,
    accountId: 'account-b',
  }
  return { client, args, controller, emit, listeners }
}

describe('Codex subagent quota classification', () => {
  it.each([
    { label: 'enveloped', response: { rateLimits: { primary: { usedPercent: 100 } } } },
    { label: 'direct', response: { primary: { usedPercent: 100 } } },
  ])('confirms suspect turn failures from $label rate limits and preserves the checkpoint', async ({ response }) => {
    const { client, args, listeners } = harness()
    client.request.mockResolvedValue(response)

    const failure = await runCodexSubagent(args).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CodexSubagentQuotaError)
    expect(failure).toMatchObject({
      partial: {
        text: 'Partial findings',
        usage,
        model,
        physicalProviderId: model.providerId,
        accountId: 'account-b',
        checkpoint: {
          commands: ['rg quota src'],
          filesChanged: ['src/fix.ts'],
          statusLines: expect.arrayContaining(['Running rg quota src completed', 'Calling edit']),
          completedDynamicTools: [
            { tool: 'read', itemId: 'read-item', callId: 'read-call', argumentsSummary: 'args: path:string' },
          ],
          inFlightDynamicTools: [
            { tool: 'edit', itemId: 'edit-item', callId: 'edit-call', argumentsSummary: 'args: path:string' },
          ],
        },
      },
    })
    expect(client.request).toHaveBeenCalledExactlyOnceWith(
      'account/rateLimits/read',
      {},
      {
        signal: args.signal,
        timeoutMs: 30_000,
      }
    )
    expect(args.removeThread).toHaveBeenCalledExactlyOnceWith('child', true)
    expect(client.interruptTurn).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it.each(['startThread', 'startTurn'] as const)('confirms a suspect %s RPC rejection', async (method) => {
    const { client, args } = harness()
    const rpcMethod = method === 'startThread' ? 'thread/start' : 'turn/start'
    client[method].mockRejectedValue(new CodexAppServerRpcError('Rate limit reached', 429, rpcMethod, 1))

    await expect(runCodexSubagent(args)).rejects.toMatchObject({
      name: 'CodexSubagentQuotaError',
      partial: { text: '', model, physicalProviderId: model.providerId, accountId: 'account-b' },
    })
    expect(client.request).toHaveBeenCalledOnce()
    if (method === 'startTurn') expect(args.removeThread).toHaveBeenCalledWith('child', true)
    else expect(args.removeThread).not.toHaveBeenCalled()
  })

  it('keeps a suspect failure as an ordinary result when rate limits are healthy', async () => {
    const { client, args } = harness()
    client.request.mockResolvedValue({ rateLimits: { primary: { usedPercent: 15 }, limitReached: false } })

    await expect(runCodexSubagent(args)).resolves.toEqual({
      text: 'Partial findings',
      error: 'Rate limit reached',
      usage,
      model,
    })
    expect(client.request).toHaveBeenCalledOnce()
  })

  it('keeps the original failure when the confirmation request fails', async () => {
    const { client, args } = harness()
    client.request.mockRejectedValue(new Error('Rate limits unavailable'))

    await expect(runCodexSubagent(args)).resolves.toEqual({
      text: 'Partial findings',
      error: 'Rate limit reached',
      usage,
      model,
    })
    expect(client.request).toHaveBeenCalledOnce()
  })

  it.each([
    'Authentication required',
    'Network disconnected',
    '429 Too many requests',
    'Tool execution failed',
  ])('preserves nonquota failures without probing: %s', async (message) => {
    const { client, args } = harness(message)

    await expect(runCodexSubagent(args)).resolves.toEqual({ text: 'Partial findings', error: message, usage, model })
    expect(client.request).not.toHaveBeenCalled()
  })

  it('raises explicit quota failures without requiring a confirmation request', async () => {
    const { client, args } = harness('UsageLimitExceeded: weekly quota exhausted')

    await expect(runCodexSubagent(args)).rejects.toMatchObject({
      name: 'CodexSubagentQuotaError',
      partial: { text: 'Partial findings', usage, model },
    })
    expect(client.request).not.toHaveBeenCalled()
  })

  it('preserves cancellation when the rate-limit request is aborted', async () => {
    const { client, args, controller, listeners } = harness()
    let started!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    client.request.mockImplementation(
      (_method, _params, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
          started()
        })
    )
    const running = runCodexSubagent(args)
    const assertion = expect(running).rejects.toMatchObject({
      message: 'Subagent aborted',
      subagentUsage: usage,
      subagentModel: model,
    })
    await requestStarted
    controller.abort()

    await assertion
    expect(args.removeThread).toHaveBeenCalledExactlyOnceWith('child', true)
    expect(listeners.size).toBe(0)
  })

  it('does not raise a quota error if cancellation races a confirmed snapshot', async () => {
    const { client, args, controller } = harness()
    client.request.mockImplementation(async () => {
      controller.abort()
      return { rateLimits: { limitReached: true } }
    })

    await expect(runCodexSubagent(args)).rejects.toMatchObject({
      name: 'Error',
      message: 'Subagent aborted',
      subagentUsage: usage,
      subagentModel: model,
    })
  })
})
