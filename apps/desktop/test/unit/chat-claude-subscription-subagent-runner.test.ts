import { jsonSchema, tool, type ToolSet } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { runClaudeSubagent } from '../../src/main/chat/claude-agent-sdk/subagent-runner'
import type {
  ClaudeSubscriptionAccountIdentity,
  ClaudeSubscriptionManager,
} from '../../src/main/chat/claude-agent-sdk/manager'
import { resolveClaudeBehaviorProfile } from '../../src/main/chat/behavior-profile'
import { CLAUDE_DISALLOWED_NATIVE_TOOLS } from '../../src/main/chat/claude-agent-sdk/tools'
import type { SubagentTextUpdate } from '../../src/main/chat/subagent-text-stream'
import { closeDb, freshDb } from '../helpers/db'

const identity: ClaudeSubscriptionAccountIdentity = {
  fingerprint: 'sha256:claude-account',
  epoch: 4,
}

function profile(overrides: { fastMode?: boolean; source?: 'conversation-default' | 'parent'; modelId?: string } = {}) {
  return {
    version: 1 as const,
    agentName: 'reviewer',
    effective: {
      providerId: 'builtin_claude_subscription',
      modelId: overrides.modelId ?? 'sonnet',
      configuredEffort: 'high',
      sentEffort: 'high',
      source: overrides.source ?? ('conversation-default' as const),
      fastMode: overrides.fastMode ?? false,
      candidateIndex: 0,
    },
    attempts: [],
  }
}

const definition = {
  name: 'reviewer',
  description: 'Reviews code',
  prompt: 'Review carefully.',
  source: '.claude/agents/reviewer.md',
  tools: ['read', 'grep', 'bash', 'task', 'review_plan', 'generate_image', 'use_skill'],
}

function tools(): ToolSet {
  return Object.fromEntries(
    ['read', 'grep', 'bash', 'task', 'review_plan', 'generate_image', 'use_skill'].map((name) => [
      name,
      tool({
        description: `${name} tool`,
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: vi.fn(async () => 'ok'),
      }),
    ])
  )
}

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
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
      },
    },
  } as unknown as SDKMessage
}

function result(subtype: 'success' | 'error_during_execution' = 'success', totalCostUsd = 0.01): SDKMessage {
  return {
    type: 'result',
    subtype,
    uuid: 'result-uuid',
    session_id: 'child-session',
    duration_ms: 200,
    duration_api_ms: 150,
    is_error: subtype !== 'success',
    num_turns: 2,
    result: subtype === 'success' ? 'Final review.' : '',
    stop_reason: 'end_turn',
    total_cost_usd: totalCostUsd,
    usage: {
      input_tokens: 100,
      output_tokens: 5,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
    modelUsage: {},
    permission_denials: [],
    errors: subtype === 'success' ? undefined : ['runtime failed'],
  } as unknown as SDKMessage
}

class FakeQuery implements AsyncIterable<SDKMessage> {
  readonly close = vi.fn()
  readonly interrupt = vi.fn(async () => {})
  readonly initializationResult = vi.fn(async () => ({
    account: { apiProvider: 'firstParty' },
  }))

  constructor(
    private readonly messages: SDKMessage[],
    private readonly afterMessages?: () => void
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (const message of this.messages) yield message
    this.afterMessages?.()
  }
}

class FakeManager {
  readonly calls: Array<{ prompt: unknown; options?: Record<string, unknown> }> = []
  readonly assertAccountIdentity = vi.fn()
  readonly assertSubscriptionRuntimeAccount = vi.fn()
  query = new FakeQuery([assistant('Final review.'), result()])

  createQuery(input: { prompt: unknown; options?: Record<string, unknown> }) {
    this.calls.push(input)
    return this.query
  }
}

describe('Claude isolated subagent runner', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('uses an isolated strict MCP session with exact model/effort and no native agents/tasks', async () => {
    const manager = new FakeManager()
    const progress: string[] = []

    await expect(
      runClaudeSubagent({
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        conversationId: 'conversation-1',
        cwd: '/repo',
        profile: profile(),
        definition,
        signal: new AbortController().signal,
        agentName: 'reviewer',
        task: '/logout',
        readOnly: false,
        tools: tools(),
        progress: (line) => progress.push(line),
      })
    ).resolves.toEqual({
      text: 'Final review.',
      model: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      usage: { input: 100, output: 5, cacheRead: 20, cacheCreate: 10, totalInput: 130 },
      runtimeEstimatedCostUsd: 0.01,
    })

    expect(manager.calls[0]).toMatchObject({
      options: {
        cwd: '/repo',
        model: 'sonnet',
        effort: 'high',
        settings: { fastMode: false, fastModePerSessionOptIn: true },
        settingSources: [],
        strictMcpConfig: true,
        tools: [],
        skills: [],
        plugins: [],
        agents: {},
        permissionMode: 'dontAsk',
        persistSession: false,
      },
    })
    expect(manager.calls[0].prompt).not.toBe('/logout')
    const structuredPrompt = (
      await (
        manager.calls[0].prompt as AsyncIterable<{
          origin?: { kind?: string }
          message: { content: Array<{ type: string; text?: string }> }
        }>
      )
        [Symbol.asyncIterator]()
        .next()
    ).value
    expect(structuredPrompt).toMatchObject({
      origin: { kind: 'human' },
      message: { content: [{ type: 'text', text: '/logout' }] },
    })
    const options = manager.calls[0].options ?? {}
    expect(options.allowedTools).toEqual([
      'mcp__maestrly__bash',
      'mcp__maestrly__generate_image',
      'mcp__maestrly__grep',
      'mcp__maestrly__read',
    ])
    expect(options.disallowedTools).toEqual(CLAUDE_DISALLOWED_NATIVE_TOOLS)
    expect(options.allowedTools).not.toContain('mcp__maestrly__task')
    expect(options.allowedTools).not.toContain('mcp__maestrly__review_plan')
    expect(options.allowedTools).not.toContain('mcp__maestrly__use_skill')
    expect(options.allowedTools).toContain('mcp__maestrly__generate_image')
    expect(progress).toEqual(['Starting subagent reviewer'])
    expect(manager.query.close).toHaveBeenCalledOnce()
  })

  it('applies the Fable profile from the resolved child identity without changing the child tool boundary', async () => {
    const manager = new FakeManager()
    manager.query = new FakeQuery([result()])

    await runClaudeSubagent({
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      conversationId: 'conversation-1',
      cwd: '/repo',
      profile: profile({ modelId: 'fable' }),
      resolvedModelId: 'claude-fable-5-1',
      definition,
      signal: new AbortController().signal,
      agentName: 'reviewer',
      task: 'Inspect independently.',
      readOnly: true,
      tools: tools(),
    })

    const options = manager.calls[0]?.options ?? {}
    expect(options.model).toBe('claude-fable-5-1')
    expect(options.systemPrompt).toContain('maestrly-fable-5.1-v1')
    expect(options.systemPrompt).toContain('report to the parent')
    expect(options.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect((options.hooks as Record<string, unknown[]>).PostToolUse).toHaveLength(1)
    expect(options.allowedTools).not.toContain('mcp__maestrly__task')
    expect(options.allowedTools).not.toContain('mcp__maestrly__review_plan')
  })

  it.each([
    'claude-opus-5',
    'opus',
  ])('applies Opus from the effective child model %s without Fable hooks', async (modelId) => {
    const manager = new FakeManager()
    manager.query = new FakeQuery([result()])

    await runClaudeSubagent({
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      conversationId: 'conversation-1',
      cwd: '/repo',
      profile: profile({ modelId }),
      resolvedModelId: modelId === 'opus' ? 'claude-opus-5' : undefined,
      definition,
      signal: new AbortController().signal,
      agentName: 'reviewer',
      task: 'Inspect independently.',
      readOnly: true,
      tools: tools(),
    })

    const options = manager.calls[0]?.options ?? {}
    expect(options.model).toBe('claude-opus-5')
    expect(options.systemPrompt).toContain(
      resolveClaudeBehaviorProfile({ requestedModelId: 'claude-opus-5' }).profile!.id
    )
    expect(options.thinking).toBeUndefined()
    expect(options.effort).toBe('high')
    expect((options.hooks as Record<string, unknown[]>).PostToolUse).toBeUndefined()
    expect(options.allowedTools).not.toContain('mcp__maestrly__task')
    expect(options.allowedTools).not.toContain('mcp__maestrly__review_plan')
  })

  it('exposes the host-governed skill loader only for a Maestro worker', async () => {
    const manager = new FakeManager()
    await runClaudeSubagent({
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      conversationId: 'conversation-1',
      cwd: '/repo',
      profile: profile(),
      definition,
      signal: new AbortController().signal,
      agentName: 'reviewer',
      task: 'Apply the relevant skill.',
      readOnly: false,
      tools: tools(),
      allowSkillLoader: true,
    })

    expect(manager.calls[0]?.options?.allowedTools).toContain('mcp__maestrly__use_skill')
    expect(manager.calls[0]?.options?.skills).toEqual([])
  })

  it('requires the parent host capability and a mutable child before exposing generate_image', async () => {
    const withoutHost = new FakeManager()
    await runClaudeSubagent({
      manager: withoutHost as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      conversationId: 'conversation-1',
      cwd: '/repo',
      profile: profile(),
      definition,
      signal: new AbortController().signal,
      agentName: 'reviewer',
      task: 'Inspect.',
      readOnly: false,
      tools: Object.fromEntries(Object.entries(tools()).filter(([name]) => name !== 'generate_image')),
    })
    expect(withoutHost.calls[0]?.options?.allowedTools).not.toContain('mcp__maestrly__generate_image')

    const readOnly = new FakeManager()
    await runClaudeSubagent({
      manager: readOnly as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      conversationId: 'conversation-1',
      cwd: '/repo',
      profile: profile(),
      definition,
      signal: new AbortController().signal,
      agentName: 'reviewer',
      task: 'Inspect.',
      readOnly: true,
      tools: tools(),
    })
    expect(readOnly.calls[0]?.options?.allowedTools).not.toContain('mcp__maestrly__generate_image')
  })

  it('normalizes corrected assistant snapshots as replace updates', async () => {
    const manager = new FakeManager()
    const textUpdates: SubagentTextUpdate[] = []
    manager.query = new FakeQuery([assistant('Draft review.'), assistant('Final review.'), result()])

    await expect(
      runClaudeSubagent({
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        conversationId: 'conversation-1',
        cwd: '/repo',
        profile: profile(),
        definition,
        signal: new AbortController().signal,
        agentName: 'reviewer',
        task: 'Inspect.',
        readOnly: true,
        tools: tools(),
        onTextUpdate: (update) => textUpdates.push(update),
      })
    ).resolves.toMatchObject({ text: 'Final review.' })

    expect(textUpdates).toEqual([
      { kind: 'append', text: 'Draft review.' },
      { kind: 'replace', text: 'Final review.' },
    ])
  })

  it.each([
    { source: 'parent' as const, fastMode: true },
    { source: 'parent' as const, fastMode: false },
    { source: 'conversation-default' as const, fastMode: true },
    { source: 'conversation-default' as const, fastMode: false },
  ])('uses snapshot Fast=$fastMode and always opts into per-session settings for $source', async ({
    source,
    fastMode,
  }) => {
    const manager = new FakeManager()

    await runClaudeSubagent({
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      conversationId: 'conversation-1',
      cwd: '/repo',
      profile: profile({ source, fastMode }),
      definition,
      signal: new AbortController().signal,
      agentName: 'reviewer',
      task: 'Inspect.',
      readOnly: true,
      tools: tools(),
    })

    expect(manager.calls[0]?.options).toMatchObject({
      settings: { fastMode, fastModePerSessionOptIn: true },
    })
  })

  it('returns runtime failures and closes the query', async () => {
    const manager = new FakeManager()
    manager.query = new FakeQuery([assistant('Partial review.'), result('error_during_execution')])

    await expect(
      runClaudeSubagent({
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        conversationId: 'conversation-1',
        cwd: '/repo',
        profile: profile(),
        definition,
        signal: new AbortController().signal,
        agentName: 'reviewer',
        task: 'Inspect.',
        readOnly: true,
        tools: tools(),
      })
    ).resolves.toMatchObject({
      text: 'Partial review.',
      error: 'runtime failed',
      usage: { input: 100, output: 5, cacheRead: 20, cacheCreate: 10, totalInput: 130 },
      runtimeEstimatedCostUsd: 0.01,
    })
    expect(manager.query.close).toHaveBeenCalledOnce()
  })

  it('preserves an explicit zero runtime estimate instead of treating it as unavailable', async () => {
    const manager = new FakeManager()
    manager.query = new FakeQuery([assistant('Free result.'), result('success', 0)])

    await expect(
      runClaudeSubagent({
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        conversationId: 'conversation-1',
        cwd: '/repo',
        profile: profile(),
        definition,
        signal: new AbortController().signal,
        agentName: 'reviewer',
        task: 'Inspect.',
        readOnly: true,
        tools: tools(),
      })
    ).resolves.toMatchObject({
      text: 'Free result.',
      runtimeEstimatedCostUsd: 0,
    })
  })

  it('keeps terminal usage and cost when the SDK iterator fails after its result', async () => {
    const manager = new FakeManager()
    manager.query = new FakeQuery([assistant('Measured result.'), result()], () => {
      throw new Error('Claude transport closed after result.')
    })

    await expect(
      runClaudeSubagent({
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        conversationId: 'conversation-1',
        cwd: '/repo',
        profile: profile(),
        definition,
        signal: new AbortController().signal,
        agentName: 'reviewer',
        task: 'Inspect.',
        readOnly: true,
        tools: tools(),
      })
    ).resolves.toMatchObject({
      text: 'Measured result.',
      error: 'Claude transport closed after result.',
      usage: { input: 100, output: 5, cacheRead: 20, cacheCreate: 10, totalInput: 130 },
      runtimeEstimatedCostUsd: 0.01,
    })
  })

  it('attaches terminal usage and cost to an abort raised after the SDK result', async () => {
    const manager = new FakeManager()
    const controller = new AbortController()
    manager.query = new FakeQuery([assistant('Measured result.'), result()], () => {
      controller.abort(new Error('cancelled after result'))
      throw new Error('Claude transport interrupted.')
    })

    await expect(
      runClaudeSubagent({
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        conversationId: 'conversation-1',
        cwd: '/repo',
        profile: profile(),
        definition,
        signal: controller.signal,
        agentName: 'reviewer',
        task: 'Inspect.',
        readOnly: true,
        tools: tools(),
      })
    ).rejects.toMatchObject({
      subagentUsage: {
        input: 100,
        output: 5,
        cacheRead: 20,
        cacheCreate: 10,
        totalInput: 130,
      },
      subagentModel: {
        providerId: 'builtin_claude_subscription',
        modelId: 'sonnet',
      },
      subagentRuntimeEstimatedCostUsd: 0.01,
    })
  })

  it('does not release or execute a prompt cancelled during runtime initialization', async () => {
    let releaseInitialization!: (value: { account: { apiProvider: 'firstParty' } }) => void
    const initialization = new Promise<{ account: { apiProvider: 'firstParty' } }>((resolve) => {
      releaseInitialization = resolve
    })
    const manager = new FakeManager()
    manager.query.initializationResult.mockImplementation(() => initialization)
    const controller = new AbortController()

    const running = runClaudeSubagent({
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      conversationId: 'conversation-1',
      cwd: '/repo',
      profile: profile(),
      definition,
      signal: controller.signal,
      agentName: 'reviewer',
      task: '/logout',
      readOnly: true,
      tools: tools(),
    })
    await vi.waitFor(() => expect(manager.query.initializationResult).toHaveBeenCalled())
    controller.abort(new Error('cancelled during initialization'))
    releaseInitialization({ account: { apiProvider: 'firstParty' } })

    await expect(running).rejects.toThrow('cancelled during initialization')
    expect(manager.query.close).toHaveBeenCalled()
  })
})

describe('Claude subagent account rotation', () => {
  beforeEach(freshDb)
  afterEach(() => {
    vi.restoreAllMocks()
    closeDb()
  })

  const argsFor = () => ({
    conversationId: 'rotation-conversation',
    cwd: '/repo',
    profile: profile({ fastMode: true }),
    definition,
    signal: new AbortController().signal,
    agentName: 'reviewer',
    task: 'Finish the effect exactly once.',
    readOnly: false,
    tools: tools(),
  })
  const targetFor = (
    manager: FakeManager,
    providerId: string
  ): import('../../src/main/chat/subscription-failover/claude-adapter').ClaudeRuntimeTarget => ({
    manager: manager as unknown as ClaudeSubscriptionManager,
    providerId,
    accountId: providerId.endsWith('acc_b') ? 'acc_b' : null,
    accountIdentity: identity,
    model: { value: 'sonnet', resolvedModel: 'claude-sonnet', displayName: 'Sonnet', description: '' },
    runtimeModelId: 'claude-sonnet',
    reasoningEffort: 'high',
    fastMode: true,
    maestrlyUltra: false,
    contextWindow: 200_000,
  })
  const quotaMessage = () =>
    ({ ...result('error_during_execution', 0.02), errors: ["You've hit your limit · resets tomorrow"] }) as SDKMessage
  async function routing(a: FakeManager, b: FakeManager) {
    const adapter = await import('../../src/main/chat/subscription-failover/claude-adapter')
    const config = await import('../../src/main/chat/subscription-failover/config')
    const targetA = targetFor(a, 'builtin_claude_subscription')
    const targetB = targetFor(b, 'builtin_claude_subscription@acc_b')
    vi.spyOn(config, 'freezeFailoverChain').mockReturnValue([targetA.providerId, targetB.providerId])
    const resolve = vi
      .spyOn(adapter, 'resolveClaudeRuntimeTarget')
      .mockResolvedValueOnce({ ok: true, target: targetA })
      .mockResolvedValueOnce({ ok: true, target: targetB })
      .mockResolvedValue({
        ok: false,
        error: 'no-eligible-account',
        reason: 'quota-exhausted',
        message: 'All accounts exhausted.',
      })
    const settle = vi.spyOn(adapter, 'settleClaudeAttempt').mockImplementation(() => {})
    return { resolve, settle, targetA, targetB }
  }

  it('records quota before draining an unacknowledged effect, then supplies all effects to a fresh account session', async () => {
    const a = new FakeManager()
    const b = new FakeManager()
    const { settle, resolve, targetA, targetB } = await routing(a, b)
    const bridge = await import('../../src/main/chat/claude-agent-sdk/tools')
    const originalBridge = bridge.buildClaudeToolBridge
    let journal: import('../../src/main/chat/claude-agent-sdk/tool-journal').ClaudeToolJournal | undefined
    let toolSignal: AbortSignal | undefined
    vi.spyOn(bridge, 'buildClaudeToolBridge').mockImplementation(async (...args) => {
      journal = args[4]
      toolSignal = args[1]
      return originalBridge(...args)
    })
    let finish!: () => void
    const effect = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve('external effect committed: ticket-42')
        })
    )
    const uncertain = vi.fn(async () => {
      throw new Error('effect may have committed: ticket-43')
    })
    const query = new FakeQuery([])
    query[Symbol.asyncIterator] = async function* () {
      yield assistant('Started the requested work.')
      void journal!.run('effect-1', 'bash', { command: 'create ticket' }, effect)
      await journal!.run('effect-2', 'bash', { command: 'create another ticket' }, uncertain).catch(() => {})
      yield quotaMessage()
    }
    a.query = query
    const sessions = vi.fn()
    const entries = vi.fn()
    const run = runClaudeSubagent({
      ...argsFor(),
      onSessionStarted: sessions,
      onJournalEntry: entries,
      persistRuntime: true,
      resume: { sessionId: 'child-session', fallbackTask: 'Previous report', accountId: null },
    })
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith(targetA, 'quota', expect.any(Object)))
    const { listClaudeAttempts } = await import('../../src/main/chat/subscription-failover/claude-attempts')
    expect(listClaudeAttempts()).toEqual([
      expect.objectContaining({ providerId: targetA.providerId, scope: 'subagent' }),
    ])
    expect(toolSignal?.aborted).toBe(false)
    expect(b.calls).toHaveLength(0)
    expect(query.close).not.toHaveBeenCalled()
    finish()
    const outcome = await run
    expect(listClaudeAttempts()).toEqual([])
    expect(outcome).toMatchObject({
      text: 'Final review.',
      runtimeEstimatedCostUsd: 0.03,
      usage: { input: 200, output: 10, cacheRead: 40, cacheCreate: 20, totalInput: 260 },
      resumed: false,
    })
    expect(effect).toHaveBeenCalledTimes(1)
    expect(uncertain).toHaveBeenCalledTimes(1)
    expect(query.close).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls.map(([target, outcome]) => [target.providerId, outcome])).toEqual([
      [targetA.providerId, 'quota'],
      [targetB.providerId, 'success'],
    ])
    expect(resolve.mock.calls[1][0]).toMatchObject({
      runtimeModelId: 'claude-sonnet',
      reasoningEffort: 'high',
      fastMode: true,
    })
    expect(b.calls[0].options).not.toHaveProperty('resume')
    expect(b.calls[0].options).toMatchObject({ model: 'claude-sonnet', effort: 'high', settings: { fastMode: true } })
    const prompt: unknown[] = []
    for await (const message of b.calls[0].prompt as AsyncIterable<unknown>) prompt.push(message)
    const context = JSON.stringify(prompt)
    expect(context).toContain('external effect committed: ticket-42')
    expect(context).toContain('effect may have committed: ticket-43')
    expect(context).toContain('uncertain')
    expect(context).toContain('Started the requested work.')
    expect(context).toContain('Previous report')
    expect(entries).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed', toolCallId: 'effect-1' }))
    expect(sessions).toHaveBeenLastCalledWith({ sessionId: 'child-session', resumed: false, target: targetB })
  })

  it('sums partial assistant usage once without a result and attributes diagnostics to each physical account', async () => {
    const a = new FakeManager()
    const b = new FakeManager()
    const { targetA, targetB } = await routing(a, b)
    const diagnostics = await import('../../src/main/chat/usage-diagnostics')
    const record = vi.spyOn(diagnostics, 'recordModelCallUsage').mockImplementation(() => {})
    const quota = { ...assistant("You've hit your limit · resets tomorrow"), error: 'rate_limit' } as SDKMessage
    a.query = new FakeQuery([assistant('partial work'), quota])
    const onTextUpdate = vi.fn()
    const progress = vi.fn()
    const outcome = await runClaudeSubagent({ ...argsFor(), onTextUpdate, progress })
    const prompt = await (b.calls[0].prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next()
    expect(JSON.stringify(prompt.value)).not.toContain("You've hit your limit")
    expect(JSON.stringify(onTextUpdate.mock.calls)).not.toContain("You've hit your limit")
    expect(JSON.stringify(progress.mock.calls)).not.toContain("You've hit your limit")
    expect(outcome.usage).toEqual({ input: 200, output: 10, cacheRead: 40, cacheCreate: 20, totalInput: 260 })
    expect(outcome).not.toHaveProperty('runtimeEstimatedCostUsd')
    expect(record.mock.calls.map(([input]) => input.providerId)).toEqual([targetA.providerId, targetB.providerId])
  })

  it('terminates when the frozen chain is exhausted without retrying an account', async () => {
    const a = new FakeManager()
    const b = new FakeManager()
    const { resolve, settle } = await routing(a, b)
    a.query = new FakeQuery([quotaMessage()])
    b.query = new FakeQuery([quotaMessage()])
    const outcome = await runClaudeSubagent(argsFor())
    expect(outcome.error).toBe('All accounts exhausted.')
    expect(outcome.runtimeEstimatedCostUsd).toBe(0.04)
    expect(resolve).toHaveBeenCalledTimes(3)
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(settle.mock.calls.map(([, outcome]) => outcome)).toEqual(['quota', 'quota'])
  })

  it('does not rotate for a generic 429', async () => {
    const a = new FakeManager()
    const b = new FakeManager()
    const { resolve, settle, targetA } = await routing(a, b)
    a.query.initializationResult.mockRejectedValue(Object.assign(new Error('Too many requests'), { status: 429 }))
    expect((await runClaudeSubagent(argsFor())).error).toContain('Too many requests')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(b.calls).toHaveLength(0)
    expect(settle).toHaveBeenCalledExactlyOnceWith(targetA, 'other', undefined)
  })

  it('Stop cancels host work while draining quota and prevents a fallback attempt', async () => {
    const a = new FakeManager()
    const b = new FakeManager()
    const { settle, resolve } = await routing(a, b)
    const bridge = await import('../../src/main/chat/claude-agent-sdk/tools')
    const originalBridge = bridge.buildClaudeToolBridge
    let journal: import('../../src/main/chat/claude-agent-sdk/tool-journal').ClaudeToolJournal | undefined
    let hostSignal: AbortSignal | undefined
    vi.spyOn(bridge, 'buildClaudeToolBridge').mockImplementation(async (...args) => {
      journal = args[4]
      hostSignal = args[1]
      return originalBridge(...args)
    })
    a.query[Symbol.asyncIterator] = async function* () {
      void journal!
        .run(
          'slow-effect',
          'bash',
          {},
          () =>
            new Promise((_resolve, reject) => {
              hostSignal!.addEventListener('abort', () => reject(hostSignal!.reason), { once: true })
            })
        )
        .catch(() => {})
      yield quotaMessage()
    }
    const controller = new AbortController()
    const run = runClaudeSubagent({ ...argsFor(), signal: controller.signal })
    const rejected = expect(run).rejects.toMatchObject({ message: 'Stop child', subagentRuntimeEstimatedCostUsd: 0.02 })
    await vi.waitFor(() => expect(settle).toHaveBeenCalled())
    controller.abort(new Error('Stop child'))
    await rejected
    expect(hostSignal?.aborted).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(b.calls).toHaveLength(0)
  })

  it('fails before submitting a task when the target context cannot hold it', async () => {
    const a = new FakeManager()
    const b = new FakeManager()
    const { targetA, settle } = await routing(a, b)
    targetA.contextWindow = 10
    expect((await runClaudeSubagent(argsFor())).error).toContain('context window')
    expect(a.calls).toHaveLength(0)
    expect(settle).toHaveBeenCalledExactlyOnceWith(targetA, 'other', undefined)
  })
  it('recreates a requested session for a different physical identity and retains the previous report', async () => {
    const a = new FakeManager()
    const b = new FakeManager()
    const { targetA } = await routing(a, b)
    const started = vi.fn()
    const outcome = await runClaudeSubagent({
      ...argsFor(),
      onSessionStarted: started,
      resume: {
        sessionId: 'old-session',
        fallbackTask: 'Previous turn report and current task',
        accountId: null,
        accountIdentity: { fingerprint: 'another-login', epoch: 0 },
      },
    })
    expect(outcome).toMatchObject({ resumed: false, resumeReason: 'account-changed' })
    expect(a.calls[0].options).not.toHaveProperty('resume')
    expect(started).toHaveBeenCalledWith({ sessionId: 'child-session', resumed: false, target: targetA })
    const messages: unknown[] = []
    for await (const message of a.calls[0].prompt as AsyncIterable<unknown>) messages.push(message)
    expect(JSON.stringify(messages)).toContain('Previous turn report and current task')
  })

  it('preserves fresh-session fallback when the SDK rejects native resume', async () => {
    const a = new FakeManager()
    const b = new FakeManager()
    await routing(a, b)
    a.query.initializationResult.mockRejectedValueOnce(new Error('Session not found'))
    const outcome = await runClaudeSubagent({
      ...argsFor(),
      resume: { sessionId: 'old-session', fallbackTask: 'Previous report' },
    })
    expect(outcome).toMatchObject({ resumed: false, resumeReason: 'resume-rejected', text: 'Final review.' })
    expect(a.calls).toHaveLength(2)
    expect(a.calls[0].options).toHaveProperty('resume', 'old-session')
    expect(a.calls[1].options).not.toHaveProperty('resume')
  })
  it('retains physical ownership until a cancellation-ignoring callback and projection settle', async () => {
    const a = new FakeManager()
    const b = new FakeManager()
    await routing(a, b)
    const registry = await import('../../src/main/chat/subscription-failover/claude-attempts')
    const released = vi.fn()
    registry.setClaudeAttemptOwner(() => released)
    const bridge = await import('../../src/main/chat/claude-agent-sdk/tools')
    const original = bridge.buildClaudeToolBridge
    let journal!: import('../../src/main/chat/claude-agent-sdk/tool-journal').ClaudeToolJournal
    vi.spyOn(bridge, 'buildClaudeToolBridge').mockImplementation(async (...args) => {
      journal = args[4]!
      return original(...args)
    })
    let finish!: () => void
    let project!: () => void
    const effect = new Promise<void>((resolve) => {
      finish = resolve
    })
    const projection = new Promise<void>((resolve) => {
      project = resolve
    })
    a.query[Symbol.asyncIterator] = async function* () {
      void journal.track(async () => {
        await journal.run('held', 'bash', {}, () => effect)
        await projection
      })
      yield quotaMessage()
    }
    const controller = new AbortController()
    const run = runClaudeSubagent({ ...argsFor(), signal: controller.signal })
    const checked = expect(run).rejects.toMatchObject({
      message: 'Stop held child',
      subagentRuntimeEstimatedCostUsd: 0.02,
    })
    try {
      await vi.waitFor(() => expect(a.calls).toHaveLength(1))
      await vi.waitFor(() => expect(journal.snapshot()).toHaveLength(1))
      controller.abort(new Error('Stop held child'))
      expect(a.query.close).toHaveBeenCalledOnce()
      expect(registry.listClaudeAttempts()).toHaveLength(1)
      finish()
      await Promise.resolve()
      expect(released).not.toHaveBeenCalled()
      project()
      await checked
      expect(registry.listClaudeAttempts()).toHaveLength(0)
      expect(released).toHaveBeenCalledOnce()
      expect(a.query.close).toHaveBeenCalledOnce()
      expect(b.calls).toHaveLength(0)
    } finally {
      finish()
      project()
      registry.setClaudeAttemptOwner(null)
    }
  })

  it('settles an admitted lease when the physical owner rejects registration', async () => {
    const a = new FakeManager()
    const { targetA, settle } = await routing(a, new FakeManager())
    targetA.availabilityLease = { generation: 1 } as typeof targetA.availabilityLease
    const registry = await import('../../src/main/chat/subscription-failover/claude-attempts')
    registry.setClaudeAttemptOwner(() => {
      throw new Error('owner rejected')
    })
    try {
      await expect(runClaudeSubagent(argsFor())).rejects.toThrow('owner rejected')
      expect(settle).toHaveBeenCalledExactlyOnceWith(targetA, 'other', undefined)
      expect(registry.listClaudeAttempts()).toHaveLength(0)
      expect(a.calls).toHaveLength(0)
    } finally {
      registry.setClaudeAttemptOwner(null)
    }
  })

  it.each([
    { accountId: null, providerId: 'builtin_claude_subscription@acc_b' },
    { accountId: 'acc_b', providerId: 'builtin_claude_subscription' },
  ])('rejects injected physical account $accountId for $providerId', async ({ accountId, providerId }) => {
    const manager = Object.assign(new FakeManager(), { accountId })
    const args = argsFor()
    args.profile.effective.providerId = providerId
    await expect(
      runClaudeSubagent({
        ...args,
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
      })
    ).rejects.toThrow('does not match')
    expect(manager.calls).toHaveLength(0)
  })

  it('omits incomplete native cost on abort after token-only quota usage', async () => {
    const a = new FakeManager()
    const b = new FakeManager()
    await routing(a, b)
    a.query = new FakeQuery([{ ...assistant("You've hit your limit"), error: 'rate_limit' } as SDKMessage])
    const controller = new AbortController()
    b.query = new FakeQuery([result()], () => {
      controller.abort(new Error('Stop after result'))
    })
    const error = await runClaudeSubagent({ ...argsFor(), signal: controller.signal }).catch((error) => error)
    expect(error.subagentUsage.input).toBe(200)
    expect(error).not.toHaveProperty('subagentRuntimeEstimatedCostUsd')
  })

  it('closes rejected resume before fresh creation and gates both prompts', async () => {
    const a = new FakeManager()
    await routing(a, new FakeManager())
    const old = new FakeQuery([])
    old.initializationResult.mockRejectedValue(new Error('Session not found'))
    const fresh = new FakeQuery([result()])
    const create = vi
      .spyOn(a, 'createQuery')
      .mockImplementationOnce((input) => {
        a.calls.push(input)
        return old
      })
      .mockImplementationOnce((input) => {
        expect(old.close).toHaveBeenCalledOnce()
        a.calls.push(input)
        return fresh
      })
    const outcome = await runClaudeSubagent({
      ...argsFor(),
      resume: { sessionId: 'old', fallbackTask: 'Previous report and retained checkpoint' },
    })
    expect(outcome.resumed).toBe(false)
    expect(create).toHaveBeenCalledTimes(2)
    await expect((a.calls[0].prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next()).rejects.toThrow(
      'Session not found'
    )
    const next = await (a.calls[1].prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next()
    expect(JSON.stringify(next.value)).toContain('Previous report and retained checkpoint')
    expect(a.calls[1].options).toMatchObject({ tools: [], permissionMode: 'dontAsk' })
  })

  it.each([
    'authentication_error',
    'network failure',
    'unknown model',
  ])('does not retry resume for %s', async (diagnostic) => {
    const a = new FakeManager()
    const { resolve } = await routing(a, new FakeManager())
    a.query.initializationResult.mockRejectedValue(new Error(diagnostic))
    const outcome = await runClaudeSubagent({
      ...argsFor(),
      resume: { sessionId: 'old', fallbackTask: 'Previous report' },
    })
    expect(outcome.error).toBeTruthy()
    expect(a.calls).toHaveLength(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('hides suspect local quota text while preserving its usage and terminal diagnostic', async () => {
    const a = new FakeManager()
    const { resolve } = await routing(a, new FakeManager())
    a.query = new FakeQuery([{ ...assistant('Local retry diagnostic'), error: 'rate_limit' } as SDKMessage])
    const onTextUpdate = vi.fn()
    const outcome = await runClaudeSubagent({ ...argsFor(), onTextUpdate })
    expect(outcome.text).toBe('')
    expect(outcome.error).toBe('Local retry diagnostic')
    expect(outcome.usage?.input).toBe(100)
    expect(outcome).not.toHaveProperty('runtimeEstimatedCostUsd')
    expect(onTextUpdate).not.toHaveBeenCalled()
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('stops if a faulty resolver returns an already attempted provider', async () => {
    const a = new FakeManager()
    const { resolve, targetA } = await routing(a, new FakeManager())
    resolve.mockReset().mockResolvedValue({ ok: true, target: targetA })
    a.query = new FakeQuery([quotaMessage()])
    await expect(runClaudeSubagent(argsFor())).rejects.toThrow('already attempted')
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(a.calls).toHaveLength(1)
  })

  it.each([
    undefined,
    null,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('does not zero-fill unknown or invalid native cost %s', async (cost) => {
    const a = new FakeManager()
    await routing(a, new FakeManager())
    a.query = new FakeQuery([{ ...result(), total_cost_usd: cost } as SDKMessage])
    expect(await runClaudeSubagent(argsFor())).not.toHaveProperty('runtimeEstimatedCostUsd')
  })

  it.each([
    'authentication_error',
    'Network unavailable',
    'Unknown model',
  ])('retains terminal assistant diagnostic %s without rotating', async (diagnostic) => {
    const a = new FakeManager()
    const { resolve } = await routing(a, new FakeManager())
    a.query = new FakeQuery([{ ...assistant(diagnostic), error: 'unknown' } as SDKMessage])
    const outcome = await runClaudeSubagent(argsFor())
    expect(outcome.error).toBeTruthy()
    expect(outcome.error).not.toContain('did not finish')
    expect(outcome.usage?.input).toBe(100)
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})
