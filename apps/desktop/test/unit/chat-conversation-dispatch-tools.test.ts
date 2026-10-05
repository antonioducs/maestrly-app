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
}))

vi.mock('../../src/main/conversation-dispatch-service', () => ({
  getConversationDispatchService: h.getConversationDispatchService,
  listConversationDispatchModels: h.listConversationDispatchModels,
  listConversationDispatchWorkspaces: h.listConversationDispatchWorkspaces,
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

  it('is offered for human-started Agent, Design and Ask turns only', () => {
    expect(conversationDispatchRuntimeFor('source', 'agent')).toBeUndefined()
    expect(conversationDispatchRuntimeFor('source', 'ask')).toBeUndefined()
    humanTurn('Abra uma conversa para cada card.')
    expect(conversationDispatchRuntimeFor('source', 'agent')).toBeDefined()
    expect(conversationDispatchRuntimeFor('source', 'design')).toBeDefined()
    expect(conversationDispatchRuntimeFor('source', 'ask')).toBeDefined()
    for (const mode of ['plan', 'maestro'] as const) {
      expect(conversationDispatchRuntimeFor('source', mode)).toBeUndefined()
    }
    const enabled = builtinToolNamesForMode('agent')
    expect(enableConversationDispatchTools(enabled, 'source', 'agent')).toBeDefined()
    expect([...CONVERSATION_DISPATCH_TOOL_NAMES].every((name) => enabled.has(name))).toBe(true)
    const restricted = builtinToolNamesForMode('plan')
    expect(enableConversationDispatchTools(restricted, 'source', 'plan')).toBeUndefined()
    expect(CONVERSATION_DISPATCH_TOOL_NAMES.some((name) => restricted.has(name))).toBe(false)
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
    // Nothing created yet: the conversation gate still applies.
    expect(await startConversationsTool.execute(batch, context({ conversationDispatch: runtime }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/does not explicitly ask/),
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
