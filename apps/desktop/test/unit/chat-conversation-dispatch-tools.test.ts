import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  dispatchBatch: vi.fn(),
  getConversationDispatchService: vi.fn(),
  listConversationDispatchModels: vi.fn(),
  listConversationDispatchWorkspaces: vi.fn(),
  conversationExecutionSettings: vi.fn(),
  createWorkspace: vi.fn(),
  getWorkspaceCreationService: vi.fn(),
  findGithubRepositoriesForChat: vi.fn(),
  createdWorkspaceIdsForTurn: vi.fn((_source: string, _origin: string): string[] => []),
  getConfirmConversationDispatch: vi.fn(() => true),
  dispatchOriginsFor: vi.fn((_ids: readonly string[]) => new Map<string, unknown>()),
  resolveConversationDispatchSettingsFor: vi.fn(),
  getConversationMaestroConfig: vi.fn(),
  ensureSwarmTasks: vi.fn(),
}))

vi.mock('../../src/main/store/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/store/settings')>()),
  getConfirmConversationDispatch: h.getConfirmConversationDispatch,
}))
vi.mock('../../src/main/store/conversations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/store/conversations')>()),
  dispatchOriginsFor: h.dispatchOriginsFor,
}))

vi.mock('../../src/main/conversation-dispatch-service', () => ({
  getConversationDispatchService: h.getConversationDispatchService,
  listConversationDispatchModels: h.listConversationDispatchModels,
  listConversationDispatchWorkspaces: h.listConversationDispatchWorkspaces,
  resolveConversationDispatchSettingsFor: h.resolveConversationDispatchSettingsFor,
}))
vi.mock('../../src/main/chat/maestro-config', () => ({
  getConversationMaestroConfig: h.getConversationMaestroConfig,
}))
vi.mock('../../src/main/chat/maestro-swarm', () => ({
  ensureSwarmTasks: h.ensureSwarmTasks,
}))
vi.mock('../../src/main/workspace-creation-service', () => ({
  getWorkspaceCreationService: h.getWorkspaceCreationService,
  findGithubRepositoriesForChat: h.findGithubRepositoriesForChat,
  createdWorkspaceIdsForTurn: h.createdWorkspaceIdsForTurn,
}))
vi.mock('../../src/main/chat/service', () => ({
  conversationExecutionSettings: h.conversationExecutionSettings,
}))

import {
  ALL_TOOL_NAMES,
  buildTools,
  builtinToolNamesForMode,
  isOptInToolName,
  READ_ONLY_TOOL_NAMES,
  selectSubagentToolNames,
} from '../../src/main/chat/tools'
import {
  conversationDispatchRuntimeFor,
  createWorkspaceTool,
  enableConversationDispatchTools,
  findGithubRepositoriesTool,
  listConversationModelsTool,
  listConversationWorkspacesTool,
  startConversationsTool,
} from '../../src/main/chat/tools/conversation-dispatch'
import { parseWorkspaceCreationResult, sameGitRemote } from '../../src/shared/workspace-creation'
import type { ToolContext } from '../../src/main/chat/tools/util'
import {
  clearHumanTurnOrigin,
  isHostTurnAdmission,
  recordHostTurnOrigin,
  recordHumanTurnOrigin,
  type HumanTurnOrigin,
} from '../../src/main/chat/conversation-dispatch-authorization'
import {
  APP_TOOL_POLICY,
  CONVERSATION_DISPATCH_TOOL_NAMES,
  conversationDispatchToolsAllowed,
  PARENT_ONLY_CONVERSATION_TOOL_NAMES,
} from '../../src/main/chat/tool-policy'
import { interactiveTool, registerAutonomousConversation } from '../../src/main/chat/autonomous'
import { isMaestroWorkerOperationalToolName } from '../../src/main/chat/maestro-worker-tools'
import {
  CONVERSATION_DISPATCH_MAX_PROMPT,
  conversationDispatchBranchSlug,
  parseConversationDispatchBatchResult,
} from '../../src/shared/conversation-dispatch'

const recorded: HumanTurnOrigin[] = []

function humanTurn(text: string, conversationId = 'source'): HumanTurnOrigin {
  const origin = { token: {}, conversationId, messageId: 'msg-1', text, signal: new AbortController().signal }
  recordHumanTurnOrigin(origin)
  recorded.push(origin)
  return origin
}

/** A turn the app ran in the conversation: an approved plan, a continuation or a message from another one. */
function hostTurn(conversationId = 'source'): HumanTurnOrigin {
  const origin = { token: {}, conversationId, messageId: 'msg-host', text: '', signal: new AbortController().signal }
  recordHostTurnOrigin(origin)
  recorded.push(origin)
  return origin
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: 'source',
    projectId: 'ws',
    messageId: 'assistant',
    toolCallId: 'call-1',
    cwd: '/repo',
    signal: new AbortController().signal,
    ask: async () => undefined,
    askQuestion: async () => [],
    ...overrides,
  }
}

const BATCH = {
  tasks: [{ requestKey: 'PROJ-1', title: 'PROJ-1', prompt: 'Implement PROJ-1 with tests.' }],
}

afterEach(() => {
  for (const origin of recorded.splice(0)) clearHumanTurnOrigin(origin.conversationId, origin.token)
  vi.clearAllMocks()
  h.createdWorkspaceIdsForTurn.mockReturnValue([])
  h.getConfirmConversationDispatch.mockReturnValue(true)
  h.dispatchOriginsFor.mockReturnValue(new Map())
})

describe('conversation dispatch tool surface', () => {
  it('is a core opt-in built-in, independent of the optional app-tools catalog', () => {
    for (const name of CONVERSATION_DISPATCH_TOOL_NAMES) {
      expect(ALL_TOOL_NAMES).toContain(name)
      expect(isOptInToolName(name)).toBe(true)
      expect(Object.keys(APP_TOOL_POLICY)).not.toContain(name)
      expect(READ_ONLY_TOOL_NAMES).not.toContain(name)
      expect(builtinToolNamesForMode('agent').has(name)).toBe(false)
    }
  })

  it('is offered for human-started Agent, Design, Ask and Maestro turns only', () => {
    expect(conversationDispatchToolsAllowed('maestro')).toBe(true)
    expect(PARENT_ONLY_CONVERSATION_TOOL_NAMES).toContain('swarm_update')
    expect(conversationDispatchRuntimeFor('source', 'agent')).toBeUndefined()
    expect(conversationDispatchRuntimeFor('source', 'ask')).toBeUndefined()
    humanTurn('Abra uma conversa para cada card.')
    expect(conversationDispatchRuntimeFor('source', 'agent')).toBeDefined()
    expect(conversationDispatchRuntimeFor('source', 'design')).toBeDefined()
    expect(conversationDispatchRuntimeFor('source', 'ask')).toBeDefined()
    expect(conversationDispatchRuntimeFor('source', 'maestro')).toBeDefined()
    expect(conversationDispatchRuntimeFor('source', 'plan')).toBeUndefined()
    const enabled = builtinToolNamesForMode('agent')
    expect(enableConversationDispatchTools(enabled, 'source', 'agent')).toBeDefined()
    expect([...CONVERSATION_DISPATCH_TOOL_NAMES].every((name) => enabled.has(name))).toBe(true)
    expect(enabled.has('swarm_update')).toBe(false)
    const maestroEnabled = builtinToolNamesForMode('maestro')
    expect(enableConversationDispatchTools(maestroEnabled, 'source', 'maestro')).toBeDefined()
    expect([...CONVERSATION_DISPATCH_TOOL_NAMES].every((name) => maestroEnabled.has(name))).toBe(true)
    expect(maestroEnabled.has('swarm_update')).toBe(true)
    const restricted = builtinToolNamesForMode('plan')
    expect(enableConversationDispatchTools(restricted, 'source', 'plan')).toBeUndefined()
    expect(CONVERSATION_DISPATCH_TOOL_NAMES.some((name) => restricted.has(name))).toBe(false)
  })

  // A native session is resumed only while its tool set holds: hiding the names from host turns (an approved plan, a
  // review loop, a seeded child) discarded the session at every switch. Those turns see the same names, and nothing
  // acts without the runtime (see 'refuses without the main-turn runtime').
  it('offers the same names to turns the person did not type, without a runtime', () => {
    const host = builtinToolNamesForMode('agent')
    expect(enableConversationDispatchTools(host, 'source', 'agent')).toBeUndefined()
    humanTurn('Abra uma conversa para cada card.')
    const typed = builtinToolNamesForMode('agent')
    expect(enableConversationDispatchTools(typed, 'source', 'agent')).toBeDefined()
    expect([...host].sort()).toEqual([...typed].sort())
    for (const name of CONVERSATION_DISPATCH_TOOL_NAMES) expect(host.has(name)).toBe(true)
  })

  it('leaves unattended executor turns without the names', () => {
    const release = registerAutonomousConversation('source', {
      cwd: '/repo',
      allowCommands: true,
      allowWeb: false,
      allowAppTools: false,
      allowMcp: false,
      allowPush: false,
    })
    try {
      const enabled = builtinToolNamesForMode('agent')
      expect(enableConversationDispatchTools(enabled, 'source', 'agent')).toBeUndefined()
      expect(CONVERSATION_DISPATCH_TOOL_NAMES.some((name) => enabled.has(name))).toBe(false)
    } finally {
      release()
    }
  })

  it('adds only the handoff and project tools to Ask, never edits or commands', () => {
    // Any human Ask turn may get a project created; whether conversations start is checked when the tool runs.
    humanTurn('pega algum repo público qualquer ae e cria lá pra mim')
    const enabled = builtinToolNamesForMode('ask')
    expect(enableConversationDispatchTools(enabled, 'source', 'ask')).toBeDefined()
    for (const name of CONVERSATION_DISPATCH_TOOL_NAMES) expect(enabled.has(name)).toBe(true)
    for (const name of ['bash', 'write', 'edit', 'review_plan']) expect(enabled.has(name)).toBe(false)
  })

  it('never reaches subagents, Maestro workers or unattended turns', () => {
    const provided = new Set([...CONVERSATION_DISPATCH_TOOL_NAMES, 'read', 'bash'])
    const worker = selectSubagentToolNames({
      definition: { name: 'general-purpose', source: 'built-in' },
      readOnly: false,
      providedHostTools: provided,
    })
    const explicit = selectSubagentToolNames({
      definition: { name: 'custom', tools: [...CONVERSATION_DISPATCH_TOOL_NAMES, 'read'] },
      readOnly: false,
      providedHostTools: provided,
    })
    for (const name of CONVERSATION_DISPATCH_TOOL_NAMES) {
      expect(worker.has(name)).toBe(false)
      expect(explicit.has(name)).toBe(false)
      expect(isMaestroWorkerOperationalToolName(name)).toBe(false)
      expect(interactiveTool(name)).toBe(true)
      expect(interactiveTool(`mcp__maestrly__${name}`)).toBe(true)
    }
  })

  it('refuses without the main-turn runtime (child contexts never receive it)', async () => {
    const tools = buildTools({ enabled: new Set(CONVERSATION_DISPATCH_TOOL_NAMES), makeCtx: () => context() })
    const execute = tools.start_conversations.execute as (input: unknown, options: unknown) => Promise<string>
    const output = await execute(BATCH, { toolCallId: 'call-1', messages: [] })
    expect(JSON.parse(output)).toMatchObject({ ok: false, items: [] })
    expect(output).toContain('only works in the main agent turn')
    expect(h.getConversationDispatchService).not.toHaveBeenCalled()
  })

  describe('turns the app ran in the conversation (plan, continuation, peer message)', () => {
    const ready = () => {
      h.dispatchBatch.mockResolvedValue({ ok: true, items: [] })
      h.getConversationDispatchService.mockResolvedValue({ dispatchBatch: h.dispatchBatch })
    }

    it('qualifies only admissions with the person behind them in this app', () => {
      expect(isHostTurnAdmission(undefined)).toBe(false)
      expect(isHostTurnAdmission({ internal: true })).toBe(true)
      expect(isHostTurnAdmission({ peerMessage: {} })).toBe(true)
      expect(isHostTurnAdmission({ dispatchSeed: {} })).toBe(true)
      for (const opts of [
        { internal: true, botAdmission: {} },
        { internal: true, remoteAdmission: true },
        { internal: true, runnerAdmission: {} },
        { internal: true, runnerSignal: {} },
        { internal: true, routineRun: {} },
      ])
        expect(isHostTurnAdmission(opts)).toBe(false)
    })

    it('refuses while the owner keeps the confirmation on', async () => {
      ready()
      hostTurn()
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      expect(runtime).toBeDefined()
      const confirm = vi.fn(async (_questions: unknown) => [['Start']])
      const result = await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime, askQuestion: confirm }))
      expect(result).toMatchObject({ ok: false, items: [] })
      expect(result.error).toMatch(/not started by a message the person typed/)
      expect(confirm).not.toHaveBeenCalled()
      expect(h.dispatchBatch).not.toHaveBeenCalled()
      const listed = await listConversationWorkspacesTool.execute({}, context({ conversationDispatch: runtime }))
      expect(listed).toMatchObject({ error: expect.stringMatching(/not started by a message/) })
    })

    it('starts conversations without asking when the owner turned the confirmation off', async () => {
      ready()
      h.getConfirmConversationDispatch.mockReturnValue(false)
      hostTurn()
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const confirm = vi.fn(async (_questions: unknown) => [["Don't start"]])
      await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime, askQuestion: confirm }))
      expect(confirm).not.toHaveBeenCalled()
      expect(h.dispatchBatch.mock.calls[0][0].grant).toMatchObject({
        maxConversations: null,
        originKey: 'message:msg-host',
      })
    })

    it('never lets a conversation an agent created start others on its own', async () => {
      ready()
      h.getConfirmConversationDispatch.mockReturnValue(false)
      h.dispatchOriginsFor.mockReturnValue(new Map([['source', { sourceConversationId: 'parent' }]]))
      hostTurn()
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const result = await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime }))
      expect(result.error).toMatch(/agent created this conversation/)
      expect(h.dispatchBatch).not.toHaveBeenCalled()
      const created = await createWorkspaceTool.execute(
        { requestKey: 'x', source: { kind: 'new', name: 'x' } } as never,
        context({ conversationDispatch: runtime })
      )
      expect(created).toMatchObject({ ok: false, code: 'unavailable' })
    })

    it('expires with the turn', async () => {
      ready()
      h.getConfirmConversationDispatch.mockReturnValue(false)
      const origin = hostTurn()
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      clearHumanTurnOrigin('source', origin.token)
      expect(conversationDispatchRuntimeFor('source', 'agent')).toBeUndefined()
      const result = await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime }))
      expect(result).toMatchObject({ ok: false, items: [] })
      expect(h.dispatchBatch).not.toHaveBeenCalled()
    })
  })

  describe('Maestro swarm dispatch runtime', () => {
    const POOL = [
      {
        id: 'builder',
        label: 'Builder',
        enabled: true,
        description: 'Implements features',
        mode: 'agent' as const,
        specialties: ['code'],
        candidates: [{ providerId: 'claude', modelId: 'sonnet', effort: 'high', fastMode: false }],
        instructions: 'Write clean TypeScript and unit tests.',
      },
      {
        id: 'designer',
        label: 'Designer',
        enabled: true,
        description: 'Builds visual prototypes',
        mode: 'design' as const,
        specialties: ['ui'],
        candidates: [{ providerId: 'claude', modelId: 'opus', effort: 'high', fastMode: false }],
        instructions: 'Focus on visual polish.',
      },
    ]

    const setupMaestro = () => {
      h.getConversationMaestroConfig.mockReturnValue({
        config: { version: 2, strategy: 'balanced', pool: POOL },
        source: 'global',
        diagnostics: [],
        hasConversationOverride: false,
      })
      h.resolveConversationDispatchSettingsFor.mockImplementation(async (_convId, requested) => ({
        ok: true as const,
        settings: {
          providerId: requested.providerId ?? 'claude',
          modelId: requested.modelId ?? 'sonnet',
          reasoning: requested.reasoning ?? 'high',
          fastMode: requested.fastMode ?? false,
          ...(requested.mode && requested.mode !== 'agent' ? { mode: requested.mode } : {}),
        },
        inherited: [],
      }))
      h.dispatchBatch.mockImplementation(async ({ batch }) => ({
        ok: true,
        items: batch.tasks.map((task: { requestKey: string; title: string }) => ({
          requestKey: task.requestKey,
          title: task.title,
          status: 'started' as const,
          conversationId: `conv-${task.requestKey}`,
        })),
      }))
      h.getConversationDispatchService.mockResolvedValue({ dispatchBatch: h.dispatchBatch })
    }

    it('dispatches from a host origin even with confirmation ON, rewrites worktree/reportBack/prompt, and ensures swarm tasks', async () => {
      setupMaestro()
      h.getConfirmConversationDispatch.mockReturnValue(true)
      hostTurn()
      const runtime = conversationDispatchRuntimeFor('source', 'maestro')!
      expect(runtime).toBeDefined()
      const confirm = vi.fn(async () => [["Don't start"]])
      const result = await startConversationsTool.execute(
        {
          tasks: [{ requestKey: 'T-1', title: 'Build API', prompt: 'Add /health endpoint.', agent: 'builder' }],
        },
        context({ conversationDispatch: runtime, askQuestion: confirm })
      )
      expect(confirm).not.toHaveBeenCalled()
      expect(result.ok).toBe(true)
      expect(h.ensureSwarmTasks).toHaveBeenCalledWith('source', [
        { key: 'T-1', title: 'Build API', resourceId: 'builder' },
      ])
      expect(h.dispatchBatch).toHaveBeenCalledTimes(1)
      const call = h.dispatchBatch.mock.calls[0][0]
      expect(call.grant).toMatchObject({ maxConversations: null, originKey: 'message:msg-host' })
      expect(call.batch.placement).toBe('worktree')
      expect(call.batch.reportBack).toBe(true)
      expect(call.batch.defaults).toBeUndefined()
      expect(call.batch.tasks).toHaveLength(1)
      expect(call.batch.tasks[0]).toMatchObject({
        requestKey: 'T-1',
        title: 'Build API',
        placement: 'worktree',
        reportBack: true,
        settings: { providerId: 'claude', modelId: 'sonnet', reasoning: 'high', fastMode: false },
      })
      expect('agent' in call.batch.tasks[0]).toBe(false)
      expect(call.batch.tasks[0].prompt).toContain('# Role\nWrite clean TypeScript and unit tests.')
      expect(call.batch.tasks[0].prompt).toContain('# Task\nAdd /health endpoint.')
      expect(call.batch.tasks[0].prompt).toContain('# Delivery contract')
    })

    it('dispatches a design resource with settings.mode "design"', async () => {
      setupMaestro()
      humanTurn('Design the dashboard')
      const runtime = conversationDispatchRuntimeFor('source', 'maestro')!
      const result = await startConversationsTool.execute(
        {
          tasks: [{ requestKey: 'UI-1', title: 'Dashboard UI', prompt: 'Create dashboard mockup.', agent: 'designer' }],
        },
        context({ conversationDispatch: runtime })
      )
      expect(result.ok).toBe(true)
      expect(h.ensureSwarmTasks).toHaveBeenCalledWith('source', [
        { key: 'UI-1', title: 'Dashboard UI', resourceId: 'designer' },
      ])
      const dispatchedTask = h.dispatchBatch.mock.calls[0][0].batch.tasks[0]
      expect(dispatchedTask.settings).toMatchObject({
        providerId: 'claude',
        modelId: 'opus',
        mode: 'design',
      })
    })

    it('fails tasks with settings or batch defaults in Maestro', async () => {
      setupMaestro()
      humanTurn('Start work')
      const runtime = conversationDispatchRuntimeFor('source', 'maestro')!
      const withTaskSettings = await startConversationsTool.execute(
        {
          tasks: [
            {
              requestKey: 'T-1',
              title: 'Task 1',
              prompt: 'Do it',
              agent: 'builder',
              settings: { modelId: 'opus' },
            },
          ],
        },
        context({ conversationDispatch: runtime })
      )
      expect(withTaskSettings).toEqual({
        ok: false,
        error: 'No task could be dispatched',
        items: [
          {
            requestKey: 'T-1',
            title: 'Task 1',
            status: 'failed',
            error: 'settings are not accepted in Maestro; choose an Agent Pool resource with agent',
          },
        ],
      })
      expect(h.dispatchBatch).not.toHaveBeenCalled()
      expect(h.ensureSwarmTasks).not.toHaveBeenCalled()

      const withBatchDefaults = await startConversationsTool.execute(
        {
          defaults: { reasoning: 'high' },
          tasks: [{ requestKey: 'T-2', title: 'Task 2', prompt: 'Do it', agent: 'builder' }],
        },
        context({ conversationDispatch: runtime })
      )
      expect(withBatchDefaults).toEqual({
        ok: false,
        error: 'No task could be dispatched',
        items: [
          {
            requestKey: 'T-2',
            title: 'Task 2',
            status: 'failed',
            error: 'settings are not accepted in Maestro; choose an Agent Pool resource with agent',
          },
        ],
      })
      expect(h.dispatchBatch).not.toHaveBeenCalled()
    })

    it('fails tasks with shared placement or missing agent in Maestro', async () => {
      setupMaestro()
      humanTurn('Start work')
      const runtime = conversationDispatchRuntimeFor('source', 'maestro')!
      const res = await startConversationsTool.execute(
        {
          tasks: [
            { requestKey: 'S-1', title: 'Shared', prompt: 'Do it', agent: 'builder', placement: 'shared' },
            { requestKey: 'M-1', title: 'No agent', prompt: 'Do it' },
          ],
        },
        context({ conversationDispatch: runtime })
      )
      expect(res).toEqual({
        ok: false,
        error: 'No task could be dispatched',
        items: [
          {
            requestKey: 'S-1',
            title: 'Shared',
            status: 'failed',
            error: 'Maestro workers always run in their own worktree',
          },
          {
            requestKey: 'M-1',
            title: 'No agent',
            status: 'failed',
            error: 'agent is required in Maestro',
          },
        ],
      })
      expect(h.dispatchBatch).not.toHaveBeenCalled()
    })

    it('fails tasks that would not start from the orchestrator HEAD in Maestro', async () => {
      setupMaestro()
      humanTurn('Start work')
      const runtime = conversationDispatchRuntimeFor('source', 'maestro')!
      const error = "Maestro workers start from this conversation's HEAD; omit target.workspaceId and target.baseBranch"
      const res = await startConversationsTool.execute(
        {
          tasks: [
            { requestKey: 'W-1', title: 'Other workspace', prompt: 'Do it', agent: 'builder', target: { workspaceId: 'ws-2' } },
            { requestKey: 'B-1', title: 'Other base', prompt: 'Do it', agent: 'builder', target: { baseBranch: 'main' } },
          ],
        },
        context({ conversationDispatch: runtime })
      )
      expect(res).toEqual({
        ok: false,
        error: 'No task could be dispatched',
        items: [
          { requestKey: 'W-1', title: 'Other workspace', status: 'failed', error },
          { requestKey: 'B-1', title: 'Other base', status: 'failed', error },
        ],
      })
      expect(h.dispatchBatch).not.toHaveBeenCalled()
    })

    it('fails only an unknown agent task while dispatching the valid task and preserving original order', async () => {
      setupMaestro()
      humanTurn('Start work')
      const runtime = conversationDispatchRuntimeFor('source', 'maestro')!
      const res = await startConversationsTool.execute(
        {
          tasks: [
            { requestKey: 'BAD-1', title: 'Unknown', prompt: 'Do A', agent: 'ghost' },
            { requestKey: 'OK-1', title: 'Valid', prompt: 'Do B', agent: 'builder' },
          ],
        },
        context({ conversationDispatch: runtime })
      )
      expect(res.ok).toBe(true)
      expect(res.items).toHaveLength(2)
      expect(res.items[0]).toMatchObject({
        requestKey: 'BAD-1',
        title: 'Unknown',
        status: 'failed',
        error: expect.stringMatching(/Unknown Agent Pool resource "ghost"/),
      })
      expect(res.items[1]).toMatchObject({
        requestKey: 'OK-1',
        title: 'Valid',
        status: 'started',
        conversationId: 'conv-OK-1',
      })
      expect(h.ensureSwarmTasks).toHaveBeenCalledWith('source', [
        { key: 'OK-1', title: 'Valid', resourceId: 'builder' },
      ])
      expect(h.dispatchBatch).toHaveBeenCalledTimes(1)
      expect(h.dispatchBatch.mock.calls[0][0].batch.tasks.map((t: { requestKey: string }) => t.requestKey)).toEqual([
        'OK-1',
      ])
    })

    it('fails a task when the composed Maestro worker prompt exceeds the max length', async () => {
      setupMaestro()
      humanTurn('Start work')
      const runtime = conversationDispatchRuntimeFor('source', 'maestro')!
      const huge = 'a'.repeat(CONVERSATION_DISPATCH_MAX_PROMPT - 10)
      const res = await startConversationsTool.execute(
        {
          tasks: [{ requestKey: 'HUGE-1', title: 'Too big', prompt: huge, agent: 'builder' }],
        },
        context({ conversationDispatch: runtime })
      )
      expect(res.ok).toBe(false)
      expect(res.error).toBe('No task could be dispatched')
      expect(res.items[0]).toMatchObject({
        requestKey: 'HUGE-1',
        status: 'failed',
        error: expect.stringMatching(/exceeds/i),
      })
      expect(h.dispatchBatch).not.toHaveBeenCalled()
    })

    it('refuses a Maestro conversation created by a dispatch (agent-created)', async () => {
      setupMaestro()
      h.dispatchOriginsFor.mockReturnValue(new Map([['source', { sourceConversationId: 'parent' }]]))
      hostTurn()
      const runtime = conversationDispatchRuntimeFor('source', 'maestro')!
      const res = await startConversationsTool.execute(
        { tasks: [{ requestKey: 'T-1', title: 'Build', prompt: 'Do it', agent: 'builder' }] },
        context({ conversationDispatch: runtime })
      )
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/agent created this conversation/)
      expect(res.items).toEqual([])
      expect(h.dispatchBatch).not.toHaveBeenCalled()
      expect(h.ensureSwarmTasks).not.toHaveBeenCalled()
    })

    it('refuses the whole batch when agent is passed outside Maestro', async () => {
      setupMaestro()
      humanTurn('Abra uma conversa para esse card.')
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const confirm = vi.fn(async () => [['Start']])
      const res = await startConversationsTool.execute(
        { tasks: [{ requestKey: 'T-1', title: 'Task', prompt: 'Do it', agent: 'builder' }] },
        context({ conversationDispatch: runtime, askQuestion: confirm })
      )
      expect(res).toEqual({
        ok: false,
        error: 'agent is only accepted in Maestro conversations',
        items: [],
      })
      expect(confirm).not.toHaveBeenCalled()
      expect(h.dispatchBatch).not.toHaveBeenCalled()
    })
  })

  it('asks the person before a request that is not explicit and starts nothing without an answer', async () => {
    humanTurn('Analise esses cards do Jira e me diga o que falta.')
    const runtime = conversationDispatchRuntimeFor('source', 'agent')!
    const askQuestion = vi.fn(async (_questions: unknown) => [] as string[][])
    const result = await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime, askQuestion }))
    expect(askQuestion).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, items: [] })
    expect(result.error).toMatch(/declined/)
    expect(h.getConversationDispatchService).not.toHaveBeenCalled()
  })

  describe('confirmation of loosely worded requests', () => {
    const LOOSE = 'Manda outro agent revisar o PROJ-1 em paralelo.'
    const ask = (answer: string[][]) => vi.fn(async (_questions: unknown) => answer)
    const ready = () => {
      h.dispatchBatch.mockResolvedValue({ ok: true, items: [] })
      h.getConversationDispatchService.mockResolvedValue({ dispatchBatch: h.dispatchBatch })
    }

    it('starts the conversations the person confirms in the chat', async () => {
      ready()
      humanTurn(LOOSE)
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const confirm = ask([['Start']])
      await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime, askQuestion: confirm }))
      expect(confirm).toHaveBeenCalledTimes(1)
      const [question] = confirm.mock.calls[0][0] as Array<{ header: string; question: string; options: unknown }>
      expect(question.header).toBe('New conversations')
      expect(question.options).toEqual([{ label: 'Start' }, { label: "Don't start" }])
      expect(question.question).toContain('PROJ-1')
      expect(question.question).toContain('this project')
      const grant = h.dispatchBatch.mock.calls[0][0].grant
      expect(grant.maxConversations).toBeNull()
      expect(grant.onlyWorkspaceIds).toBeUndefined()
      expect(grant.originKey).toBe('message:msg-1')
    })

    it('names the target workspace in the question', async () => {
      ready()
      humanTurn(LOOSE)
      h.listConversationDispatchWorkspaces.mockResolvedValue([
        { workspaceId: 'ws-1', name: 'Example', path: '/example', defaultBranch: 'main', branches: ['main'] },
      ])
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const confirm = ask([['Start']])
      const batch = { ...BATCH, target: { workspaceId: 'ws-1' } }
      await startConversationsTool.execute(batch, context({ conversationDispatch: runtime, askQuestion: confirm }))
      const [question] = confirm.mock.calls[0][0] as Array<{ question: string }>
      expect(question.question).toContain('(Example)')
    })

    it.each([
      ['declines', ask([["Don't start"]])],
      ['dismisses the question', ask([])],
      ['cannot be asked', vi.fn(async (_questions: unknown): Promise<string[][]> => {
        throw new Error('Interactive questions are unavailable in an unattended turn.')
      })],
    ])('starts nothing when the person %s', async (_label, askQuestion) => {
      ready()
      humanTurn(LOOSE)
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const result = await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime, askQuestion }))
      expect(result).toMatchObject({ ok: false, items: [] })
      expect(result.error).toMatch(/declined/)
      expect(h.dispatchBatch).not.toHaveBeenCalled()
    })

    it('starts without asking when the owner turned the confirmation off', async () => {
      ready()
      h.getConfirmConversationDispatch.mockReturnValue(false)
      humanTurn(LOOSE)
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const confirm = ask([["Don't start"]])
      await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime, askQuestion: confirm }))
      expect(confirm).not.toHaveBeenCalled()
      expect(h.dispatchBatch).toHaveBeenCalledTimes(1)
      expect(h.dispatchBatch.mock.calls[0][0].grant).toMatchObject({ maxConversations: null, originKey: 'message:msg-1' })
    })

    it('still respects an explicit negation with the confirmation off', async () => {
      h.getConfirmConversationDispatch.mockReturnValue(false)
      humanTurn('Não abra conversas novas, só analise.')
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const result = await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime }))
      expect(result.error).toMatch(/asked NOT/)
      expect(h.getConversationDispatchService).not.toHaveBeenCalled()
    })

    it('respects an explicit negation without asking', async () => {
      humanTurn('Não abra conversas novas, só analise.')
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const confirm = ask([['Start']])
      const result = await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime, askQuestion: confirm }))
      expect(confirm).not.toHaveBeenCalled()
      expect(result.error).toMatch(/asked NOT/)
      expect(h.getConversationDispatchService).not.toHaveBeenCalled()
    })

    it('does not ask when the message is explicit', async () => {
      ready()
      humanTurn('Abra duas conversas novas, uma para cada card.')
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const confirm = ask([['Start']])
      await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime, askQuestion: confirm }))
      expect(confirm).not.toHaveBeenCalled()
      expect(h.dispatchBatch.mock.calls[0][0].grant.maxConversations).toBe(2)
    })

    it('asks once per turn for the same confirmed request keys', async () => {
      ready()
      humanTurn(LOOSE)
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const confirm = ask([['Start']])
      await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime, askQuestion: confirm }))
      await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime, askQuestion: confirm }))
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(h.dispatchBatch).toHaveBeenCalledTimes(2)
      // A different key is a different request and is confirmed again.
      const other = { tasks: [{ ...BATCH.tasks[0], requestKey: 'PROJ-2' }] }
      await startConversationsTool.execute(other, context({ conversationDispatch: runtime, askQuestion: confirm }))
      expect(confirm).toHaveBeenCalledTimes(2)
      // A later turn starts over.
      humanTurn(LOOSE)
      const next = conversationDispatchRuntimeFor('source', 'agent')!
      await startConversationsTool.execute(BATCH, context({ conversationDispatch: next, askQuestion: confirm }))
      expect(confirm).toHaveBeenCalledTimes(3)
    })

    it('skips the question for a project created in the turn, but not for another workspace', async () => {
      ready()
      humanTurn('clona o acme/api e já começa o export')
      const runtime = conversationDispatchRuntimeFor('source', 'agent')!
      const confirm = ask([['Start']])
      h.createdWorkspaceIdsForTurn.mockReturnValue(['ws-new'])
      await startConversationsTool.execute(
        { ...BATCH, target: { workspaceId: 'ws-new' } },
        context({ conversationDispatch: runtime, askQuestion: confirm })
      )
      expect(confirm).not.toHaveBeenCalled()
      expect(h.dispatchBatch.mock.calls[0][0].grant).toMatchObject({ maxConversations: 1, onlyWorkspaceIds: ['ws-new'] })

      await startConversationsTool.execute(
        { tasks: [{ ...BATCH.tasks[0], requestKey: 'OTHER', target: { workspaceId: 'ws-other' } }] },
        context({ conversationDispatch: runtime, askQuestion: confirm })
      )
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(h.dispatchBatch.mock.calls[1][0].grant.onlyWorkspaceIds).toBeUndefined()
    })
  })

  it('passes an explicit request to the dispatch service bound to the admitted turn', async () => {
    const origin = humanTurn('Abra 1 conversa nova para o PROJ-1 com Opus.')
    const runtime = conversationDispatchRuntimeFor('source', 'agent')!
    const expected = {
      ok: true,
      items: [{ requestKey: 'PROJ-1', title: 'PROJ-1', status: 'started', conversationId: 'dest' }],
    }
    h.dispatchBatch.mockResolvedValue(expected)
    h.getConversationDispatchService.mockResolvedValue({ dispatchBatch: h.dispatchBatch })

    const result = await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime }))
    expect(result).toEqual(expected)
    const call = h.dispatchBatch.mock.calls[0][0]
    expect(call.grant).toMatchObject({
      conversationId: 'source',
      messageId: 'msg-1',
      originKey: 'message:msg-1',
      maxConversations: 1,
      token: origin.token,
    })
    expect(call.batch).toEqual(BATCH)
    expect(() => call.assertCurrent()).not.toThrow()
    // A newer turn in the same conversation expires the grant captured for this one.
    humanTurn('Obrigado', 'source')
    expect(() => call.assertCurrent()).toThrow(/no longer active/)
    expect(startConversationsTool.toModelText(BATCH, result)).toBe(JSON.stringify(expected, null, 2))
  })

  it('lists the model catalog with the inherited source settings', async () => {
    humanTurn('Abra uma nova conversa.')
    const runtime = conversationDispatchRuntimeFor('source', 'agent')!
    h.listConversationDispatchModels.mockResolvedValue([
      { providerId: 'claude', providerLabel: 'Claude', modelId: 'opus', reasoningEfforts: ['high'], fastMode: false },
    ])
    h.conversationExecutionSettings.mockReturnValue({ providerId: 'codex', modelId: 'gpt', reasoning: 'off', fastMode: true })
    const result = await listConversationModelsTool.execute({}, context({ conversationDispatch: runtime }))
    expect(result).toEqual({
      models: [expect.objectContaining({ providerId: 'claude', modelId: 'opus' })],
      current: { providerId: 'codex', modelId: 'gpt', reasoning: 'off', fastMode: true },
    })
    expect(await listConversationModelsTool.execute({}, context())).toEqual({
      error: expect.stringContaining('not available here'),
    })
  })

  it('discovers canonical workspaces in a standalone human turn and reports failures', async () => {
    humanTurn('Send this plan for development in workspace Example.')
    const runtime = conversationDispatchRuntimeFor('source', 'agent')!
    const workspaces = [{ workspaceId: 'ws-1', name: 'Example', path: '/example', defaultBranch: 'main', branches: ['main'] }]
    h.listConversationDispatchWorkspaces.mockResolvedValue(workspaces)
    const ctx = context({ projectId: null, conversationDispatch: runtime })
    const result = await listConversationWorkspacesTool.execute({}, ctx)
    expect(result).toEqual({ workspaces })
    expect(listConversationWorkspacesTool.toModelText({}, result)).toBe(JSON.stringify({ workspaces }, null, 2))
    expect(await listConversationWorkspacesTool.execute({}, context())).toEqual({
      error: expect.stringContaining('standalone or project'),
    })
    h.listConversationDispatchWorkspaces.mockRejectedValue(new Error('Workspace catalog unavailable'))
    expect(await listConversationWorkspacesTool.execute({}, ctx)).toEqual({ error: 'Workspace catalog unavailable' })
  })

  it('forwards workspace, branch, base and chosen settings from a standalone handoff', async () => {
    humanTurn('Send this plan for development in workspace Example.')
    const runtime = conversationDispatchRuntimeFor('source', 'agent')!
    const batch = {
      ...BATCH,
      target: { workspaceId: 'ws-1', branch: 'feat/example', baseBranch: 'main' },
      defaults: { providerId: 'codex', modelId: 'gpt', reasoning: 'high', fastMode: true },
    }
    h.dispatchBatch.mockResolvedValue({ ok: true, items: [] })
    h.getConversationDispatchService.mockResolvedValue({ dispatchBatch: h.dispatchBatch })
    await startConversationsTool.execute(batch, context({ projectId: null, conversationDispatch: runtime }))
    expect(h.dispatchBatch).toHaveBeenCalledWith(expect.objectContaining({
      batch,
      grant: expect.objectContaining({ maxConversations: 1, conversationId: 'source' }),
    }))
  })

  it('creates a project in any human turn, however the person phrased it, bound to that turn', async () => {
    const tools = buildTools({ enabled: new Set(CONVERSATION_DISPATCH_TOOL_NAMES), makeCtx: () => context() })
    const execute = tools.create_workspace.execute as (input: unknown, options: unknown) => Promise<string>
    const input = { requestKey: 'octocat/Hello-World', source: { kind: 'github' as const, repo: 'octocat/Hello-World' } }
    const child = JSON.parse(await execute(input, { toolCallId: 'call-1', messages: [] }))
    expect(child).toMatchObject({ ok: false, code: 'unavailable', error: expect.stringContaining('main agent turn') })
    expect(h.getWorkspaceCreationService).not.toHaveBeenCalled()

    const created = { ok: true, requestKey: input.requestKey, workspaceId: 'ws-new', name: 'Hello-World', path: '/p/hw' }
    h.createWorkspace.mockResolvedValue(created)
    h.getWorkspaceCreationService.mockResolvedValue({ create: h.createWorkspace })
    const origin = humanTurn('pega algum repo público qualquer ae e cria lá pra mim')
    const runtime = conversationDispatchRuntimeFor('source', 'ask')!
    expect(await createWorkspaceTool.execute(input, context({ conversationDispatch: runtime }))).toEqual(created)
    const call = h.createWorkspace.mock.calls.at(-1)![0]
    expect(call.grant).toEqual({
      conversationId: 'source',
      messageId: 'msg-1',
      originKey: 'message:msg-1',
      token: origin.token,
      signal: origin.signal,
    })
    expect(call.input).toEqual(input)
    expect(createWorkspaceTool.toModelText(input, created)).toBe(JSON.stringify(created, null, 2))

    // The grant ends with its turn.
    expect(() => call.assertCurrent()).not.toThrow()
    humanTurn('valeu')
    expect(() => call.assertCurrent()).toThrow(/no longer active/)
  })

  it('asks the person in the chat before a repository becomes public', async () => {
    humanTurn('cria um projeto Atlas público no GitHub')
    const runtime = conversationDispatchRuntimeFor('source', 'agent')!
    h.createWorkspace.mockImplementation(async ({ confirmPublic }) => ({ ok: true, choice: await confirmPublic('octo/Atlas') }))
    h.getWorkspaceCreationService.mockResolvedValue({ create: h.createWorkspace })
    const input = { requestKey: 'atlas', name: 'Atlas', source: { kind: 'new' as const, github: { create: true, visibility: 'public' as const } } }
    const ask = (answer: string[][]) => vi.fn(async (_questions: unknown) => answer)

    const confirm = ask([['Create public']])
    expect(await createWorkspaceTool.execute(input, context({ conversationDispatch: runtime, askQuestion: confirm }))).toEqual(
      { ok: true, choice: 'public' }
    )
    expect(confirm.mock.calls[0][0]).toEqual([
      {
        header: 'Public repository',
        question: 'Create octo/Atlas on GitHub as a PUBLIC repository? Anyone will be able to see it.',
        options: [{ label: 'Create public' }, { label: 'Make it private' }, { label: 'Cancel' }],
      },
    ])
    const answers: Array<[string[][], string]> = [
      [[['Make it private']], 'private'],
      [[['Cancel']], 'cancel'],
      [[], 'cancel'],
      [[['something else']], 'cancel'],
    ]
    for (const [answer, choice] of answers) {
      const result = await createWorkspaceTool.execute(input, context({ conversationDispatch: runtime, askQuestion: ask(answer) }))
      expect(result).toEqual({ ok: true, choice })
    }
  })

  it('starts one conversation in a project created in the turn without a separate request', async () => {
    h.dispatchBatch.mockResolvedValue({ ok: true, items: [] })
    h.getConversationDispatchService.mockResolvedValue({ dispatchBatch: h.dispatchBatch })
    const batch = { ...BATCH, target: { workspaceId: 'ws-new' } }

    humanTurn('clona o acme/api e já começa o export')
    const runtime = conversationDispatchRuntimeFor('source', 'agent')!
    // Nothing created yet: the person must confirm, and an unanswered question starts nothing.
    expect(await startConversationsTool.execute(batch, context({ conversationDispatch: runtime }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/declined/),
    })
    expect(h.getConversationDispatchService).not.toHaveBeenCalled()

    h.createdWorkspaceIdsForTurn.mockReturnValueOnce(['ws-new'])
    await startConversationsTool.execute(batch, context({ conversationDispatch: runtime }))
    expect(h.createdWorkspaceIdsForTurn).toHaveBeenLastCalledWith('source', 'message:msg-1')
    expect(h.dispatchBatch.mock.calls[0][0].grant).toMatchObject({ maxConversations: 1, onlyWorkspaceIds: ['ws-new'] })

    // An explicit "no conversations" wins even after the project exists.
    humanTurn('clona o acme/api, mas não abra nenhuma conversa nova')
    const negated = conversationDispatchRuntimeFor('source', 'agent')!
    h.createdWorkspaceIdsForTurn.mockReturnValueOnce(['ws-new'])
    expect(await startConversationsTool.execute(batch, context({ conversationDispatch: negated }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/NOT to open/),
    })
    expect(h.dispatchBatch).toHaveBeenCalledTimes(1)
  })

  it('looks up GitHub repositories through the main-turn runtime only', async () => {
    expect(await findGithubRepositoriesTool.execute({ query: 'api' }, context())).toEqual({
      error: expect.stringContaining('not available here'),
    })
    humanTurn('Clone acme/api and start working on issue 12.')
    const runtime = conversationDispatchRuntimeFor('source', 'agent')!
    const repositories = [
      { nameWithOwner: 'acme/api', url: 'https://github.com/acme/api', defaultBranch: 'main', visibility: 'private', description: null },
    ]
    h.findGithubRepositoriesForChat.mockResolvedValue({ repositories })
    expect(
      await findGithubRepositoriesTool.execute({ query: 'api', owner: 'acme' }, context({ conversationDispatch: runtime }))
    ).toEqual({ repositories })
    expect(h.findGithubRepositoriesForChat).toHaveBeenCalledWith({ query: 'api', owner: 'acme' }, expect.any(AbortSignal))
  })

  it('validates project sources at the schema boundary', () => {
    const schema = createWorkspaceTool.parameters
    expect(schema.safeParse({ requestKey: 'k', source: { kind: 'github', repo: 'acme/api' } }).success).toBe(true)
    expect(schema.safeParse({ requestKey: 'k', source: { kind: 'git', url: 'git@github.com:acme/api.git' } }).success).toBe(
      true
    )
    expect(
      schema.safeParse({ requestKey: 'k', name: 'Atlas', source: { kind: 'new', github: { create: true } } }).success
    ).toBe(true)
    expect(schema.safeParse({ requestKey: 'k', source: { kind: 'github' } }).success, 'repo required').toBe(false)
    expect(schema.safeParse({ requestKey: 'k', source: { kind: 'github', repo: 'acme' } }).success).toBe(false)
    expect(schema.safeParse({ requestKey: 'k', source: { kind: 'new' } }).success, 'name required').toBe(false)
    expect(
      schema.safeParse({ requestKey: 'k', source: { kind: 'github', repo: 'a/b', github: { create: true } } }).success,
      'github.create only for new projects'
    ).toBe(false)
    expect(schema.safeParse({ requestKey: 'k', name: 'x', source: { kind: 'new' }, explicit: true }).success).toBe(false)
  })

  it('rejects malformed batches at the schema boundary', () => {
    const schema = startConversationsTool.parameters
    expect(schema.safeParse(BATCH).success).toBe(true)
    expect(schema.safeParse({ tasks: [] }).success).toBe(false)
    expect(
      schema.safeParse({ tasks: [BATCH.tasks[0], BATCH.tasks[0]] }).success,
      'duplicate request keys'
    ).toBe(false)
    expect(schema.safeParse({ tasks: Array.from({ length: 21 }, (_, i) => ({ ...BATCH.tasks[0], requestKey: `K${i}` })) }).success).toBe(false)
    expect(schema.safeParse({ ...BATCH, defaults: { fastMode: 'yes' } }).success).toBe(false)
    expect(schema.safeParse({ ...BATCH, explicit: true }).success, 'no self-declared authorization').toBe(false)
  })
})

describe('conversation dispatch presentation helpers', () => {
  it('parses a tool result for the card and drops malformed rows', () => {
    const parsed = parseConversationDispatchBatchResult(
      JSON.stringify({
        ok: true,
        notes: ['note', 3],
        items: [
          { requestKey: 'A', title: 'A', status: 'started', conversationId: 'c1', placement: 'worktree', replayed: true },
          { requestKey: 'B', title: 'B', status: 'exploded' },
          'junk',
        ],
      })
    )
    expect(parsed).toEqual({
      ok: true,
      notes: ['note'],
      items: [{ requestKey: 'A', title: 'A', status: 'started', conversationId: 'c1', placement: 'worktree', replayed: true }],
    })
    expect(parseConversationDispatchBatchResult('Plain text error')).toBeNull()
    expect(parseConversationDispatchBatchResult('{"ok":true}')).toBeNull()
  })

  it('parses a create_workspace result for the card', () => {
    expect(
      parseWorkspaceCreationResult(
        JSON.stringify({
          ok: true,
          requestKey: 'acme/api',
          source: { kind: 'github', label: 'acme/api' },
          workspaceId: 'ws',
          name: 'api',
          path: '/p/api',
          defaultBranch: 'main',
          reused: true,
          remote: { status: 'failed', error: 'exists', extra: 1 },
          unknown: 'dropped',
        })
      )
    ).toEqual({
      ok: true,
      requestKey: 'acme/api',
      source: { kind: 'github', label: 'acme/api' },
      workspaceId: 'ws',
      name: 'api',
      path: '/p/api',
      defaultBranch: 'main',
      reused: true,
      remote: { status: 'failed', error: 'exists' },
    })
    expect(parseWorkspaceCreationResult('{"ok":false,"code":"projects-directory-not-set","error":"Set it"}')).toEqual({
      ok: false,
      code: 'projects-directory-not-set',
      error: 'Set it',
    })
    expect(parseWorkspaceCreationResult('{"ok":true,"source":{"kind":"svn","label":"x"}}')).toEqual({ ok: true })
    expect(parseWorkspaceCreationResult('Plain text')).toBeNull()
  })

  it('compares git remotes across URL forms', () => {
    expect(sameGitRemote('git@github.com:Acme/API.git', 'https://github.com/acme/api')).toBe(true)
    expect(sameGitRemote('ssh://git@github.com/acme/api.git', 'https://github.com/acme/api/')).toBe(true)
    expect(sameGitRemote('file:///tmp/remote.git', '/tmp/remote')).toBe(true)
    expect(sameGitRemote('https://gitlab.com/Acme/api', 'https://gitlab.com/acme/api')).toBe(false)
    expect(sameGitRemote('https://github.com/acme/api', 'https://github.com/acme/web')).toBe(false)
  })

  it('makes branch-safe slugs from card titles', () => {
    expect(conversationDispatchBranchSlug('PROJ-12 · Exportar relatório (CSV)')).toBe('proj-12-exportar-relatorio-csv')
    expect(conversationDispatchBranchSlug('***')).toBe('task')
    expect(conversationDispatchBranchSlug('x'.repeat(80))).toHaveLength(40)
  })
})


describe('conversation dispatch wiring across runtimes', () => {
  const read = (file: string) => readFileSync(new URL(`../../src/main/chat/${file}`, import.meta.url), 'utf8')

  it.each([
    'runner.ts',
    'claude-agent-sdk/runner.ts',
    'codex-subscription/runner.ts',
    'github-copilot/runner.ts',
    'cursor-subscription/runner.ts',
  ])('%s offers the same guarded tools only in its main context', (file) => {
    const source = read(file)
    expect(source).toContain('enableConversationDispatchTools(')
    expect(source).toMatch(/const conversationDispatch = enableConversationDispatchTools\(/)
    expect(source).toContain('...(conversationDispatch ? { conversationDispatch } : {})')
  })

  it.each([
    'claude-agent-sdk/subagent-runner.ts',
    'claude-agent-sdk/task-runtime.ts',
    'github-copilot/subagent-runner.ts',
    'cursor-subscription/subagent-runner.ts',
    'maestro-worker-tools.ts',
  ])('%s never forwards the tools to children', (file) => {
    expect(read(file)).toContain('...PARENT_ONLY_CONVERSATION_TOOL_NAMES')
  })

  it('Codex child tool runtimes exclude the tools by name', () => {
    expect(read('codex-subscription/runner.ts').match(/!isParentOnlyConversationToolName\(/g)).toHaveLength(3)
  })
})
