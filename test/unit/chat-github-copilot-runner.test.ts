import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk'

import type { ChatMessage, ChatStreamEvent } from '../../src/shared/chat'
import { listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import type {
  GitHubCopilotAccountIdentity,
  GitHubCopilotCreateSessionConfig,
  GitHubCopilotResumeSessionConfig,
  GitHubCopilotSubscriptionManager,
} from '../../src/main/chat/github-copilot/manager'
import {
  agentsCatalog,
  compactGitHubCopilotSession,
  GITHUB_COPILOT_AGENT_DESCRIPTION_MAX_CHARS,
  GITHUB_COPILOT_TASK_TOOL_DESCRIPTION_MAX_BYTES,
  normalizeGitHubCopilotFinishReason,
  runGitHubCopilotChat,
} from '../../src/main/chat/github-copilot/runner'
import { chatDiag } from '../../src/main/chat/diag-log'
import {
  getGitHubCopilotSessionBinding,
  listGitHubCopilotSessionCleanup,
  putGitHubCopilotSessionBinding,
} from '../../src/main/chat/github-copilot/session-store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { patchConvUiPrefs } from '../../src/main/store'
import { REVIEWER_READONLY_TOOL_NAMES } from '../../src/main/chat/tools'
import { FABLE_51_BEHAVIOR_PROFILE } from '../../src/main/chat/fable/profile'

vi.mock('../../src/main/chat/diag-log', () => ({ chatDiag: vi.fn() }))

type Script = (onEvent: (event: SessionEvent) => void) => void | Promise<void>

function event(type: SessionEvent['type'], data: Record<string, unknown>, agentId?: string): SessionEvent {
  return { type, data, ...(agentId ? { agentId } : {}) } as unknown as SessionEvent
}

class FakeSession {
  readonly abort = vi.fn(async () => {})
  readonly sendCalls: Array<{ input: unknown; timeout: number | undefined }> = []
  readonly rpc = {
    history: {
      compact: vi.fn(async (_input?: { customInstructions?: string }) => ({
        success: true,
        tokensRemoved: 4_000,
        messagesRemoved: 8,
        summaryContent: 'Official summary',
        contextWindow: { tokenLimit: 200_000, currentTokens: 2_000, messagesLength: 3 },
      })),
      abortManualCompaction: vi.fn(async () => ({ aborted: true })),
    },
  }

  constructor(
    readonly sessionId: string,
    private readonly config: GitHubCopilotCreateSessionConfig | GitHubCopilotResumeSessionConfig,
    private readonly script: Script
  ) {}

  async sendAndWait(input: unknown, timeout?: number): Promise<undefined> {
    this.sendCalls.push({ input, timeout })
    await this.script(this.config.onEvent ?? (() => {}))
    return undefined
  }
}

class FakeManager {
  readonly identity: GitHubCopilotAccountIdentity = { fingerprint: 'sha256:account-a', epoch: 7 }
  readonly assertAccountIdentity = vi.fn((expected: GitHubCopilotAccountIdentity) => {
    if (expected.fingerprint !== this.identity.fingerprint || expected.epoch !== this.identity.epoch) {
      throw new Error('account changed')
    }
  })
  readonly createCalls: GitHubCopilotCreateSessionConfig[] = []
  readonly resumeCalls: Array<{ sessionId: string; config: GitHubCopilotResumeSessionConfig }> = []
  readonly disconnectSession = vi.fn(async () => {})
  readonly deleteSession = vi.fn(async () => {})
  readonly sessions: FakeSession[] = []
  private readonly scripts: Script[] = []
  private sequence = 0

  queue(script: Script): void {
    this.scripts.push(script)
  }

  async createSession(config: GitHubCopilotCreateSessionConfig): Promise<CopilotSession> {
    this.createCalls.push(config)
    const session = new FakeSession(`copilot-session-${++this.sequence}`, config, this.nextScript())
    this.sessions.push(session)
    return session as unknown as CopilotSession
  }

  async resumeSession(sessionId: string, config: GitHubCopilotResumeSessionConfig): Promise<CopilotSession> {
    this.resumeCalls.push({ sessionId, config })
    const session = new FakeSession(sessionId, config, this.nextScript())
    this.sessions.push(session)
    return session as unknown as CopilotSession
  }

  private nextScript(): Script {
    const script = this.scripts.shift()
    if (!script) throw new Error('FakeManager received a session without a queued script')
    return script
  }
}

function persistUser(conversationId: string, id: string, text: string, createdAt: number): ChatMessage {
  const message: ChatMessage = {
    id,
    conversationId,
    role: 'user',
    parts: [{ type: 'text', id: `${id}-text`, text }],
    createdAt,
  }
  upsertChatMessage(message)
  return message
}

function args(
  conversationId: string,
  projectId: string,
  cwd: string,
  manager: FakeManager,
  emit: (streamEvent: ChatStreamEvent) => void = () => {}
) {
  return {
    conversationId,
    projectId,
    cwd,
    selection: { providerId: 'builtin_github_copilot_subscription', modelId: 'gpt-5.6-sol' },
    mode: 'ask' as const,
    permMode: 'ask' as const,
    reasoningEffort: 'xhigh',
    manager: manager as unknown as GitHubCopilotSubscriptionManager,
    accountIdentity: manager.identity,
    broker: {
      assert: vi.fn(async () => {}),
      assertDecision: vi.fn(async () => 'once' as const),
    } as never,
    questionBroker: { ask: vi.fn(async () => []) } as never,
    emit,
    signal: new AbortController().signal,
  }
}

function assistantMessages(conversationId: string): ChatMessage[] {
  return listChatMessages(conversationId).filter((message) => message.role === 'assistant')
}

describe('GitHub Copilot official runner', () => {
  let cwd: string

  beforeEach(() => {
    vi.mocked(chatDiag).mockClear()
    freshDb()
    cwd = mkdtempSync(path.join(os.tmpdir(), 'maestrly-copilot-runner-'))
  })

  afterEach(() => {
    closeDb()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('translates streaming, tools, subagents, and usage without duplicating final envelopes', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'Analise o projeto', 1)
    const manager = new FakeManager()
    const emitted: ChatStreamEvent[] = []
    const observedWindows: number[] = []
    manager.queue((onEvent) => {
      onEvent(event('assistant.reasoning_delta', { reasoningId: 'reason-1', deltaContent: 'checando' }))
      onEvent(event('assistant.reasoning', { reasoningId: 'reason-1', content: 'checando duplicado' }))
      onEvent(event('assistant.message_delta', { messageId: 'answer-1', deltaContent: 'All ' }))
      onEvent(event('assistant.message_delta', { messageId: 'answer-1', deltaContent: 'good.' }))
      onEvent(
        event('assistant.message', {
          messageId: 'answer-1',
          content: 'All good.',
          citations: {
            sources: [
              { id: 'source-1', provider: 'openai', title: 'Documentation', url: 'https://example.com/docs' },
              { id: 'source-duplicate', provider: 'openai', title: 'Same link', url: 'https://example.com/docs' },
              { id: 'source-2', provider: 'client', title: 'Local code', path: 'src/main/file.ts' },
            ],
            spans: [
              {
                startIndex: 0,
                endIndex: 4,
                references: [{ sourceId: 'source-1', citedText: 'excerpt that must not be repeated' }],
              },
            ],
          },
        })
      )
      onEvent(
        event('tool.execution_start', { toolCallId: 'tool-1', toolName: 'read_file', arguments: { path: 'a.ts' } })
      )
      onEvent(event('tool.execution_progress', { toolCallId: 'tool-1', progressMessage: 'reading' }))
      onEvent(
        event('tool.execution_complete', {
          toolCallId: 'tool-1',
          success: true,
          result: { content: 'ok', detailedContent: 'file read' },
        })
      )
      onEvent(
        event('tool.execution_start', {
          toolCallId: 'task-1',
          toolName: 'task',
          arguments: { agent: 'explore', prompt: 'Investigue o fluxo.' },
        })
      )
      onEvent(
        event(
          'subagent.started',
          {
            toolCallId: 'task-1',
            agentName: 'explore',
            agentDisplayName: 'Explore',
            agentDescription: 'investigates',
            model: 'gpt-5.6-sol',
          },
          'agent-1'
        )
      )
      onEvent(event('assistant.message_delta', { messageId: 'child-1', deltaContent: 'achei ' }, 'agent-1'))
      onEvent(event('assistant.message_delta', { messageId: 'child-1', deltaContent: 'one point' }, 'agent-1'))
      onEvent(
        event('tool.execution_partial_result', { toolCallId: 'child-tool', partialOutput: 'buscando' }, 'agent-1')
      )
      onEvent(event('assistant.message', { messageId: 'child-1', content: 'Resultado final coerente.' }, 'agent-1'))
      onEvent(
        event(
          'subagent.completed',
          { toolCallId: 'task-1', agentName: 'explore', agentDisplayName: 'Explore', durationMs: 25 },
          'agent-1'
        )
      )
      onEvent(
        event('assistant.usage', {
          model: 'gpt-5.6-sol',
          inputTokens: 100,
          outputTokens: 30,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          finishReason: 'stop',
        })
      )
      onEvent(
        event(
          'assistant.usage',
          { model: 'gpt-5.6-sol', inputTokens: 40, outputTokens: 10, cacheReadTokens: 5 },
          'agent-1'
        )
      )
      onEvent(
        event('session.usage_info', {
          currentTokens: 1_200,
          tokenLimit: 200_000,
          messagesLength: 5,
          toolDefinitionsTokens: 321,
        })
      )
    })

    await expect(
      runGitHubCopilotChat({
        ...args(conversation.id, workspace.id, cwd, manager, (streamEvent) => emitted.push(streamEvent)),
        onModelContextWindow: (contextWindow) => observedWindows.push(contextWindow),
      })
    ).resolves.toMatchObject({ planSubmitted: false, sessionId: 'copilot-session-1' })

    const textDeltas = emitted.filter((streamEvent) => streamEvent.kind === 'text-delta')
    expect(textDeltas).toEqual([
      expect.objectContaining({ delta: 'All good.' }),
      expect.objectContaining({
        delta: '\n\n### Sources\n- [Documentation](<https://example.com/docs>)\n- Local code — `src/main/file.ts`',
      }),
    ])
    expect(textDeltas.some((streamEvent) => streamEvent.delta.includes('excerpt that must not be repeated'))).toBe(
      false
    )
    const reasoningDeltas = emitted.filter((streamEvent) => streamEvent.kind === 'reasoning-delta')
    expect(reasoningDeltas).toEqual([expect.objectContaining({ delta: 'checando' })])
    expect(
      emitted.find(
        (streamEvent) =>
          streamEvent.kind === 'tool-state' &&
          streamEvent.toolCallId === 'task-1' &&
          streamEvent.state.status === 'completed'
      )
    ).toMatchObject({
      state: { status: 'completed', output: 'Resultado final coerente.' },
    })
    expect(
      emitted.some((streamEvent) => streamEvent.kind === 'tool-state' && streamEvent.toolCallId === 'child-tool')
    ).toBe(false)
    expect(emitted.find((streamEvent) => streamEvent.kind === 'finish')).toMatchObject({
      finishReason: 'stop',
      usage: {
        input: 70,
        output: 30,
        cachedInput: 20,
        cacheCreate: 10,
        subInput: 35,
        subOutput: 10,
        subCachedInput: 5,
        contextInput: 1_200,
        modelContextWindow: 200_000,
      },
    })
    expect(observedWindows).toEqual([200_000])
    expect(assistantMessages(conversation.id)).toHaveLength(1)
    expect(getGitHubCopilotSessionBinding(conversation.id)).toMatchObject({
      sessionId: 'copilot-session-1',
      modelId: 'gpt-5.6-sol',
      harnessProfile: 'copilot-openai-v1',
      accountFingerprint: manager.identity.fingerprint,
    })
    expect(manager.disconnectSession).toHaveBeenCalledWith('copilot-session-1')
    expect(manager.createCalls[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      streaming: true,
      includeSubAgentStreamingEvents: true,
      toolSearch: { enabled: true, deferThreshold: 0 },
      enableSessionTelemetry: false,
      enableConfigDiscovery: false,
      enableSessionStore: false,
      infiniteSessions: { enabled: false },
      systemMessage: { mode: 'replace' },
    })
    expect((manager.createCalls[0].availableTools as string[]).every((name) => name.startsWith('custom:'))).toBe(true)
    expect((manager.createCalls[0].tools ?? []).every((tool) => tool.overridesBuiltInTool === true)).toBe(true)
    expect(
      (manager.createCalls[0].customAgents ?? []).every((agent) =>
        (agent.tools ?? []).every((name) => !['ask_question', 'review_plan', 'todo_write'].includes(name))
      )
    ).toBe(true)
    expect(chatDiag).toHaveBeenCalledWith({
      kind: 'github-copilot-subscription-tools-profile',
      mode: 'ask',
      model: 'gpt-5.6-sol',
      resumed: false,
      tools: expect.objectContaining({ total: expect.any(Number), eager: expect.any(Number), deferred: 0 }),
    })
    expect(chatDiag).toHaveBeenCalledWith({
      kind: 'github-copilot-subscription-initial-context',
      mode: 'ask',
      model: 'gpt-5.6-sol',
      contextInput: 1_200,
      toolDefinitionsTokens: 321,
      tools: expect.objectContaining({ total: expect.any(Number), eager: expect.any(Number), deferred: 0 }),
    })
  })

  it.each([
    ['tool_calls', 'tool-calls'],
    ['content_filter', 'content-filter'],
    ['max_tokens', 'length'],
  ])('normalizes official finish reason %s to %s', (raw, expected) => {
    expect(normalizeGitHubCopilotFinishReason(raw)).toBe(expected)
  })

  it.each([
    ['ask', 'interactive'],
    ['plan', 'plan'],
    ['agent', 'interactive'],
  ] as const)('sends selective toolSearch in %s mode', async (mode, agentMode) => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, `user-${mode}`, `execute in ${mode}`, 1)
    const manager = new FakeManager()
    manager.queue(() => {})

    await runGitHubCopilotChat({ ...args(conversation.id, workspace.id, cwd, manager), mode })

    expect(manager.createCalls[0]).toMatchObject({
      toolSearch: { enabled: true, deferThreshold: 0 },
    })
    expect(manager.sessions[0].sendCalls[0].input).toMatchObject({ agentMode })
    for (const entry of manager.createCalls[0].tools ?? []) {
      if (['task', 'use_skill', 'review_plan'].includes(entry.name)) expect(entry.defer).toBe('never')
    }
  })

  it('applies only the Fable behavioral profile on Copilot transport', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-fable-copilot', 'Inspect the project.', 1)
    const manager = new FakeManager()
    manager.queue(() => {})

    await runGitHubCopilotChat({
      ...args(conversation.id, workspace.id, cwd, manager),
      selection: { providerId: 'builtin_github_copilot_subscription', modelId: 'claude-fable-5-1' },
      behaviorProfile: FABLE_51_BEHAVIOR_PROFILE,
    })

    const config = manager.createCalls[0]
    expect(config.systemMessage?.content).toContain('maestrly-fable-5.1-v1')
    expect(config.systemMessage?.content).toContain('brief progress updates at meaningful milestones')
    expect(config).not.toHaveProperty('thinking')
    expect(config).not.toHaveProperty('betas')
    expect(config).not.toHaveProperty('toolChoice')
  })

  it('offers exactly the reviewer read-only tools and terminates after accepted submit_review', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-reviewer-boundary', 'Review the execution.', 1)
    const manager = new FakeManager()
    const reviewerRuntime = {
      recordEvidence: vi.fn(),
      submitReview: vi.fn(() => ({ ok: true as const })),
      searchExecutionContext: vi.fn(async () => []),
      readExecutionContext: vi.fn(async () => []),
    }
    manager.queue(async () => {
      const submitReview = manager.createCalls[0].tools?.find((entry) => entry.name === 'submit_review')
      expect(submitReview).toBeTruthy()
      await (
        submitReview!.handler as unknown as (input: unknown, invocation: { toolCallId: string }) => Promise<unknown>
      )({ result: 'clean', summary: 'No findings.' }, { toolCallId: 'reviewer-submit-1' })
    })

    const outcome = await runGitHubCopilotChat({
      ...args(conversation.id, workspace.id, cwd, manager),
      mode: 'agent',
      permMode: 'full',
      ephemeralSession: true,
      reviewerRuntime,
    })

    expect(outcome).toEqual({ planSubmitted: true, sessionId: 'copilot-session-1' })
    expect(manager.createCalls[0].tools?.map((entry) => entry.name)).toEqual([...REVIEWER_READONLY_TOOL_NAMES].sort())
    expect(manager.createCalls[0].availableTools).toEqual(
      [...REVIEWER_READONLY_TOOL_NAMES].sort().map((name) => `custom:${name}`)
    )
    expect(manager.createCalls[0].enableSkills).toBe(false)
    expect(manager.createCalls[0].enableHostGitOperations).toBe(false)
    expect(reviewerRuntime.submitReview).toHaveBeenCalledWith({ result: 'clean', summary: 'No findings.' })
    await vi.waitFor(() => expect(manager.sessions[0].abort).toHaveBeenCalledOnce())
  })

  it('bounds summarized agent catalogs in instructions', () => {
    const catalog = agentsCatalog(
      [
        {
          name: 'verbose-agent',
          description: `  ${'description '.repeat(100)}  `,
          prompt: 'prompt',
          source: '/tmp/agent.md',
        },
      ],
      'conv-1',
      false
    )
    const renderedDescription = catalog.split('- verbose-agent [specialist, read-only, inherited profile]: ')[1]

    expect(catalog).toContain(`capped at ${GITHUB_COPILOT_AGENT_DESCRIPTION_MAX_CHARS} characters`)
    expect(catalog).toContain('Selection rules:')
    expect(catalog).toContain('Available agents:')
    expect(catalog).not.toContain('providerId')
    expect(catalog).not.toContain('modelId')
    expect(renderedDescription).toHaveLength(GITHUB_COPILOT_AGENT_DESCRIPTION_MAX_CHARS)
    expect(renderedDescription.endsWith('…')).toBe(true)
  })

  it('preserves verbatim deltas when final subagent envelopes are missing', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'delegue', 1)
    const manager = new FakeManager()
    const emitted: ChatStreamEvent[] = []
    manager.queue((onEvent) => {
      onEvent(
        event(
          'subagent.started',
          {
            toolCallId: 'task-fallback',
            agentName: 'explore',
            agentDisplayName: 'Explore',
            agentDescription: 'investigates',
          },
          'agent-fallback'
        )
      )
      onEvent(event('assistant.message_delta', { messageId: 'child-fallback', deltaContent: 'two ' }, 'agent-fallback'))
      onEvent(
        event('assistant.message_delta', { messageId: 'child-fallback', deltaContent: 'words' }, 'agent-fallback')
      )
      onEvent(
        event(
          'subagent.completed',
          { toolCallId: 'task-fallback', agentName: 'explore', agentDisplayName: 'Explore' },
          'agent-fallback'
        )
      )
    })

    await runGitHubCopilotChat(
      args(conversation.id, workspace.id, cwd, manager, (streamEvent) => emitted.push(streamEvent))
    )

    expect(
      emitted.find(
        (streamEvent) =>
          streamEvent.kind === 'tool-state' &&
          streamEvent.toolCallId === 'task-fallback' &&
          streamEvent.state.status === 'completed'
      )
    ).toMatchObject({ state: { status: 'completed', output: 'two words' } })
  })

  it('replaces customAgents/builtin:task with the Maestrly host-managed task', async () => {
    const agentsDirectory = path.join(cwd, '.claude', 'agents')
    mkdirSync(agentsDirectory, { recursive: true })
    writeFileSync(
      path.join(agentsDirectory, 'runtime-reviewer.md'),
      [
        '---',
        'name: runtime-reviewer',
        'description: reviews the runtime',
        'model: claude-sonnet-4.6',
        'tools: read, bash, ask_question, review_plan, todo_write',
        '---',
        'Review the runtime.',
      ].join('\n')
    )
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'revise', 1)
    const manager = new FakeManager()
    manager.queue(() => {})

    await runGitHubCopilotChat({ ...args(conversation.id, workspace.id, cwd, manager), mode: 'agent' })

    expect(manager.createCalls[0].customAgents).toBeUndefined()
    expect(manager.createCalls[0].availableTools).toContain('custom:task')
    expect(manager.createCalls[0].availableTools).not.toContain('builtin:task')
    const task = manager.createCalls[0].tools?.find((entry) => entry.name === 'task')
    expect(task).toMatchObject({ overridesBuiltInTool: true, skipPermission: true, defer: 'never' })
    expect(Buffer.byteLength(task?.description ?? '', 'utf8')).toBeLessThanOrEqual(
      GITHUB_COPILOT_TASK_TOOL_DESCRIPTION_MAX_BYTES
    )
    expect(task?.description).not.toContain('runtime-reviewer')
    expect(task?.description).not.toContain('Available agents')
    expect(task?.parameters).toMatchObject({
      properties: { agent: { enum: expect.arrayContaining(['runtime-reviewer']) } },
    })
  })

  it('exposes effective virtual agents in task enums', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    patchConvUiPrefs(conversation.id, {
      chat: {
        subagentProfiles: {
          version: 1,
          byAgent: { testing: [{ providerId: 'byok-provider', modelId: 'deepseek-v4-flash', effort: 'max' }] },
        },
      },
    })
    persistUser(conversation.id, 'user-virtual-copilot', 'revise', 1)
    const manager = new FakeManager()
    manager.queue(() => {})

    await runGitHubCopilotChat({ ...args(conversation.id, workspace.id, cwd, manager), mode: 'agent' })

    const task = manager.createCalls[0].tools?.find((entry) => entry.name === 'task')
    expect(task?.parameters).toMatchObject({
      properties: { agent: { enum: expect.arrayContaining(['testing']) } },
    })
  })

  it('resumes only when message, model, harness, tools, and account still match', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    const manager = new FakeManager()
    manager.queue((onEvent) => {
      onEvent(
        event('assistant.message', {
          messageId: 'answer-1',
          content: 'first',
          citations: {
            sources: [
              { id: 'source-1', provider: 'anthropic', title: 'Fonte final', url: 'https://example.com/final' },
            ],
            spans: [],
          },
        })
      )
    })
    persistUser(conversation.id, 'user-1', 'first question', 1)
    await runGitHubCopilotChat(args(conversation.id, workspace.id, cwd, manager))

    const firstBinding = getGitHubCopilotSessionBinding(conversation.id)
    expect(firstBinding?.sessionId).toBe('copilot-session-1')
    expect(
      assistantMessages(conversation.id)[0]
        .parts.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
    ).toContain('### Sources\n- [Fonte final](<https://example.com/final>)')
    persistUser(conversation.id, 'user-2', 'second question', 3)
    manager.queue((onEvent) => {
      onEvent(event('assistant.message', { messageId: 'answer-2', content: 'second' }))
    })

    await runGitHubCopilotChat(args(conversation.id, workspace.id, cwd, manager))

    expect(manager.resumeCalls).toHaveLength(1)
    expect(manager.resumeCalls[0]).toMatchObject({
      sessionId: 'copilot-session-1',
      config: {
        suppressResumeEvent: true,
        continuePendingWork: false,
        toolSearch: { enabled: true, deferThreshold: 0 },
      },
    })
    expect(manager.createCalls).toHaveLength(1)
    expect(manager.sessions[1].sendCalls[0].input).toMatchObject({
      prompt: 'second question',
      agentMode: 'interactive',
    })
    expect(getGitHubCopilotSessionBinding(conversation.id)).toMatchObject({
      sessionId: 'copilot-session-1',
      lastMessageId: assistantMessages(conversation.id).at(-1)?.id,
    })
    expect(chatDiag).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'github-copilot-subscription-tools-profile',
        resumed: true,
      })
    )
  })

  it('reseeds visible transcripts after compatible resume failure', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    const manager = new FakeManager()
    persistUser(conversation.id, 'user-1', 'first question', 1)
    manager.queue((onEvent) => {
      onEvent(event('assistant.message', { messageId: 'answer-1', content: 'first answer' }))
    })
    await runGitHubCopilotChat(args(conversation.id, workspace.id, cwd, manager))

    persistUser(conversation.id, 'user-2', 'second question', 3)
    vi.spyOn(manager, 'resumeSession').mockRejectedValueOnce(new Error('session state missing'))
    manager.queue((onEvent) => {
      onEvent(event('assistant.message', { messageId: 'answer-2', content: 'second answer' }))
    })

    await runGitHubCopilotChat(args(conversation.id, workspace.id, cwd, manager))

    expect(manager.createCalls).toHaveLength(2)
    expect(manager.sessions[1].sendCalls[0].input).toMatchObject({ agentMode: 'interactive' })
    const prompt = (manager.sessions[1].sendCalls[0].input as { prompt: string }).prompt
    expect(prompt).toContain('Context imported from the existing Maestrly conversation')
    expect(prompt).toContain('first question')
    expect(prompt).toContain('first answer')
    expect(prompt).toContain('second question')
  })

  it('emits one error and removes unpersisted new sessions', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'falhe', 1)
    const manager = new FakeManager()
    const emitted: ChatStreamEvent[] = []
    manager.queue(() => {
      throw new Error('runtime crashed Authorization: Bearer gho_runner_secret')
    })

    await expect(
      runGitHubCopilotChat(
        args(conversation.id, workspace.id, cwd, manager, (streamEvent) => emitted.push(streamEvent))
      )
    ).resolves.toMatchObject({ planSubmitted: false, sessionId: 'copilot-session-1' })

    expect(emitted.filter((streamEvent) => streamEvent.kind === 'error')).toEqual([
      expect.objectContaining({ message: 'runtime crashed Authorization: Bearer [REDACTED]' }),
    ])
    expect(JSON.stringify(emitted)).not.toContain('gho_runner_secret')
    expect(manager.deleteSession).toHaveBeenCalledTimes(1)
    expect(manager.deleteSession).toHaveBeenCalledWith('copilot-session-1')
    expect(getGitHubCopilotSessionBinding(conversation.id)).toBeNull()
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
  })

  it('retires sessions exactly once on closure callbacks', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'continue', 1)
    const manager = new FakeManager()
    const emitted: ChatStreamEvent[] = []
    manager.queue(() => {})

    await expect(
      runGitHubCopilotChat({
        ...args(conversation.id, workspace.id, cwd, manager, (streamEvent) => emitted.push(streamEvent)),
        onSessionReady: () => false,
        canPersistSession: () => false,
      })
    ).resolves.toMatchObject({ sessionId: 'copilot-session-1' })

    expect(manager.deleteSession).toHaveBeenCalledTimes(1)
    expect(emitted.filter((streamEvent) => streamEvent.kind === 'error')).toHaveLength(1)
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
  })

  it('compacts at threshold and continues with cumulative usage in the same message', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'execute a long task', 1)
    const manager = new FakeManager()
    const emitted: ChatStreamEvent[] = []

    manager.queue((onEvent) => {
      onEvent(
        event('tool.execution_start', { toolCallId: 'tool-1', toolName: 'read_file', arguments: { path: 'a.ts' } })
      )
      onEvent(
        event('tool.execution_complete', {
          toolCallId: 'tool-1',
          success: true,
          result: { detailedContent: 'preserved state' },
        })
      )
      onEvent(event('assistant.message', { messageId: 'partial-1', content: 'Partial before the summary.' }))
      onEvent(event('assistant.usage', { inputTokens: 100, outputTokens: 20, finishReason: 'max_tokens' }))
      onEvent(event('session.usage_info', { currentTokens: 900, tokenLimit: 1_000, messagesLength: 8 }))
      // Only the first runtime snapshot triggers compaction before abort recognition.
      onEvent(event('session.usage_info', { currentTokens: 920, tokenLimit: 1_000, messagesLength: 8 }))
      onEvent(event('session.error', { message: 'provider attempt aborted' }))
    })
    manager.queue((onEvent) => {
      onEvent(event('assistant.message', { messageId: 'answer-2', content: ' Continuation complete.' }))
      onEvent(event('assistant.usage', { inputTokens: 50, outputTokens: 10, finishReason: 'stop' }))
      onEvent(event('session.usage_info', { currentTokens: 200, tokenLimit: 1_000, messagesLength: 3 }))
    })

    const compactHistory = vi.fn(async () => {
      const partial = assistantMessages(conversation.id)[0]
      expect(partial.parts.some((part) => part.type === 'text' && part.text.includes('Partial before'))).toBe(true)
      return {
        summary: 'Portable summary preserving decisions and task state.',
        usage: { input: 7, output: 3, cacheRead: 2, cacheCreate: 1, totalInput: 10 },
      }
    })

    await expect(
      runGitHubCopilotChat({
        ...args(conversation.id, workspace.id, cwd, manager, (streamEvent) => emitted.push(streamEvent)),
        contextWindow: 1_000,
        compactHistory,
      })
    ).resolves.toEqual({ planSubmitted: false, sessionId: 'copilot-session-2' })

    expect(compactHistory).toHaveBeenCalledOnce()
    expect(manager.sessions[0].abort).toHaveBeenCalledOnce()
    expect(emitted.filter((streamEvent) => streamEvent.kind === 'message-start')).toHaveLength(1)
    expect(emitted.filter((streamEvent) => streamEvent.kind === 'error')).toEqual([])
    expect(emitted.filter((streamEvent) => streamEvent.kind === 'aborted')).toEqual([])
    expect(emitted.find((streamEvent) => streamEvent.kind === 'compaction')).toMatchObject({
      strategy: 'summary',
      text: 'Portable summary preserving decisions and task state.',
    })
    expect(emitted.find((streamEvent) => streamEvent.kind === 'finish')).toMatchObject({
      usage: {
        input: 157,
        output: 33,
        cachedInput: 2,
        cacheCreate: 1,
        contextInput: 200,
        modelContextWindow: 1_000,
      },
    })

    expect(manager.createCalls).toHaveLength(2)
    expect(manager.resumeCalls).toHaveLength(0)
    expect(manager.disconnectSession).toHaveBeenCalledWith('copilot-session-1')
    expect(manager.deleteSession).toHaveBeenCalledWith('copilot-session-1')
    const continuationPrompt = (manager.sessions[1].sendCalls[0].input as { prompt: string }).prompt
    expect(continuationPrompt).toContain('Previous summary:')
    expect(continuationPrompt).toContain('Portable summary preserving decisions and task state.')
    expect(continuationPrompt).toContain('Continue the same assistant turn')

    const persisted = assistantMessages(conversation.id)[0]
    expect(persisted.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool',
          toolCallId: 'tool-1',
          state: { status: 'completed', output: 'preserved state' },
        }),
        expect.objectContaining({
          type: 'compaction',
          text: 'Portable summary preserving decisions and task state.',
          strategy: 'summary',
        }),
      ])
    )
    expect(getGitHubCopilotSessionBinding(conversation.id)).toMatchObject({
      sessionId: 'copilot-session-2',
      lastMessageId: persisted.id,
    })
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
  })

  it('limits portable compaction to twice per turn', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'continue through many steps', 1)
    const manager = new FakeManager()
    for (const index of [1, 2]) {
      manager.queue((onEvent) => {
        onEvent(event('assistant.message', { messageId: `partial-${index}`, content: `etapa ${index}` }))
        onEvent(event('session.usage_info', { currentTokens: 950, tokenLimit: 1_000, messagesLength: 8 }))
      })
    }
    manager.queue((onEvent) => {
      onEvent(event('assistant.message', { messageId: 'answer-3', content: 'end' }))
      onEvent(event('session.usage_info', { currentTokens: 980, tokenLimit: 1_000, messagesLength: 8 }))
    })
    const compactHistory = vi
      .fn<() => Promise<{ summary: string }>>()
      .mockResolvedValueOnce({ summary: 'summary 1' })
      .mockResolvedValueOnce({ summary: 'summary 2' })

    await runGitHubCopilotChat({
      ...args(conversation.id, workspace.id, cwd, manager),
      contextWindow: 1_000,
      compactHistory,
    })

    expect(compactHistory).toHaveBeenCalledTimes(2)
    expect(manager.createCalls).toHaveLength(3)
    expect(manager.sessions[0].abort).toHaveBeenCalledOnce()
    expect(manager.sessions[1].abort).toHaveBeenCalledOnce()
    expect(manager.sessions[2].abort).not.toHaveBeenCalled()
    expect(getGitHubCopilotSessionBinding(conversation.id)?.sessionId).toBe('copilot-session-3')
  })

  it('ends safely and removes sessions after compaction failure', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'long task whose summary will fail', 1)
    const manager = new FakeManager()
    const emitted: ChatStreamEvent[] = []
    manager.queue((onEvent) => {
      onEvent(event('assistant.message', { messageId: 'partial-1', content: 'Durable partial response.' }))
      onEvent(event('session.usage_info', { currentTokens: 900, tokenLimit: 1_000, messagesLength: 8 }))
      onEvent(event('session.error', { message: 'provider attempt aborted' }))
    })
    const compactHistory = vi.fn(async () => {
      expect(
        assistantMessages(conversation.id)[0].parts.some(
          (part) => part.type === 'text' && part.text.includes('Durable partial response.')
        )
      ).toBe(true)
      throw new Error('summarizer unavailable')
    })

    await expect(
      runGitHubCopilotChat({
        ...args(conversation.id, workspace.id, cwd, manager, (streamEvent) => emitted.push(streamEvent)),
        contextWindow: 1_000,
        compactHistory,
      })
    ).resolves.toEqual({ planSubmitted: false, sessionId: 'copilot-session-1' })

    expect(compactHistory).toHaveBeenCalledOnce()
    expect(manager.sessions[0].abort).toHaveBeenCalledOnce()
    expect(manager.createCalls).toHaveLength(1)
    expect(manager.resumeCalls).toHaveLength(0)
    expect(emitted.filter((streamEvent) => streamEvent.kind === 'finish')).toEqual([])
    expect(emitted.filter((streamEvent) => streamEvent.kind === 'aborted')).toEqual([])
    expect(emitted.filter((streamEvent) => streamEvent.kind === 'compaction')).toEqual([])
    expect(emitted.filter((streamEvent) => streamEvent.kind === 'error')).toEqual([
      expect.objectContaining({ message: 'GitHub Copilot portable intra-turn compaction failed' }),
    ])
    expect(manager.disconnectSession).toHaveBeenCalledWith('copilot-session-1')
    expect(manager.deleteSession).toHaveBeenCalledWith('copilot-session-1')
    expect(getGitHubCopilotSessionBinding(conversation.id)).toBeNull()
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
    expect(
      assistantMessages(conversation.id)[0].parts.some(
        (part) => part.type === 'text' && part.text.includes('Durable partial response.')
      )
    ).toBe(true)
  })

  it('uses official compaction RPC without moving Maestrly history cursors', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'gere contexto', 1)
    const manager = new FakeManager()
    manager.queue((onEvent) => {
      onEvent(event('assistant.message', { messageId: 'answer-1', content: 'long context' }))
    })
    const runInput = args(conversation.id, workspace.id, cwd, manager)
    await runGitHubCopilotChat(runInput)
    const bindingBefore = getGitHubCopilotSessionBinding(conversation.id)
    manager.queue(() => {})

    await expect(
      compactGitHubCopilotSession({
        conversationId: runInput.conversationId,
        projectId: runInput.projectId,
        cwd: runInput.cwd,
        selection: runInput.selection,
        mode: runInput.mode,
        permMode: runInput.permMode,
        reasoningEffort: runInput.reasoningEffort,
        manager: runInput.manager,
        accountIdentity: runInput.accountIdentity,
        broker: runInput.broker,
        questionBroker: runInput.questionBroker,
        signal: runInput.signal,
        customInstructions: 'Preserve decisions and file paths.',
      })
    ).resolves.toEqual({
      sessionId: 'copilot-session-1',
      success: true,
      tokensRemoved: 4_000,
      messagesRemoved: 8,
      summary: 'Official summary',
      contextWindow: { tokenLimit: 200_000, currentTokens: 2_000, messagesLength: 3 },
    })

    expect(manager.resumeCalls).toHaveLength(1)
    expect(manager.sessions[1].rpc.history.compact).toHaveBeenCalledWith({
      customInstructions: 'Preserve decisions and file paths.',
    })
    expect(getGitHubCopilotSessionBinding(conversation.id)).toEqual(bindingBefore)
    expect(manager.disconnectSession).toHaveBeenLastCalledWith('copilot-session-1')
  })

  it('persists ephemeral messages without changing main bindings', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    putGitHubCopilotSessionBinding({
      conversationId: conversation.id,
      sessionId: 'copilot-main',
      modelId: 'gpt-5.6-sol',
      harnessProfile: 'copilot-openai-v1',
      toolSignature: 'main-tools',
      lastMessageId: 'main-assistant',
      accountFingerprint: 'sha256:account-a',
    })
    const mainBefore = structuredClone(getGitHubCopilotSessionBinding(conversation.id))
    const executionId = 'exec-copilot-1'
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
      id: 'iso-user-copilot',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'iso-user-copilot-text', text: 'revise isolated' }],
      createdAt: 1,
      ...messageMeta,
    })
    const manager = new FakeManager()
    manager.queue((onEvent) => {
      onEvent(event('assistant.message', { messageId: 'answer-iso', content: 'ok isolated' }))
      onEvent(
        event('assistant.usage', {
          model: 'gpt-5.6-sol',
          inputTokens: 40,
          outputTokens: 12,
          cacheReadTokens: 5,
          cacheWriteTokens: 0,
          finishReason: 'stop',
        })
      )
    })
    await runGitHubCopilotChat({
      ...args(conversation.id, workspace.id, cwd, manager),
      ephemeralSession: true,
      messageMeta,
      accountIdentity: manager.identity,
    })

    expect(getGitHubCopilotSessionBinding(conversation.id)).toEqual(mainBefore)
    expect(manager.createCalls).toHaveLength(1)
    expect(manager.resumeCalls).toHaveLength(0)
    expect(manager.deleteSession).toHaveBeenCalledWith('copilot-session-1')
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
    const assistants = listChatMessages(conversation.id).filter(
      (m) => m.role === 'assistant' && m.executionScope?.kind === 'review-loop'
    )
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'ok isolated' })])
    )
    expect(assistants[0]?.usage).toMatchObject({ output: 12, cachedInput: 5 })
  })
})
