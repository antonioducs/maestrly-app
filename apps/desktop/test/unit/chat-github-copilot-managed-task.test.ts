import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotSession, SessionEvent, ToolInvocation } from '@github/copilot-sdk'
import type { ChatMessage, ChatStreamEvent } from '../../src/shared/chat'
import { listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import { resolveSubagentExecutionProfile } from '../../src/main/chat/subagent-execution-profile'
import { runSubagent } from '../../src/main/chat/subagent-runner'
import { runCodexSubagent } from '../../src/main/chat/codex-subscription/subagent-runner'
import { getCodexSubscriptionManager } from '../../src/main/chat/codex-subscription/manager'
import { runClaudeSubagent } from '../../src/main/chat/claude-agent-sdk/subagent-runner'
import { getClaudeSubscriptionManager } from '../../src/main/chat/claude-agent-sdk/manager'
import { registerCodexSubagentRequestRoute, toolSetRuntimes } from '../../src/main/chat/codex-subscription/runner'
import { runGitHubCopilotSubagent } from '../../src/main/chat/github-copilot/subagent-runner'
import type {
  GitHubCopilotAccountIdentity,
  GitHubCopilotCreateSessionConfig,
  GitHubCopilotSubscriptionManager,
} from '../../src/main/chat/github-copilot/manager'
import { runGitHubCopilotChat } from '../../src/main/chat/github-copilot/runner'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

vi.mock('../../src/main/chat/subagent-execution-profile', () => ({
  resolveSubagentExecutionProfile: vi.fn(),
}))
vi.mock('../../src/main/chat/subagent-runner', () => ({
  runSubagent: vi.fn(),
  namespaceSubagentToolSet: (tools: Record<string, unknown>) => tools,
}))
vi.mock('../../src/main/chat/codex-subscription/subagent-runner', () => ({
  runCodexSubagent: vi.fn(),
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: vi.fn(),
}))
vi.mock('../../src/main/chat/claude-agent-sdk/subagent-runner', () => ({
  runClaudeSubagent: vi.fn(),
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  getClaudeSubscriptionManager: vi.fn(),
}))
vi.mock('../../src/main/chat/codex-subscription/runner', () => ({
  approvalConfig: vi.fn(() => ({ sandbox: 'read-only', approvalPolicy: 'untrusted' })),
  sandboxPolicyFor: vi.fn(() => ({ type: 'readOnly', networkAccess: false })),
  toolSetRuntimes: vi.fn(async () => []),
  registerCodexSubagentRequestRoute: vi.fn(() => ({
    addThread: vi.fn(),
    removeThread: vi.fn(),
    remove: vi.fn(),
  })),
}))
vi.mock('../../src/main/chat/github-copilot/subagent-runner', () => ({
  runGitHubCopilotSubagent: vi.fn(),
}))

const resolveProfileMock = vi.mocked(resolveSubagentExecutionProfile)
const runByokMock = vi.mocked(runSubagent)
const runCodexMock = vi.mocked(runCodexSubagent)
const runClaudeMock = vi.mocked(runClaudeSubagent)
const runCopilotMock = vi.mocked(runGitHubCopilotSubagent)
const getCodexManagerMock = vi.mocked(getCodexSubscriptionManager)
const getClaudeManagerMock = vi.mocked(getClaudeSubscriptionManager)
const toolSetRuntimesMock = vi.mocked(toolSetRuntimes)
const registerCodexRouteMock = vi.mocked(registerCodexSubagentRequestRoute)

const identity: GitHubCopilotAccountIdentity = { fingerprint: 'sha256:parent-account', epoch: 1 }

function event(type: SessionEvent['type'], data: Record<string, unknown>): SessionEvent {
  return { type, data } as unknown as SessionEvent
}

class FakeSession {
  readonly abort = vi.fn(async () => {})

  constructor(
    readonly sessionId: string,
    private readonly invokeTask: () => Promise<void>
  ) {}

  async sendAndWait(): Promise<undefined> {
    await this.invokeTask()
    return undefined
  }
}

class FakeManager {
  readonly createCalls: GitHubCopilotCreateSessionConfig[] = []
  readonly disconnectSession = vi.fn(async () => {})
  readonly deleteSession = vi.fn(async () => {})
  readonly assertAccountIdentity = vi.fn(() => {})
  invokeCount = 1

  async createSession(config: GitHubCopilotCreateSessionConfig): Promise<CopilotSession> {
    this.createCalls.push(config)
    const invokeTask = async (): Promise<void> => {
      const task = config.tools?.find((entry) => entry.name === 'task')
      if (!task?.handler) throw new Error('custom task not found')
      for (let index = 0; index < this.invokeCount; index += 1) {
        const toolCallId = 'managed-task-1'
        config.onEvent?.(
          event('tool.execution_start', {
            toolCallId,
            toolName: 'task',
            arguments: { agent: 'reviewer', prompt: 'Review this patch.' },
          })
        )
        try {
          const output = await task.handler({ agent: 'reviewer', prompt: 'Review this patch.' }, {
            sessionId: 'copilot-parent-1',
            toolCallId,
            toolName: 'task',
            arguments: { agent: 'reviewer', prompt: 'Review this patch.' },
          } as ToolInvocation)
          config.onEvent?.(
            event('tool.execution_complete', {
              toolCallId,
              success: true,
              result: { content: String(output) },
            })
          )
        } catch (error) {
          config.onEvent?.(
            event('tool.execution_complete', {
              toolCallId,
              success: false,
              error: { message: error instanceof Error ? error.message : String(error) },
            })
          )
        }
      }
      config.onEvent?.(
        event('assistant.usage', {
          inputTokens: 50,
          outputTokens: 8,
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
          finishReason: 'stop',
        })
      )
    }
    return new FakeSession('copilot-parent-1', invokeTask) as unknown as CopilotSession
  }

  async resumeSession(): Promise<CopilotSession> {
    throw new Error('not used')
  }
}

/** Call task.handler with agent sequences to simulate model retries and corrections. */
class FakeExplicitAgentManager extends FakeManager {
  constructor(readonly agentSequence: Array<{ agent: string; prompt?: string } | string>) {
    super()
  }

  override async createSession(config: GitHubCopilotCreateSessionConfig): Promise<CopilotSession> {
    this.createCalls.push(config)
    const invokeTask = async (): Promise<void> => {
      const task = config.tools?.find((entry) => entry.name === 'task')
      if (!task?.handler) throw new Error('custom task not found')
      for (const [index, entry] of this.agentSequence.entries()) {
        const agent = typeof entry === 'string' ? entry : entry.agent
        const prompt = typeof entry === 'string' ? 'Analyze the integration.' : entry.prompt
        const toolCallId = `managed-task-${index + 1}`
        config.onEvent?.(
          event('tool.execution_start', {
            toolCallId,
            toolName: 'task',
            arguments: { agent, prompt },
          })
        )
        try {
          const output = await task.handler({ agent, prompt }, {
            sessionId: 'copilot-parent-1',
            toolCallId,
            toolName: 'task',
            arguments: { agent, prompt },
          } as ToolInvocation)
          config.onEvent?.(
            event('tool.execution_complete', {
              toolCallId,
              success: true,
              result: { content: String(output) },
            })
          )
        } catch (error) {
          config.onEvent?.(
            event('tool.execution_complete', {
              toolCallId,
              success: false,
              error: { message: error instanceof Error ? error.message : String(error) },
            })
          )
        }
      }
      config.onEvent?.(
        event('assistant.usage', {
          inputTokens: 50,
          outputTokens: 8,
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
          finishReason: 'stop',
        })
      )
    }
    return new FakeSession('copilot-parent-1', invokeTask) as unknown as CopilotSession
  }
}

function persistUser(conversationId: string): void {
  const message: ChatMessage = {
    id: 'user-1',
    conversationId,
    role: 'user',
    parts: [{ type: 'text', id: 'user-1-text', text: 'Delegate this review.' }],
    createdAt: 1,
  }
  upsertChatMessage(message)
}

function profile(providerId: string, modelId: string) {
  return {
    version: 1 as const,
    agentName: 'reviewer',
    effective: {
      providerId,
      modelId,
      configuredEffort: 'high',
      sentEffort: 'high',
      source: 'conversation-default' as const,
      candidateIndex: 0,
    },
    attempts: [],
  }
}

describe('GitHub Copilot host-managed task orchestration', () => {
  let cwd: string

  beforeEach(() => {
    vi.clearAllMocks()
    freshDb()
    cwd = mkdtempSync(path.join(os.tmpdir(), 'maestrly-copilot-managed-task-'))
    mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(
      path.join(cwd, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code\ntools: read, grep\n---\nReview carefully.'
    )
    getCodexManagerMock.mockReturnValue({ getClient: vi.fn(async () => ({ id: 'codex-client' })) } as never)
    getClaudeManagerMock.mockReturnValue({
      status: vi.fn(async () => ({
        authenticated: true,
        accountFingerprint: 'sha256:claude-account',
        accountEpoch: 2,
      })),
      assertAccountIdentity: vi.fn(),
    } as never)
  })

  afterEach(() => {
    closeDb()
    rmSync(cwd, { recursive: true, force: true })
  })

  it.each([
    ['builtin_github_copilot_subscription', 'claude-sonnet-4.6', 'copilot'],
    ['builtin_codex_subscription', 'gpt-5.6', 'codex'],
    ['builtin_claude_subscription', 'opus[1m]', 'claude'],
    ['openai', 'gpt-5.5', 'byok'],
  ] as const)('dispatches %s through executor %s and persists snapshot/accounting', async (providerId, modelId, route) => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id)
    const manager = new FakeManager()
    const emitted: ChatStreamEvent[] = []
    const resolvedProfile = profile(providerId, modelId)
    const definition = {
      name: 'reviewer',
      description: 'Reviews code',
      prompt: 'Review carefully.',
      source: '.claude/agents/reviewer.md',
      tools: ['read', 'grep'],
    }
    resolveProfileMock.mockResolvedValue({ definition, profile: resolvedProfile })
    const childResult = {
      text: `${route} result`,
      model: { providerId, modelId },
      usage: { input: 7, output: 3, cacheRead: 2, cacheCreate: 1, totalInput: 10 },
      ...(route === 'claude' ? { runtimeEstimatedCostUsd: 0.005 } : {}),
    }
    runCopilotMock.mockResolvedValue(childResult)
    runCodexMock.mockResolvedValue(childResult)
    runClaudeMock.mockResolvedValue(childResult)
    runByokMock.mockResolvedValue(childResult)

    await runGitHubCopilotChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd,
      selection: { providerId: 'builtin_github_copilot_subscription', modelId: 'gpt-5.6-sol' },
      mode: 'agent',
      permMode: 'ask',
      reasoningEffort: 'xhigh',
      manager: manager as unknown as GitHubCopilotSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(async () => {}), assertDecision: vi.fn(async () => 'once') } as never,
      questionBroker: { ask: vi.fn(async () => []) } as never,
      emit: (streamEvent) => emitted.push(streamEvent),
      signal: new AbortController().signal,
    })

    expect(resolveProfileMock).toHaveBeenCalledOnce()
    expect(runCopilotMock).toHaveBeenCalledTimes(route === 'copilot' ? 1 : 0)
    expect(runCodexMock).toHaveBeenCalledTimes(route === 'codex' ? 1 : 0)
    expect(runClaudeMock).toHaveBeenCalledTimes(route === 'claude' ? 1 : 0)
    expect(runByokMock).toHaveBeenCalledTimes(route === 'byok' ? 1 : 0)
    expect(manager.createCalls[0].customAgents).toBeUndefined()
    expect(manager.createCalls[0].availableTools).toContain('custom:task')
    expect(manager.createCalls[0].availableTools).not.toContain('builtin:task')

    const completed = emitted.find(
      (streamEvent) =>
        streamEvent.kind === 'tool-state' &&
        streamEvent.toolCallId === 'managed-task-1' &&
        streamEvent.state.status === 'completed'
    )
    expect(completed).toMatchObject({
      state: {
        status: 'completed',
        output: `${route} result`,
        sub: {
          profile: resolvedProfile,
          usage: { input: 7, output: 3, cacheRead: 2, cacheCreate: 1 },
          ...(route === 'claude' ? { runtimeEstimatedCostUsd: 0.005 } : {}),
          durationMs: expect.any(Number),
        },
      },
    })
    expect(emitted.find((streamEvent) => streamEvent.kind === 'finish')).toMatchObject({
      usage: {
        usageVersion: 2,
        input: 40,
        output: 8,
        cachedInput: 10,
        subInput: 7,
        subOutput: 3,
        subCachedInput: 2,
        subCacheCreate: 1,
        subagentUsage: [
          {
            providerId,
            modelId,
            input: 7,
            output: 3,
            cachedInput: 2,
            cacheCreate: 1,
            ...(route === 'claude' ? { runtimeEstimatedCostUsd: 0.005 } : {}),
          },
        ],
      },
    })
    const persistedTask = listChatMessages(conversation.id)
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool' && part.toolCallId === 'managed-task-1')
    expect(persistedTask).toMatchObject({
      state: { status: 'completed', sub: { profile: resolvedProfile, durationMs: expect.any(Number) } },
    })
    if (route === 'codex') {
      expect(toolSetRuntimesMock).toHaveBeenCalledOnce()
      expect(registerCodexRouteMock).toHaveBeenCalledOnce()
    }
  })

  it('coordinates specialists and helpers while blocking premature general-purpose', async () => {
    writeFileSync(
      path.join(cwd, '.claude', 'agents', 'api-integration-engineer.md'),
      [
        '---',
        'name: api-integration-engineer',
        'description: Integrates third-party APIs.',
        'tools: read, bash, write, edit',
        '---',
        'You are the API integration specialist. Analyze the integration and report.',
      ].join('\n')
    )
    writeFileSync(
      path.join(cwd, '.claude', 'agents', 'runtime-reviewer.md'),
      [
        '---',
        'name: runtime-reviewer',
        'description: Reviews the runtime.',
        'tools: read, bash',
        '---',
        'Review the runtime carefully.',
      ].join('\n')
    )
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    const userMessage: ChatMessage = {
      id: 'user-explicit-1',
      conversationId: conversation.id,
      role: 'user',
      parts: [
        {
          type: 'text',
          id: 'user-explicit-1-text',
          text: 'Use o api-integration-engineer para implementar. Antes, use explore para mapear os pontos e depois runtime-reviewer para revisar.',
        },
      ],
      createdAt: 1,
    }
    upsertChatMessage(userMessage)
    const manager = new FakeExplicitAgentManager([
      { agent: 'explore', prompt: 'Map the integration points.' },
      'general-purpose',
      { agent: 'api-integration-engineer', prompt: 'Implement the integration.' },
      { agent: 'runtime-reviewer', prompt: 'Review the implementation.' },
    ])
    const emitted: ChatStreamEvent[] = []
    const specialistProfile = {
      version: 1 as const,
      agentName: 'api-integration-engineer',
      effective: {
        providerId: 'provider-a',
        modelId: 'model-a',
        configuredEffort: 'high',
        sentEffort: 'high',
        source: 'conversation-agent' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    resolveProfileMock.mockResolvedValue({
      definition: {
        name: 'api-integration-engineer',
        description: 'Integrates third-party APIs.',
        prompt: 'You are the API integration specialist. Analyze the integration and report.',
        source: '.claude/agents/api-integration-engineer.md',
        tools: ['read', 'bash', 'write', 'edit'],
      },
      profile: specialistProfile,
    })
    runByokMock.mockResolvedValue({
      text: 'integration analysis',
      model: { providerId: 'provider-a', modelId: 'model-a' },
      usage: { input: 7, output: 3, cacheRead: 2, cacheCreate: 1, totalInput: 10 },
    })

    await runGitHubCopilotChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd,
      selection: { providerId: 'builtin_github_copilot_subscription', modelId: 'gpt-5.6-sol' },
      mode: 'agent',
      permMode: 'ask',
      reasoningEffort: 'xhigh',
      manager: manager as unknown as GitHubCopilotSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(async () => {}), assertDecision: vi.fn(async () => 'once') } as never,
      questionBroker: { ask: vi.fn(async () => []) } as never,
      emit: (streamEvent) => emitted.push(streamEvent),
      signal: new AbortController().signal,
    })

    // Explore helpers are allowed while specialists remain pending.
    expect(
      emitted.find(
        (streamEvent) =>
          streamEvent.kind === 'tool-state' &&
          streamEvent.toolCallId === 'managed-task-1' &&
          streamEvent.state.status === 'completed'
      )
    ).toMatchObject({ state: { status: 'completed' } })
    // The guard blocks general-purpose before profile resolution.
    expect(
      emitted.find(
        (streamEvent) =>
          streamEvent.kind === 'tool-state' &&
          streamEvent.toolCallId === 'managed-task-2' &&
          streamEvent.state.status === 'error'
      )
    ).toMatchObject({
      state: {
        status: 'error',
        error: expect.stringContaining('explicitly requested the available subagent'),
      },
    })
    expect(resolveProfileMock).not.toHaveBeenCalledWith(expect.objectContaining({ agentName: 'general-purpose' }))
    // 3) The specialist resolves the configured profile and executes.
    expect(
      emitted.find(
        (streamEvent) =>
          streamEvent.kind === 'tool-state' &&
          streamEvent.toolCallId === 'managed-task-3' &&
          streamEvent.state.status === 'completed'
      )
    ).toMatchObject({
      state: { status: 'completed', sub: { profile: specialistProfile } },
    })
    expect(resolveProfileMock).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'api-integration-engineer' }))
    expect(runByokMock).toHaveBeenCalledWith(
      expect.objectContaining({ profile: specialistProfile, agentName: 'api-integration-engineer' })
    )
    // Reviewer helpers are allowed after specialist dispatch.
    expect(
      emitted.find(
        (streamEvent) =>
          streamEvent.kind === 'tool-state' &&
          streamEvent.toolCallId === 'managed-task-4' &&
          streamEvent.state.status === 'completed'
      )
    ).toMatchObject({ state: { status: 'completed' } })
    expect(runByokMock).not.toHaveBeenCalledWith(expect.objectContaining({ agentName: 'general-purpose' }))
    // Usage belongs to the effective specialist model; three runs sum to 21/9.
    expect(emitted.find((streamEvent) => streamEvent.kind === 'finish')).toMatchObject({
      usage: {
        subagentUsage: [{ providerId: 'provider-a', modelId: 'model-a', input: 21, output: 9 }],
      },
    })
    const persistedErrorPart = listChatMessages(conversation.id)
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool' && part.toolCallId === 'managed-task-2')
    expect(persistedErrorPart).toMatchObject({
      state: { status: 'error', error: expect.stringContaining('explicitly requested the available subagent') },
    })
    const persistedOkPart = listChatMessages(conversation.id)
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool' && part.toolCallId === 'managed-task-3')
    expect(persistedOkPart).toMatchObject({
      state: { status: 'completed', sub: { profile: specialistProfile } },
    })
  })

  it('preserves snapshots and duration on pre-child resolution failure', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id)
    const manager = new FakeManager()
    const emitted: ChatStreamEvent[] = []
    const failedProfile = {
      version: 1 as const,
      agentName: 'reviewer',
      effective: null,
      attempts: [],
      diagnostics: [{ code: 'provider-disconnected' as const, severity: 'error' as const, message: 'Sign in.' }],
    }
    resolveProfileMock.mockResolvedValue({ definition: null, profile: failedProfile })

    await runGitHubCopilotChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd,
      selection: { providerId: 'builtin_github_copilot_subscription', modelId: 'gpt-5.6-sol' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as GitHubCopilotSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(async () => {}), assertDecision: vi.fn(async () => 'once') } as never,
      questionBroker: { ask: vi.fn(async () => []) } as never,
      emit: (streamEvent) => emitted.push(streamEvent),
      signal: new AbortController().signal,
    })

    expect(runCopilotMock).not.toHaveBeenCalled()
    expect(runCodexMock).not.toHaveBeenCalled()
    expect(runByokMock).not.toHaveBeenCalled()
    expect(
      emitted.find(
        (streamEvent) =>
          streamEvent.kind === 'tool-state' &&
          streamEvent.toolCallId === 'managed-task-1' &&
          streamEvent.state.status === 'error'
      )
    ).toMatchObject({
      state: {
        status: 'error',
        sub: { profile: failedProfile, durationMs: expect.any(Number) },
      },
    })
    expect(
      listChatMessages(conversation.id)
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'tool' && part.toolCallId === 'managed-task-1')
    ).toMatchObject({ state: { status: 'error', sub: { profile: failedProfile } } })
  })

  it('resolves profiles once per tool call despite repeated runtime execution', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id)
    const manager = new FakeManager()
    manager.invokeCount = 2
    resolveProfileMock.mockResolvedValue({
      definition: {
        name: 'reviewer',
        description: 'Reviews code',
        prompt: 'Review carefully.',
        source: '.claude/agents/reviewer.md',
        tools: ['read'],
      },
      profile: profile('openai', 'gpt-5.5'),
    })
    runByokMock.mockResolvedValue({
      text: 'ok',
      model: { providerId: 'openai', modelId: 'gpt-5.5' },
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0, totalInput: 1 },
    })

    await runGitHubCopilotChat({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd,
      selection: { providerId: 'builtin_github_copilot_subscription', modelId: 'gpt-5.6-sol' },
      mode: 'agent',
      permMode: 'ask',
      manager: manager as unknown as GitHubCopilotSubscriptionManager,
      accountIdentity: identity,
      broker: { assert: vi.fn(async () => {}), assertDecision: vi.fn(async () => 'once') } as never,
      questionBroker: { ask: vi.fn(async () => []) } as never,
      emit: () => {},
      signal: new AbortController().signal,
    })

    expect(resolveProfileMock).toHaveBeenCalledOnce()
    expect(runByokMock).toHaveBeenCalledTimes(2)
  })
})
