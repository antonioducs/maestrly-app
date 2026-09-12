import { describe, expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'
import { selectedSubagentToolNames } from '../../src/main/chat/claude-agent-sdk/task-runtime'

describe('Claude Agent SDK managed task runtime', () => {
  it('removes recursive and parent-only tools from configured subagent tools', () => {
    const selected = selectedSubagentToolNames(false, [
      'read',
      'bash',
      'task',
      'delegate',
      'review_plan',
      'ask_question',
      'todo_write',
      'use_skill',
      'generate_image',
    ])
    expect([...selected]).toEqual(['read', 'bash'])
  })

  it('delegates generate_image only with the parent host capability and a mutable child', () => {
    const provided = { generate_image: {} as never } as ToolSet
    expect(selectedSubagentToolNames(false, ['read', 'bash', 'generate_image'], provided)).toEqual(
      new Set(['read', 'bash', 'generate_image'])
    )
    expect(selectedSubagentToolNames(false, ['read', 'bash', 'generate_image'])).not.toContain('generate_image')
    expect(selectedSubagentToolNames(true, ['read', 'bash', 'generate_image'], provided)).not.toContain(
      'generate_image'
    )
  })

  it('enforces the read-only allowlist regardless of a mutating agent profile', () => {
    const selected = selectedSubagentToolNames(true, ['bash', 'write', 'edit'])
    expect(selected.has('read')).toBe(true)
    expect(selected.has('bash')).toBe(false)
    expect(selected.has('write')).toBe(false)
    expect(selected.has('task')).toBe(false)
  })
})

it('keeps a single managed task and coordinator lease while its real Claude child rotates accounts', async () => {
  const { freshDb, closeDb } = await import('../helpers/db')
  const { makeConversation, makeWorkspace } = await import('../helpers/factories')
  const { upsertChatMessage } = await import('../../src/main/chat/chat-store')
  const { createClaudeTaskRuntime } = await import('../../src/main/chat/claude-agent-sdk/task-runtime')
  const { SubagentCoordinator } = await import('../../src/main/chat/subagent-coordinator')
  const resolver = await import('../../src/main/chat/subagent-execution-profile')
  const adapter = await import('../../src/main/chat/subscription-failover/claude-adapter')
  const config = await import('../../src/main/chat/subscription-failover/config')
  const { listSubagentSessions } = await import('../../src/main/chat/subagent-session-store')
  freshDb()
  try {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    upsertChatMessage({ id: 'parent', conversationId: conversation.id, role: 'assistant', parts: [], createdAt: 1 })
    const definition = {
      name: 'reviewer',
      description: 'Review',
      prompt: 'Review the work.',
      source: 'test',
      tools: ['read'],
    }
    const profile = {
      version: 1 as const,
      agentName: 'reviewer',
      effective: {
        providerId: 'builtin_claude_subscription',
        modelId: 'sonnet',
        configuredEffort: 'high',
        sentEffort: 'high',
        fastMode: true,
        source: 'conversation-default' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    vi.spyOn(resolver, 'resolveSubagentExecutionProfile').mockResolvedValue({ definition, profile })
    const targets = [0, 1].map((index) => ({
      providerId: index ? 'builtin_claude_subscription@acc_b' : 'builtin_claude_subscription',
      accountId: index ? 'acc_b' : null,
      accountIdentity: { fingerprint: `account-${index}`, epoch: 1 },
      runtimeModelId: 'claude-sonnet',
      model: { value: 'sonnet' },
      reasoningEffort: 'high',
      fastMode: true,
      maestrlyUltra: false,
      contextWindow: 200_000,
      manager: {
        assertAccountIdentity: vi.fn(),
        assertSubscriptionRuntimeAccount: vi.fn(),
        createQuery: vi.fn(() => ({
          initializationResult: async () => ({ account: { apiProvider: 'firstParty' } }),
          close: vi.fn(),
          interrupt: vi.fn(async () => {}),
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'result',
              subtype: index ? 'success' : 'error_during_execution',
              session_id: `child-${index}`,
              errors: index ? [] : ["You've hit your limit · resets tomorrow"],
              result: index ? 'Review finished.' : '',
              total_cost_usd: 0.01,
              usage: { input_tokens: 10, output_tokens: 5 },
            }
          },
        })),
      },
    }))
    vi.spyOn(config, 'freezeFailoverChain').mockReturnValue(targets.map((target) => target.providerId))
    vi.spyOn(adapter, 'resolveClaudeRuntimeTarget')
      .mockResolvedValueOnce({
        ok: true,
        target:
          targets[0] as unknown as import('../../src/main/chat/subscription-failover/claude-adapter').ClaudeRuntimeTarget,
      })
      .mockResolvedValueOnce({
        ok: true,
        target:
          targets[1] as unknown as import('../../src/main/chat/subscription-failover/claude-adapter').ClaudeRuntimeTarget,
      })
    vi.spyOn(adapter, 'settleClaudeAttempt').mockImplementation(() => {})
    const lifecycle = vi.fn()
    const apply = vi.fn()
    const subagentUsage = new Map()
    const runTask = createClaudeTaskRuntime({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: conversation.cwd,
      mode: 'agent',
      permMode: 'ask',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      reasoningEffort: 'high',
      fastMode: true,
      // The parent identity is deliberately unusable: child account admission belongs to its own runner.
      manager: { status: async () => ({ authenticated: false }) } as never,
      accountIdentity: { fingerprint: 'stale-parent', epoch: 0 },
      broker: {} as never,
      questionBroker: {} as never,
      assistantId: 'parent',
      agents: [definition],
      tools: {},
      coordinator: new SubagentCoordinator({ onEvent: lifecycle }),
      subagentUsage,
      apply,
      turnState: { requested: new Set(), dispatched: new Set() },
    })
    const output = await runTask(
      { agent: 'reviewer', prompt: 'Review now.' },
      'same-card',
      new AbortController().signal,
      vi.fn()
    )
    expect(output).toMatchObject({
      output: 'Review finished.',
      sub: { runtimeEstimatedCostUsd: 0.02, usage: { input: 20, output: 10 } },
    })
    expect(lifecycle.mock.calls.map(([event]) => event.type)).toEqual(['acquired', 'released'])
    expect(new Set(apply.mock.calls.map(([event]) => event.toolCallId))).toEqual(new Set(['same-card']))
    expect(listSubagentSessions(conversation.id)).toHaveLength(1)
    expect([...subagentUsage.values()]).toEqual([
      expect.objectContaining({ input: 20, output: 10, runtimeEstimatedCostUsd: 0.02 }),
    ])
  } finally {
    vi.restoreAllMocks()
    closeDb()
  }
})
