import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { insertConversation } from '../../src/main/store'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { runChat } from '../../src/main/chat/runner'
import { runClaudeChat } from '../../src/main/chat/claude-agent-sdk/runner'
import { runGitHubCopilotChat } from '../../src/main/chat/github-copilot/runner'
import { runCodexSubscriptionChat } from '../../src/main/chat/codex-subscription/runner'
import { buildCursorHarnessContext } from '../../src/main/chat/cursor-subscription/session'
import { harnessFor } from '../../src/main/chat/harness/execution'
import type { ChatStreamEvent } from '../../src/shared/chat'
const h = vi.hoisted(() => ({
  stream: vi.fn(),
  resolve: vi.fn(),
  git: vi.fn(),
  tools: vi.fn(),
  mcp: vi.fn(),
  permission: vi.fn(async () => {}),
}))
vi.mock('ai', async (original) => ({ ...(await original<typeof import('ai')>()), streamText: h.stream }))
vi.mock('../../src/main/chat/provider', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/provider')>()),
  resolveChatModel: h.resolve,
}))
vi.mock('../../src/main/git-service', () => ({ gitEnvInfo: h.git }))
vi.mock('../../src/main/chat/tools', async (original) => {
  const actual = await original<typeof import('../../src/main/chat/tools')>()
  return {
    ...actual,
    buildTools: (...args: Parameters<typeof actual.buildTools>) => {
      h.tools(...args)
      return actual.buildTools(...args)
    },
  }
})
vi.mock('../../src/main/chat/mcp', () => ({ buildMcpTools: h.mcp, buildAppTools: h.mcp }))
vi.mock('../../src/main/chat/diag-log', () => ({ chatDiag: vi.fn() }))
vi.mock('../../src/main/chat/usage-diagnostics', () => ({ recordModelCallUsage: vi.fn() }))
vi.mock('../../src/main/chat/model-meta', () => ({
  getProviderModelMetaWithStatus: async () => ({ status: 'unavailable', meta: null }),
  getProviderModelMeta: async () => null,
  catalogProviderForBaseURL: () => null,
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: () => ({ getStatusSnapshot: () => ({ authenticated: false }) }),
}))
let cwd: string
let events: ChatStreamEvent[]
const owner = { kind: 'conversation', id: 'owner' } as const
function common() {
  return {
    conversationId: 'fork',
    projectId: null,
    permissionScope: owner,
    cwd,
    mode: 'ask' as const,
    permMode: 'ask' as const,
    broker: { assert: h.permission, assertDecision: vi.fn(async () => 'once') } as never,
    questionBroker: { ask: vi.fn(async () => []) } as never,
    emit: (event: ChatStreamEvent) => events.push(event),
    signal: new AbortController().signal,
  }
}
async function assertScope(prompt: string) {
  expect(prompt).toContain('general assistant')
  expect(prompt).toContain('Do NOT edit')
  expect(prompt).not.toContain('PROJECT_CONTEXT_SENTINEL')
  expect(prompt).not.toContain('# Durable project memory')
  expect(h.git).not.toHaveBeenCalled()
  expect(h.tools).toHaveBeenCalled()
  const context = h.tools.mock.calls[0][0].makeCtx('scope-probe', new AbortController().signal)
  await context.ask('read', ['AGENTS.md'])
  expect(h.permission).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: null, permissionScope: owner, conversationId: 'fork', action: 'read' })
  )
  for (const name of ['bash', 'write', 'edit']) expect(h.tools.mock.calls[0][0].enabled.has(name)).toBe(false)
  expect(context).toMatchObject({
    projectId: null,
    permissionScope: owner,
    cwd,
  })
  expect(existsSync(path.join(cwd, '.git'))).toBe(false)
  expect(events.filter((event) => event.kind === 'error')).toEqual([])
}
function assertHistory(value: unknown) {
  for (const marker of ['PRIOR_USER_SENTINEL', 'PRIOR_ANSWER_SENTINEL', 'CURRENT_USER_SENTINEL'])
    expect(JSON.stringify(value)).toContain(marker)
}
beforeEach(() => {
  vi.clearAllMocks()
  freshDb()
  cwd = mkdtempSync(path.join(os.tmpdir(), 'standalone-adapters-'))
  writeFileSync(path.join(cwd, 'AGENTS.md'), 'PROJECT_CONTEXT_SENTINEL')
  events = []
  insertConversation({
    id: 'fork',
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    name: 'Fork',
    cwd,
    status: 'idle',
    createdAt: 1,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 1,
  })
  for (const [index, role] of (['user', 'assistant', 'user'] as const).entries())
    upsertChatMessage({
      id: `history-${index}`,
      conversationId: 'fork',
      role,
      createdAt: index + 1,
      parts: [
        {
          type: 'text',
          id: `text-${index}`,
          text: ['PRIOR_USER_SENTINEL', 'PRIOR_ANSWER_SENTINEL', 'CURRENT_USER_SENTINEL'][index],
        },
      ],
    })
  h.mcp.mockResolvedValue({ tools: {}, close: async () => {} })
})
afterEach(() => {
  closeDb()
  rmSync(cwd, { recursive: true, force: true })
})
it.each([
  ['openai', 'gpt-test'],
  ['builtin_grok_subscription', 'grok-4'],
])('executes standalone %s with owner scope and history', async (providerId, modelId) => {
  h.resolve.mockReturnValue({
    model: { specificationVersion: 'v4', provider: 'openai', modelId },
    transport: 'openai',
    harnessProfile: 'legacy-v1',
    promptProfile: 'maestrly-legacy',
    harness: harnessFor('openai', modelId),
    capabilities: {
      encryptedReasoning: false,
      nativeApplyPatch: false,
      nativeCompaction: false,
      nativeShell: false,
      promptCacheKey: false,
      toolSearch: false,
    },
    providerFingerprint: 'test',
  })
  h.stream.mockReturnValue({
    fullStream: (async function* () {
      yield { type: 'text-delta', id: 'reply', text: 'Answer' }
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 2 } }
    })(),
  })
  await runChat({
    ...common(),
    selection: { providerId, modelId },
    assistantMessageId: 'answer',
    assistantCreatedAt: 10,
    responseStartedAt: 10,
    modeOverride: 'ask',
  })
  expect(h.stream).toHaveBeenCalledOnce()
  const request = h.stream.mock.calls[0][0]
  await assertScope(request.system)
  assertHistory(request.messages)
  for (const tool of ['bash', 'write', 'edit', 'web_search']) expect(request.tools).not.toHaveProperty(tool)
})
it('executes standalone Copilot with native discovery disabled', async () => {
  const send = vi.fn(async (_input: unknown) => undefined)
  const createSession = vi.fn(async (_input: unknown) => ({
    sessionId: 'copilot-standalone',
    sendAndWait: send,
    abort: vi.fn(),
  }))
  await runGitHubCopilotChat({
    ...common(),
    selection: { providerId: 'builtin_github_copilot_subscription', modelId: 'gpt-5.6-sol' },
    manager: { createSession, assertAccountIdentity: vi.fn(), disconnectSession: vi.fn(async () => {}) } as never,
    accountIdentity: { fingerprint: 'test', epoch: 1 },
  })
  expect(createSession).toHaveBeenCalledOnce()
  const config = createSession.mock.calls[0][0] as any
  await assertScope(config.systemMessage.content)
  assertHistory(send.mock.calls)
  expect(config).toMatchObject({
    workingDirectory: cwd,
    enableConfigDiscovery: false,
    enableSessionStore: false,
    infiniteSessions: { enabled: false },
  })
  expect(config.availableTools).not.toContain('bash')
  expect(config.availableTools).not.toContain('web_search')
})
it('executes standalone Claude with native settings and search disabled', async () => {
  const createQuery = vi.fn((_input: unknown) => ({
    close: vi.fn(),
    interrupt: vi.fn(async () => {}),
    initializationResult: async () => ({ account: { apiProvider: 'firstParty' } }),
    getContextUsage: async () => ({ totalTokens: 10, maxTokens: 200000, model: 'claude-sonnet' }),
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'claude-standalone',
        is_error: false,
        result: 'Answer',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
        modelUsage: {},
      }
    },
  }))
  await runClaudeChat({
    ...common(),
    selection: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
    resolvedModelId: 'claude-sonnet',
    manager: {
      createQuery,
      accountId: null,
      assertAccountIdentity: vi.fn(),
      assertSubscriptionRuntimeAccount: vi.fn(),
      resolveModelId: async () => 'claude-sonnet',
    } as never,
    accountIdentity: { fingerprint: 'test', epoch: 1 },
  })
  expect(createQuery).toHaveBeenCalledOnce()
  const request = createQuery.mock.calls[0][0] as any
  await assertScope(request.options.systemPrompt)
  const prompts = []
  for await (const message of request.prompt) prompts.push(message)
  assertHistory(prompts)
  expect(request.options.cwd).toBe(cwd)
  expect(request.options.settingSources).toEqual([])
  expect(request.options.disallowedTools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']))
})
it('executes standalone Codex without Git initialization or native web search', async () => {
  const listeners = new Set<(event: any) => void>()
  const startThread = vi.fn(async (_input: unknown) => ({ thread: { id: 'thread' } }))
  const startTurn = vi.fn(async (_input: unknown) => {
    setImmediate(() => {
      for (const listener of listeners)
        listener({
          method: 'turn/completed',
          params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', error: null } },
        })
    })
    return { turn: { id: 'turn' } }
  })
  await runCodexSubscriptionChat({
    ...common(),
    selection: { providerId: 'builtin_codex_subscription', modelId: 'gpt-5.6-sol' },
    fastMode: false,
    client: {
      startThread,
      startTurn,
      onNotification: (listener: (event: any) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      setServerRequestHandler: vi.fn(),
      waitForExit: () => new Promise(() => {}),
      request: async () => ({}),
    } as never,
  })
  expect(startThread).toHaveBeenCalledOnce()
  const config = startThread.mock.calls[0][0] as any
  await assertScope(config.developerInstructions)
  assertHistory(startTurn.mock.calls)
  expect(config.cwd).toBe(cwd)
  expect(config.config.web_search).toBe('disabled')
  expect(config.baseInstructions).toBeUndefined()
})
it('builds standalone Cursor context without project material', async () => {
  // The private chat directory has no repository, so the probe resolves to no Git environment.
  h.git.mockResolvedValue(null)
  const { envelope } = await buildCursorHarnessContext({
    projectId: null,
    cwd,
    conversationId: 'fork',
    mode: 'agent',
    modelId: 'cursor-model',
  })
  expect(envelope.projectContext).toBe('')
  expect(envelope.skillCatalog).not.toContain('Project skills')
  expect(envelope.environment).toContain(cwd)
})