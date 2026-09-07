import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatStreamEvent } from '../../src/shared/chat'
import type { ChatBehavior } from '../../src/shared/conversation-experience'

const h = vi.hoisted(() => ({
  stagePlan: vi.fn(),
  listAgents: vi.fn(),
  resolveSubagentExecutionProfile: vi.fn(),
  runClaudeSubagent: vi.fn(),
  getCodexClient: vi.fn(),
  codexPreferredServiceTier: vi.fn(),
  codexStatusSnapshot: null as { authenticated: boolean } | null,
  codexSetServerRequestHandler: vi.fn(),
  codexOnNotification: vi.fn(),
  runCodexSubagent: vi.fn(),
  buildMcpTools: vi.fn(async () => ({ tools: {}, close: vi.fn(async () => {}) })),
  buildAppTools: vi.fn(async () => ({ tools: {}, close: vi.fn(async () => {}) })),
  gitEnvInfo: vi.fn(async () => null as { branch: string; dirty: boolean } | null),
}))

vi.mock('../../src/main/plan-broker', () => ({
  stagePlan: h.stagePlan,
}))
vi.mock('../../src/main/chat/mcp', () => ({
  buildMcpTools: h.buildMcpTools,
  buildAppTools: h.buildAppTools,
}))
vi.mock('../../src/main/chat/skills', () => ({
  listSkills: vi.fn(async () => []),
  readSkillBody: vi.fn(async () => null),
}))
vi.mock('../../src/main/chat/agents', () => ({
  listAgents: h.listAgents,
}))
vi.mock('../../src/main/chat/subagent-execution-profile', () => ({
  resolveSubagentExecutionProfile: h.resolveSubagentExecutionProfile,
}))
vi.mock('../../src/main/chat/claude-agent-sdk/subagent-runner', () => ({
  runClaudeSubagent: h.runClaudeSubagent,
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: () => ({
    getClient: h.getCodexClient,
    preferredServiceTier: h.codexPreferredServiceTier,
    // Cached Codex authentication gates generate_image through the ChatGPT subscription.
    getStatusSnapshot: () => h.codexStatusSnapshot,
  }),
}))
vi.mock('../../src/main/chat/codex-subscription/subagent-runner', () => ({
  runCodexSubagent: h.runCodexSubagent,
}))
vi.mock('../../src/main/chat/project-context', () => ({
  buildProjectContext: vi.fn(async () => ''),
}))
vi.mock('../../src/main/git-service', () => ({
  gitEnvInfo: h.gitEnvInfo,
}))
vi.mock('../../src/main/chat/runner', async () => {
  const { renderDesignModePrompt } = await import('../../src/main/chat/design-mode-prompt')
  return {
    IN_TURN_COMPACT_RATIO: 0.9,
    SYSTEM_PROMPT: vi.fn(
      (_cwd: string, _appToolsEnabled: boolean, mode: ChatBehavior, _notes: boolean, profile?: { id: string } | null) =>
        [
          profile ? `Maestrly Fable system prompt ${profile.id}` : 'Maestrly system prompt',
          renderDesignModePrompt(mode),
        ]
          .filter(Boolean)
          .join('\n\n')
    ),
  }
})
vi.mock('../../src/main/chat/usage-diagnostics', () => ({
  recordModelCallUsage: vi.fn(),
}))

import { compactClaudeSession, runClaudeChat } from '../../src/main/chat/claude-agent-sdk/runner'
import type {
  ClaudeSubscriptionAccountIdentity,
  ClaudeSubscriptionManager,
} from '../../src/main/chat/claude-agent-sdk/manager'
import {
  getClaudeMessageMapping,
  getClaudeSessionBinding,
  putClaudeSessionBinding,
} from '../../src/main/chat/claude-agent-sdk/session-store'
import {
  deleteChatMessagesFrom,
  getMessageSeq,
  listChatMessages,
  upsertChatMessage,
} from '../../src/main/chat/chat-store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { REVIEWER_READONLY_TOOL_NAMES } from '../../src/main/chat/tools'
import { FABLE_51_BEHAVIOR_PROFILE } from '../../src/main/chat/fable/profile'

const identity: ClaudeSubscriptionAccountIdentity = {
  fingerprint: 'sha256:claude-account',
  epoch: 2,
}

const intentionalPlanInterruptDiagnostic =
  'Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'

function resultMessage(sessionId = 'claude-session-1', withCost = true): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'result-uuid',
    session_id: sessionId,
    duration_ms: 500,
    duration_api_ms: 450,
    is_error: false,
    num_turns: 2,
    result: '',
    stop_reason: 'end_turn',
    ...(withCost ? { total_cost_usd: 0.0123 } : {}),
    usage: {
      input_tokens: 120,
      output_tokens: 8,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 40,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
    modelUsage: {
      'claude-sonnet': {
        inputTokens: 120,
        outputTokens: 8,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 10,
        webSearchRequests: 0,
        costUSD: 0.0123,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
    permission_denials: [],
    user_message_uuid: 'sdk-user-uuid',
  } as unknown as SDKMessage
}

function errorResultMessage(errors: string[], sessionId = 'claude-session-1'): SDKMessage {
  return {
    ...resultMessage(sessionId),
    subtype: 'error_during_execution',
    is_error: true,
    stop_reason: null,
    errors,
  } as unknown as SDKMessage
}

class PlanQuery implements AsyncIterable<SDKMessage> {
  readonly close = vi.fn()
  readonly lifecycle: string[] = []
  private interrupted = false
  private iteratorFinished = false
  readonly interrupt = vi.fn(async () => {
    this.lifecycle.push('interrupt')
    this.interrupted = true
  })
  readonly getContextUsage = vi.fn(async () => {
    if (this.iteratorFinished) throw new Error('Claude transport already closed.')
    this.lifecycle.push('context')
    return {
      totalTokens: 420,
      maxTokens: 200_000,
      percentage: 0.21,
      model: 'claude-sonnet',
    }
  })
  readonly initializationResult = vi.fn(async () => ({
    account: { apiProvider: 'firstParty' },
  }))

  constructor(
    private readonly options: Record<string, unknown>,
    private readonly emitToolResult = true,
    private readonly sessionId = 'claude-session-1',
    private readonly interruptErrorMessage: string | null = null,
    private readonly resultErrors: string[] | null = null
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    try {
      yield {
        type: 'assistant',
        uuid: 'sdk-assistant-uuid',
        session_id: this.sessionId,
        parent_tool_use_id: null,
        message: {
          id: 'anthropic-assistant',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet',
          content: [
            {
              type: 'tool_use',
              id: 'tool-plan-1',
              name: 'mcp__maestrly__review_plan',
              input: { plan: '# Final plan', title: 'Ship Claude' },
            },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 4,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 20,
          },
        },
      } as unknown as SDKMessage

      const server = (this.options.mcpServers as Record<string, { instance: any }>).maestrly.instance
      const tool = server._registeredTools.review_plan
      const preToolUse = (
        this.options.hooks as {
          PreToolUse: Array<{
            hooks: Array<(input: unknown, toolUseId: string, options: { signal: AbortSignal }) => Promise<unknown>>
          }>
        }
      ).PreToolUse[0].hooks[0]
      await preToolUse(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__maestrly__review_plan',
          tool_input: { plan: '# Final plan', title: 'Ship Claude' },
          tool_use_id: 'tool-plan-1',
        },
        'tool-plan-1',
        { signal: new AbortController().signal }
      )
      const toolResult = await tool.handler({ plan: '# Final plan', title: 'Ship Claude' }, {})
      expect(toolResult).toMatchObject({
        content: [{ type: 'text', text: expect.any(String) }],
      })

      if (!this.emitToolResult) return
      yield {
        type: 'user',
        uuid: 'sdk-tool-result-uuid',
        session_id: this.sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-plan-1',
              content: 'Plan staged.',
              is_error: false,
            },
          ],
        },
      } as unknown as SDKMessage
      if (this.interruptErrorMessage) {
        while (!this.interrupted) await new Promise<void>((resolve) => setImmediate(resolve))
        throw new Error(this.interruptErrorMessage)
      }
      yield this.resultErrors ? errorResultMessage(this.resultErrors, this.sessionId) : resultMessage(this.sessionId)
    } finally {
      this.iteratorFinished = true
    }
  }
}

class ReviewerQuery implements AsyncIterable<SDKMessage> {
  readonly close = vi.fn()
  readonly interrupt = vi.fn(async () => {})
  readonly getContextUsage = vi.fn(async () => ({
    totalTokens: 300,
    maxTokens: 200_000,
    percentage: 0.15,
    model: 'claude-sonnet',
  }))
  readonly initializationResult = vi.fn(async () => ({ account: { apiProvider: 'firstParty' } }))

  constructor(private readonly options: Record<string, unknown>) {}

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    yield {
      type: 'assistant',
      uuid: 'reviewer-assistant-uuid',
      session_id: 'claude-reviewer-session',
      parent_tool_use_id: null,
      message: {
        id: 'reviewer-assistant-message',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        content: [
          {
            type: 'tool_use',
            id: 'tool-review-1',
            name: 'mcp__maestrly__submit_review',
            input: { result: 'clean', summary: 'No findings.' },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: 80,
          output_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10,
        },
      },
    } as unknown as SDKMessage

    const server = (this.options.mcpServers as Record<string, { instance: any }>).maestrly.instance
    const preToolUse = (
      this.options.hooks as {
        PreToolUse: Array<{
          hooks: Array<(input: unknown, toolUseId: string, options: { signal: AbortSignal }) => Promise<unknown>>
        }>
      }
    ).PreToolUse[0].hooks[0]
    await preToolUse(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__maestrly__submit_review',
        tool_input: { result: 'clean', summary: 'No findings.' },
        tool_use_id: 'tool-review-1',
      },
      'tool-review-1',
      { signal: new AbortController().signal }
    )
    await server._registeredTools.submit_review.handler({ result: 'clean', summary: 'No findings.' }, {})

    yield {
      type: 'user',
      uuid: 'reviewer-result-uuid',
      session_id: 'claude-reviewer-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-review-1',
            content: 'Review accepted.',
            is_error: false,
          },
        ],
      },
    } as unknown as SDKMessage
    yield resultMessage('claude-reviewer-session')
  }
}

class FakeManager {
  readonly calls: Array<{ prompt: unknown; options?: Record<string, unknown> }> = []
  readonly assertAccountIdentity = vi.fn()
  readonly assertSubscriptionRuntimeAccount = vi.fn()
  readonly deleteManagedSession = vi.fn(async () => {})
  emitToolResult = true
  interruptErrorMessage: string | null = null
  resultErrors: string[] | null = null
  sessionIds: string[] = []
  query: PlanQuery | null = null

  createQuery(input: { prompt: unknown; options?: Record<string, unknown> }) {
    this.calls.push(input)
    const sessionId = this.sessionIds[this.calls.length - 1] ?? 'claude-session-1'
    this.query = new PlanQuery(
      input.options ?? {},
      this.emitToolResult,
      sessionId,
      this.interruptErrorMessage,
      this.resultErrors
    )
    return this.query
  }
}

const streamedApiMessageId = 'anthropic-streamed-response'
const streamedReasoning = 'I will respond briefly.'
const streamedText = 'Hello! How can I help with the project `my-web-page`?'

function partialMessage(
  uuid: string,
  event: Record<string, unknown>,
  parentToolUseId: string | null = null
): SDKMessage {
  return {
    type: 'stream_event',
    uuid,
    session_id: 'claude-stream-session',
    parent_tool_use_id: parentToolUseId,
    event,
  } as unknown as SDKMessage
}

function finalAssistant(uuid: string, content: Array<Record<string, unknown>>): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 'claude-stream-session',
    parent_tool_use_id: null,
    message: {
      id: streamedApiMessageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 2,
        output_tokens: 12,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as SDKMessage
}

class StreamingTextQuery implements AsyncIterable<SDKMessage> {
  readonly close = vi.fn()
  readonly interrupt = vi.fn(async () => {})
  readonly getContextUsage = vi.fn(async () => ({
    totalTokens: 100,
    maxTokens: 200_000,
    percentage: 0.05,
    model: 'claude-sonnet',
  }))
  readonly initializationResult = vi.fn(async () => ({
    account: { apiProvider: 'firstParty' },
  }))

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    yield partialMessage('partial-message-start', {
      type: 'message_start',
      message: { id: streamedApiMessageId },
    })
    yield partialMessage(
      'nested-message-start',
      {
        type: 'message_start',
        message: { id: 'nested-api-message' },
      },
      'parent-tool-use'
    )
    yield partialMessage(
      'nested-text-delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Must not leak into the parent response.' },
      },
      'parent-tool-use'
    )
    yield partialMessage('partial-thinking-start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    })
    yield partialMessage('partial-thinking-delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: streamedReasoning },
    })
    yield partialMessage('partial-thinking-stop', {
      type: 'content_block_stop',
      index: 0,
    })
    // The SDK emits normalized assistant envelopes while the raw API stream is
    // still active. Their UUIDs are unrelated to the UUIDs on stream_event.
    yield finalAssistant('final-thinking-envelope', [
      { type: 'thinking', thinking: streamedReasoning, signature: 'signed-thinking' },
    ])
    yield partialMessage('partial-text-start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    })
    yield partialMessage('partial-text-delta-1', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Hello! How can I help with the project `my-web-' },
    })
    yield partialMessage('partial-text-delta-2', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'page`?' },
    })
    yield partialMessage('partial-text-stop', {
      type: 'content_block_stop',
      index: 1,
    })
    yield finalAssistant('final-text-envelope', [{ type: 'text', text: streamedText }])
    yield partialMessage('partial-tool-start', {
      type: 'content_block_start',
      index: 2,
      content_block: {
        type: 'tool_use',
        id: 'streamed-tool-use',
        name: 'mcp__maestrly__read',
        input: {},
      },
    })
    yield partialMessage('partial-tool-delta-1', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"path":' },
    })
    yield partialMessage('partial-tool-delta-2', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '"/repo/README.md"}' },
    })
    yield partialMessage('partial-tool-stop', {
      type: 'content_block_stop',
      index: 2,
    })
    yield finalAssistant('final-tool-envelope', [
      {
        type: 'tool_use',
        id: 'streamed-tool-use',
        name: 'mcp__maestrly__read',
        input: { path: '/repo/README.md' },
      },
    ])
    yield partialMessage('partial-message-stop', { type: 'message_stop' })
    yield {
      type: 'user',
      uuid: 'streamed-tool-result',
      session_id: 'claude-stream-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'streamed-tool-use',
            content: 'README contents',
            is_error: false,
          },
        ],
      },
    } as unknown as SDKMessage
    yield resultMessage('claude-stream-session')
  }
}

class StreamingTextManager {
  readonly calls: Array<{ prompt: unknown; options?: Record<string, unknown> }> = []
  readonly assertAccountIdentity = vi.fn()
  readonly assertSubscriptionRuntimeAccount = vi.fn()
  readonly deleteManagedSession = vi.fn(async () => {})
  readonly query = new StreamingTextQuery()

  createQuery(input: { prompt: unknown; options?: Record<string, unknown> }) {
    this.calls.push(input)
    return this.query
  }
}

const expiredOAuthDiagnostic = 'OAuth token expired. Please run claude auth login.'

class AuthenticationErrorQuery implements AsyncIterable<SDKMessage> {
  readonly close = vi.fn()
  readonly interrupt = vi.fn(async () => {})
  readonly initializationResult = vi.fn(async () => ({
    account: { apiProvider: 'firstParty' },
  }))
  readonly getContextUsage = vi.fn(async () => ({
    totalTokens: 20,
    maxTokens: 200_000,
    percentage: 0.01,
    model: 'claude-sonnet',
  }))

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    yield finalAssistant('oauth-error-assistant', [{ type: 'text', text: expiredOAuthDiagnostic }])
    yield errorResultMessage([expiredOAuthDiagnostic], 'claude-stream-session')
  }
}

class AuthenticationErrorManager {
  readonly assertAccountIdentity = vi.fn()
  readonly assertSubscriptionRuntimeAccount = vi.fn()
  readonly deleteManagedSession = vi.fn(async () => {})
  readonly requireAuthentication = vi.fn(() => true)
  readonly query = new AuthenticationErrorQuery()

  createQuery() {
    return this.query
  }
}

class ManagedTaskQuery implements AsyncIterable<SDKMessage> {
  readonly close = vi.fn()
  readonly interrupt = vi.fn(async () => {})
  readonly getContextUsage = vi.fn(async () => ({
    totalTokens: 640,
    maxTokens: 200_000,
    percentage: 0.32,
    model: 'claude-sonnet',
  }))
  readonly initializationResult = vi.fn(async () => ({
    account: { apiProvider: 'firstParty' },
  }))

  constructor(
    private readonly options: Record<string, unknown>,
    private readonly summarizeAfterResult = false,
    private readonly taskAgent = 'general-purpose',
    private readonly taskPrompt = 'Inspect the project.'
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    yield {
      type: 'assistant',
      uuid: 'sdk-task-assistant',
      session_id: 'claude-task-session',
      parent_tool_use_id: null,
      message: {
        id: 'anthropic-task-assistant',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        content: [
          {
            type: 'tool_use',
            id: 'tool-task-1',
            name: 'mcp__maestrly__task',
            input: { agent: this.taskAgent, prompt: this.taskPrompt },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 20,
        },
      },
    } as unknown as SDKMessage

    const server = (this.options.mcpServers as Record<string, { instance: any }>).maestrly.instance
    const taskTool = server._registeredTools.task
    const preToolUse = (
      this.options.hooks as {
        PreToolUse: Array<{
          hooks: Array<(input: unknown, toolUseId: string, options: { signal: AbortSignal }) => Promise<unknown>>
        }>
      }
    ).PreToolUse[0].hooks[0]
    await preToolUse(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__maestrly__task',
        tool_input: { agent: this.taskAgent, prompt: this.taskPrompt },
        tool_use_id: 'tool-task-1',
      },
      'tool-task-1',
      { signal: new AbortController().signal }
    )
    const toolResult = await taskTool.handler({ agent: this.taskAgent, prompt: this.taskPrompt }, {})
    const output = toolResult.content
      .filter((entry: { type?: string; text?: string }) => entry.type === 'text')
      .map((entry: { text?: string }) => entry.text ?? '')
      .join('\n')

    yield {
      type: 'user',
      uuid: 'sdk-task-result',
      session_id: 'claude-task-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-task-1',
            content: output,
            is_error: false,
          },
        ],
      },
    } as unknown as SDKMessage
    if (this.summarizeAfterResult) {
      yield {
        type: 'tool_use_summary',
        uuid: 'sdk-task-summary',
        session_id: 'claude-task-session',
        parent_tool_use_id: null,
        summary: 'Late task summary',
        preceding_tool_use_ids: ['tool-task-1'],
      } as unknown as SDKMessage
    }
    yield resultMessage('claude-task-session')
  }
}

class ManagedTaskManager {
  readonly assertAccountIdentity = vi.fn()
  readonly assertSubscriptionRuntimeAccount = vi.fn()
  readonly deleteManagedSession = vi.fn(async () => {})
  readonly calls: Array<{ prompt: unknown; options?: Record<string, unknown> }> = []
  query: ManagedTaskQuery | null = null

  constructor(
    private readonly summarizeAfterResult = false,
    private readonly taskAgent = 'general-purpose',
    private readonly taskPrompt = 'Inspect the project.'
  ) {}

  createQuery(input: { prompt: unknown; options?: Record<string, unknown> }) {
    this.calls.push(input)
    this.query = new ManagedTaskQuery(input.options ?? {}, this.summarizeAfterResult, this.taskAgent, this.taskPrompt)
    return this.query
  }
}

class PortableCompactionQuery implements AsyncIterable<SDKMessage> {
  readonly close = vi.fn()
  readonly interrupt = vi.fn(async () => {})
  readonly initializationResult = vi.fn(async () => ({
    account: { apiProvider: 'firstParty' },
  }))
  readonly getContextUsage = vi.fn(async () => ({
    totalTokens: this.attempt === 0 ? 900 : 100,
    // The provider-reported maximum is runtime metadata; the test's effective window is 1,000.
    maxTokens: 200_000,
    percentage: this.attempt === 0 ? 0.45 : 0.05,
    model: 'claude-sonnet',
  }))

  constructor(
    readonly attempt: number,
    private readonly withCost = true
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    const sessionId = this.attempt === 0 ? 'claude-portable-old' : 'claude-portable-fresh'
    if (this.attempt === 0) {
      yield {
        type: 'assistant',
        uuid: 'portable-old-assistant-uuid',
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: 'portable-old-assistant-message',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet',
          content: [
            { type: 'text', text: 'I inspected the project before compacting.' },
            {
              type: 'tool_use',
              id: 'portable-tool-use',
              name: 'mcp__maestrly__read',
              input: { path: '/repo/README.md' },
            },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: {
            input_tokens: 70,
            output_tokens: 11,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
          },
        },
      } as unknown as SDKMessage
      yield {
        type: 'user',
        uuid: 'portable-tool-result-uuid',
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'portable-tool-use',
              content: 'README portable contents',
              is_error: false,
            },
          ],
        },
      } as unknown as SDKMessage
    } else {
      yield {
        type: 'assistant',
        uuid: 'portable-fresh-assistant-uuid',
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: 'portable-fresh-assistant-message',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet',
          content: [{ type: 'text', text: 'Completed after portable compaction.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 30,
            output_tokens: 7,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 5,
          },
        },
      } as unknown as SDKMessage
    }
    yield resultMessage(sessionId, this.withCost)
  }
}

class PortableCompactionManager {
  readonly assertAccountIdentity = vi.fn()
  readonly assertSubscriptionRuntimeAccount = vi.fn()
  readonly deleteManagedSession = vi.fn(async () => {})
  readonly calls: Array<{ prompt: unknown; options?: Record<string, unknown> }> = []
  readonly queries: PortableCompactionQuery[] = []

  constructor(private readonly withCost = true) {}

  createQuery(input: { prompt: unknown; options?: Record<string, unknown> }) {
    this.calls.push(input)
    const query = new PortableCompactionQuery(this.queries.length, this.withCost)
    this.queries.push(query)
    return query
  }
}

class CompactQuery implements AsyncIterable<SDKMessage> {
  readonly close = vi.fn()
  private iteratorFinished = false
  readonly getContextUsage = vi.fn(async () => {
    if (this.iteratorFinished) throw new Error('Claude transport already closed.')
    if (this.hangContextUsage) return await new Promise<never>(() => {})
    return {
      totalTokens: 100,
      maxTokens: 200_000,
      percentage: 0.05,
      model: 'claude-sonnet',
    }
  })

  constructor(private readonly hangContextUsage = false) {}

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    try {
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-boundary-uuid',
        session_id: 'claude-session-1',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 420,
        },
      } as unknown as SDKMessage
      yield resultMessage()
    } finally {
      this.iteratorFinished = true
    }
  }
}

class CompactManager {
  readonly assertAccountIdentity = vi.fn()
  readonly listModels = vi.fn(async () => [])
  readonly calls: Array<{ prompt: unknown; options?: Record<string, unknown> }> = []
  readonly query: CompactQuery

  constructor(hangContextUsage = false) {
    this.query = new CompactQuery(hangContextUsage)
  }

  createQuery(input: { prompt: unknown; options?: Record<string, unknown> }) {
    this.calls.push(input)
    return this.query
  }
}

describe('Claude official chat runner', () => {
  beforeEach(() => {
    freshDb()
    h.stagePlan.mockReset()
    h.stagePlan.mockReturnValue({ ok: true })
    h.listAgents.mockReset()
    h.listAgents.mockResolvedValue([])
    h.resolveSubagentExecutionProfile.mockReset()
    h.runClaudeSubagent.mockReset()
    h.codexStatusSnapshot = null
    h.getCodexClient.mockReset()
    h.codexPreferredServiceTier.mockReset()
    h.codexPreferredServiceTier.mockResolvedValue('priority')
    h.codexSetServerRequestHandler.mockReset()
    h.codexOnNotification.mockReset()
    h.codexOnNotification.mockReturnValue(() => {})
    h.getCodexClient.mockResolvedValue({
      setServerRequestHandler: h.codexSetServerRequestHandler,
      onNotification: h.codexOnNotification,
    })
    h.runCodexSubagent.mockReset()
    h.buildMcpTools.mockClear()
    h.buildAppTools.mockClear()
    h.gitEnvInfo.mockReset()
    h.gitEnvInfo.mockResolvedValue(null)
  })
  afterEach(closeDb)

  it('gives Design the Agent tool surface, hashes its prompt once, and keeps Plan/Ask restricted', async () => {
    const workspace = makeWorkspace()
    h.listAgents.mockResolvedValue([
      {
        name: 'general-purpose',
        description: 'Worker with full tools.',
        tools: ['read', 'bash', 'write', 'edit'],
        prompt: 'Do the work.',
        source: 'test',
      },
    ])

    const runMode = async (mode: 'agent' | 'design' | 'plan' | 'ask') => {
      const conversation = makeConversation(workspace.id, { cwd: '/repo' })
      upsertChatMessage({
        id: `user-tools-${mode}`,
        conversationId: conversation.id,
        role: 'user',
        parts: [{ type: 'text', id: `text-tools-${mode}`, text: `Work in ${mode}.` }],
        createdAt: 1,
      })
      const manager = new StreamingTextManager()
      await runClaudeChat({
        conversationId: conversation.id,
        projectId: workspace.id,
        cwd: '/repo',
        selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
        mode,
        permMode: 'ask',
        maestrlyUltra: mode === 'design',
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        broker: { assert: vi.fn(), on: vi.fn() } as never,
        questionBroker: { ask: vi.fn() } as never,
        emit: vi.fn(),
        signal: new AbortController().signal,
      })
      return { conversation, options: manager.calls[0].options ?? {} }
    }

    const agent = await runMode('agent')
    const design = await runMode('design')
    const plan = await runMode('plan')
    const ask = await runMode('ask')
    const allowed = (value: { options: Record<string, unknown> }) =>
      [...((value.options.allowedTools as string[] | undefined) ?? [])].sort()
    const designPrompt = design.options.systemPrompt as string

    expect(allowed(design)).toEqual(allowed(agent))
    expect(allowed(design)).toEqual(expect.arrayContaining(['mcp__maestrly__bash', 'mcp__maestrly__task']))
    for (const restricted of [plan, ask]) {
      for (const toolName of [
        'mcp__maestrly__bash',
        'mcp__maestrly__edit',
        'mcp__maestrly__write',
        'mcp__maestrly__task',
      ]) {
        expect(allowed(restricted)).not.toContain(toolName)
      }
    }
    expect(designPrompt.match(/# Maestrly Design mode — design-v1/g)).toHaveLength(1)
    expect(designPrompt).toContain('## Design + Ultra guidance')
    expect(designPrompt).not.toContain('Stay read-only, investigate deeply')
    expect(agent.options.systemPrompt).not.toContain('# Maestrly Design mode')
    expect(getClaudeSessionBinding(design.conversation.id)?.promptHash).toBe(
      createHash('sha256').update(designPrompt).digest('hex')
    )
    expect(getClaudeSessionBinding(agent.conversation.id)?.promptHash).not.toBe(
      getClaudeSessionBinding(design.conversation.id)?.promptHash
    )
  })

  it('compacts at a folded tool-result boundary, continues in a fresh session and aggregates usage', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-portable-compaction',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-portable-compaction', text: 'Inspect and finish the work.' }],
      createdAt: 1,
    })
    const manager = new PortableCompactionManager()
    const events: Array<{ kind: string; [key: string]: unknown }> = []
    let durableAssistantAtCompaction: ReturnType<typeof listChatMessages>[number] | undefined
    const compactHistory = vi.fn(async () => {
      durableAssistantAtCompaction = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
      return {
        summary: 'Portable summary of the original history and completed README inspection.',
        usage: { input: 3, output: 4, cacheRead: 5, cacheCreate: 6, totalInput: 14 },
      }
    })

    const outcome = await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (event) => events.push(event as (typeof events)[number]),
      signal: new AbortController().signal,
      contextWindow: 1_000,
      compactHistory,
    })

    expect(manager.queries[0].getContextUsage).toHaveBeenCalledOnce()
    expect(compactHistory).toHaveBeenCalledOnce()
    expect(outcome).toEqual({ planSubmitted: false, sessionId: 'claude-portable-fresh' })
    expect(durableAssistantAtCompaction?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'I inspected the project before compacting.' }),
        expect.objectContaining({
          type: 'tool',
          toolCallId: 'portable-tool-use',
          state: { status: 'completed', output: 'README portable contents' },
        }),
      ])
    )
    expect(manager.queries).toHaveLength(2)
    expect(manager.queries[0].interrupt).toHaveBeenCalledOnce()
    expect(manager.queries[0].close).toHaveBeenCalledOnce()
    expect(manager.deleteManagedSession).toHaveBeenCalledWith('claude-portable-old', '/repo')
    expect(manager.calls[1].options).not.toHaveProperty('resume')

    const continuation = (
      await (
        manager.calls[1].prompt as AsyncIterable<{
          message: { content: Array<{ type: string; text?: string }> }
        }>
      )
        [Symbol.asyncIterator]()
        .next()
    ).value
    const continuationText = continuation.message.content.map((part: { text?: string }) => part.text ?? '').join('\n')
    expect(continuationText).toContain(
      'Previous summary:\nPortable summary of the original history and completed README inspection.'
    )
    expect(continuationText).toContain(
      'Continue the same assistant turn from the imported transcript. Do not repeat completed work or prior progress updates.'
    )

    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    expect(assistant?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'compaction',
          text: 'Portable summary of the original history and completed README inspection.',
          strategy: 'summary',
        }),
        expect.objectContaining({ type: 'text', text: 'Completed after portable compaction.' }),
      ])
    )
    expect(assistant?.usage).toMatchObject({
      input: 193,
      output: 23,
      cachedInput: 65,
      cacheCreate: 26,
      contextInput: 100,
      modelContextWindow: 200_000,
    })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'compaction', strategy: 'summary' }),
        expect.objectContaining({ kind: 'finish' }),
      ])
    )
    expect(events.some((event) => event.kind === 'error' || event.kind === 'aborted')).toBe(false)
    expect(getClaudeSessionBinding(conversation.id)).toMatchObject({
      sessionId: 'claude-portable-fresh',
      lastMessageId: assistant?.id,
      lastAssistantUuid: 'portable-fresh-assistant-uuid',
      usage: {
        inputTokens: 193,
        outputTokens: 23,
        cacheReadTokens: 65,
        cacheWriteTokens: 26,
      },
    })
    expect(getClaudeMessageMapping(conversation.id, 'user-portable-compaction')).toMatchObject({
      sessionId: 'claude-portable-fresh',
    })
  })

  it('adds native intra-turn compaction cost to main turn cost', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-portable-cost',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-portable-cost', text: 'Inspect and finish the work.' }],
      createdAt: 1,
    })
    const manager = new PortableCompactionManager()
    const compactHistory = vi.fn(async () => ({
      summary: 'Portable summary with native cost.',
      usage: { input: 3, output: 4, cacheRead: 5, cacheCreate: 6, totalInput: 14 },
      runtimeEstimatedCostUsd: 0.0045, // COMPLETE estimate for auxiliary calls
    }))
    const outcome = await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: () => {},
      signal: new AbortController().signal,
      contextWindow: 1_000,
      compactHistory,
    })
    expect(outcome).toEqual({ planSubmitted: false, sessionId: 'claude-portable-fresh' })
    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    // Cost combines main 0.0123 and compaction 0.0045; every token is priced.
    expect(assistant?.usage?.runtimeEstimatedCostUsd).toBeCloseTo(0.0123 + 0.0045, 6)
    expect(assistant?.usage?.catalogInput).toBeUndefined()
    expect(assistant?.usage?.catalogOutput).toBeUndefined()
    // Compactor tokens still add to turn tokens (existing contract).
    expect(assistant?.usage).toMatchObject({ input: 193, output: 23, cachedInput: 65, cacheCreate: 26 })
  })

  it('prices compaction without native estimates using catalog buckets', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-portable-catalog',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-portable-catalog', text: 'Inspect and finish the work.' }],
      createdAt: 1,
    })
    const manager = new PortableCompactionManager()
    const compactHistory = vi.fn(async () => ({
      summary: 'Portable summary with catalog-only cost.',
      usage: { input: 3, output: 4, cacheRead: 5, cacheCreate: 6, totalInput: 14 },
      // Without native estimates, compactor tokens use catalog pricing.
    }))
    const outcome = await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: () => {},
      signal: new AbortController().signal,
      contextWindow: 1_000,
      compactHistory,
    })
    expect(outcome).toEqual({ planSubmitted: false, sessionId: 'claude-portable-fresh' })
    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    // Main uses native cost; compactor tokens remain explicit catalog buckets.
    expect(assistant?.usage?.runtimeEstimatedCostUsd).toBeCloseTo(0.0123, 6)
    expect(assistant?.usage).toMatchObject({
      catalogInput: 3,
      catalogOutput: 4,
      catalogCacheRead: 5,
      catalogCacheCreate: 6,
    })
  })

  it('prices only main tokens when compaction has native cost estimates', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-portable-aux-covered',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-portable-aux-covered', text: 'Inspect and finish the work.' }],
      createdAt: 1,
    })
    // Runtime results WITHOUT total_cost_usd (main has no native estimate).
    const manager = new PortableCompactionManager(false)
    const compactHistory = vi.fn(async () => ({
      summary: 'Portable summary with runtime cost but no main cost.',
      usage: { input: 3, output: 4, cacheRead: 5, cacheCreate: 6, totalInput: 14 },
      runtimeEstimatedCostUsd: 0.0045, // COMPLETE auxiliary estimate (its tokens are COVERED)
    }))
    const outcome = await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: () => {},
      signal: new AbortController().signal,
      contextWindow: 1_000,
      compactHistory,
    })
    expect(outcome).toEqual({ planSubmitted: false, sessionId: 'claude-portable-fresh' })
    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    // Runtime covers only auxiliary cost; catalog pricing covers only main tokens.
    // Runtime-covered tokens never return to the residual for duplicate pricing.
    expect(assistant?.usage?.runtimeEstimatedCostUsd).toBeCloseTo(0.0045, 6)
    expect(assistant?.usage).toMatchObject({
      catalogInput: 190,
      catalogOutput: 19,
      catalogCacheRead: 60,
      catalogCacheCreate: 20,
    })
    expect(assistant?.usage).toMatchObject({ input: 193, output: 23, cachedInput: 65, cacheCreate: 26 })
  })

  it('stops safely when portable intra-turn compaction fails', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-portable-failure',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-portable-failure', text: 'Inspect this without looping.' }],
      createdAt: 1,
    })
    const manager = new PortableCompactionManager()
    const compactHistory = vi.fn(async () => {
      throw new Error('summarizer unavailable')
    })
    const events: Array<{ kind: string; [key: string]: unknown }> = []

    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (event) => events.push(event as (typeof events)[number]),
      signal: new AbortController().signal,
      contextWindow: 1_000,
      compactHistory,
    })

    expect(manager.queries[0].getContextUsage).toHaveBeenCalledOnce()
    expect(compactHistory).toHaveBeenCalledOnce()
    expect(manager.calls).toHaveLength(1)
    expect(manager.queries[0].interrupt).toHaveBeenCalledOnce()
    expect(manager.deleteManagedSession).toHaveBeenCalledWith('claude-portable-old', '/repo')
    expect(getClaudeSessionBinding(conversation.id)).toBeNull()
    expect(listChatMessages(conversation.id).at(-1)).toMatchObject({
      role: 'assistant',
      error: 'Claude portable intra-turn compaction failed.',
    })
    expect(events.filter((event) => event.kind === 'error')).toHaveLength(1)
    expect(events.some((event) => event.kind === 'aborted' || event.kind === 'finish')).toBe(false)
  })

  it('does not trigger portable compaction without an effective runtime window', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-portable-no-window',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-portable-no-window', text: 'Use provider runtime metadata only.' }],
      createdAt: 1,
    })
    const manager = new PortableCompactionManager()
    const compactHistory = vi.fn(async () => ({ summary: 'must not run' }))

    const outcome = await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: vi.fn(),
      signal: new AbortController().signal,
      compactHistory,
    })

    expect(outcome.sessionId).toBe('claude-portable-old')
    expect(compactHistory).not.toHaveBeenCalled()
    expect(manager.calls).toHaveLength(1)
    expect(manager.queries[0].interrupt).not.toHaveBeenCalled()
  })

  it('submits and releases a plan with strict Maestrly-only tools, complete tool state and resumable UUIDs', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-1',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-1', text: 'Make a plan.' }],
      createdAt: 1,
    })
    const manager = new FakeManager()
    const events: Array<{ kind: string; [key: string]: unknown }> = []

    const outcome = await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'plan',
      permMode: 'ask',
      reasoningEffort: 'high',
      fastMode: true,
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (event) => events.push(event as (typeof events)[number]),
      signal: new AbortController().signal,
      onSessionReady: () => true,
      canPersistSession: () => true,
    })

    expect(outcome).toEqual({ planSubmitted: true, sessionId: 'claude-session-1' })
    expect(h.stagePlan).toHaveBeenCalledWith({
      agentId: conversation.id,
      cwd: '/repo',
      plan: '# Final plan',
      title: 'Ship Claude',
    })
    await vi.waitFor(() => expect(manager.query?.interrupt).toHaveBeenCalled())
    expect(manager.calls[0].options).toMatchObject({
      cwd: '/repo',
      model: 'sonnet',
      effort: 'high',
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      skills: [],
      plugins: [],
      agents: {},
      permissionMode: 'dontAsk',
      includePartialMessages: true,
      persistSession: true,
    })
    expect(manager.calls[0].prompt).not.toBe('Make a plan.')
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
      message: { content: [{ type: 'text', text: 'Make a plan.' }] },
    })
    expect(manager.calls[0].options?.allowedTools).toEqual(
      expect.arrayContaining(['mcp__maestrly__review_plan', 'mcp__maestrly__ask_question'])
    )
    expect(manager.calls[0].options?.toolAliases).toMatchObject({
      ExitPlanMode: 'mcp__maestrly__review_plan',
      AskUserQuestion: 'mcp__maestrly__ask_question',
    })
    expect(manager.calls[0].options?.mcpServers).toEqual({
      maestrly: expect.objectContaining({ type: 'sdk', name: 'maestrly' }),
    })

    const planCall = listChatMessages(conversation.id)
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool' && part.toolCallId === 'tool-plan-1')
    expect(planCall).toMatchObject({
      type: 'tool',
      toolName: 'review_plan',
      state: {
        status: 'completed',
        output: expect.stringContaining('Plan submitted to the user for review.'),
      },
    })
    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    expect(assistant?.usage).toMatchObject({
      input: 120,
      output: 8,
      cachedInput: 40,
      cacheCreate: 10,
      contextInput: 420,
      modelContextWindow: 200_000,
      runtimeEstimatedCostUsd: 0.0123,
    })
    expect(getClaudeSessionBinding(conversation.id)).toMatchObject({
      sessionId: 'claude-session-1',
      modelId: 'sonnet',
      effort: 'high',
      fastMode: true,
      promptHash: expect.any(String),
      toolSignature: expect.any(String),
      lastMessageId: assistant?.id,
      lastAssistantUuid: 'sdk-assistant-uuid',
      accountFingerprint: identity.fingerprint,
      accountEpoch: identity.epoch,
    })
    expect(getClaudeMessageMapping(conversation.id, 'user-1')).toMatchObject({
      sdkUserUuid: 'sdk-user-uuid',
    })
    expect(getClaudeMessageMapping(conversation.id, assistant!.id)).toMatchObject({
      sdkAssistantUuid: 'sdk-assistant-uuid',
    })
    expect(manager.deleteManagedSession).not.toHaveBeenCalled()
    expect(manager.query?.close).toHaveBeenCalledOnce()
    expect(events.some((event) => event.kind === 'finish')).toBe(true)
  })

  it('keeps the Fable system/hash stable across environment changes and sends current state transiently', async () => {
    const workspace = makeWorkspace()
    const runWithGit = async (dirty: boolean) => {
      const conversation = makeConversation(workspace.id, { cwd: '/repo' })
      upsertChatMessage({
        id: `user-fable-${dirty}`,
        conversationId: conversation.id,
        role: 'user',
        parts: [{ type: 'text', id: `text-fable-${dirty}`, text: 'Make a plan.' }],
        createdAt: 1,
      })
      h.gitEnvInfo.mockResolvedValueOnce({ branch: 'main', dirty })
      const manager = new FakeManager()
      await runClaudeChat({
        conversationId: conversation.id,
        projectId: workspace.id,
        cwd: '/repo',
        selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
        behaviorProfile: FABLE_51_BEHAVIOR_PROFILE,
        mode: 'plan',
        permMode: 'ask',
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        broker: { assert: vi.fn(), on: vi.fn() } as never,
        questionBroker: { ask: vi.fn() } as never,
        emit: vi.fn(),
        signal: new AbortController().signal,
      })
      const structured = (
        await (
          manager.calls[0].prompt as AsyncIterable<{
            message: { content: Array<{ type: string; text?: string }> }
          }>
        )
          [Symbol.asyncIterator]()
          .next()
      ).value
      return {
        options: manager.calls[0].options ?? {},
        prompt: structured.message.content.map((part: { text?: string }) => part.text ?? '').join('\n'),
        binding: getClaudeSessionBinding(conversation.id),
      }
    }

    const clean = await runWithGit(false)
    const dirty = await runWithGit(true)
    expect(clean.options.systemPrompt).toBe(dirty.options.systemPrompt)
    expect(clean.binding?.promptHash).toBe(dirty.binding?.promptHash)
    expect(clean.options.systemPrompt).not.toContain('# Environment')
    expect(clean.prompt).toContain('# Current environment')
    expect(clean.prompt).toContain('Git branch: main (clean)')
    expect(dirty.prompt).toContain('Git branch: main (uncommitted changes)')
    expect(clean.options.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect((clean.options.hooks as Record<string, unknown[]>).PostToolUse).toHaveLength(1)
  })

  it('offers exactly the reviewer tools and waits for submit_review tool-result acknowledgement', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-reviewer-boundary',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-reviewer-boundary', text: 'Review the execution.' }],
      createdAt: 1,
    })
    const calls: Array<{ prompt: unknown; options?: Record<string, unknown> }> = []
    const queries: ReviewerQuery[] = []
    const manager = {
      accountId: null,
      assertAccountIdentity: vi.fn(),
      assertSubscriptionRuntimeAccount: vi.fn(),
      deleteManagedSession: vi.fn(async () => {}),
      createQuery: (input: { prompt: unknown; options?: Record<string, unknown> }) => {
        calls.push(input)
        const query = new ReviewerQuery(input.options ?? {})
        queries.push(query)
        return query
      },
    }
    const reviewerRuntime = {
      recordEvidence: vi.fn(),
      submitReview: vi.fn(() => ({ ok: true as const })),
      searchExecutionContext: vi.fn(async () => []),
      readExecutionContext: vi.fn(async () => []),
    }

    const outcome = await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'full',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: vi.fn(),
      signal: new AbortController().signal,
      ephemeralSession: true,
      reviewerRuntime,
    })

    expect(outcome).toEqual({ planSubmitted: true, sessionId: 'claude-reviewer-session' })
    expect(calls[0].options?.allowedTools).toEqual(
      [...REVIEWER_READONLY_TOOL_NAMES].sort().map((name) => `mcp__maestrly__${name}`)
    )
    expect(calls[0].options).toMatchObject({
      tools: [],
      skills: [],
      plugins: [],
      agents: {},
      permissionMode: 'dontAsk',
    })
    expect(h.buildMcpTools).not.toHaveBeenCalled()
    expect(h.buildAppTools).not.toHaveBeenCalled()
    expect(h.listAgents).not.toHaveBeenCalled()
    expect(h.stagePlan).not.toHaveBeenCalled()
    expect(reviewerRuntime.submitReview).toHaveBeenCalledWith({ result: 'clean', summary: 'No findings.' })
    expect(queries[0].interrupt).toHaveBeenCalledOnce()
  })

  // Non-Codex image generation uses an ephemeral Codex thread and therefore
  // offered with the toggle enabled AND the ChatGPT subscription connected.
  it('offers generate_image according to the toggle and ChatGPT connection', async () => {
    const { setAppFlag } = await import('../../src/main/store')
    const workspace = makeWorkspace()

    const runTurn = async (conversationId: string, userId: string, mode: 'agent' | 'design' = 'agent') => {
      upsertChatMessage({
        id: userId,
        conversationId,
        role: 'user',
        parts: [{ type: 'text', id: `${userId}-text`, text: 'Draw a robot.' }],
        createdAt: 1,
      })
      const manager = new FakeManager()
      await runClaudeChat({
        conversationId,
        projectId: workspace.id,
        cwd: '/repo',
        selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
        mode,
        permMode: 'ask',
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        broker: { assert: vi.fn(), on: vi.fn() } as never,
        questionBroker: { ask: vi.fn() } as never,
        emit: () => {},
        signal: new AbortController().signal,
        onSessionReady: () => true,
        canPersistSession: () => true,
      })
      return (manager.calls[0].options?.allowedTools ?? []) as string[]
    }

    // (a) Connected + default toggle (ON): Claude sees the tool.
    h.codexStatusSnapshot = { authenticated: true }
    const connected = makeConversation(workspace.id, { cwd: '/repo' })
    expect(await runTurn(connected.id, 'user-img-on')).toContain('mcp__maestrly__generate_image')
    const design = makeConversation(workspace.id, { cwd: '/repo' })
    expect(await runTurn(design.id, 'user-img-design', 'design')).toContain('mcp__maestrly__generate_image')

    // (b) Global toggle disabled: hidden even with the account connected.
    setAppFlag('chat.imageGen', false)
    const toggledOff = makeConversation(workspace.id, { cwd: '/repo' })
    expect(await runTurn(toggledOff.id, 'user-img-off')).not.toContain('mcp__maestrly__generate_image')
    setAppFlag('chat.imageGen', true)

    // Without a connected ChatGPT subscription, the tool is unavailable.
    h.codexStatusSnapshot = { authenticated: false }
    const disconnected = makeConversation(workspace.id, { cwd: '/repo' })
    expect(await runTurn(disconnected.id, 'user-img-noauth')).not.toContain('mcp__maestrly__generate_image')
  })

  it('treats the acknowledged review_plan interrupt diagnostic as a successful measured turn', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-plan-interrupt',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-plan-interrupt', text: 'Make a test plan.' }],
      createdAt: 1,
    })
    const manager = new FakeManager()
    manager.interruptErrorMessage = intentionalPlanInterruptDiagnostic
    const events: Array<{ kind: string; [key: string]: unknown }> = []
    const onModelContextWindow = vi.fn()

    const outcome = await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'plan',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (event) => events.push(event as (typeof events)[number]),
      signal: new AbortController().signal,
      onModelContextWindow,
    })

    expect(outcome).toEqual({ planSubmitted: true, sessionId: 'claude-session-1' })
    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    expect(assistant?.error).toBeUndefined()
    expect(assistant?.usage).toMatchObject({
      usageVersion: 2,
      input: 100,
      output: 4,
      cachedInput: 20,
      cacheCreate: 0,
      contextInput: 420,
      modelContextWindow: 200_000,
    })
    expect(events.some((event) => event.kind === 'error')).toBe(false)
    expect(events.some((event) => event.kind === 'finish')).toBe(true)
    expect(onModelContextWindow).toHaveBeenCalledWith(200_000)
    expect(manager.query?.lifecycle).toEqual(['context', 'interrupt'])
    expect(getClaudeSessionBinding(conversation.id)).toMatchObject({
      sessionId: 'claude-session-1',
      lastMessageId: assistant?.id,
      lastAssistantUuid: 'sdk-assistant-uuid',
      context: {
        totalTokens: 420,
        maxTokens: 200_000,
      },
    })
    expect(manager.deleteManagedSession).not.toHaveBeenCalled()
  })

  it('reports unexpected post-plan errors and retires a resumed session binding', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    const manager = new FakeManager()
    manager.sessionIds = ['claude-session-1', 'claude-session-1']
    const run = (signal: AbortSignal, events: Array<{ kind: string; [key: string]: unknown }>) =>
      runClaudeChat({
        conversationId: conversation.id,
        projectId: workspace.id,
        cwd: '/repo',
        selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
        mode: 'plan',
        permMode: 'ask',
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        broker: { assert: vi.fn(), on: vi.fn() } as never,
        questionBroker: { ask: vi.fn() } as never,
        emit: (event) => events.push(event as (typeof events)[number]),
        signal,
      })
    const addUser = (id: string, text: string) =>
      upsertChatMessage({
        id,
        conversationId: conversation.id,
        role: 'user',
        parts: [{ type: 'text', id: `${id}-text`, text }],
        createdAt: Date.now(),
      })

    addUser('user-plan-ok', 'Make the first plan.')
    await run(new AbortController().signal, [])
    const firstAssistant = listChatMessages(conversation.id).at(-1)!
    expect(getClaudeSessionBinding(conversation.id)).toMatchObject({
      sessionId: 'claude-session-1',
      lastMessageId: firstAssistant.id,
    })

    addUser('user-plan-error', 'Revise the plan.')
    manager.interruptErrorMessage = 'Claude transport failed after the plan result.'
    const events: Array<{ kind: string; [key: string]: unknown }> = []
    const outcome = await run(new AbortController().signal, events)

    expect(outcome).toEqual({ planSubmitted: true, sessionId: 'claude-session-1' })
    expect(manager.calls[1].options).toMatchObject({ resume: 'claude-session-1' })
    expect(events.some((event) => event.kind === 'finish')).toBe(false)
    expect(events.some((event) => event.kind === 'error')).toBe(true)
    expect(listChatMessages(conversation.id).at(-1)?.error).toContain('Claude transport failed after the plan result.')
    expect(getClaudeSessionBinding(conversation.id)).toBeNull()
    expect(manager.deleteManagedSession).toHaveBeenCalledWith('claude-session-1', '/repo')
  })

  it('does not hide an SDK result error mixed with the plan interrupt diagnostic', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-plan-mixed-error',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-plan-mixed-error', text: 'Make a test plan.' }],
      createdAt: 1,
    })
    const manager = new FakeManager()
    manager.resultErrors = [
      '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null',
      'Claude transport failed while persisting the turn.',
    ]
    const events: Array<{ kind: string; [key: string]: unknown }> = []

    const outcome = await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'plan',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (event) => events.push(event as (typeof events)[number]),
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ planSubmitted: true, sessionId: 'claude-session-1' })
    expect(events.some((event) => event.kind === 'finish')).toBe(false)
    expect(events.some((event) => event.kind === 'error')).toBe(true)
    expect(listChatMessages(conversation.id).at(-1)?.error).toContain(
      'Claude transport failed while persisting the turn.'
    )
    expect(getClaudeSessionBinding(conversation.id)).toBeNull()
    expect(manager.deleteManagedSession).toHaveBeenCalledWith('claude-session-1', '/repo')
  })

  it('persists the Maestrly-managed subagent profile, effort, duration and token buckets', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-managed-task',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-managed-task', text: 'Delegate this task.' }],
      createdAt: 1,
    })
    const definition = {
      name: 'general-purpose',
      description: 'General worker',
      prompt: 'Complete the delegated task.',
      source: 'built-in',
    }
    const profile = {
      version: 1 as const,
      agentName: 'general-purpose',
      effective: {
        providerId: 'builtin_claude_subscription',
        modelId: 'opus[1m]',
        configuredEffort: 'xhigh',
        sentEffort: 'xhigh',
        source: 'conversation-default' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    h.listAgents.mockResolvedValue([definition])
    h.resolveSubagentExecutionProfile.mockResolvedValue({ definition, profile })
    h.runClaudeSubagent.mockImplementation(async (args: { progress?: (line: string) => void }) => {
      args.progress?.('Reading project files')
      return {
        text: 'Managed subagent result.',
        model: { providerId: 'builtin_claude_subscription', modelId: 'opus[1m]' },
        usage: { input: 10, output: 30, cacheRead: 120, cacheCreate: 40, totalInput: 170 },
        runtimeEstimatedCostUsd: 0.0042,
      }
    })
    const manager = new ManagedTaskManager()
    const events: Array<{ kind: string; [key: string]: unknown }> = []

    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (event) => events.push(event as (typeof events)[number]),
      signal: new AbortController().signal,
    })

    expect(h.resolveSubagentExecutionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'general-purpose',
        conversationId: conversation.id,
        parent: expect.objectContaining({
          providerId: 'builtin_claude_subscription',
          modelId: 'sonnet',
        }),
      })
    )
    expect(h.runClaudeSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        agentName: 'general-purpose',
        task: 'Inspect the project.',
      })
    )
    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    const taskPart = assistant?.parts.find((part) => part.type === 'tool' && part.toolCallId === 'tool-task-1')
    expect(taskPart).toMatchObject({
      type: 'tool',
      toolName: 'task',
      state: {
        status: 'completed',
        output: 'Managed subagent result.',
        sub: {
          profile,
          usage: {
            input: 10,
            output: 30,
            cacheRead: 120,
            cacheCreate: 40,
          },
          runtimeEstimatedCostUsd: 0.0042,
          durationMs: expect.any(Number),
        },
      },
    })
    expect(assistant?.usage).toMatchObject({
      subInput: 10,
      subOutput: 30,
      subCachedInput: 120,
      subCacheCreate: 40,
      subagentUsage: [
        {
          providerId: 'builtin_claude_subscription',
          modelId: 'opus[1m]',
          input: 10,
          output: 30,
          cachedInput: 120,
          cacheCreate: 40,
          runtimeEstimatedCostUsd: 0.0042,
        },
      ],
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool-state',
        toolCallId: 'tool-task-1',
        state: expect.objectContaining({
          status: 'running',
          output: 'Reading project files',
          sub: expect.objectContaining({ profile }),
        }),
      })
    )
  })

  it('runs virtual #testing tasks with the logical testing identity', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    // Structured selection turns the composer chip into an agent-mention part; plain text
    // typed text does NOT feed the guard (covered by turn-request unit tests).
    upsertChatMessage({
      id: 'user-virtual-task',
      conversationId: conversation.id,
      role: 'user',
      parts: [
        { type: 'text', id: 'text-virtual-task', text: 'run a simple validation.' },
        { type: 'agent-mention', id: 'mention-virtual-task', name: 'testing', start: 0, end: 8 },
      ],
      createdAt: 1,
    })
    const definition = {
      name: 'testing',
      description: 'Custom virtual agent based on general-purpose with a dedicated host-managed profile.',
      prompt: 'Complete the delegated task.',
      source: 'virtual-profile',
      virtual: true,
      baseAgentName: 'general-purpose',
    }
    const profile = {
      version: 1 as const,
      agentName: 'testing',
      effective: {
        providerId: 'builtin_claude_subscription',
        modelId: 'opus[1m]',
        configuredEffort: 'xhigh',
        sentEffort: 'xhigh',
        source: 'conversation-agent' as const,
        ruleKey: 'testing',
        candidateIndex: 0,
      },
      attempts: [],
    }
    h.listAgents.mockResolvedValue([definition])
    h.resolveSubagentExecutionProfile.mockResolvedValue({ definition, profile })
    h.runClaudeSubagent.mockImplementation(async (args: { progress?: (line: string) => void }) => {
      args.progress?.('Validando')
      return {
        text: 'Validation complete.',
        model: { providerId: 'builtin_claude_subscription', modelId: 'opus[1m]' },
        usage: { input: 8, output: 20, cacheRead: 90, cacheCreate: 30, totalInput: 98 },
      }
    })
    const manager = new ManagedTaskManager(false, 'testing', 'Valide o fluxo.')
    const events: Array<{ kind: string; [key: string]: unknown }> = []

    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (event) => events.push(event as (typeof events)[number]),
      signal: new AbortController().signal,
    })

    // The structured mention feeds the guard; agent=testing resolves the
    // profile by its LOGICAL name (the alias), never general-purpose.
    expect(h.resolveSubagentExecutionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'testing',
        conversationId: conversation.id,
        parent: expect.objectContaining({ providerId: 'builtin_claude_subscription', modelId: 'sonnet' }),
      })
    )
    expect(h.runClaudeSubagent).toHaveBeenCalledWith(
      expect.objectContaining({ profile, agentName: 'testing', task: 'Valide o fluxo.' })
    )
    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    const taskPart = assistant?.parts.find((part) => part.type === 'tool' && part.toolCallId === 'tool-task-1')
    expect(taskPart).toMatchObject({
      type: 'tool',
      toolName: 'task',
      state: {
        status: 'completed',
        output: 'Validation complete.',
        sub: { profile, usage: { input: 8, output: 20, cacheRead: 90, cacheCreate: 30 } },
      },
    })
    expect(assistant?.usage).toMatchObject({
      subagentUsage: [expect.objectContaining({ providerId: 'builtin_claude_subscription', modelId: 'opus[1m]' })],
    })
  })

  it('dispatches a Claude parent task to the configured Codex Fast model without exposing recursive task tools', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-claude-to-codex',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-claude-to-codex', text: 'Delegate to Codex.' }],
      createdAt: 1,
    })
    const definition = {
      name: 'general-purpose',
      description: 'General worker',
      prompt: 'Complete the delegated task.',
      source: 'built-in',
      tools: ['read', 'grep', 'task'],
    }
    const profile = {
      version: 1 as const,
      agentName: 'general-purpose',
      effective: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-luna',
        configuredEffort: 'medium',
        sentEffort: 'medium',
        fastMode: true,
        source: 'conversation-default' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    h.listAgents.mockResolvedValue([definition])
    h.resolveSubagentExecutionProfile.mockResolvedValue({ definition, profile })
    h.runCodexSubagent.mockImplementation(async (args: { progress?: (line: string) => void }) => {
      args.progress?.('Reading with Codex')
      return {
        text: 'Codex worker result.',
        model: { providerId: 'builtin_codex_subscription', modelId: 'gpt-5.6-luna' },
        usage: { input: 20, output: 12, cacheRead: 80, cacheCreate: 0, totalInput: 100 },
      }
    })
    const manager = new ManagedTaskManager()

    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: vi.fn(),
      signal: new AbortController().signal,
    })

    expect(h.runCodexSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        agentName: 'general-purpose',
        task: 'Inspect the project.',
        readOnly: true,
        serviceTier: 'priority',
      })
    )
    expect(h.codexPreferredServiceTier).toHaveBeenCalledWith('gpt-5.6-luna')
    const codexDynamicTools = (h.runCodexSubagent.mock.calls[0][0] as { dynamicTools: Array<{ name: string }> })
      .dynamicTools
    expect(codexDynamicTools.map((tool) => tool.name)).not.toContain('task')
    expect(codexDynamicTools.map((tool) => tool.name)).not.toContain('review_plan')
    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    expect(assistant?.parts.find((part) => part.type === 'tool' && part.toolCallId === 'tool-task-1')).toMatchObject({
      state: {
        status: 'completed',
        output: 'Codex worker result.',
        sub: {
          profile,
          usage: { input: 20, output: 12, cacheRead: 80, cacheCreate: 0 },
          durationMs: expect.any(Number),
        },
      },
    })
    expect(assistant?.usage).toMatchObject({
      subagentUsage: [
        {
          providerId: 'builtin_codex_subscription',
          modelId: 'gpt-5.6-luna',
          input: 20,
          output: 12,
          cachedInput: 80,
          cacheCreate: 0,
        },
      ],
    })
  })

  it('blocks general-purpose when the user requests an available specialist', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-explicit-claude',
      conversationId: conversation.id,
      role: 'user',
      parts: [
        {
          type: 'text',
          id: 'text-explicit-claude',
          text: 'Use o api-integration-engineer para analisar esta integração.',
        },
      ],
      createdAt: 1,
    })
    h.listAgents.mockResolvedValue([
      {
        name: 'api-integration-engineer',
        description: 'Integrates third-party APIs.',
        prompt: 'You are the API integration specialist.',
        source: '.claude/agents/api-integration-engineer.md',
        tools: ['read', 'bash', 'write', 'edit'],
      },
      {
        name: 'general-purpose',
        description: 'General worker',
        prompt: 'Complete the delegated task.',
        source: 'built-in',
        tools: ['read', 'grep'],
      },
    ])
    const manager = new ManagedTaskManager()

    // The SDK fixture calls task(general-purpose): the guard rejects before resolving the profile.
    const emitted: ChatStreamEvent[] = []
    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (streamEvent) => emitted.push(streamEvent),
      signal: new AbortController().signal,
    })
    expect(emitted.find((streamEvent) => streamEvent.kind === 'error')).toMatchObject({
      message: expect.stringContaining('explicitly requested the available subagent'),
    })
    expect(h.resolveSubagentExecutionProfile).not.toHaveBeenCalled()
  })

  it('allows explore while the requested specialist awaits dispatch', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-multi-claude',
      conversationId: conversation.id,
      role: 'user',
      parts: [
        {
          type: 'text',
          id: 'text-multi-claude',
          text: 'Use o api-integration-engineer para implementar. Antes, use explore para mapear os pontos.',
        },
      ],
      createdAt: 1,
    })
    h.listAgents.mockResolvedValue([
      {
        name: 'api-integration-engineer',
        description: 'Integrates third-party APIs.',
        prompt: 'You are the API integration specialist.',
        source: '.claude/agents/api-integration-engineer.md',
        tools: ['read', 'bash', 'write', 'edit'],
      },
      {
        name: 'explore',
        description: 'Read-only search agent.',
        prompt: 'Explore.',
        source: 'built-in',
      },
      {
        name: 'general-purpose',
        description: 'General worker',
        prompt: 'Complete the delegated task.',
        source: 'built-in',
        tools: ['read', 'grep'],
      },
    ])
    const exploreProfile = {
      version: 1 as const,
      agentName: 'explore',
      effective: {
        providerId: 'builtin_claude_subscription',
        modelId: 'sonnet',
        configuredEffort: 'low',
        sentEffort: 'low',
        source: 'parent' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    h.resolveSubagentExecutionProfile.mockResolvedValue({
      definition: { name: 'explore', description: 'Read-only search agent.', prompt: 'Explore.', source: 'built-in' },
      profile: exploreProfile,
    })
    h.runClaudeSubagent.mockImplementation(async (args: { progress?: (line: string) => void }) => {
      args.progress?.('Mapping')
      return {
        text: 'integration point map',
        model: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
        usage: { input: 5, output: 2, cacheRead: 1, cacheCreate: 0, totalInput: 7 },
      }
    })
    // The SDK fixture calls task(explore): an allowed helper even with a pending specialist.
    const manager = new ManagedTaskManager(false, 'explore', 'Map the integration points.')
    const emitted: ChatStreamEvent[] = []
    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (streamEvent) => emitted.push(streamEvent),
      signal: new AbortController().signal,
    })
    expect(h.resolveSubagentExecutionProfile).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'explore' }))
    const toolPart = listChatMessages(conversation.id)
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool' && part.toolCallId === 'tool-task-1')
    expect(toolPart).toMatchObject({
      state: { status: 'completed', output: 'integration point map', sub: { profile: exploreProfile } },
    })
  })

  it('does not let a late Claude tool summary erase completed subagent metadata', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-late-task-summary',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-late-task-summary', text: 'Delegate and summarize.' }],
      createdAt: 1,
    })
    const definition = {
      name: 'general-purpose',
      description: 'General worker',
      prompt: 'Complete the delegated task.',
      source: 'built-in',
      tools: ['read', 'grep'],
    }
    const profile = {
      version: 1 as const,
      agentName: 'general-purpose',
      effective: {
        providerId: 'builtin_claude_subscription',
        modelId: 'opus[1m]',
        configuredEffort: 'xhigh',
        sentEffort: 'xhigh',
        source: 'conversation-default' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    h.listAgents.mockResolvedValue([definition])
    h.resolveSubagentExecutionProfile.mockResolvedValue({ definition, profile })
    h.runClaudeSubagent.mockResolvedValue({
      text: 'Managed subagent result.',
      model: { providerId: 'builtin_claude_subscription', modelId: 'opus[1m]' },
      usage: { input: 10, output: 30, cacheRead: 120, cacheCreate: 40, totalInput: 170 },
    })

    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: new ManagedTaskManager(true) as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: vi.fn(),
      signal: new AbortController().signal,
    })

    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    expect(assistant?.parts.find((part) => part.type === 'tool' && part.toolCallId === 'tool-task-1')).toMatchObject({
      state: {
        status: 'completed',
        output: 'Managed subagent result.',
        sub: {
          profile,
          usage: { input: 10, output: 30, cacheRead: 120, cacheCreate: 40 },
          durationMs: expect.any(Number),
        },
      },
    })
  })

  it.each([
    { terminal: 'error' as const, abort: false },
    { terminal: 'abort' as const, abort: true },
  ])('preserves final subagent metadata and usage after a worker $terminal', async ({ abort }) => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: `user-task-${abort ? 'abort' : 'error'}`,
      conversationId: conversation.id,
      role: 'user',
      parts: [
        {
          type: 'text',
          id: `text-task-${abort ? 'abort' : 'error'}`,
          text: 'Delegate a failing task.',
        },
      ],
      createdAt: 1,
    })
    const definition = {
      name: 'general-purpose',
      description: 'General worker',
      prompt: 'Complete the delegated task.',
      source: 'built-in',
      tools: ['read', 'grep'],
    }
    const profile = {
      version: 1 as const,
      agentName: 'general-purpose',
      effective: {
        providerId: 'builtin_claude_subscription',
        modelId: 'opus[1m]',
        configuredEffort: 'xhigh',
        sentEffort: 'xhigh',
        source: 'conversation-default' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    const controller = new AbortController()
    const failure = Object.assign(new Error('Worker transport failed.'), {
      subagentModel: {
        providerId: 'builtin_claude_subscription',
        modelId: 'opus[1m]',
      },
      subagentUsage: {
        input: 15,
        output: 9,
        cacheRead: 60,
        cacheCreate: 5,
        totalInput: 80,
      },
      subagentRuntimeEstimatedCostUsd: 0.003,
    })
    h.listAgents.mockResolvedValue([definition])
    h.resolveSubagentExecutionProfile.mockResolvedValue({ definition, profile })
    h.runClaudeSubagent.mockImplementation(async () => {
      if (abort) controller.abort()
      throw failure
    })

    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'agent',
      permMode: 'ask',
      manager: new ManagedTaskManager() as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: vi.fn(),
      signal: controller.signal,
    })

    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    expect(assistant?.parts.find((part) => part.type === 'tool' && part.toolCallId === 'tool-task-1')).toMatchObject({
      state: {
        status: 'error',
        sub: {
          profile,
          usage: { input: 15, output: 9, cacheRead: 60, cacheCreate: 5 },
          runtimeEstimatedCostUsd: 0.003,
          durationMs: expect.any(Number),
        },
      },
    })
    expect(assistant?.usage).toMatchObject({
      subInput: 15,
      subOutput: 9,
      subCachedInput: 60,
      subCacheCreate: 5,
      subagentUsage: [
        {
          providerId: 'builtin_claude_subscription',
          modelId: 'opus[1m]',
          input: 15,
          output: 9,
          cachedInput: 60,
          cacheCreate: 5,
          runtimeEstimatedCostUsd: 0.003,
        },
      ],
    })
  })

  it('folds partial envelopes by API message id without duplicate text or chunk-split markdown', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-stream',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-stream', text: 'Hello' }],
      createdAt: 1,
    })
    const manager = new StreamingTextManager()
    const events: Array<{ kind: string; [key: string]: unknown }> = []

    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'ask',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (event) => events.push(event as (typeof events)[number]),
      signal: new AbortController().signal,
    })

    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    expect(assistant?.parts).toHaveLength(3)
    expect(assistant?.parts[0]).toEqual({
      type: 'reasoning',
      id: `claude_reasoning_${streamedApiMessageId}:0`,
      text: streamedReasoning,
    })
    expect(assistant?.parts[1]).toEqual({
      type: 'text',
      id: `claude_text_${streamedApiMessageId}:1`,
      text: streamedText,
    })
    expect(assistant?.parts[2]).toMatchObject({
      type: 'tool',
      id: 'streamed-tool-use',
      toolCallId: 'streamed-tool-use',
      toolName: 'read',
      input: { path: '/repo/README.md' },
      state: { status: 'completed', output: 'README contents' },
    })
    expect(events.filter((event) => event.kind === 'text-start')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'text-delta')).toEqual([
      expect.objectContaining({ delta: streamedText }),
    ])
    expect(events.filter((event) => event.kind === 'reasoning-start')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'reasoning-delta')).toEqual([
      expect.objectContaining({ delta: streamedReasoning }),
    ])
    expect(events.filter((event) => event.kind === 'tool-input-start')).toHaveLength(1)
    expect(getClaudeSessionBinding(conversation.id)).toMatchObject({
      sessionId: 'claude-stream-session',
      lastAssistantUuid: 'final-tool-envelope',
    })
  })

  it('emits and persists one structured authentication error without duplicated assistant text', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-oauth-error',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-oauth-error', text: 'Continue.' }],
      createdAt: 1,
    })
    const manager = new AuthenticationErrorManager()
    const events: Array<{ kind: string; [key: string]: unknown }> = []

    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'ask',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (event) => events.push(event as (typeof events)[number]),
      signal: new AbortController().signal,
    })

    const errors = events.filter((event) => event.kind === 'error')
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'claude-authentication-required',
        removeAssistantText: true,
      }),
    ])
    expect(manager.requireAuthentication).toHaveBeenCalledOnce()
    expect(listChatMessages(conversation.id).at(-1)).toMatchObject({
      errorCode: 'claude-authentication-required',
      parts: [],
    })
  })

  it('validates the admitted identity before committing a terminal event', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-identity-boundary',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-identity-boundary', text: 'Continue.' }],
      createdAt: 1,
    })
    const manager = new StreamingTextManager()
    manager.assertAccountIdentity.mockImplementationOnce(() => undefined)
    manager.assertAccountIdentity.mockImplementationOnce(() => undefined)
    manager.assertAccountIdentity.mockImplementation(() => {
      throw new Error('Claude account changed at the terminal boundary.')
    })
    const events: Array<{ kind: string; [key: string]: unknown }> = []

    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'ask',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (event) => events.push(event as (typeof events)[number]),
      signal: new AbortController().signal,
    })

    expect(events.filter((event) => event.kind === 'finish')).toEqual([])
    expect(events.filter((event) => event.kind === 'error')).toHaveLength(1)
    expect(listChatMessages(conversation.id).at(-1)?.error).toContain('terminal boundary')
  })

  it('uses resume for the tip and resumeSessionAt+fork after edit/resend rewinds history', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    const manager = new FakeManager()
    manager.sessionIds = ['claude-session-1', 'claude-session-1', 'claude-session-2', 'claude-session-3']
    const run = () =>
      runClaudeChat({
        conversationId: conversation.id,
        projectId: workspace.id,
        cwd: '/repo',
        selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
        mode: 'plan',
        permMode: 'ask',
        reasoningEffort: 'high',
        fastMode: true,
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        broker: { assert: vi.fn(), on: vi.fn() } as never,
        questionBroker: { ask: vi.fn() } as never,
        emit: vi.fn(),
        signal: new AbortController().signal,
      })
    const addUser = (id: string, text: string) =>
      upsertChatMessage({
        id,
        conversationId: conversation.id,
        role: 'user',
        parts: [{ type: 'text', id: `${id}-text`, text }],
        createdAt: Date.now(),
      })

    addUser('user-first', 'First plan.')
    await run()
    const firstAssistant = listChatMessages(conversation.id).at(-1)!

    addUser('user-second', 'Continue.')
    await run()
    expect(manager.calls[1].options).toMatchObject({ resume: 'claude-session-1' })
    expect(manager.calls[1].options).not.toHaveProperty('resumeSessionAt')

    const secondSeq = getMessageSeq('user-second')
    expect(secondSeq).not.toBeNull()
    deleteChatMessagesFrom(conversation.id, secondSeq!)
    addUser('user-second-edited', 'Continue with an edited request.')
    await run()

    expect(manager.calls[2].options).toMatchObject({
      resume: 'claude-session-1',
      resumeSessionAt: 'sdk-assistant-uuid',
      forkSession: true,
    })
    expect(getClaudeMessageMapping(conversation.id, firstAssistant.id)).toMatchObject({
      sessionId: 'claude-session-2',
      sdkAssistantUuid: 'sdk-assistant-uuid',
    })

    const editedSeq = getMessageSeq('user-second-edited')
    expect(editedSeq).not.toBeNull()
    deleteChatMessagesFrom(conversation.id, editedSeq!)
    addUser('user-second-edited-again', 'Continue with another edited request.')
    await run()

    expect(manager.calls[3].options).toMatchObject({
      resume: 'claude-session-2',
      resumeSessionAt: 'sdk-assistant-uuid',
      forkSession: true,
    })
    expect(getClaudeMessageMapping(conversation.id, firstAssistant.id)).toMatchObject({
      sessionId: 'claude-session-3',
      sdkAssistantUuid: 'sdk-assistant-uuid',
    })
  })

  it('resumes Fable with a stable system while appending the latest environment observation', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    const manager = new FakeManager()
    const run = () =>
      runClaudeChat({
        conversationId: conversation.id,
        projectId: workspace.id,
        cwd: '/repo',
        selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
        behaviorProfile: FABLE_51_BEHAVIOR_PROFILE,
        mode: 'plan',
        permMode: 'ask',
        manager: manager as unknown as ClaudeSubscriptionManager,
        accountIdentity: identity,
        broker: { assert: vi.fn(), on: vi.fn() } as never,
        questionBroker: { ask: vi.fn() } as never,
        emit: vi.fn(),
        signal: new AbortController().signal,
      })
    const addUser = (id: string) =>
      upsertChatMessage({
        id,
        conversationId: conversation.id,
        role: 'user',
        parts: [{ type: 'text', id: `${id}-text`, text: 'Continue.' }],
        createdAt: Date.now(),
      })

    h.gitEnvInfo.mockResolvedValueOnce({ branch: 'main', dirty: false })
    addUser('user-fable-resume-1')
    await run()
    h.gitEnvInfo.mockResolvedValueOnce({ branch: 'main', dirty: true })
    addUser('user-fable-resume-2')
    await run()

    expect(manager.calls[1].options).toMatchObject({ resume: 'claude-session-1' })
    expect(manager.calls[1].options?.systemPrompt).toBe(manager.calls[0].options?.systemPrompt)
    const second = (
      await (
        manager.calls[1].prompt as AsyncIterable<{
          message: { content: Array<{ type: string; text?: string }> }
        }>
      )
        [Symbol.asyncIterator]()
        .next()
    ).value
    const secondText = second.message.content.map((part: { text?: string }) => part.text ?? '').join('\n')
    expect(secondText).toContain('# Current environment')
    expect(secondText).toContain('Git branch: main (uncommitted changes)')
  })

  it('discards a plan session when the matching tool result is never acknowledged', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-orphan',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-orphan', text: 'Make a plan.' }],
      createdAt: 1,
    })
    const manager = new FakeManager()
    manager.emitToolResult = false
    const events: Array<{ kind: string; [key: string]: unknown }> = []

    const outcome = await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'plan',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: (event) => events.push(event as (typeof events)[number]),
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ planSubmitted: false, sessionId: 'claude-session-1' })
    expect(getClaudeSessionBinding(conversation.id)).toBeNull()
    expect(manager.deleteManagedSession).toHaveBeenCalledWith('claude-session-1', '/repo')
    const planCall = listChatMessages(conversation.id)
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool' && part.toolCallId === 'tool-plan-1')
    expect(planCall).toMatchObject({
      type: 'tool',
      state: {
        status: 'error',
        error: expect.stringContaining('did not acknowledge'),
      },
    })
    expect(events.some((event) => event.kind === 'error')).toBe(true)
  })

  it('preserves disjoint cache buckets and usage for provider-native compaction', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-before-compact',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-before-compact', text: 'Make a plan.' }],
      createdAt: 1,
    })
    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'plan',
      permMode: 'ask',
      reasoningEffort: 'high',
      fastMode: true,
      manager: new FakeManager() as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: vi.fn(),
      signal: new AbortController().signal,
    })
    const manager = new CompactManager()

    const result = await compactClaudeSession({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'plan',
      permMode: 'ask',
      reasoningEffort: 'high',
      fastMode: true,
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      success: true,
      tokensRemoved: 320,
      usage: {
        input: 120,
        output: 8,
        cacheRead: 40,
        cacheCreate: 10,
        totalInput: 170,
        runtimeEstimatedCostUsd: 0.0123,
      },
    })
    expect(manager.calls[0]).toMatchObject({
      prompt: '/compact',
      options: {
        resume: 'claude-session-1',
        settingSources: [],
        strictMcpConfig: true,
        allowedTools: [],
      },
    })
    expect(manager.query.getContextUsage).toHaveBeenCalledOnce()
    expect(manager.query.close).toHaveBeenCalledOnce()
  })

  it('continues provider-native compaction when live context usage times out', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'user-before-compact-timeout',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-before-compact-timeout', text: 'Make a plan.' }],
      createdAt: 1,
    })
    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'plan',
      permMode: 'ask',
      manager: new FakeManager() as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: vi.fn(),
      signal: new AbortController().signal,
    })
    const manager = new CompactManager(true)

    const result = await compactClaudeSession({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'plan',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      success: true,
      context: {
        totalTokens: 178,
        maxTokens: 200_000,
      },
    })
    expect(manager.query.getContextUsage).toHaveBeenCalledOnce()
    expect(manager.query.close).toHaveBeenCalledOnce()
  })

  it('persists ephemeral messages and cleans sessions without changing the main binding', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    putClaudeSessionBinding({
      conversationId: conversation.id,
      sessionId: 'claude-main',
      modelId: 'sonnet',
      effort: 'high',
      fastMode: false,
      cwd: '/repo',
      harnessProfile: 'maestrly-claude-v1',
      promptHash: 'main-prompt',
      toolSignature: 'main-tools',
      lastMessageId: 'main-assistant',
      lastAssistantUuid: 'sdk-main',
      accountFingerprint: identity.fingerprint ?? 'sha256:claude-account',
      accountEpoch: identity.epoch,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        turns: 1,
        durationMs: 0,
        durationApiMs: 0,
      },
      context: null,
    })
    const mainBefore = structuredClone(getClaudeSessionBinding(conversation.id))
    const executionId = 'exec-claude-1'
    const messageMeta = {
      source: 'chatgpt-web-review-loop' as const,
      internal: true as const,
      executionScope: {
        kind: 'review-loop' as const,
        executionId,
        loopId: 'loop-1',
        iteration: 1,
        maxIterations: 3,
      },
    }
    upsertChatMessage({
      id: 'iso-user-claude',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'iso-user-claude-text', text: 'revise isolated' }],
      createdAt: 1,
      ...messageMeta,
    })
    const manager = new StreamingTextManager()
    await runClaudeChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: '/repo',
      selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
      mode: 'ask',
      permMode: 'ask',
      manager: manager as unknown as ClaudeSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(), on: vi.fn() } as never,
      questionBroker: { ask: vi.fn() } as never,
      emit: () => undefined,
      signal: new AbortController().signal,
      ephemeralSession: true,
      messageMeta,
    })

    expect(getClaudeSessionBinding(conversation.id)).toEqual(mainBefore)
    expect(manager.deleteManagedSession).toHaveBeenCalledWith('claude-stream-session', '/repo')
    const assistants = listChatMessages(conversation.id).filter(
      (m) => m.role === 'assistant' && m.executionScope?.kind === 'review-loop'
    )
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.parts.some((p) => p.type === 'text' && p.text.includes('Hello!'))).toBe(true)
    expect(assistants[0]?.usage).toMatchObject({ input: expect.any(Number), output: expect.any(Number) })
  })
})
