import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  dispatchBatch: vi.fn(),
  getConversationDispatchService: vi.fn(),
  listConversationDispatchModels: vi.fn(),
  conversationExecutionSettings: vi.fn(),
}))

vi.mock('../../src/main/conversation-dispatch-service', () => ({
  getConversationDispatchService: h.getConversationDispatchService,
  listConversationDispatchModels: h.listConversationDispatchModels,
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
  enableConversationDispatchTools,
  listConversationModelsTool,
  startConversationsTool,
} from '../../src/main/chat/tools/conversation-dispatch'
import type { ToolContext } from '../../src/main/chat/tools/util'
import {
  clearHumanTurnOrigin,
  recordHumanTurnOrigin,
  type HumanTurnOrigin,
} from '../../src/main/chat/conversation-dispatch-authorization'
import { APP_TOOL_POLICY, CONVERSATION_DISPATCH_TOOL_NAMES } from '../../src/main/chat/tool-policy'
import { interactiveTool } from '../../src/main/chat/autonomous'
import { isMaestroWorkerOperationalToolName } from '../../src/main/chat/maestro-worker-tools'
import {
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

  it('is offered only for a human-started main turn in Agent/Design', () => {
    expect(conversationDispatchRuntimeFor('source', 'agent')).toBeUndefined()
    humanTurn('Abra uma conversa para cada card.')
    expect(conversationDispatchRuntimeFor('source', 'agent')).toBeDefined()
    expect(conversationDispatchRuntimeFor('source', 'design')).toBeDefined()
    for (const mode of ['plan', 'ask', 'maestro'] as const) {
      expect(conversationDispatchRuntimeFor('source', mode)).toBeUndefined()
    }
    const enabled = builtinToolNamesForMode('agent')
    expect(enableConversationDispatchTools(enabled, 'source', 'agent')).toBeDefined()
    expect([...CONVERSATION_DISPATCH_TOOL_NAMES].every((name) => enabled.has(name))).toBe(true)
    const restricted = builtinToolNamesForMode('plan')
    expect(enableConversationDispatchTools(restricted, 'source', 'plan')).toBeUndefined()
    expect(CONVERSATION_DISPATCH_TOOL_NAMES.some((name) => restricted.has(name))).toBe(false)
  })

  it('never reaches subagents, Maestro workers or unattended turns', () => {
    const provided = new Set([...CONVERSATION_DISPATCH_TOOL_NAMES, 'read', 'bash'])
    const worker = selectSubagentToolNames({
      definition: { name: 'general-purpose', source: 'built-in' },
      readOnly: false,
      providedHostTools: provided,
    })
    const explicit = selectSubagentToolNames({
      definition: { name: 'custom', tools: ['start_conversations', 'list_conversation_models', 'read'] },
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

  it('denies a non-explicit request before any conversation work', async () => {
    humanTurn('Analise esses cards do Jira e me diga o que falta.')
    const runtime = conversationDispatchRuntimeFor('source', 'agent')!
    const result = await startConversationsTool.execute(BATCH, context({ conversationDispatch: runtime }))
    expect(result).toMatchObject({ ok: false, items: [] })
    expect(result.error).toMatch(/does not explicitly ask/)
    expect(h.getConversationDispatchService).not.toHaveBeenCalled()
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
  ])('%s offers the same guarded tools only in its main, non-reviewer context', (file) => {
    const source = read(file)
    expect(source).toContain('enableConversationDispatchTools(')
    expect(source).toMatch(/const conversationDispatch = args\.reviewerRuntime\s*\?\s*undefined/)
    expect(source).toContain('...(conversationDispatch ? { conversationDispatch } : {})')
  })

  it.each([
    'claude-agent-sdk/subagent-runner.ts',
    'claude-agent-sdk/task-runtime.ts',
    'github-copilot/subagent-runner.ts',
    'cursor-subscription/subagent-runner.ts',
    'maestro-worker-tools.ts',
  ])('%s never forwards the tools to children', (file) => {
    expect(read(file)).toContain('...CONVERSATION_DISPATCH_TOOL_NAMES')
  })

  it('Codex child tool runtimes exclude the tools by name', () => {
    expect(read('codex-subscription/runner.ts').match(/!isConversationDispatchToolName\(/g)).toHaveLength(3)
  })
})
