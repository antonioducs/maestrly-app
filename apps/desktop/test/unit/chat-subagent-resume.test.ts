import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { freshDb, closeDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getDb } from '../../src/main/store'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import {
  claudeSubagentRuntimeSignature,
  planSubagentResume,
  recreatedTask,
  releaseTurnDelegationRuntimes,
  resolveSubagentResume,
} from '../../src/main/chat/subagent-resume'
import {
  createSubagentSession,
  getSubagentRuntimeHandle,
  updateSubagentSession,
  upsertSubagentTranscriptPart,
} from '../../src/main/chat/subagent-session-store'
import { listCodexThreadCleanup, queueCodexThreadCleanup } from '../../src/main/chat/codex-subscription/thread-store'
import { listClaudeSessionCleanup, queueClaudeSessionCleanup } from '../../src/main/chat/claude-agent-sdk/session-store'

const codexHandle = { kind: 'codex-thread' as const, threadId: 'thread_1', accountId: null, toolSignature: 'sig-a' }
const claudeHandle = { kind: 'claude-session' as const, sessionId: 'sess_1', cwd: '/w', accountId: 'acc' }
const claudeContractHandle = {
  ...claudeHandle,
  modelId: 'claude-fable-5-1',
  behaviorProfileId: 'maestrly-fable-5.1-v1',
  runtimeSignature: 'runtime-a',
}

const replay = [
  { role: 'user' as const, content: 'Build it.' },
  { role: 'assistant' as const, content: '[tool read → completed]\nDone.' },
]

describe('planSubagentResume', () => {
  it.each([
    [
      'byok without transcript',
      { providerId: 'openai', accountId: null, resume: { handle: null, replay: [] } },
      'no-transcript',
    ],
    [
      'copilot worker',
      { providerId: 'builtin_github_copilot_subscription', accountId: null, resume: { handle: null, replay } },
      'provider-unsupported',
    ],
    [
      'no handle',
      { providerId: 'builtin_codex_subscription', accountId: null, resume: { handle: null } },
      'no-runtime-handle',
    ],
    [
      'handle from another provider kind',
      { providerId: 'builtin_codex_subscription', accountId: null, resume: { handle: claudeHandle } },
      'provider-mismatch',
    ],
    [
      'account changed',
      { providerId: 'builtin_codex_subscription', accountId: 'other', resume: { handle: codexHandle } },
      'account-changed',
    ],
    [
      'codex tools changed',
      {
        providerId: 'builtin_codex_subscription',
        accountId: null,
        toolSignature: 'sig-b',
        resume: { handle: codexHandle },
      },
      'tools-changed',
    ],
  ])('recreates when %s', (_label, input, reason) => {
    expect(planSubagentResume(input)).toEqual({ mode: 'recreate', reason })
  })

  it('replays the previous turn as history for stateless BYOK providers', () => {
    expect(planSubagentResume({ providerId: 'openai', accountId: null, resume: { handle: null, replay } })).toEqual({
      mode: 'replay',
      history: replay,
    })
  })

  it('resumes natively when provider, account and tools match', () => {
    expect(
      planSubagentResume({
        providerId: 'builtin_codex_subscription',
        accountId: null,
        toolSignature: 'sig-a',
        resume: { handle: codexHandle },
      })
    ).toEqual({ mode: 'native', handle: codexHandle })
    expect(
      planSubagentResume({
        providerId: 'builtin_claude_subscription@acc',
        accountId: 'acc',
        resume: { handle: claudeHandle },
      })
    ).toEqual({ mode: 'native', handle: claudeHandle })
  })

  it('binds persistent Claude workers to model, behavior version and definition', () => {
    const base = {
      providerId: 'builtin_claude_subscription@acc',
      accountId: 'acc',
      modelId: 'claude-fable-5-1',
      behaviorProfileId: 'maestrly-fable-5.1-v1',
      runtimeSignature: 'runtime-a',
      resume: { handle: claudeContractHandle },
    }
    expect(planSubagentResume(base)).toEqual({ mode: 'native', handle: claudeContractHandle })
    expect(planSubagentResume({ ...base, modelId: 'claude-sonnet-5' })).toEqual({
      mode: 'recreate',
      reason: 'model-changed',
    })
    expect(planSubagentResume({ ...base, behaviorProfileId: null })).toEqual({
      mode: 'recreate',
      reason: 'behavior-profile-changed',
    })
    expect(planSubagentResume({ ...base, runtimeSignature: 'runtime-b' })).toEqual({
      mode: 'recreate',
      reason: 'definition-changed',
    })
    expect(planSubagentResume({ ...base, resume: { handle: claudeHandle } })).toEqual({
      mode: 'recreate',
      reason: 'model-changed',
    })
  })

  it('builds deterministic Claude worker signatures from sorted tools and behavior', () => {
    const base = {
      modelId: 'claude-fable-5-1',
      behaviorProfileId: 'maestrly-fable-5.1-v1',
      prompt: 'p',
      readOnly: true,
      sentEffort: 'high',
      fastMode: false,
    }
    expect(claudeSubagentRuntimeSignature({ ...base, toolNames: ['grep', 'read'] })).toBe(
      claudeSubagentRuntimeSignature({ ...base, toolNames: ['read', 'grep'] })
    )
    expect(claudeSubagentRuntimeSignature({ ...base, toolNames: ['read'] })).not.toBe(
      claudeSubagentRuntimeSignature({ ...base, toolNames: ['read', 'grep'] })
    )
    expect(claudeSubagentRuntimeSignature({ ...base, toolNames: ['read'], sentEffort: 'max' })).not.toBe(
      claudeSubagentRuntimeSignature({ ...base, toolNames: ['read'] })
    )
    expect(claudeSubagentRuntimeSignature({ ...base, toolNames: ['read'], fastMode: true })).not.toBe(
      claudeSubagentRuntimeSignature({ ...base, toolNames: ['read'] })
    )
  })
})

describe('recreatedTask', () => {
  it('labels the previous report with agent, session and reason before the new task', () => {
    const task = recreatedTask(
      'Apply findings F-1..F-3.',
      { sessionId: 'subagent-x', agentName: 'reviewer', lastReport: 'NOT APPROVED: F-1 …' },
      'resume-rejected'
    )
    expect(task).toContain('<maestrly-previous-turn agent="reviewer" session="subagent-x" reason="resume-rejected">')
    expect(task).toContain('NOT APPROVED: F-1 …')
    expect(task.trim().endsWith('Apply findings F-1..F-3.')).toBe(true)
    expect(recreatedTask('t', { sessionId: 's', agentName: 'a', lastReport: '   ' }, 'no-runtime-handle')).toContain(
      '(the previous turn returned no text)'
    )
  })
})

describe('resolveSubagentResume / releaseTurnDelegationRuntimes', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  function fixture() {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { experience: 'maestro' })
    const parentMessageId = 'maestro-parent'
    upsertChatMessage({
      id: parentMessageId,
      conversationId: conversation.id,
      role: 'assistant',
      parts: [],
      createdAt: 1,
    })
    return { conversation, parentMessageId }
  }

  it('renders the previous task and the assistant work (text + tools) as replay history', () => {
    const { conversation, parentMessageId } = fixture()
    const session = createSubagentSession({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'd-replay',
      origin: 'delegate',
      agentName: 'author',
      task: 'Implement the panel.',
    })
    upsertSubagentTranscriptPart({
      sessionId: session.id,
      partId: 'tool-1',
      position: 1,
      part: {
        type: 'tool',
        id: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'read',
        input: { path: 'src/panel.tsx' },
        state: { status: 'completed', output: 'export const Panel = () => null' },
      },
    })
    upsertSubagentTranscriptPart({
      sessionId: session.id,
      partId: 't1',
      position: 2,
      part: { type: 'text', id: 't1', text: 'Panel done.' },
    })
    updateSubagentSession(session.id, { status: 'completed', finishedAt: 2 })
    const resolved = resolveSubagentResume(session.id)!
    expect(resolved.replay).toHaveLength(2)
    expect(resolved.replay[0]).toEqual({ role: 'user', content: 'Implement the panel.' })
    expect(resolved.replay[1]?.role).toBe('assistant')
    expect(resolved.replay[1]?.content.startsWith('Assistant:')).toBe(false)
    expect(resolved.replay[1]?.content).toContain('[tool read → completed]')
    expect(resolved.replay[1]?.content).toContain('src/panel.tsx')
    expect(resolved.replay[1]?.content).toContain('Panel done.')
    expect(resolved.lastReport).toBe('Panel done.')

    const empty = createSubagentSession({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'd-empty',
      origin: 'delegate',
      agentName: 'author',
      task: 'Nothing happened.',
    })
    updateSubagentSession(empty.id, { status: 'failed', finishedAt: 2 })
    expect(resolveSubagentResume(empty.id)?.replay).toEqual([])
  })

  it('reads the last assistant report clipped to 8k and the stored handle', () => {
    const { conversation, parentMessageId } = fixture()
    const session = createSubagentSession({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'd-1',
      origin: 'delegate',
      agentName: 'author',
      task: 'Do it.',
    })
    upsertSubagentTranscriptPart({
      sessionId: session.id,
      partId: 't1',
      position: 1,
      part: { type: 'text', id: 't1', text: 'first' },
    })
    upsertSubagentTranscriptPart({
      sessionId: session.id,
      partId: 't2',
      position: 2,
      part: { type: 'text', id: 't2', text: 'x'.repeat(9_000) },
    })
    updateSubagentSession(session.id, { status: 'completed', finishedAt: 2, runtimeHandle: codexHandle })
    const resolved = resolveSubagentResume(session.id)
    expect(resolved).toMatchObject({ sessionId: session.id, agentName: 'author', handle: codexHandle })
    expect(resolved?.lastReport.length).toBe(8_001)
    expect(resolved?.lastReport.endsWith('…')).toBe(true)
    expect(resolveSubagentResume('missing')).toBeNull()
  })

  it('deletes each terminal handle once, treats "not found" as success, keeps failures for the sweeper', async () => {
    const { conversation, parentMessageId } = fixture()
    const make = (toolCallId: string, agentName: string) =>
      createSubagentSession({
        conversationId: conversation.id,
        parentMessageId,
        toolCallId,
        origin: 'delegate',
        agentName,
        task: 't',
      })
    const codex = make('d-codex', 'author')
    const claude = make('d-claude', 'reviewer')
    const missing = make('d-missing', 'scout')
    const failing = make('d-failing', 'tester')
    const live = make('d-live', 'worker')
    updateSubagentSession(codex.id, { status: 'completed', finishedAt: 2, runtimeHandle: codexHandle })
    updateSubagentSession(claude.id, { status: 'failed', finishedAt: 2, runtimeHandle: claudeHandle })
    updateSubagentSession(missing.id, {
      status: 'completed',
      finishedAt: 2,
      runtimeHandle: { ...codexHandle, threadId: 'thread_gone' },
    })
    updateSubagentSession(failing.id, {
      status: 'completed',
      finishedAt: 2,
      runtimeHandle: { ...codexHandle, threadId: 'thread_stuck' },
    })
    updateSubagentSession(live.id, { runtimeHandle: { ...codexHandle, threadId: 'thread_live' } })
    queueCodexThreadCleanup(conversation.id, 'thread_1', null)
    queueCodexThreadCleanup(conversation.id, 'thread_stuck', null)
    queueClaudeSessionCleanup(conversation.id, 'sess_1', '/w', 'acc')

    const deleteCodexThread = vi.fn(async (threadId: string) => {
      if (threadId === 'thread_gone') throw new Error('thread not found')
      if (threadId === 'thread_stuck') throw new Error('app-server unreachable')
    })
    const deleteClaudeSession = vi.fn(async () => {})
    const outcome = await releaseTurnDelegationRuntimes(conversation.id, parentMessageId, {
      deleteCodexThread,
      deleteClaudeSession,
    })

    expect(outcome.released.sort()).toEqual([claude.id, codex.id, missing.id].sort())
    expect(outcome.failed).toEqual([failing.id])
    expect(deleteCodexThread).toHaveBeenCalledTimes(3)
    expect(deleteClaudeSession).toHaveBeenCalledWith('sess_1', '/w', 'acc')
    expect(getSubagentRuntimeHandle(codex.id)).toBeNull()
    expect(getSubagentRuntimeHandle(claude.id)).toBeNull()
    expect(getSubagentRuntimeHandle(missing.id)).toBeNull()
    expect(getSubagentRuntimeHandle(failing.id)).not.toBeNull()
    expect(getSubagentRuntimeHandle(live.id)).not.toBeNull()
    expect(listCodexThreadCleanup().map((item) => item.threadId)).toEqual(['thread_stuck'])
    expect(listClaudeSessionCleanup()).toEqual([])

    const again = await releaseTurnDelegationRuntimes(conversation.id, parentMessageId, {
      deleteCodexThread,
      deleteClaudeSession,
    })
    expect(again.released).toEqual([])
    expect(deleteCodexThread).toHaveBeenCalledTimes(4)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM chat_subagent_sessions').get()).toEqual({ n: 5 })
  })
})

describe('Claude rotation resume identity', () => {
  it('recreates a Maestro worker when the selected fallback account differs from the persisted handle', () => {
    expect(
      planSubagentResume({
        providerId: 'builtin_claude_subscription@acc_b',
        accountId: 'acc_b',
        resume: { handle: { ...claudeContractHandle, accountId: 'acc_a' } },
      })
    ).toEqual({ mode: 'recreate', reason: 'account-changed' })
  })

  it('invalidates native resume after a login identity changes in the same account slot', () => {
    const contract = {
      modelId: 'claude-fable-5-1',
      behaviorProfileId: 'maestrly-fable-5.1-v1',
      prompt: 'Finish the delegated task.',
      readOnly: false,
      sentEffort: 'high',
      fastMode: true,
      toolNames: ['read', 'bash'],
    }
    const oldSignature = claudeSubagentRuntimeSignature({
      ...contract,
      accountIdentity: { fingerprint: 'account-a', epoch: 1 },
    })
    const nextSignature = claudeSubagentRuntimeSignature({
      ...contract,
      accountIdentity: { fingerprint: 'account-b', epoch: 2 },
    })
    expect(nextSignature).not.toBe(oldSignature)
    expect(
      planSubagentResume({
        providerId: 'builtin_claude_subscription',
        accountId: null,
        runtimeSignature: nextSignature,
        resume: { handle: { ...claudeContractHandle, accountId: null, runtimeSignature: oldSignature } },
      })
    ).toEqual({ mode: 'recreate', reason: 'definition-changed' })
  })
})

describe('Maestro Claude rotation persistence', () => {
  beforeEach(freshDb)
  afterEach(() => {
    vi.restoreAllMocks()
    closeDb()
  })

  it('recreates on the selected account and persists that account in the native handle and cleanup tombstone', async () => {
    const { executeSubagent } = await import('../../src/main/chat/subagent-executor')
    const workerTools = await import('../../src/main/chat/maestro-worker-tools')
    const adapter = await import('../../src/main/chat/subscription-failover/claude-adapter')
    const { getSubagentSession } = await import('../../src/main/chat/subagent-session-store')
    vi.spyOn(workerTools, 'buildMaestroWorkerTools').mockResolvedValue({
      tools: {},
      skillCatalog: '',
      deferredToolNames: new Set(),
      close: async () => {},
    } as never)
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { experience: 'maestro' })
    upsertChatMessage({
      id: 'maestro-parent',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [],
      createdAt: 1,
    })
    const previous = createSubagentSession({
      conversationId: conversation.id,
      parentMessageId: 'maestro-parent',
      toolCallId: 'previous-card',
      origin: 'delegate',
      agentName: 'reviewer',
      task: 'Previous task',
      startedAt: 1,
    })
    updateSubagentSession(previous.id, {
      status: 'completed',
      finishedAt: 2,
      runtimeHandle: { ...claudeContractHandle, accountId: 'acc_a' },
    })
    upsertSubagentTranscriptPart({
      sessionId: previous.id,
      messageId: 'previous-answer',
      role: 'assistant',
      partId: 'previous-answer-text',
      position: 0,
      part: { type: 'text', id: 'previous-answer-text', text: 'Previous report: ticket-42 already created.' },
    })
    let submittedPrompt: unknown
    const query = {
      initializationResult: async () => ({ account: { apiProvider: 'firstParty' } }),
      close: vi.fn(),
      interrupt: vi.fn(async () => {}),
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'new-physical-session',
          result: 'Continued work.',
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0.01,
        }
      },
    }
    const manager = {
      createQuery: vi.fn((input: { prompt: unknown }) => {
        submittedPrompt = input.prompt
        return query
      }),
      assertAccountIdentity: vi.fn(),
      assertSubscriptionRuntimeAccount: vi.fn(),
    }
    const target = {
      providerId: 'builtin_claude_subscription@acc_b',
      accountId: 'acc_b',
      manager,
      accountIdentity: { fingerprint: 'account-b', epoch: 2 },
      model: { value: 'sonnet' },
      runtimeModelId: 'claude-sonnet',
      reasoningEffort: 'high',
      fastMode: false,
      maestrlyUltra: false,
      contextWindow: 200_000,
    }
    vi.spyOn(adapter, 'resolveClaudeRuntimeTarget').mockResolvedValue({
      ok: true,
      target:
        target as unknown as import('../../src/main/chat/subscription-failover/claude-adapter').ClaudeRuntimeTarget,
    })
    vi.spyOn(adapter, 'settleClaudeAttempt').mockImplementation(() => {})
    const result = await executeSubagent({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: conversation.cwd,
      parentMessageId: 'maestro-parent',
      toolCallId: 'continued-card',
      mode: 'maestro',
      permMode: 'ask',
      maestroSnapshot: { resumedFrom: previous.id } as never,
      profile: {
        version: 1,
        agentName: 'reviewer',
        effective: {
          providerId: 'builtin_claude_subscription',
          modelId: 'sonnet',
          configuredEffort: 'high',
          sentEffort: 'high',
          source: 'conversation-default',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: { name: 'reviewer', description: 'Review', prompt: 'Finish the work.', source: 'test' },
      agentName: 'reviewer',
      task: 'Continue the previous work.',
      readOnly: false,
      tools: {},
      broker: {} as never,
      questionBroker: {} as never,
      signal: new AbortController().signal,
    })
    expect(result.text).toBe('Continued work.')
    const { listSubagentSessions } = await import('../../src/main/chat/subagent-session-store')
    const current = listSubagentSessions(conversation.id).find((session) => session.toolCallId === 'continued-card')!
    expect(getSubagentSession(current.id)).toMatchObject({ resumeStatus: 'recreated', resumeReason: 'account-changed' })
    expect(getSubagentRuntimeHandle(current.id)).toMatchObject({
      kind: 'claude-session',
      sessionId: 'new-physical-session',
      accountId: 'acc_b',
      modelId: 'claude-sonnet',
      runtimeSignature: expect.any(String),
    })
    expect(listClaudeSessionCleanup()).toContainEqual(
      expect.objectContaining({ sessionId: 'new-physical-session', accountId: 'acc_b' })
    )
    expect(manager.createQuery.mock.calls[0][0]).not.toHaveProperty('options.resume')
    const messages: unknown[] = []
    for await (const message of submittedPrompt as AsyncIterable<unknown>) messages.push(message)
    expect(JSON.stringify(messages)).toContain('ticket-42 already created')
  })
})
