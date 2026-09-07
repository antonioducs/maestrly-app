import { jsonSchema, tool, type ToolSet } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { runClaudeSubagent } from '../../src/main/chat/claude-agent-sdk/subagent-runner'
import type {
  ClaudeSubscriptionAccountIdentity,
  ClaudeSubscriptionManager,
} from '../../src/main/chat/claude-agent-sdk/manager'
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
