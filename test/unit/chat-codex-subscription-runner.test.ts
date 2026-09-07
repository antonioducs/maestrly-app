import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as waitImmediate } from 'node:timers/promises'
import { tool, type ToolSet } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  findPendingChatQuestion,
  MAESTRLY_ULTRA_EFFORT,
  type ChatMessage,
  type ChatStreamEvent,
} from '../../src/shared/chat'
import { listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import type { CodexAppServerClient } from '../../src/main/chat/codex-subscription/client'
import { CodexAppServerRpcError } from '../../src/main/chat/codex-subscription/client'
import type { CodexNotification, CodexServerRequest } from '../../src/main/chat/codex-subscription/protocol'
import {
  compactCodexSubscriptionThread,
  dynamicToolRegistrations,
  maestrlyDeveloperInstructions,
  mergeDynamicToolSets,
  profileDynamicTools,
  registerCodexSubagentRequestRoute,
  ROOT_THREAD_NATIVE_AUTO_COMPACTION_CONFIG,
  runCodexSubscriptionChat,
  SUBAGENT_CATALOG_DESCRIPTION_MAX_CHARS,
  TASK_TOOL_DESCRIPTION_MAX_BYTES,
  toolSetRuntimes,
  type RunCodexSubscriptionChatArgs,
} from '../../src/main/chat/codex-subscription/runner'
import { saveGeneratedImage } from '../../src/main/chat/generated-images'
import { NATIVE_SUBAGENT_MODE_HINT } from '../../src/main/chat/codex-subscription/model-catalog-override'
import { runCodexSubagent } from '../../src/main/chat/codex-subscription/subagent-runner'
import { runClaudeSubagent } from '../../src/main/chat/claude-agent-sdk/subagent-runner'
import { runGitHubCopilotSubagent } from '../../src/main/chat/github-copilot/subagent-runner'
import {
  getCodexThreadBinding,
  listCodexThreadCleanup,
  putCodexThreadBinding,
} from '../../src/main/chat/codex-subscription/thread-store'
import {
  resetSubscriptionFailoverRouterForTests,
  setFailoverRoute,
  getSubscriptionFailoverRouter,
} from '../../src/main/chat/subscription-failover'
import { chatDiag } from '../../src/main/chat/diag-log'
import { BYOK_DEFAULT_RULESET, PermissionBroker } from '../../src/main/chat/permission'
import { QuestionBroker } from '../../src/main/chat/question-broker'
import { chatToolOutputToAiSdkOutput, mcpResultToChatToolOutput } from '../../src/main/chat/tool-output'
import { toolOutputImages } from '../../src/shared/chat'
import { resolveSubagentExecutionProfile } from '../../src/main/chat/subagent-execution-profile'
import { runSubagent } from '../../src/main/chat/subagent-runner'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { patchConvUiPrefs, setAppSetting } from '../../src/main/store'
import { REVIEWER_READONLY_TOOL_NAMES } from '../../src/main/chat/tools'
import { createDefaultMaestroConfig } from '../../src/shared/maestro'

vi.mock('../../src/main/chat/subagent-execution-profile', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/subagent-execution-profile')>()
  return { ...original, resolveSubagentExecutionProfile: vi.fn(original.resolveSubagentExecutionProfile) }
})
vi.mock('../../src/main/chat/subagent-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/subagent-runner')>()
  return { ...original, runSubagent: vi.fn(original.runSubagent) }
})
const claudeH = vi.hoisted(() => ({
  status: vi.fn(),
}))
const codexH = vi.hoisted(() => ({
  authenticated: true,
  models: [
    { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', isDefault: true },
    { id: 'gpt-5.6-mini', model: 'gpt-5.6-mini', isDefault: false },
  ],
  defaultClient: undefined as unknown,
  accounts: new Map<
    string,
    { authenticated?: boolean; models?: readonly Record<string, unknown>[]; client?: unknown }
  >(),
  managerCalls: [] as Array<{ accountId: string | null; method: string }>,
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: (accountId: string | null = null) => {
    const normalizedAccountId = accountId ?? null
    const configured = codexH.accounts.get(accountId ?? 'default')
    const recordCall = (method: string): void => {
      codexH.managerCalls.push({ accountId: normalizedAccountId, method })
    }
    return {
      getStatusSnapshot: () => {
        recordCall('getStatusSnapshot')
        return { authenticated: configured?.authenticated ?? codexH.authenticated }
      },
      listModels: async () => {
        recordCall('listModels')
        return configured?.models ?? codexH.models
      },
      getClient: async () => {
        recordCall('getClient')
        return configured?.client ?? (normalizedAccountId === null ? codexH.defaultClient : undefined)
      },
    }
  },
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  getClaudeSubscriptionManager: () => ({ status: claudeH.status }),
}))
vi.mock('../../src/main/chat/claude-agent-sdk/subagent-runner', () => ({
  runClaudeSubagent: vi.fn(),
}))
vi.mock('../../src/main/chat/github-copilot/manager', () => ({
  getGitHubCopilotSubscriptionManager: () => ({
    accountId: null,
    getAccountIdentity: () => ({ fingerprint: 'sha256:copilot-account', epoch: 5 }),
  }),
}))
vi.mock('../../src/main/chat/github-copilot/subagent-runner', () => ({
  runGitHubCopilotSubagent: vi.fn(),
}))
vi.mock('../../src/main/chat/diag-log', () => ({ chatDiag: vi.fn() }))
vi.mock('../../src/main/chat/generated-images', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/generated-images')>()
  return { ...original, saveGeneratedImage: vi.fn(original.saveGeneratedImage) }
})

/** Bridge: retireCodexThread now deletes through getCodexSubscriptionManager(accountId), not args.client.
 *  Forwarding deletion preserves existing FakeCodexClient.deleteThreadCalls assertions. */
const codexManagerBridge = vi.hoisted(() => {
  const clientsByAccount = new Map<
    string | null,
    {
      deleteThread: (params: unknown, options?: unknown) => Promise<unknown>
    }
  >()
  const rateLimitsByAccount = new Map<string | null, Readonly<Record<string, unknown>> | null>()
  const authenticatedByAccount = new Map<string | null, boolean>()
  let defaultClient: {
    deleteThread: (params: unknown, options?: unknown) => Promise<unknown>
  } | null = null
  const modelIds = ['gpt-5.6-mini', 'gpt-5.6-sol', 'gpt-5.6', 'gpt-5.6-luna', 'gpt-child', 'gpt-5.4']
  const defaultModels = modelIds.map((id, index) => ({
    id,
    model: id === 'gpt-5.6-sol' ? 'gpt-5.6' : id,
    displayName: id,
    description: '',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: '' },
      { reasoningEffort: 'medium', description: '' },
      { reasoningEffort: 'high', description: '' },
      { reasoningEffort: 'xhigh', description: '' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    serviceTiers: [{ id: 'priority', name: 'Priority', description: '' }],
    defaultServiceTier: null,
    legacySpeedTiers: [],
    contextWindow: 200_000,
    isDefault: index === 0,
  }))
  return {
    setClient(
      client: {
        deleteThread: (params: unknown, options?: unknown) => Promise<unknown>
      } | null,
      accountId: string | null = null
    ) {
      if (!client) {
        clientsByAccount.clear()
        rateLimitsByAccount.clear()
        authenticatedByAccount.clear()
        defaultClient = null
        return
      }
      clientsByAccount.set(accountId, client)
      if (accountId == null) defaultClient = client
    },
    setRateLimits(limits: Readonly<Record<string, unknown>> | null, accountId: string | null = null) {
      rateLimitsByAccount.set(accountId, limits)
    },
    setAuthenticated(authenticated: boolean, accountId: string | null = null) {
      authenticatedByAccount.set(accountId, authenticated)
    },
    getCodexSubscriptionManager: vi.fn((accountId: string | null = null) => ({
      deleteThread: async (threadId: string, options?: { signal?: AbortSignal }) => {
        const bridged = clientsByAccount.get(accountId) ?? defaultClient
        if (!bridged) throw new Error(`Codex manager bridge has no client for account ${accountId}`)
        await bridged.deleteThread({ threadId }, options)
      },
      getClient: async () => {
        const bridged = clientsByAccount.get(accountId) ?? defaultClient
        if (!bridged) throw new Error(`Codex manager bridge has no client for account ${accountId}`)
        return bridged
      },
      getRateLimits: async () => rateLimitsByAccount.get(accountId) ?? null,
      getStatusSnapshot: () => ({
        authenticated: authenticatedByAccount.get(accountId) ?? true,
        state: 'ready',
        available: true,
        connected: true,
      }),
      getStatus: async () => ({
        authenticated: authenticatedByAccount.get(accountId) ?? true,
        state: 'ready',
        available: true,
        connected: true,
      }),
      listModels: async () => defaultModels,
      preferredServiceTier: async () => 'priority',
      observeModelContextWindow: () => {},
    })),
  }
})
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: (accountId: string | null = null) =>
    codexManagerBridge.getCodexSubscriptionManager(accountId),
}))

const resolveSubagentExecutionProfileMock = vi.mocked(resolveSubagentExecutionProfile)
const runSubagentMock = vi.mocked(runSubagent)
const runClaudeSubagentMock = vi.mocked(runClaudeSubagent)
const runGitHubCopilotSubagentMock = vi.mocked(runGitHubCopilotSubagent)
const chatDiagMock = vi.mocked(chatDiag)
const saveGeneratedImageMock = vi.mocked(saveGeneratedImage)

type NotificationListener = (notification: CodexNotification) => void

interface TokenBreakdownFixture {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

interface UsageFixture {
  total: TokenBreakdownFixture
  last: TokenBreakdownFixture
}

interface TurnScript {
  turnId: string
  notifications: CodexNotification[]
}

function breakdown(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens = 0
): TokenBreakdownFixture {
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  }
}

function usageNotification(
  threadId: string,
  turnId: string,
  usage: UsageFixture,
  modelContextWindow = 200_000
): CodexNotification {
  return {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: {
        total: usage.total,
        last: usage.last,
        modelContextWindow,
      },
    },
  }
}

function completedNotification(
  threadId: string,
  turnId: string,
  status: 'completed' | 'interrupted' | 'failed' = 'completed',
  errorMessage?: string
): CodexNotification {
  return {
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id: turnId,
        status,
        error: status === 'failed' ? { message: errorMessage || 'Codex turn failed' } : null,
      },
    },
  }
}

/** Simulate an RPC that loses the local quota race but still delivers a late app-server response. */
class LateThreadStartRequest {
  private lateHandler: (() => void) | null = null
  private released = false
  private observedByRace = false

  constructor(
    private readonly response: { thread: { id: string } },
    private readonly racedError: Error
  ) {}

  catch(): Promise<void> {
    return Promise.resolve()
  }

  // biome-ignore lint/suspicious/noThenProperty: This test double intentionally models a late RPC thenable.
  then(onFulfilled?: (value: { thread: { id: string } }) => unknown, onRejected?: (reason: unknown) => unknown) {
    if (!this.observedByRace) {
      this.observedByRace = true
      queueMicrotask(() => void onRejected?.(this.racedError))
      return Promise.resolve()
    }

    const late = new Promise<unknown>((resolve, reject) => {
      this.lateHandler = () => {
        try {
          Promise.resolve(onFulfilled?.(this.response)).then(resolve, reject)
        } catch (error) {
          reject(error)
        }
      }
    })
    if (this.released) this.lateHandler?.()
    return late
  }

  release(): void {
    this.released = true
    this.lateHandler?.()
    this.lateHandler = null
  }
}

class FakeCodexClient {
  readonly startThreadCalls: unknown[] = []
  readonly resumeThreadCalls: unknown[] = []
  readonly deleteThreadCalls: unknown[] = []
  readonly startTurnCalls: unknown[] = []
  readonly interruptTurnCalls: unknown[] = []
  readonly steerTurnCalls: unknown[] = []
  readonly updateTurnSettingsCalls: unknown[] = []
  readonly requestCalls: Array<{ method: string; params: unknown; options: unknown }> = []

  failure: Error | null = null
  resumeError: Error | null = null
  startTurnError: Error | null = null
  startThreadError: Error | null = null
  resumeHook: ((params: { threadId: string }) => void | Promise<void>) | null = null
  startThreadHook: ((params: unknown) => void | Promise<void>) | null = null
  startTurnHook: ((params: unknown) => void | Promise<void>) | null = null
  deleteThreadHook: ((params: unknown) => void | Promise<void>) | null = null
  interruptTurnHook: ((params: unknown) => void | Promise<void>) | null = null
  requestHook: ((method: string, params: unknown) => void | Promise<void>) | null = null
  initializeResult: { capabilities?: Record<string, boolean> | null } = { capabilities: null }
  private threadSequence = 0
  private readonly listeners = new Set<NotificationListener>()
  private readonly turnScripts: TurnScript[] = []
  private readonly startTurnErrors: Array<Error | null> = []
  private readonly startThreadRequests: LateThreadStartRequest[] = []
  private serverRequestHandler:
    | ((request: CodexServerRequest, signal: AbortSignal) => unknown | Promise<unknown>)
    | undefined

  queueTurn(script: TurnScript): void {
    this.turnScripts.push(script)
  }

  queueStartTurnError(error: Error | null): void {
    this.startTurnErrors.push(error)
  }

  queueLateThreadStart(threadId: string): LateThreadStartRequest {
    const request = new LateThreadStartRequest(
      { thread: { id: threadId } },
      new Error('UsageLimitExceeded: quota response raced local start')
    )
    this.startThreadRequests.push(request)
    return request
  }

  emit(notification: CodexNotification): void {
    for (const listener of [...this.listeners]) listener(notification)
  }

  startThread(params: unknown): Promise<{ thread: { id: string } }> {
    this.startThreadCalls.push(params)
    const queuedRequest = this.startThreadRequests.shift()
    if (queuedRequest) return queuedRequest as unknown as Promise<{ thread: { id: string } }>
    return this.startThreadNormally(params)
  }

  private async startThreadNormally(params: unknown): Promise<{ thread: { id: string } }> {
    await this.startThreadHook?.(params)
    if (this.startThreadError) throw this.startThreadError
    this.threadSequence += 1
    return { thread: { id: `thread_${this.threadSequence}` } }
  }

  async resumeThread(params: { threadId: string }): Promise<{ thread: { id: string } }> {
    this.resumeThreadCalls.push(params)
    if (this.resumeError) throw this.resumeError
    await this.resumeHook?.(params)
    return { thread: { id: params.threadId } }
  }

  async deleteThread(params: unknown): Promise<Record<string, never>> {
    this.deleteThreadCalls.push(params)
    await this.deleteThreadHook?.(params)
    return {}
  }

  async startTurn(params: unknown): Promise<{ turn: { id: string } }> {
    this.startTurnCalls.push(params)
    await this.startTurnHook?.(params)
    const queuedError = this.startTurnErrors.length ? this.startTurnErrors.shift() : undefined
    if (queuedError) throw queuedError
    if (this.startTurnError) throw this.startTurnError
    const script = this.turnScripts.shift()
    if (!script) throw new Error('FakeCodexClient received startTurn without a queued script')
    setImmediate(() => {
      for (const notification of script.notifications) this.emit(notification)
    })
    return { turn: { id: script.turnId } }
  }

  async interruptTurn(params: unknown): Promise<void> {
    this.interruptTurnCalls.push(params)
    await this.interruptTurnHook?.(params)
  }

  async steerTurn(params: unknown): Promise<{ accepted: true }> {
    this.steerTurnCalls.push(params)
    return { accepted: true }
  }

  async updateTurnSettings(params: unknown): Promise<{ applied: true }> {
    this.updateTurnSettingsCalls.push(params)
    return { applied: true }
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setServerRequestHandler(
    handler: ((request: CodexServerRequest, signal: AbortSignal) => unknown | Promise<unknown>) | undefined
  ): void {
    this.serverRequestHandler = handler
  }

  async serverRequest(request: CodexServerRequest): Promise<unknown> {
    if (!this.serverRequestHandler) throw new Error('FakeCodexClient has no server request handler')
    return this.serverRequestHandler(request, new AbortController().signal)
  }

  async request(method: string, params: unknown, options?: unknown): Promise<Record<string, never>> {
    this.requestCalls.push({ method, params, options })
    await this.requestHook?.(method, params)
    return {}
  }

  waitForExit(): Promise<never> {
    return new Promise<never>(() => {})
  }
}

function persistUser(conversationId: string, id: string, text: string, createdAt: number): ChatMessage {
  const message: ChatMessage = {
    id,
    conversationId,
    role: 'user',
    parts: [{ type: 'text', id: `${id}_text`, text }],
    createdAt,
  }
  upsertChatMessage(message)
  return message
}

function runArgs(
  conversationId: string,
  projectId: string,
  cwd: string,
  client: FakeCodexClient,
  emit: (event: ChatStreamEvent) => void = () => {}
): RunCodexSubscriptionChatArgs {
  codexManagerBridge.setClient(client)
  return {
    conversationId,
    projectId,
    cwd,
    selection: { providerId: 'builtin_codex_subscription', modelId: 'gpt-5.6-sol' },
    mode: 'ask',
    permMode: 'ask',
    reasoningEffort: 'xhigh',
    fastMode: true,
    serviceTier: 'priority',
    client: client as unknown as CodexAppServerClient,
    eligibleChatGptSession: true,
    broker: {
      assert: vi.fn(async () => {}),
      assertDecision: vi.fn(async () => 'once' as const),
    } as unknown as RunCodexSubscriptionChatArgs['broker'],
    questionBroker: {
      ask: vi.fn(async () => []),
    } as unknown as RunCodexSubscriptionChatArgs['questionBroker'],
    emit,
    signal: new AbortController().signal,
  }
}

function astraRuntimeModel(): NonNullable<RunCodexSubscriptionChatArgs['runtimeModel']> {
  return {
    id: 'gpt-6-astra',
    model: 'gpt-6-astra',
    displayName: 'Astra',
    description: '',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: '' },
      { reasoningEffort: 'high', description: '' },
      { reasoningEffort: 'ultra', description: '' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: true,
    serviceTiers: [],
    defaultServiceTier: null,
    legacySpeedTiers: [],
    contextWindow: 1_000,
    nominalContextWindow: 1_000,
    maxContextWindow: 1_000,
    effectiveContextWindowPercent: 100,
    supportsExperimentalContext: null,
    preferWebsockets: true,
    supportsParallelToolCalls: true,
    toolMode: 'code_mode_only',
    multiAgentVersion: 2,
    useResponsesLite: true,
    supportedVerbosity: ['low', 'medium'],
    defaultVerbosity: 'medium',
    minimumClientVersion: '0.153.4',
    isDefault: false,
  }
}

function directSubagentArgs(
  client: FakeCodexClient,
  signal: AbortSignal,
  callbacks: {
    registerThread?: (threadId: string, modelId: string) => boolean
    removeThread?: (threadId: string, terminal: boolean) => void
  } = {}
): Parameters<typeof runCodexSubagent>[0] {
  return {
    client: client as unknown as CodexAppServerClient,
    cwd: '/workspace',
    profile: {
      version: 1,
      agentName: 'explore',
      effective: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-mini',
        configuredEffort: 'high',
        sentEffort: 'high',
        source: 'conversation-agent',
        candidateIndex: 0,
      },
      attempts: [],
    },
    definition: {
      name: 'explore',
      description: 'Explore',
      prompt: 'Inspect read-only.',
      source: 'test',
    },
    signal,
    agentName: 'explore',
    task: 'Inspect the flow.',
    readOnly: true,
    serviceTier: 'default',
    approvalPolicy: 'untrusted',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    dynamicTools: [],
    registerThread: callbacks.registerThread ?? (() => true),
    removeThread: callbacks.removeThread ?? (() => {}),
  }
}

function assistantMessages(conversationId: string): ChatMessage[] {
  return listChatMessages(conversationId).filter((message) => message.role === 'assistant')
}

describe('Codex subscription runner', () => {
  beforeEach(() => {
    freshDb()
    codexManagerBridge.setClient(null)
    codexManagerBridge.getCodexSubscriptionManager.mockClear()
    resetSubscriptionFailoverRouterForTests()
    resolveSubagentExecutionProfileMock.mockClear()
    runSubagentMock.mockClear()
    runClaudeSubagentMock.mockReset()
    runGitHubCopilotSubagentMock.mockReset()
    saveGeneratedImageMock.mockClear()
    claudeH.status.mockReset()
    claudeH.status.mockResolvedValue({
      authenticated: true,
      accountFingerprint: 'sha256:claude-account',
      accountEpoch: 3,
    })
    codexH.authenticated = true
    codexH.defaultClient = undefined
    codexH.accounts.clear()
    codexH.managerCalls.length = 0
    chatDiagMock.mockClear()
  })
  afterEach(closeDb)

  it('propagates deferLoading by effective origin and preserves bridge > app > MCP precedence and dispatch', async () => {
    const makeTool = (source: string) =>
      tool({
        description: `${source} description`,
        inputSchema: z.object({}),
        execute: async () => source,
      })
    const mcpTools: ToolSet = {
      shared: makeTool('mcp-shared'),
      app_collision: makeTool('mcp-collision'),
      mcp_call: makeTool('mcp-call'),
      mcp_only: makeTool('mcp-only'),
      mcp_search: makeTool('mcp-search'),
    }
    const appTools: ToolSet = {
      shared: makeTool('app-shared'),
      app_collision: makeTool('app-collision'),
      notes_append_page: makeTool('drawer-notes-append'),
      drawer_only: makeTool('drawer-only'),
    }
    const bridgeTools: ToolSet = {
      shared: makeTool('bridge-shared'),
      read: makeTool('bridge-read'),
    }

    const merged = mergeDynamicToolSets(mcpTools, appTools, bridgeTools)
    const runtimes = await toolSetRuntimes(merged.tools, merged.deferredToolNames)
    const byName = new Map(runtimes.map((runtime) => [runtime.spec.name, runtime]))

    expect(runtimes.map((runtime) => runtime.spec.name)).toEqual([
      'app_collision',
      'drawer_only',
      'mcp_call',
      'mcp_only',
      'mcp_search',
      'notes_append_page',
      'read',
      'shared',
    ])
    expect(byName.get('app_collision')?.spec.deferLoading).toBe(true)
    expect(byName.get('notes_append_page')?.spec.deferLoading).toBe(true)
    expect(byName.get('drawer_only')?.spec.deferLoading).toBe(true)
    expect(byName.get('mcp_call')?.spec.deferLoading).toBe(true)
    expect(byName.get('mcp_only')?.spec.deferLoading).toBe(true)
    expect(byName.get('mcp_search')?.spec.deferLoading).toBe(true)
    expect(byName.get('read')?.spec.deferLoading).toBeUndefined()
    expect(byName.get('shared')?.spec.deferLoading).toBeUndefined()
    expect(dynamicToolRegistrations(runtimes.map((runtime) => runtime.spec))).toMatchObject([
      { type: 'function', name: 'read' },
      { type: 'function', name: 'shared' },
      {
        type: 'namespace',
        name: 'maestrly_deferred',
        tools: [
          { name: 'app_collision', deferLoading: true },
          { name: 'drawer_only', deferLoading: true },
          { name: 'mcp_call', deferLoading: true },
          { name: 'mcp_only', deferLoading: true },
          { name: 'mcp_search', deferLoading: true },
          { name: 'notes_append_page', deferLoading: true },
        ],
      },
    ])

    const signal = new AbortController().signal
    const update = () => {}
    await expect(byName.get('app_collision')?.execute({}, 'app-call', signal, update)).resolves.toBe('app-collision')
    await expect(byName.get('notes_append_page')?.execute({}, 'notes-call', signal, update)).resolves.toBe(
      'drawer-notes-append'
    )
    await expect(byName.get('mcp_only')?.execute({}, 'mcp-call', signal, update)).resolves.toBe('mcp-only')
    await expect(byName.get('shared')?.execute({}, 'bridge-call', signal, update)).resolves.toBe('bridge-shared')
  })

  it('produces a deterministic aggregate profile without exposing names or schemas', () => {
    const specs = [
      {
        type: 'function' as const,
        name: 'deferred-secret-name',
        description: 'Deferred description',
        inputSchema: { type: 'object', properties: { secretField: { type: 'string' } } },
        deferLoading: true,
      },
      {
        type: 'function' as const,
        name: 'eager-secret-name',
        description: 'Eager',
        inputSchema: { type: 'object', properties: {} },
      },
    ]

    const profile = profileDynamicTools(specs)
    expect(profileDynamicTools([...specs].reverse())).toEqual(profile)
    expect(profile).toMatchObject({ total: 2, eager: 1, deferred: 1 })
    expect(profile.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(dynamicToolRegistrations(specs)), 'utf8'))
    expect(profile.schemaBytes).toBeGreaterThan(0)
    expect(profile.descriptionBytes).toBeGreaterThan(profile.largestDescriptionBytes)
    expect(JSON.stringify(profile)).not.toMatch(/deferred-secret|eager-secret|secretField|Deferred|Eager/)
  })

  it('keeps agent descriptions only in the abbreviated developer instructions catalog', () => {
    const description = `begin-${'x'.repeat(SUBAGENT_CATALOG_DESCRIPTION_MAX_CHARS * 2)}-end`
    const instructions = maestrlyDeveloperInstructions(
      'agent',
      [],
      [
        {
          name: 'bounded-agent',
          description,
          prompt: 'Do work.',
          source: 'test',
        },
      ]
    )
    const renderedDescription =
      instructions.match(/- bounded-agent \[specialist, read-only, inherited profile\]: (.+)/)?.[1] ?? ''

    expect(renderedDescription.length).toBe(SUBAGENT_CATALOG_DESCRIPTION_MAX_CHARS)
    expect(renderedDescription).toContain('begin-')
    expect(renderedDescription).not.toContain('-end')
  })

  it('preserves deferLoading in the thread/start payload for Codex subagents', async () => {
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_child_deferred',
      notifications: [
        {
          method: 'turn/started',
          params: { threadId: 'thread_1', turn: { id: 'turn_child_deferred', status: 'inProgress' } },
        },
        completedNotification('thread_1', 'turn_child_deferred'),
      ],
    })

    await runCodexSubagent({
      client: client as unknown as CodexAppServerClient,
      cwd: '/workspace',
      profile: {
        version: 1,
        agentName: 'explore',
        effective: {
          providerId: 'builtin_codex_subscription',
          modelId: 'gpt-5.6-mini',
          configuredEffort: 'high',
          sentEffort: 'high',
          source: 'conversation-agent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: {
        name: 'explore',
        description: 'Explore',
        prompt: 'Inspect read-only.',
        source: 'test',
      },
      signal: new AbortController().signal,
      agentName: 'explore',
      task: 'Inspect the flow.',
      readOnly: true,
      serviceTier: 'default',
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      dynamicTools: [
        {
          type: 'function',
          name: 'drawer_lookup',
          description: 'Deferred drawer lookup.',
          inputSchema: { type: 'object', properties: {} },
          deferLoading: true,
        },
        {
          type: 'function',
          name: 'read',
          description: 'Eager reader.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      registerThread: () => true,
      removeThread: () => {},
    })

    expect(client.startThreadCalls[0]).toMatchObject({
      ephemeral: true,
      config: { 'features.image_generation': false },
      dynamicTools: [
        expect.objectContaining({ name: 'read' }),
        expect.objectContaining({
          type: 'namespace',
          name: 'maestrly_deferred',
          tools: [expect.objectContaining({ name: 'drawer_lookup', deferLoading: true })],
        }),
      ],
    })
    const childSpecs = (
      client.startThreadCalls[0] as {
        dynamicTools: Array<{ name: string; deferLoading?: boolean }>
      }
    ).dynamicTools
    expect(childSpecs.find((spec) => spec.name === 'read')?.deferLoading).toBeUndefined()
    const childConfig = (client.startThreadCalls[0] as { config: Record<string, unknown> }).config
    expect(childConfig).not.toHaveProperty('model_auto_compact_token_limit')
    expect(childConfig).not.toHaveProperty('model_auto_compact_token_limit_scope')
    expect(childConfig).not.toHaveProperty('model_context_window')
  })

  it('resumes the native thread of a Maestro subagent without opening a new thread', async () => {
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_resumed',
      notifications: [completedNotification('thread_prev', 'turn_resumed')],
    })
    const onThreadStarted = vi.fn()
    const result = await runCodexSubagent({
      ...directSubagentArgs(client, new AbortController().signal),
      task: 'Apply the findings.',
      persistRuntime: true,
      resume: { threadId: 'thread_prev', fallbackTask: 'FALLBACK' },
      onThreadStarted,
    })
    expect(client.resumeThreadCalls).toEqual([expect.objectContaining({ threadId: 'thread_prev', cwd: '/workspace' })])
    expect(client.startThreadCalls).toEqual([])
    expect(client.startTurnCalls[0]).toMatchObject({
      threadId: 'thread_prev',
      input: [expect.objectContaining({ text: 'Apply the findings.' })],
    })
    expect(onThreadStarted).toHaveBeenCalledWith({ threadId: 'thread_prev', resumed: true })
    expect(result).toMatchObject({ resumed: true })
    expect(result.resumeReason).toBeUndefined()
  })

  it('recreates with the fallback task when the provider rejects resume and exposes the reason', async () => {
    const client = new FakeCodexClient()
    client.resumeError = new Error('thread not found')
    client.queueTurn({
      turnId: 'turn_fresh',
      notifications: [completedNotification('thread_1', 'turn_fresh')],
    })
    const onThreadStarted = vi.fn()
    const result = await runCodexSubagent({
      ...directSubagentArgs(client, new AbortController().signal),
      task: 'Apply the findings.',
      persistRuntime: true,
      resume: { threadId: 'thread_prev', fallbackTask: 'FALLBACK with previous report' },
      onThreadStarted,
    })
    expect(client.resumeThreadCalls).toHaveLength(1)
    expect(client.startThreadCalls[0]).toMatchObject({ ephemeral: false })
    expect(client.startTurnCalls[0]).toMatchObject({
      threadId: 'thread_1',
      input: [expect.objectContaining({ text: 'FALLBACK with previous report' })],
    })
    expect(onThreadStarted).toHaveBeenCalledWith({ threadId: 'thread_1', resumed: false })
    expect(result).toMatchObject({ resumed: false, resumeReason: 'resume-rejected' })
  })

  it('keeps threads ephemeral by default and does not report resume unless requested', async () => {
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_plain', notifications: [completedNotification('thread_1', 'turn_plain')] })
    const onThreadStarted = vi.fn()
    const result = await runCodexSubagent({
      ...directSubagentArgs(client, new AbortController().signal),
      onThreadStarted,
    })
    expect(client.startThreadCalls[0]).toMatchObject({ ephemeral: true })
    expect(client.resumeThreadCalls).toEqual([])
    expect(onThreadStarted).toHaveBeenCalledWith({ threadId: 'thread_1', resumed: false })
    expect(result.resumed).toBeUndefined()
  })

  it('preserves generate_image in the Codex worker only with host capability and without native imagegen', async () => {
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_child_image',
      notifications: [completedNotification('thread_1', 'turn_child_image')],
    })
    const args = directSubagentArgs(client, new AbortController().signal)
    args.readOnly = false
    args.definition = {
      ...args.definition,
      tools: ['bash', 'generate_image'],
    }
    args.dynamicTools = [
      {
        type: 'function',
        name: 'generate_image',
        description: 'Generate an image.',
        inputSchema: { type: 'object', properties: {} },
      },
    ]

    await runCodexSubagent(args)

    const child = client.startThreadCalls[0] as {
      dynamicTools: Array<{ name: string }>
      config: Record<string, unknown>
    }
    expect(child.dynamicTools).toEqual([expect.objectContaining({ name: 'generate_image' })])
    expect(child.config['features.image_generation']).toBe(false)
  })

  it('keeps canonical image output separate from the Codex projection without vision', async () => {
    for (const supportsImages of [false, true]) {
      const rawOutput = mcpResultToChatToolOutput({
        content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      })
      if (typeof rawOutput === 'string' || !rawOutput.images?.[0]) throw new Error('expected image output')
      const canonicalOutput = {
        ...rawOutput,
        images: rawOutput.images.map((image) => ({ ...image, description: 'A small screenshot.' })),
      }
      const runtimes = await toolSetRuntimes({
        screenshot: tool({
          description: 'Capture a screenshot.',
          inputSchema: z.object({}),
          execute: async () => canonicalOutput,
          toModelOutput: ({ output }) => chatToolOutputToAiSdkOutput(output, { dropImages: !supportsImages }),
        }),
      })

      const result = await runtimes[0]!.execute(
        {},
        `codex-image-${supportsImages}`,
        new AbortController().signal,
        () => {}
      )
      if (typeof result === 'string') throw new Error('expected structured Codex result')
      expect(toolOutputImages(result.toolOutput)).toHaveLength(1)
      expect(result.toolOutput).toMatchObject({ images: [{ description: 'A small screenshot.' }] })
      if (supportsImages) {
        expect(result.contentItems).toEqual(
          expect.arrayContaining([{ type: 'inputImage', imageUrl: 'data:image/png;base64,aGVsbG8=' }])
        )
      } else {
        expect(result.contentItems).toEqual([
          { type: 'inputText', text: expect.stringContaining('A small screenshot.') },
        ])
        expect(JSON.stringify(result.contentItems)).not.toContain('aGVsbG8=')
      }
    }
  })

  it('keeps multimodal failure separate from the Codex projection with success=false', async () => {
    for (const supportsImages of [false, true]) {
      const rawOutput = mcpResultToChatToolOutput({
        content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      })
      if (typeof rawOutput === 'string' || !rawOutput.images?.[0]) throw new Error('expected image output')
      const canonicalOutput = {
        ...rawOutput,
        text: 'Screenshot failed.',
        images: rawOutput.images.map((image) => ({ ...image, description: 'A small screenshot.' })),
        isError: true,
      }
      const runtimes = await toolSetRuntimes({
        screenshot: tool({
          description: 'Capture a screenshot.',
          inputSchema: z.object({}),
          execute: async () => canonicalOutput,
          toModelOutput: ({ output }) => chatToolOutputToAiSdkOutput(output, { dropImages: !supportsImages }),
        }),
      })

      const result = await runtimes[0]!.execute(
        {},
        `codex-error-image-${supportsImages}`,
        new AbortController().signal,
        () => {}
      )
      if (typeof result === 'string') throw new Error('expected structured Codex result')
      expect(result).toMatchObject({
        error: 'Screenshot failed.',
        toolOutput: { isError: true, images: [{ description: 'A small screenshot.' }] },
      })
      expect(result.contentItems).toEqual(
        supportsImages
          ? expect.arrayContaining([{ type: 'inputImage', imageUrl: 'data:image/png;base64,aGVsbG8=' }])
          : [{ type: 'inputText', text: expect.stringContaining('A small screenshot.') }]
      )

      const client = new FakeCodexClient()
      const registration = registerCodexSubagentRequestRoute({
        client: client as unknown as CodexAppServerClient,
        conversationId: 'codex-error-conversation',
        projectId: 'codex-error-project',
        messageId: 'codex-error-message',
        broker: {
          assert: vi.fn(async () => {}),
          assertDecision: vi.fn(async () => 'once' as const),
        } as unknown as RunCodexSubscriptionChatArgs['broker'],
        questionBroker: {
          ask: vi.fn(async () => []),
          reply: vi.fn(),
        } as unknown as RunCodexSubscriptionChatArgs['questionBroker'],
        runtimes,
        signal: new AbortController().signal,
        mode: 'ask',
      })
      registration.addThread(`codex-error-thread-${supportsImages}`)
      try {
        const providerResult = await client.serverRequest({
          id: `codex-error-request-${supportsImages}`,
          method: 'item/tool/call',
          params: {
            threadId: `codex-error-thread-${supportsImages}`,
            itemId: `codex-error-item-${supportsImages}`,
            callId: `codex-error-call-${supportsImages}`,
            tool: 'screenshot',
            arguments: {},
          },
        })
        expect(providerResult).toMatchObject({ success: false })
      } finally {
        registration.remove()
      }
    }
  })

  it.each([
    { source: 'parent' as const, fastMode: true, serviceTier: 'priority' },
    { source: 'parent' as const, fastMode: false, serviceTier: 'default' },
    { source: 'conversation-agent' as const, fastMode: false, serviceTier: 'default' },
  ])('sends snapshot Fast=$fastMode tier=$serviceTier to both child RPCs for $source', async ({
    source,
    fastMode,
    serviceTier,
  }) => {
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: `turn_child_${serviceTier}_${source}`,
      notifications: [
        {
          method: 'turn/started',
          params: {
            threadId: 'thread_1',
            turn: { id: `turn_child_${serviceTier}_${source}`, status: 'inProgress' },
          },
        },
        completedNotification('thread_1', `turn_child_${serviceTier}_${source}`),
      ],
    })

    await runCodexSubagent({
      ...directSubagentArgs(client, new AbortController().signal),
      profile: {
        ...directSubagentArgs(client, new AbortController().signal).profile,
        effective: {
          ...directSubagentArgs(client, new AbortController().signal).profile.effective!,
          source,
          fastMode,
        },
      },
      serviceTier,
    })

    expect(client.startThreadCalls[0]).toMatchObject({ serviceTier })
    expect(client.startTurnCalls[0]).toMatchObject({ serviceTier })
  })

  it('bounds Codex subagent abort without terminal state and does not declare it stopped', async () => {
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_child_timeout', notifications: [] })
    const controller = new AbortController()
    const removed: Array<{ threadId: string; terminal: boolean }> = []
    const running = runCodexSubagent({
      client: client as unknown as CodexAppServerClient,
      cwd: '/workspace',
      profile: {
        version: 1,
        agentName: 'explore',
        effective: {
          providerId: 'builtin_codex_subscription',
          modelId: 'gpt-5.6-mini',
          configuredEffort: 'high',
          sentEffort: 'high',
          source: 'conversation-agent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: {
        name: 'explore',
        description: 'Explore',
        prompt: 'Inspect read-only.',
        source: 'test',
      },
      signal: controller.signal,
      agentName: 'explore',
      task: 'Never confirm terminal state.',
      readOnly: true,
      serviceTier: 'default',
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      dynamicTools: [],
      registerThread: () => true,
      removeThread: (threadId, terminal) => removed.push({ threadId, terminal }),
    })

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    vi.useFakeTimers()
    try {
      const rejected = expect(running).rejects.toThrow('Timed out waiting for Codex subagent thread_1 to stop')
      controller.abort()
      await vi.advanceTimersByTimeAsync(15_001)
      await rejected
    } finally {
      vi.useRealTimers()
    }
    expect(client.interruptTurnCalls).toContainEqual({
      threadId: 'thread_1',
      turnId: 'turn_child_timeout',
    })
    expect(removed).toEqual([{ threadId: 'thread_1', terminal: false }])
  })

  it('bounds abort while subagent thread/start is still pending', async () => {
    const client = new FakeCodexClient()
    let releaseThreadStart!: () => void
    client.startThreadHook = () =>
      new Promise<void>((resolve) => {
        releaseThreadStart = resolve
      })
    const controller = new AbortController()
    const registerThread = vi.fn(() => true)
    const removeThread = vi.fn()
    const running = runCodexSubagent(directSubagentArgs(client, controller.signal, { registerThread, removeThread }))

    await vi.waitFor(() => expect(client.startThreadCalls).toHaveLength(1))
    vi.useFakeTimers()
    try {
      const rejected = expect(running).rejects.toThrow('Timed out waiting for Codex subagent explore to stop')
      controller.abort()
      await vi.advanceTimersByTimeAsync(15_001)
      await rejected
    } finally {
      vi.useRealTimers()
    }
    expect(registerThread).not.toHaveBeenCalled()
    expect(removeThread).not.toHaveBeenCalled()
    expect(client.startTurnCalls).toEqual([])

    releaseThreadStart()
    await vi.waitFor(() => expect(removeThread).toHaveBeenCalledWith('thread_1', true))
    expect(registerThread).not.toHaveBeenCalled()
    expect(client.startTurnCalls).toEqual([])
  })

  it('bounds abort during pending turn/start and stops a late response in the background', async () => {
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_child_late_start',
      notifications: [
        {
          method: 'turn/started',
          params: { threadId: 'thread_1', turn: { id: 'turn_child_late_start', status: 'inProgress' } },
        },
        completedNotification('thread_1', 'turn_child_late_start', 'interrupted'),
      ],
    })
    let releaseTurnStart!: () => void
    client.startTurnHook = () =>
      new Promise<void>((resolve) => {
        releaseTurnStart = resolve
      })
    const controller = new AbortController()
    const removed: Array<{ threadId: string; terminal: boolean }> = []
    const running = runCodexSubagent(
      directSubagentArgs(client, controller.signal, {
        removeThread: (threadId, terminal) => removed.push({ threadId, terminal }),
      })
    )

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    vi.useFakeTimers()
    try {
      const rejected = expect(running).rejects.toThrow('Timed out waiting for Codex subagent thread_1 to stop')
      controller.abort()
      await vi.advanceTimersByTimeAsync(15_001)
      await rejected
    } finally {
      vi.useRealTimers()
    }
    expect(removed).toEqual([])

    releaseTurnStart()
    await vi.waitFor(() =>
      expect(client.interruptTurnCalls).toContainEqual({
        threadId: 'thread_1',
        turnId: 'turn_child_late_start',
      })
    )
    await vi.waitFor(() => expect(removed).toEqual([{ threadId: 'thread_1', terminal: true }]))
  })

  it('retains ownership after a local turn/start timeout and stops the late response', async () => {
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_child_request_timeout',
      notifications: [
        {
          method: 'turn/started',
          params: { threadId: 'thread_1', turn: { id: 'turn_child_request_timeout', status: 'inProgress' } },
        },
        completedNotification('thread_1', 'turn_child_request_timeout', 'interrupted'),
      ],
    })
    let releaseTurnStart!: () => void
    client.startTurnHook = () =>
      new Promise<void>((resolve) => {
        releaseTurnStart = resolve
      })
    const removed: Array<{ threadId: string; terminal: boolean }> = []

    vi.useFakeTimers()
    let running!: ReturnType<typeof runCodexSubagent>
    try {
      running = runCodexSubagent(
        directSubagentArgs(client, new AbortController().signal, {
          removeThread: (threadId, terminal) => removed.push({ threadId, terminal }),
        })
      )
      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(30_001)
      await expect(running).resolves.toMatchObject({
        error: 'Codex subagent turn/start timed out after 30000ms',
      })
      expect(removed).toEqual([])
    } finally {
      vi.useRealTimers()
    }

    releaseTurnStart()
    await vi.waitFor(() =>
      expect(client.interruptTurnCalls).toContainEqual({
        threadId: 'thread_1',
        turnId: 'turn_child_request_timeout',
      })
    )
    await vi.waitFor(() => expect(removed).toEqual([{ threadId: 'thread_1', terminal: true }]))
  })

  it('keeps the defensive auto-compaction limit exactly JSON-serializable', () => {
    expect(Number.isSafeInteger(ROOT_THREAD_NATIVE_AUTO_COMPACTION_CONFIG.model_auto_compact_token_limit)).toBe(true)
    expect(JSON.parse(JSON.stringify(ROOT_THREAD_NATIVE_AUTO_COMPACTION_CONFIG))).toEqual({
      model_auto_compact_token_limit: Number.MAX_SAFE_INTEGER,
      model_auto_compact_token_limit_scope: 'body_after_prefix',
    })
  })

  it('sends the requested nominal window in thread/start without changing auto-compaction configuration', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_requested_window_start', 'Use long context', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_requested_window_start',
      notifications: [completedNotification('thread_1', 'turn_requested_window_start')],
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.requestedContextWindow = 1_000_000

    await runCodexSubscriptionChat(args)

    const config = (client.startThreadCalls[0] as { config: Record<string, unknown> }).config
    expect(config.model_context_window).toBe(1_000_000)
    expect({
      model_auto_compact_token_limit: config.model_auto_compact_token_limit,
      model_auto_compact_token_limit_scope: config.model_auto_compact_token_limit_scope,
    }).toEqual(ROOT_THREAD_NATIVE_AUTO_COMPACTION_CONFIG)
  })

  it('omits model_context_window when nominal capacity is unknown', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_unknown_window_capability', 'Use the available context', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_unknown_window_capability',
      notifications: [completedNotification('thread_1', 'turn_unknown_window_capability')],
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.requestedContextWindow = null

    await runCodexSubscriptionChat(args)

    const config = (client.startThreadCalls[0] as { config: Record<string, unknown> }).config
    expect(config).not.toHaveProperty('model_context_window')
  })

  it('injects canonical context, disables native project docs and invalidates the thread when conventions change', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'codex-project-context-'))
    const cwd = path.join(root, 'packages', 'app')
    mkdirSync(cwd, { recursive: true })
    try {
      const workspace = makeWorkspace({ path: root })
      const conversation = makeConversation(workspace.id, { cwd })
      writeFileSync(path.join(root, 'AGENTS.md'), 'Root convention.')
      writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Closest fallback v1.')
      persistUser(conversation.id, 'user_project_context_1', 'First turn', 1)
      const client = new FakeCodexClient()
      client.queueTurn({
        turnId: 'turn_project_context_1',
        notifications: [completedNotification('thread_1', 'turn_project_context_1')],
      })

      await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, cwd, client))

      const firstStart = client.startThreadCalls[0] as {
        config: Record<string, unknown>
        developerInstructions: string
      }
      expect(firstStart.config.project_doc_max_bytes).toBe(0)
      expect(firstStart.developerInstructions).toContain('Source: AGENTS.md\nRoot convention.')
      expect(firstStart.developerInstructions).toContain('Source: packages/app/CLAUDE.md\nClosest fallback v1.')
      const firstBinding = getCodexThreadBinding(conversation.id)
      expect(firstBinding).toMatchObject({
        toolSignature: expect.any(String),
        instructionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })

      writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Closest fallback v2.')
      persistUser(conversation.id, 'user_project_context_2', 'Second turn', 3)
      client.queueTurn({
        turnId: 'turn_project_context_2',
        notifications: [completedNotification('thread_2', 'turn_project_context_2')],
      })

      await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, cwd, client))

      expect(client.resumeThreadCalls).toEqual([])
      expect(client.startThreadCalls).toHaveLength(2)
      expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_1' })
      const secondBinding = getCodexThreadBinding(conversation.id)
      expect(secondBinding?.toolSignature).toBe(firstBinding?.toolSignature)
      expect(secondBinding?.instructionHash).not.toBe(firstBinding?.instructionHash)
      expect((client.startThreadCalls[1] as { developerInstructions: string }).developerInstructions).toContain(
        'Closest fallback v2.'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('starts a thread, converts text/tool/finish notifications and persists binding plus cumulative usage', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_1', 'Show the current directory', 1)
    const client = new FakeCodexClient()
    const emitted: ChatStreamEvent[] = []
    const total = breakdown(120, 20, 30, 7)
    const last = breakdown(40, 10, 12, 3)
    client.queueTurn({
      turnId: 'turn_1',
      notifications: [
        {
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'answer_1', delta: 'Result: ' },
        },
        {
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'answer_1', delta: 'ready.' },
        },
        {
          method: 'item/started',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_1',
            item: {
              id: 'command_1',
              type: 'commandExecution',
              command: 'pwd',
              cwd: conversation.cwd,
              status: 'inProgress',
            },
          },
        },
        {
          method: 'item/commandExecution/outputDelta',
          params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'command_1', delta: 'partial stream' },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_1',
            item: {
              id: 'command_1',
              type: 'commandExecution',
              command: 'pwd',
              cwd: conversation.cwd,
              status: 'completed',
              aggregatedOutput: 'final result',
              exitCode: 0,
            },
          },
        },
        usageNotification('thread_1', 'turn_1', { total, last }),
        completedNotification('thread_1', 'turn_1'),
      ],
    })

    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => emitted.push(event))
    args.onModelContextWindow = vi.fn()
    const result = await runCodexSubscriptionChat(args)

    expect(result).toEqual({ planSubmitted: false, threadId: 'thread_1' })
    expect(args.onModelContextWindow).toHaveBeenCalledWith(200_000, null)
    expect(client.resumeThreadCalls).toEqual([])
    expect(client.startThreadCalls).toHaveLength(1)
    expect(client.startThreadCalls[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      serviceTier: 'priority',
      cwd: conversation.cwd,
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
      config: {
        'features.default_mode_request_user_input': true,
        model_auto_compact_token_limit: Number.MAX_SAFE_INTEGER,
        model_auto_compact_token_limit_scope: 'body_after_prefix',
        'features.shell_tool': false,
        'features.multi_agent': false,
        'features.multi_agent_v2': false,
        'features.apps': false,
        'features.plugins': false,
        'features.tool_suggest': false,
        'features.image_generation': false,
        'features.skill_search': false,
        'features.skill_mcp_dependency_install': false,
        'skills.include_instructions': false,
        'shell_environment_policy.ignore_default_excludes': false,
        web_search: 'disabled',
      },
      environments: [],
      ephemeral: false,
      dynamicTools: [
        expect.objectContaining({ name: 'glob' }),
        expect.objectContaining({ name: 'grep' }),
        expect.objectContaining({ name: 'read' }),
        expect.objectContaining({ name: 'webfetch' }),
      ],
    })
    expect(
      (
        client.startThreadCalls[0] as {
          dynamicTools: Array<{ deferLoading?: boolean }>
        }
      ).dynamicTools.every((spec) => spec.deferLoading !== true)
    ).toBe(true)
    expect(client.startTurnCalls[0]).toMatchObject({
      threadId: 'thread_1',
      clientUserMessageId: 'user_1',
      model: 'gpt-5.6-sol',
      serviceTier: 'priority',
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      effort: 'xhigh',
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-5.6-sol',
          reasoning_effort: 'xhigh',
          developer_instructions: null,
        },
      },
    })
    expect(client.startTurnCalls[0]).toMatchObject({
      input: [{ type: 'text', text: 'Show the current directory' }],
    })

    const [assistant] = assistantMessages(conversation.id)
    expect(assistant.parts).toEqual([
      { type: 'text', id: 'answer_1', text: 'Result: ready.' },
      {
        type: 'tool',
        id: 'command_1',
        toolCallId: 'command_1',
        toolName: 'bash',
        input: { command: 'pwd', cwd: conversation.cwd },
        state: { status: 'completed', output: 'final result\n\n(exit code 0)' },
      },
    ])
    expect(assistant.finishReason).toBe('stop')
    expect(assistant.usage).toEqual({
      usageVersion: 2,
      input: 100,
      cachedInput: 20,
      output: 30,
      contextInput: 40,
      contextOutput: 12,
      modelContextWindow: 200_000,
    })
    expect(emitted).toContainEqual(expect.objectContaining({ kind: 'message-start', messageId: assistant.id }))
    expect(emitted).toContainEqual(
      expect.objectContaining({
        kind: 'finish',
        messageId: assistant.id,
        finishReason: 'stop',
        usage: assistant.usage,
        responseDurationMs: expect.any(Number),
      })
    )
    expect(chatDiagMock).toHaveBeenCalledWith({
      kind: 'codex-subscription-tools-profile',
      mode: 'ask',
      model: 'gpt-5.6-sol',
      tools: expect.objectContaining({ total: 4, eager: 4, deferred: 0 }),
    })
    expect(chatDiagMock).toHaveBeenCalledWith({
      kind: 'codex-subscription-initial-context',
      mode: 'ask',
      model: 'gpt-5.6-sol',
      contextInput: 40,
      tools: expect.objectContaining({ total: 4, eager: 4, deferred: 0 }),
    })
    expect(getCodexThreadBinding(conversation.id)).toEqual({
      conversationId: conversation.id,
      threadId: 'thread_1',
      modelId: 'gpt-5.6-sol',
      toolSignature: expect.any(String),
      instructionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      harnessProfile: 'openai-default-v1',
      lastMessageId: assistant.id,
      usage: {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 7,
      },
      accountId: null,
      updatedAt: expect.any(Number),
    })
  })

  it('compacts portably at the threshold, replaces the root and continues in the same bubble with cumulative usage', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_portable', 'Run a long task', 1)
    const client = new FakeCodexClient()
    const emitted: ChatStreamEvent[] = []
    client.queueTurn({
      turnId: 'turn_portable_1',
      notifications: [
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_portable_1',
            itemId: 'partial_portable',
            delta: 'Partial output before the summary.',
          },
        },
        usageNotification(
          'thread_1',
          'turn_portable_1',
          { total: breakdown(880, 100, 20), last: breakdown(880, 100, 20) },
          1_000
        ),
        // Repeated snapshots above the threshold must not trigger a second interrupt in the same attempt.
        usageNotification(
          'thread_1',
          'turn_portable_1',
          { total: breakdown(880, 100, 20), last: breakdown(880, 100, 20) },
          1_000
        ),
        completedNotification('thread_1', 'turn_portable_1', 'interrupted'),
      ],
    })
    client.queueTurn({
      turnId: 'turn_portable_2',
      notifications: [
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread_2',
            turnId: 'turn_portable_2',
            itemId: 'answer_portable',
            delta: ' Continuation completed.',
          },
        },
        usageNotification(
          'thread_2',
          'turn_portable_2',
          { total: breakdown(50, 10, 10), last: breakdown(200, 10, 10) },
          1_000
        ),
        completedNotification('thread_2', 'turn_portable_2'),
      ],
    })
    const compactHistory = vi.fn(async () => {
      expect(
        assistantMessages(conversation.id)[0].parts.some(
          (part) => part.type === 'text' && part.text.includes('Partial output before the summary.')
        )
      ).toBe(true)
      return {
        summary: 'Portable summary preserving decisions and task state.',
        usage: { input: 7, output: 3, cacheRead: 2, cacheCreate: 1, totalInput: 10 },
      }
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => emitted.push(event))
    args.contextWindow = 1_000
    args.compactHistory = compactHistory
    args.onThreadReady = vi.fn(() => true)

    await expect(runCodexSubscriptionChat(args)).resolves.toEqual({ planSubmitted: false, threadId: 'thread_2' })

    expect(compactHistory).toHaveBeenCalledOnce()
    expect(client.interruptTurnCalls).toEqual([{ threadId: 'thread_1', turnId: 'turn_portable_1' }])
    expect(client.startThreadCalls).toHaveLength(2)
    expect(client.deleteThreadCalls).toEqual([{ threadId: 'thread_1' }])
    expect(args.onThreadReady).toHaveBeenNthCalledWith(1, 'thread_1', {
      providerId: 'builtin_codex_subscription',
      accountId: null,
    })
    expect(args.onThreadReady).toHaveBeenNthCalledWith(2, 'thread_2', {
      providerId: 'builtin_codex_subscription',
      accountId: null,
    })
    expect(emitted.filter((event) => event.kind === 'message-start')).toHaveLength(1)
    expect(emitted.filter((event) => event.kind === 'aborted' || event.kind === 'error')).toEqual([])
    expect(emitted.filter((event) => event.kind === 'finish')).toHaveLength(1)
    expect(emitted.find((event) => event.kind === 'compaction')).toMatchObject({
      strategy: 'summary',
      text: 'Portable summary preserving decisions and task state.',
    })
    expect(emitted.find((event) => event.kind === 'finish')).toMatchObject({
      usage: {
        input: 827,
        output: 33,
        cachedInput: 112,
        cacheCreate: 1,
        contextInput: 200,
        modelContextWindow: 1_000,
      },
    })
    expect(client.startTurnCalls[1]).toMatchObject({
      threadId: 'thread_2',
      clientUserMessageId: expect.not.stringMatching(/^user_portable$/),
      input: [
        {
          type: 'text',
          text: expect.stringMatching(
            /Previous summary:\nPortable summary preserving decisions and task state\.[\s\S]*Continue the same assistant turn/
          ),
        },
      ],
    })
    const assistant = assistantMessages(conversation.id)[0]
    expect(assistant.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', id: 'partial_portable', text: 'Partial output before the summary.' }),
        expect.objectContaining({
          type: 'compaction',
          strategy: 'summary',
          text: 'Portable summary preserving decisions and task state.',
        }),
        expect.objectContaining({ type: 'text', id: 'answer_portable', text: ' Continuation completed.' }),
      ])
    )
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({
      threadId: 'thread_2',
      lastMessageId: assistant.id,
      usage: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 10 },
    })
    expect(listCodexThreadCleanup()).toEqual([])
  })

  it('limits portable compaction to twice per turn and retains only the final fresh root', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_portable_limit', 'Continue through many steps', 1)
    const client = new FakeCodexClient()
    for (const index of [1, 2]) {
      client.queueTurn({
        turnId: `turn_limit_${index}`,
        notifications: [
          usageNotification(
            `thread_${index}`,
            `turn_limit_${index}`,
            { total: breakdown(950, 0, index), last: breakdown(950, 0, index) },
            1_000
          ),
          completedNotification(`thread_${index}`, `turn_limit_${index}`, 'interrupted'),
        ],
      })
    }
    client.queueTurn({
      turnId: 'turn_limit_3',
      notifications: [
        usageNotification(
          'thread_3',
          'turn_limit_3',
          { total: breakdown(980, 0, 3), last: breakdown(980, 0, 3) },
          1_000
        ),
        completedNotification('thread_3', 'turn_limit_3'),
      ],
    })
    const compactHistory = vi
      .fn<() => Promise<{ summary: string }>>()
      .mockResolvedValueOnce({ summary: 'Portable summary 1' })
      .mockResolvedValueOnce({ summary: 'Portable summary 2' })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.contextWindow = 1_000
    args.compactHistory = compactHistory

    await expect(runCodexSubscriptionChat(args)).resolves.toEqual({ planSubmitted: false, threadId: 'thread_3' })

    expect(compactHistory).toHaveBeenCalledTimes(2)
    expect(client.interruptTurnCalls).toEqual([
      { threadId: 'thread_1', turnId: 'turn_limit_1' },
      { threadId: 'thread_2', turnId: 'turn_limit_2' },
    ])
    expect(client.startThreadCalls).toHaveLength(3)
    expect(client.deleteThreadCalls).toEqual([{ threadId: 'thread_1' }, { threadId: 'thread_2' }])
    expect(getCodexThreadBinding(conversation.id)?.threadId).toBe('thread_3')
    expect(listCodexThreadCleanup()).toEqual([])
  })

  it('keeps the Maestrly sentinel out of the protocol and enables Ultra orchestration per turn', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_ultra', 'Implement and validate', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_ultra',
      notifications: [completedNotification('thread_1', 'turn_ultra')],
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    args.permMode = 'full'
    args.reasoningEffort = 'max'
    args.maestrlyUltra = true

    await runCodexSubscriptionChat(args)

    expect(client.startTurnCalls[0]).toMatchObject({
      effort: 'max',
      collaborationMode: {
        mode: 'default',
        settings: {
          reasoning_effort: 'max',
          developer_instructions: expect.stringMatching(
            /Maestrly Ultra mode is active[\s\S]*actively look for independent slices[\s\S]*multiple independent `task` calls in the same response[\s\S]*run in parallel[\s\S]*Delegation is encouraged, not mandatory/
          ),
        },
      },
    })

    const invalid = runArgs(conversation.id, workspace.id, conversation.cwd, new FakeCodexClient())
    invalid.reasoningEffort = MAESTRLY_ULTRA_EFFORT
    await expect(runCodexSubscriptionChat(invalid)).rejects.toThrow(
      'Maestrly Ultra sentinel must be resolved before calling the Codex app-server'
    )
  })

  it('keeps delegation optional at xhigh without applying the prescriptive Ultra overlay', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_xhigh', 'Implement and validate', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_xhigh',
      notifications: [completedNotification('thread_1', 'turn_xhigh')],
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    args.permMode = 'full'
    args.reasoningEffort = 'xhigh'
    args.maestrlyUltra = false

    await runCodexSubscriptionChat(args)

    expect(client.startThreadCalls[0]).toMatchObject({
      developerInstructions: expect.stringContaining('Maestrly subagents are available'),
      dynamicTools: expect.arrayContaining([expect.objectContaining({ name: 'task' })]),
    })
    const start = client.startThreadCalls[0] as {
      dynamicTools: Array<{ name: string; description: string; deferLoading?: boolean; inputSchema: unknown }>
    }
    const task = start.dynamicTools.find((spec) => spec.name === 'task')
    expect(task?.deferLoading).toBeUndefined()
    expect(Buffer.byteLength(task?.description ?? '', 'utf8')).toBeLessThanOrEqual(TASK_TOOL_DESCRIPTION_MAX_BYTES)
    expect(task?.description).not.toContain('Available agents')
    expect(
      (task?.inputSchema as { properties?: { agent?: { enum?: string[] } } })?.properties?.agent?.enum?.length
    ).toBeGreaterThan(0)
    const readers = start.dynamicTools.filter((spec) => ['read', 'grep', 'glob', 'webfetch'].includes(spec.name))
    expect(readers.map((spec) => spec.name).sort()).toEqual(['glob', 'grep', 'read', 'webfetch'])
    expect(readers.every((spec) => spec.deferLoading !== true)).toBe(true)
    expect(client.startTurnCalls[0]).toMatchObject({
      effort: 'xhigh',
      collaborationMode: {
        mode: 'default',
        settings: {
          reasoning_effort: 'xhigh',
          developer_instructions: null,
        },
      },
    })
  })

  it.each([
    ['plan', 'independent research lines'],
    ['ask', 'broad or independent investigation lines'],
  ] as const)('encourages parallel exploration in Ultra in %s mode', async (mode, investigationKind) => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, `user_ultra_${mode}`, 'Investigate in depth', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: `turn_ultra_${mode}`,
      notifications: [completedNotification('thread_1', `turn_ultra_${mode}`)],
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = mode
    args.reasoningEffort = 'max'
    args.maestrlyUltra = true

    await runCodexSubscriptionChat(args)

    expect(client.startThreadCalls[0]).toMatchObject({
      dynamicTools: expect.arrayContaining([expect.objectContaining({ name: 'task' })]),
    })
    const turn = client.startTurnCalls[0] as {
      collaborationMode: { settings: { developer_instructions: string } }
    }
    const instructions = turn.collaborationMode.settings.developer_instructions
    expect(instructions).toContain(investigationKind)
    expect(instructions).toContain('multiple independent `task` calls in the same response')
    expect(instructions).toContain('run in parallel')
  })

  it('Ask exposes only readers, disables native tools and rejects approvals without consulting the broker', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_ask_only', 'Explain this concept', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_ask_only', notifications: [] })
    const assertDecision = vi.fn()
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.broker = {
      assert: vi.fn(),
      assertDecision,
    } as unknown as RunCodexSubscriptionChatArgs['broker']
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    expect(client.startThreadCalls[0]).toMatchObject({
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
      environments: [],
      dynamicTools: [
        expect.objectContaining({ name: 'glob' }),
        expect.objectContaining({ name: 'grep' }),
        expect.objectContaining({ name: 'read' }),
        expect.objectContaining({ name: 'webfetch' }),
      ],
      config: {
        'features.shell_tool': false,
        'features.multi_agent': false,
        'features.multi_agent_v2': false,
        'features.apps': false,
        'features.plugins': false,
        'features.tool_suggest': false,
        'features.image_generation': false,
        'features.skill_search': false,
        'features.skill_mcp_dependency_install': false,
        'skills.include_instructions': false,
        web_search: 'disabled',
      },
      developerInstructions: expect.stringContaining('read-only Maestrly readers'),
    })
    expect(client.startTurnCalls[0]).toMatchObject({
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'untrusted',
    })

    await expect(
      client.serverRequest({
        id: 'ask-command',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_ask_only',
          itemId: 'command_item',
          command: 'pwd',
        },
      })
    ).resolves.toEqual({ decision: 'decline' })
    await expect(
      client.serverRequest({
        id: 'ask-file',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_ask_only',
          itemId: 'file_item',
        },
      })
    ).resolves.toEqual({ decision: 'decline' })
    await expect(
      client.serverRequest({
        id: 'ask-permissions',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_ask_only',
          itemId: 'permissions_item',
          permissions: { network: { enabled: true } },
        },
      })
    ).resolves.toEqual({ permissions: {}, scope: 'turn' })
    expect(assertDecision).not.toHaveBeenCalled()

    client.emit(completedNotification('thread_1', 'turn_ask_only'))
    await running
  })

  it.each([
    ['auto', { type: 'workspaceWrite', writableRoots: null }],
    ['ask', { type: 'readOnly', writableRoots: null }],
  ] as const)('Agent %s disables the native shell and offers the bash bridge under the turn sandbox', async (permMode, expectedSandbox) => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, `user_agent_${permMode}`, 'Implement the change', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: `turn_agent_${permMode}`,
      notifications: [completedNotification('thread_1', `turn_agent_${permMode}`)],
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    args.permMode = permMode

    await runCodexSubscriptionChat(args)

    const threadStart = client.startThreadCalls[0] as {
      config: Record<string, unknown>
      dynamicTools: Array<{ name: string }>
      environments?: unknown
    }
    expect(threadStart).toMatchObject({
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
      config: { 'features.shell_tool': false },
    })
    expect(threadStart.dynamicTools.map((tool) => tool.name)).toContain('bash')
    expect(threadStart.environments).toBeUndefined()

    const sandboxPolicy =
      expectedSandbox.type === 'workspaceWrite'
        ? {
            type: 'workspaceWrite',
            writableRoots: [conversation.cwd],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          }
        : { type: 'readOnly', networkAccess: false }
    expect(client.startTurnCalls[0]).toMatchObject({
      approvalPolicy: 'untrusted',
      sandboxPolicy,
    })
  })

  it('Agent Full keeps the native shell without the bash bridge and applies danger-full-access only to the turn', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_agent_full', 'Implement the change', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_agent_full',
      notifications: [completedNotification('thread_1', 'turn_agent_full')],
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    args.permMode = 'full'

    await runCodexSubscriptionChat(args)

    const threadStart = client.startThreadCalls[0] as {
      config: Record<string, unknown>
      dynamicTools: Array<{ name: string }>
      environments?: unknown
    }
    expect(threadStart).toMatchObject({
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    expect(threadStart.config).not.toHaveProperty('features.shell_tool')
    expect(threadStart.dynamicTools.map((tool) => tool.name)).not.toContain('bash')
    expect(threadStart.environments).toBeUndefined()
    expect(client.startTurnCalls[0]).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
  })

  it('discards the created thread when teardown wins the race before the first turn', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_closed', 'Start the task', 1)
    const client = new FakeCodexClient()
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.onThreadReady = vi.fn(() => false)

    await expect(runCodexSubscriptionChat(args)).rejects.toThrow(
      'Codex thread was discarded because the conversation is being closed'
    )

    expect(args.onThreadReady).toHaveBeenCalledWith('thread_1', {
      providerId: 'builtin_codex_subscription',
      accountId: null,
    })
    expect(client.deleteThreadCalls).toEqual([{ threadId: 'thread_1' }])
    expect(client.startTurnCalls).toEqual([])
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
  })

  it('does not renew the binding when teardown invalidates the thread during the turn', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_invalidated', 'Continue the task', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_invalidated', notifications: [] })
    let mayPersist = true
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.canPersistThread = () => mayPersist
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    mayPersist = false
    client.emit(completedNotification('thread_1', 'turn_invalidated'))
    await running

    expect(getCodexThreadBinding(conversation.id)).toBeNull()
  })

  it('bounds abort during root thread/start and deletes the late response', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_root_thread_start_abort', 'Start and abort', 1)
    const client = new FakeCodexClient()
    let releaseThreadStart!: () => void
    client.startThreadHook = () =>
      new Promise<void>((resolve) => {
        releaseThreadStart = resolve
      })
    const controller = new AbortController()
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.signal = controller.signal
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startThreadCalls).toHaveLength(1))
    vi.useFakeTimers()
    try {
      const rejected = expect(running).rejects.toThrow('Timed out waiting for Codex root thread (starting) to stop')
      controller.abort()
      await vi.advanceTimersByTimeAsync(15_001)
      await rejected
    } finally {
      vi.useRealTimers()
    }
    expect(client.startTurnCalls).toEqual([])
    expect(getCodexThreadBinding(conversation.id)).toBeNull()

    releaseThreadStart()
    await vi.waitFor(() => expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_1' }))
  })

  it('retains ownership after a local thread/start timeout and deletes the late response', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_root_thread_start_timeout', 'Start the thread', 1)
    const client = new FakeCodexClient()
    let releaseThreadStart!: () => void
    client.startThreadHook = () =>
      new Promise<void>((resolve) => {
        releaseThreadStart = resolve
      })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)

    vi.useFakeTimers()
    try {
      const running = runCodexSubscriptionChat(args)
      const rejected = expect(running).rejects.toThrow('Codex thread/start timed out after 30000ms')
      await vi.waitFor(() => expect(client.startThreadCalls).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(30_001)
      await rejected
    } finally {
      vi.useRealTimers()
    }
    expect(getCodexThreadBinding(conversation.id)).toBeNull()

    releaseThreadStart()
    await vi.waitFor(() => expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_1' }))
  })

  it('bounds abort during thread/resume without starting a new turn', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const client = new FakeCodexClient()
    persistUser(conversation.id, 'user_resume_abort_1', 'First turn', 1)
    client.queueTurn({
      turnId: 'turn_resume_abort_1',
      notifications: [completedNotification('thread_1', 'turn_resume_abort_1')],
    })
    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))
    const firstBinding = getCodexThreadBinding(conversation.id)

    persistUser(conversation.id, 'user_resume_abort_2', 'Second turn', 3)
    let releaseResume!: () => void
    client.resumeHook = () =>
      new Promise<void>((resolve) => {
        releaseResume = resolve
      })
    const controller = new AbortController()
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.signal = controller.signal
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.resumeThreadCalls).toHaveLength(1))
    vi.useFakeTimers()
    try {
      const rejected = expect(running).rejects.toThrow('Timed out waiting for Codex root thread (starting) to stop')
      controller.abort()
      await vi.advanceTimersByTimeAsync(15_001)
      await rejected
    } finally {
      vi.useRealTimers()
    }
    expect(client.startTurnCalls).toHaveLength(1)
    expect(getCodexThreadBinding(conversation.id)).toEqual(firstBinding)

    releaseResume()
    await waitImmediate()
    expect(client.startTurnCalls).toHaveLength(1)
  })

  it('bounds abort during root turn/start and interrupts any late response', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_root_turn_start_abort', 'Start the turn and abort', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_late_start', notifications: [] })
    let releaseTurnStart!: () => void
    client.startTurnHook = () =>
      new Promise<void>((resolve) => {
        releaseTurnStart = resolve
      })
    const controller = new AbortController()
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.signal = controller.signal
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    vi.useFakeTimers()
    try {
      controller.abort()
      await vi.advanceTimersByTimeAsync(15_001)
      await running
    } finally {
      vi.useRealTimers()
    }
    expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_1' })
    expect(getCodexThreadBinding(conversation.id)).toBeNull()

    releaseTurnStart()
    await vi.waitFor(() =>
      expect(client.interruptTurnCalls).toContainEqual({
        threadId: 'thread_1',
        turnId: 'turn_root_late_start',
      })
    )
  })

  it('retires the root after a local turn/start timeout and interrupts the late response', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_root_turn_start_timeout', 'Start the turn', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_request_timeout', notifications: [] })
    let releaseTurnStart!: () => void
    client.startTurnHook = () =>
      new Promise<void>((resolve) => {
        releaseTurnStart = resolve
      })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)

    vi.useFakeTimers()
    let running!: ReturnType<typeof runCodexSubscriptionChat>
    try {
      running = runCodexSubscriptionChat(args)
      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(30_001)
      await running
    } finally {
      vi.useRealTimers()
    }

    expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_1' })
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
    expect(assistantMessages(conversation.id)[0].error).toBe('Codex turn/start timed out after 30000ms')

    releaseTurnStart()
    await vi.waitFor(() =>
      expect(client.interruptTurnCalls).toContainEqual({
        threadId: 'thread_1',
        turnId: 'turn_root_request_timeout',
      })
    )
  })

  it('bounds root abort when the runtime does not confirm turn/completed', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_root_abort_timeout', 'Interrupt the task', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_abort_timeout', notifications: [] })
    client.interruptTurnHook = () => {
      throw new Error('runtime did not accept interrupt')
    }
    const controller = new AbortController()
    const events: ChatStreamEvent[] = []
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => events.push(event))
    args.signal = controller.signal
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    vi.useFakeTimers()
    try {
      controller.abort()
      await vi.advanceTimersByTimeAsync(15_001)
      await running
    } finally {
      vi.useRealTimers()
    }
    expect(events).toContainEqual(expect.objectContaining({ kind: 'aborted' }))
    expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_1' })
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
  })

  it('retires a resumed root when abort does not reach terminal state', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_resumed_abort_timeout_1', 'First turn', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_resumed_abort_timeout_1',
      notifications: [completedNotification('thread_1', 'turn_resumed_abort_timeout_1')],
    })
    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({ threadId: 'thread_1' })

    persistUser(conversation.id, 'user_resumed_abort_timeout_2', 'Second turn', 3)
    client.queueTurn({ turnId: 'turn_resumed_abort_timeout_2', notifications: [] })
    const controller = new AbortController()
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.signal = controller.signal
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(2))
    vi.useFakeTimers()
    try {
      controller.abort()
      await vi.advanceTimersByTimeAsync(15_001)
      await running
    } finally {
      vi.useRealTimers()
    }

    expect(client.interruptTurnCalls).toContainEqual({
      threadId: 'thread_1',
      turnId: 'turn_resumed_abort_timeout_2',
    })
    expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_1' })
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
  })

  it('ends execution when the root thread is deleted without turn/completed', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_root_deleted', 'Run the task', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_deleted', notifications: [] })
    const running = runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    client.emit({ method: 'thread/deleted', params: { threadId: 'thread_1' } })
    await running

    expect(assistantMessages(conversation.id)[0].error).toBe('Codex root thread was deleted before completion')
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
  })

  it('invalidates the binding when a resumed root receives thread/deleted', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_resumed_deleted_1', 'First turn', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_resumed_deleted_1',
      notifications: [completedNotification('thread_1', 'turn_resumed_deleted_1')],
    })
    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({ threadId: 'thread_1' })

    persistUser(conversation.id, 'user_resumed_deleted_2', 'Second turn', 3)
    client.queueTurn({ turnId: 'turn_resumed_deleted_2', notifications: [] })
    const running = runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(2))
    client.emit({ method: 'thread/deleted', params: { threadId: 'thread_1' } })
    await running

    expect(getCodexThreadBinding(conversation.id)).toBeNull()
  })

  it('does not recreate the binding or tombstone when abort and thread/deleted race to completion', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_abort_deleted_1', 'First turn', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_abort_deleted_1',
      notifications: [completedNotification('thread_1', 'turn_abort_deleted_1')],
    })
    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    persistUser(conversation.id, 'user_abort_deleted_2', 'Second turn', 3)
    client.queueTurn({ turnId: 'turn_abort_deleted_2', notifications: [] })
    const controller = new AbortController()
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.signal = controller.signal
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(2))
    controller.abort()
    client.emit({ method: 'thread/deleted', params: { threadId: 'thread_1' } })
    await running

    expect(getCodexThreadBinding(conversation.id)).toBeNull()
    expect(listCodexThreadCleanup()).not.toContainEqual(expect.objectContaining({ threadId: 'thread_1' }))
  })

  it('root thread/deleted waits for a task still resolving its profile before finishing', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_root_deleted_pending_task', 'Delegate the task', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_deleted_pending_task', notifications: [] })
    let releaseProfile!: () => void
    resolveSubagentExecutionProfileMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProfile = () =>
            resolve({
              definition: {
                name: 'general-purpose',
                description: 'Worker',
                prompt: 'Do the task.',
                source: 'built-in',
              },
              profile: {
                version: 1,
                agentName: 'general-purpose',
                effective: {
                  providerId: 'byok-provider',
                  modelId: 'worker-model',
                  configuredEffort: 'high',
                  sentEffort: 'high',
                  source: 'conversation-agent',
                  candidateIndex: 0,
                },
                attempts: [],
              },
            })
        })
    )
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    let rootResolved = false
    const running = runCodexSubscriptionChat(args).then((result) => {
      rootResolved = true
      return result
    })

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    const task = client.serverRequest({
      id: 'task_root_deleted_pending',
      method: 'item/tool/call',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_root_deleted_pending_task',
        itemId: 'task_root_deleted_pending',
        callId: 'task_root_deleted_pending',
        tool: 'task',
        arguments: { agent: 'general-purpose', prompt: 'Do the task.' },
      },
    })
    await vi.waitFor(() => expect(resolveSubagentExecutionProfileMock).toHaveBeenCalled())
    client.emit({ method: 'thread/deleted', params: { threadId: 'thread_1' } })
    await waitImmediate()
    expect(rootResolved).toBe(false)

    releaseProfile()
    await expect(task).resolves.toMatchObject({ success: false })
    await running
    expect(assistantMessages(conversation.id)[0].error).toBe('Codex root thread was deleted before completion')
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
  })

  it('keeps an asynchronous Maestro delegate alive and forces the final overview in a continuation', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { experience: 'maestro' })
    persistUser(conversation.id, 'user_maestro_async_guard', 'Delegate and then provide an overview.', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_maestro_parent', notifications: [] })
    client.queueTurn({ turnId: 'turn_maestro_child', notifications: [] })
    client.queueTurn({
      turnId: 'turn_maestro_overview',
      notifications: [
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_maestro_overview',
            itemId: 'maestro_overview',
            delta: 'Final overview after reconciling the agent.',
          },
        },
        completedNotification('thread_1', 'turn_maestro_overview'),
      ],
    })
    const config = createDefaultMaestroConfig()
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'maestro'
    args.permMode = 'full'
    args.maestro = {
      version: 1,
      strategy: config.strategy,
      pool: config.pool,
      source: 'safe-default',
      diagnostics: [],
      frozenAt: 1,
    }
    let rootResolved = false
    const running = runCodexSubscriptionChat(args).then((result) => {
      rootResolved = true
      return result
    })

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1), { timeout: 10_000 })
    await expect(
      client.serverRequest({
        id: 'delegate_maestro_async',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_maestro_parent',
          itemId: 'delegate_maestro_async',
          callId: 'delegate_maestro_async',
          tool: 'delegate',
          arguments: {
            agent: 'generalist',
            task: 'Do the delegated work.',
            kind: 'implement',
            domain: 'fullstack',
            independent: true,
          },
        },
      })
    ).resolves.toMatchObject({ success: true })
    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(2), { timeout: 10_000 })

    // The provider ends the parent round before the worker. This must trigger supervision, not teardown/timeout.
    client.emit(completedNotification('thread_1', 'turn_maestro_parent'))
    await waitImmediate()
    expect(rootResolved).toBe(false)
    expect(client.interruptTurnCalls).not.toContainEqual({
      threadId: 'thread_2',
      turnId: 'turn_maestro_child',
    })

    client.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread_2',
        turnId: 'turn_maestro_child',
        itemId: 'maestro_child_answer',
        delta: 'Delegated work completed.',
      },
    })
    client.emit(completedNotification('thread_2', 'turn_maestro_child'))

    await expect(running).resolves.toEqual({ planSubmitted: false, threadId: 'thread_1' })
    expect(client.startTurnCalls).toHaveLength(3)
    expect(client.startTurnCalls[2]).toMatchObject({
      threadId: 'thread_1',
      input: [
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Host guard: delegated sessions have settled.'),
        }),
      ],
    })
    const assistant = assistantMessages(conversation.id)[0]
    expect(assistant.error).toBeUndefined()
    expect(assistant.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Final overview after reconciling the agent.' })
    )
  })

  it('uses official Plan collaborationMode, streams plan deltas and accepts the final item without a delta', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_plan', 'Plan the implementation', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_plan',
      notifications: [
        {
          method: 'item/plan/delta',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_plan',
            itemId: 'plan_stream',
            delta: '- Investigate\n',
          },
        },
        {
          method: 'item/plan/delta',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_plan',
            itemId: 'plan_stream',
            delta: '- Implement',
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_plan',
            item: { id: 'plan_stream', type: 'plan', text: '- Investigate\n- Implement' },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_plan',
            item: { id: 'plan_final', type: 'plan', text: 'Consolidated final plan.' },
          },
        },
        completedNotification('thread_1', 'turn_plan'),
      ],
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'plan'

    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(`/tmp/no-codex-skills-${conversation.id}`)
    try {
      await runCodexSubscriptionChat(args)
    } finally {
      homedir.mockRestore()
    }

    const threadStart = client.startThreadCalls[0] as {
      config: Record<string, unknown>
      dynamicTools: Array<{ name: string }>
      environments?: unknown
    }
    expect(threadStart.environments).toEqual([])
    expect(threadStart.config).toMatchObject({ 'features.shell_tool': false })
    expect(threadStart.dynamicTools.map((tool) => tool.name)).toEqual([
      'glob',
      'grep',
      'read',
      'review_plan',
      'webfetch',
    ])
    expect(
      (threadStart.dynamicTools as Array<{ deferLoading?: boolean }>).every((spec) => spec.deferLoading !== true)
    ).toBe(true)
    expect(client.startTurnCalls[0]).toMatchObject({
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'gpt-5.6-sol',
          reasoning_effort: 'xhigh',
          developer_instructions: null,
        },
      },
    })
    expect(assistantMessages(conversation.id)[0].parts).toEqual([
      { type: 'text', id: 'plan_stream', text: '- Investigate\n- Implement' },
      { type: 'text', id: 'plan_final', text: 'Consolidated final plan.' },
    ])
  })

  it('treats the interrupt triggered by review_plan as clean plan completion', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_review_plan', 'Plan the implementation', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_review_plan', notifications: [] })
    const emitted: ChatStreamEvent[] = []
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => emitted.push(event))
    args.mode = 'plan'
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    await expect(
      client.serverRequest({
        id: 'review_plan_request',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_review_plan',
          itemId: 'review_plan_item',
          callId: 'review_plan_call',
          tool: 'review_plan',
          arguments: { title: 'Test plan', plan: '- Implement\n- Validate' },
        },
      })
    ).resolves.toMatchObject({ success: true })
    await vi.waitFor(() =>
      expect(client.interruptTurnCalls).toContainEqual({ threadId: 'thread_1', turnId: 'turn_review_plan' })
    )

    client.emit(completedNotification('thread_1', 'turn_review_plan', 'interrupted'))
    await expect(running).resolves.toEqual({ planSubmitted: true, threadId: 'thread_1' })
    expect(emitted).toContainEqual(expect.objectContaining({ kind: 'finish', finishReason: 'stop' }))
    expect(emitted).not.toContainEqual(expect.objectContaining({ kind: 'finish', finishReason: 'interrupted' }))
  })

  it('isolates the reviewer to the exact read-only surface and stops after submit_review is accepted', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: process.cwd() })
    persistUser(conversation.id, 'user_reviewer_boundary', 'Review the execution.', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_reviewer_boundary', notifications: [] })
    const reviewerRuntime = {
      recordEvidence: vi.fn(),
      submitReview: vi.fn(() => ({ ok: true as const })),
      searchExecutionContext: vi.fn(async () => []),
      readExecutionContext: vi.fn(async () => []),
    }
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    args.permMode = 'full'
    args.reviewerRuntime = reviewerRuntime
    args.ephemeralSession = true

    const running = runCodexSubscriptionChat(args)
    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))

    const threadStart = client.startThreadCalls[0] as {
      config: Record<string, unknown>
      dynamicTools: Array<{ name: string }>
      environments?: unknown
    }
    expect(threadStart.dynamicTools.map((entry) => entry.name)).toEqual([...REVIEWER_READONLY_TOOL_NAMES].sort())
    expect(threadStart.environments).toEqual([])
    expect(threadStart.config).toMatchObject({
      'features.shell_tool': false,
      'features.apps': false,
      'features.plugins': false,
      web_search: 'disabled',
    })
    expect(client.startTurnCalls[0]).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false } })

    await expect(
      client.serverRequest({
        id: 'reviewer_read',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_reviewer_boundary',
          itemId: 'reviewer_read',
          callId: 'reviewer_read',
          tool: 'read',
          arguments: { path: 'package.json', limit: 1 },
        },
      })
    ).resolves.toMatchObject({ success: true })
    expect(args.broker.assert).not.toHaveBeenCalled()

    await expect(
      client.serverRequest({
        id: 'reviewer_external_read',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_reviewer_boundary',
          itemId: 'reviewer_external_read',
          callId: 'reviewer_external_read',
          tool: 'read',
          arguments: { path: path.dirname(process.cwd()), limit: 1 },
        },
      })
    ).resolves.toMatchObject({ success: false })
    expect(args.broker.assert).not.toHaveBeenCalled()

    await expect(
      client.serverRequest({
        id: 'reviewer_submit',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_reviewer_boundary',
          itemId: 'reviewer_submit',
          callId: 'reviewer_submit',
          tool: 'submit_review',
          arguments: { result: 'clean', summary: 'No findings.' },
        },
      })
    ).resolves.toMatchObject({ success: true })
    await vi.waitFor(() =>
      expect(client.interruptTurnCalls).toContainEqual({
        threadId: 'thread_1',
        turnId: 'turn_reviewer_boundary',
      })
    )
    client.emit(completedNotification('thread_1', 'turn_reviewer_boundary', 'interrupted'))

    await expect(running).resolves.toEqual({ planSubmitted: true, threadId: 'thread_1' })
    expect(reviewerRuntime.submitReview).toHaveBeenCalledWith({ result: 'clean', summary: 'No findings.' })
  })

  it('exposes .agents, .claude and .codex skills through use_skill governed by effective state', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'maestrly-codex-skills-'))
    try {
      const legacyDir = path.join(cwd, '.claude/skills/deploy')
      const nativeDir = path.join(cwd, '.agents/skills/native-review')
      const codexDir = path.join(cwd, '.codex/skills/codex-audit')
      mkdirSync(legacyDir, { recursive: true })
      mkdirSync(nativeDir, { recursive: true })
      mkdirSync(codexDir, { recursive: true })
      writeFileSync(
        path.join(legacyDir, 'SKILL.md'),
        '---\nname: Safe Deploy\ndescription: publish with checks\n---\nRun the full deployment checklist.'
      )
      writeFileSync(
        path.join(nativeDir, 'SKILL.md'),
        '---\nname: Native Review\ndescription: native review\n---\nUse the native Codex workflow.'
      )
      writeFileSync(
        path.join(codexDir, 'SKILL.md'),
        '---\nname: Codex Audit\ndescription: governed Codex audit\n---\nAudit through the governed workflow.'
      )

      const workspace = makeWorkspace({ path: cwd })
      const conversation = makeConversation(workspace.id, { cwd })
      persistUser(conversation.id, 'user_skill', 'Plan the deployment', 1)
      const client = new FakeCodexClient()
      client.queueTurn({ turnId: 'turn_skill', notifications: [] })
      const args = runArgs(conversation.id, workspace.id, cwd, client)
      args.mode = 'plan'
      const running = runCodexSubscriptionChat(args)

      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
      const start = client.startThreadCalls[0] as {
        developerInstructions: string
        dynamicTools: Array<{ name: string; inputSchema: unknown }>
      }
      const useSkill = start.dynamicTools.find((tool) => tool.name === 'use_skill')
      const skillNames = (useSkill?.inputSchema as { properties?: { name?: { enum?: string[] } } })?.properties?.name
        ?.enum
      expect(skillNames).toContain('safe-deploy')
      // .agents also uses Maestrly use_skill: native Codex discovery stays disabled
      // (skills.include_instructions=false in all modes) so global/per-conversation state always applies.
      expect(skillNames).toContain('native-review')
      expect(skillNames).toContain('codex-audit')
      expect(start.dynamicTools.map((tool) => tool.name)).toContain('review_plan')
      expect(start.developerInstructions).toContain('safe-deploy: publish with checks')
      expect(start.developerInstructions).toContain('native-review: native review')
      expect(start.developerInstructions).toContain('codex-audit: governed Codex audit')

      await expect(
        client.serverRequest({
          id: 'skill_call',
          method: 'item/tool/call',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_skill',
            itemId: 'skill_item',
            callId: 'skill_call',
            tool: 'use_skill',
            arguments: { name: 'safe-deploy' },
          },
        })
      ).resolves.toMatchObject({
        // The return value is now the skill BLOCK: header + absolute directory root + instructions (level 3 of
        // progressive disclosure: the model resolves scripts/references from the root).
        contentItems: [
          {
            type: 'inputText',
            text: expect.stringContaining('Run the full deployment checklist.'),
          },
        ],
        success: true,
      })
      const skillResult = (await client.serverRequest({
        id: 'skill_call_2',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_skill',
          itemId: 'skill_item_2',
          callId: 'skill_call_2',
          tool: 'use_skill',
          arguments: { name: 'safe-deploy' },
        },
      })) as { contentItems: { text: string }[] }
      expect(skillResult.contentItems[0].text).toContain(legacyDir)

      client.emit(completedNotification('thread_1', 'turn_skill'))
      await running
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('renders only the reasoning summary and ignores raw textDelta', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_reasoning', 'Explain briefly', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_reasoning',
      notifications: [
        {
          method: 'item/reasoning/textDelta',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_reasoning',
            itemId: 'reasoning_1',
            delta: 'raw chain-of-thought that must not appear',
          },
        },
        {
          method: 'item/reasoning/summaryTextDelta',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_reasoning',
            itemId: 'reasoning_1',
            delta: 'Safe summary.',
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_reasoning',
            item: {
              id: 'reasoning_1',
              type: 'reasoning',
              summary: ['Safe summary.'],
              content: ['raw chain-of-thought that must not appear'],
            },
          },
        },
        completedNotification('thread_1', 'turn_reasoning'),
      ],
    })

    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    expect(assistantMessages(conversation.id)[0].parts).toEqual([
      { type: 'reasoning', id: 'reasoning_1', text: 'Safe summary.' },
    ])
  })

  it('auto-resolves request_user_input within the official deadline and removes the broker wait', async () => {
    vi.useFakeTimers()
    try {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_question', 'Ask if needed', 1)
      const client = new FakeCodexClient()
      client.queueTurn({ turnId: 'turn_question', notifications: [] })
      const questionBroker = new QuestionBroker()
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
      args.questionBroker = questionBroker
      const running = runCodexSubscriptionChat(args)

      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
      const response = client.serverRequest({
        id: 'request_question',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_question',
          itemId: 'question_1',
          questions: [
            {
              id: 'choice',
              header: 'Choice',
              question: 'How should we continue?',
              options: [{ label: 'Default', description: 'Proceed with the default.' }],
            },
          ],
          autoResolutionMs: 60_000,
        },
      })

      expect(questionBroker.pendingFor(conversation.id)).toEqual(['question_1'])
      expect(questionBroker.pendingQuestionsFor(conversation.id)).toEqual([
        {
          messageId: expect.any(String),
          toolCallId: 'question_1',
          questions: [
            {
              header: 'Choice',
              question: 'How should we continue?',
              options: [{ label: 'Default', description: 'Proceed with the default.' }],
            },
          ],
        },
      ])
      expect(findPendingChatQuestion(assistantMessages(conversation.id))).toMatchObject({
        toolCallId: 'question_1',
        questions: [{ question: 'How should we continue?' }],
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await expect(response).resolves.toEqual({ answers: { choice: { answers: [] } } })
      expect(questionBroker.pendingFor(conversation.id)).toEqual([])

      client.emit(completedNotification('thread_1', 'turn_question'))
      await running
    } finally {
      vi.useRealTimers()
    }
  })

  it('serverRequest/resolved cancels only the approval with the same JSON-RPC id and saves no rule', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_resolved', 'Run the commands', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_resolved', notifications: [] })
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    args.broker = broker
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1), { timeout: 10_000 })
    const numericId = client.serverRequest({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_resolved',
        itemId: 'numeric_item',
        command: 'npm test',
        availableDecisions: ['accept', 'acceptForSession', 'decline'],
      },
    })
    const stringId = client.serverRequest({
      id: '7',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_resolved',
        itemId: 'string_item',
        command: 'git status',
        availableDecisions: ['accept', 'decline'],
      },
    })
    await vi.waitFor(() => expect(broker.pendingFor(conversation.id)).toHaveLength(2))

    client.emit({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread_1', requestId: 7 },
    })

    await expect(numericId).resolves.toEqual({ decision: 'decline' })
    expect(broker.pendingFor(conversation.id).map((request) => request.toolCallId)).toEqual(['string_item'])
    broker.reply({ requestId: broker.pendingFor(conversation.id)[0].id, reply: 'once' })
    await expect(stringId).resolves.toEqual({ decision: 'accept' })

    // If cancellation took the `always` path, the same command would not ask again.
    const retry = client.serverRequest({
      id: 'retry',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_resolved',
        itemId: 'retry_item',
        command: 'npm test',
        availableDecisions: ['accept', 'decline'],
      },
    })
    await vi.waitFor(() => expect(broker.pendingFor(conversation.id)).toHaveLength(1))
    broker.reply({ requestId: broker.pendingFor(conversation.id)[0].id, reply: 'once' })
    await expect(retry).resolves.toEqual({ decision: 'accept' })

    client.emit(completedNotification('thread_1', 'turn_resolved'))
    await running
  })

  it('serverRequest/resolved dismisses request_user_input and clears the QuestionBroker', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_question_resolved', 'Ask if needed', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_question_resolved', notifications: [] })
    const questionBroker = new QuestionBroker()
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.questionBroker = questionBroker
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    const response = client.serverRequest({
      id: 'question_rpc',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_question_resolved',
        itemId: 'question_item',
        questions: [{ id: 'choice', header: 'Choice', question: 'How should we continue?', options: [] }],
      },
    })
    expect(questionBroker.pendingFor(conversation.id)).toEqual(['question_item'])

    client.emit({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread_1', requestId: 'question_rpc' },
    })

    await expect(response).resolves.toEqual({ answers: { choice: { answers: [] } } })
    expect(questionBroker.pendingFor(conversation.id)).toEqual([])
    client.emit(completedNotification('thread_1', 'turn_question_resolved'))
    await running
  })

  it('turn/completed clears pending approvals as a defense against missing resolved notifications', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_turn_cleanup', 'Execute', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_cleanup', notifications: [] })
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    args.broker = broker
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    const response = client.serverRequest({
      id: 'stale_approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_cleanup',
        itemId: 'stale_item',
        command: 'npm test',
        availableDecisions: ['accept', 'decline'],
      },
    })
    await vi.waitFor(() => expect(broker.pendingFor(conversation.id)).toHaveLength(1))

    client.emit(completedNotification('thread_1', 'turn_cleanup'))

    await expect(response).resolves.toEqual({ decision: 'decline' })
    await running
    expect(broker.pendingFor(conversation.id)).toEqual([])
  })

  it('resumes the bound thread and calculates new turn usage against the cumulative baseline', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const client = new FakeCodexClient()
    persistUser(conversation.id, 'user_1', 'first', 1)
    client.queueTurn({
      turnId: 'turn_1',
      notifications: [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_1',
            item: { id: 'answer_1', type: 'agentMessage', text: 'answer one' },
          },
        },
        usageNotification('thread_1', 'turn_1', {
          total: breakdown(100, 20, 30, 4),
          last: breakdown(100, 20, 30, 4),
        }),
        completedNotification('thread_1', 'turn_1'),
      ],
    })
    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    persistUser(conversation.id, 'user_2', 'second', 3)
    client.queueTurn({
      turnId: 'turn_2',
      notifications: [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_2',
            item: { id: 'answer_2', type: 'agentMessage', text: 'answer two' },
          },
        },
        usageNotification('thread_1', 'turn_2', {
          total: breakdown(150, 30, 45, 6),
          last: breakdown(25, 5, 8, 1),
        }),
        completedNotification('thread_1', 'turn_2'),
      ],
    })

    const resumeArgs = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    resumeArgs.requestedContextWindow = 300_000
    const result = await runCodexSubscriptionChat(resumeArgs)

    expect(result.threadId).toBe('thread_1')
    expect(client.startThreadCalls).toHaveLength(1)
    expect(client.resumeThreadCalls).toHaveLength(1)
    expect(client.resumeThreadCalls[0]).toMatchObject({
      threadId: 'thread_1',
      model: 'gpt-5.6-sol',
      config: {
        ...ROOT_THREAD_NATIVE_AUTO_COMPACTION_CONFIG,
        model_context_window: 300_000,
      },
    })
    expect(client.startTurnCalls[1]).toMatchObject({
      threadId: 'thread_1',
      clientUserMessageId: 'user_2',
      input: [{ type: 'text', text: 'second' }],
    })
    const secondAssistant = assistantMessages(conversation.id)[1]
    expect(secondAssistant.parts).toEqual([{ type: 'text', id: 'answer_2', text: 'answer two' }])
    expect(secondAssistant.usage).toEqual({
      usageVersion: 2,
      input: 40,
      cachedInput: 10,
      output: 15,
      contextInput: 25,
      contextOutput: 8,
      modelContextWindow: 200_000,
    })
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({
      threadId: 'thread_1',
      lastMessageId: secondAssistant.id,
      usage: {
        inputTokens: 150,
        cachedInputTokens: 30,
        outputTokens: 45,
        reasoningOutputTokens: 6,
      },
    })
  })

  it('resumes the same thread when switching Codex models and applies the override on resume', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const client = new FakeCodexClient()
    persistUser(conversation.id, 'user_model_1', 'first', 1)
    client.queueTurn({
      turnId: 'turn_model_1',
      notifications: [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_model_1',
            item: { id: 'answer_model_1', type: 'agentMessage', text: 'sol answer' },
          },
        },
        usageNotification('thread_1', 'turn_model_1', {
          total: breakdown(100, 20, 30, 4),
          last: breakdown(100, 20, 30, 4),
        }),
        completedNotification('thread_1', 'turn_model_1'),
      ],
    })
    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    persistUser(conversation.id, 'user_model_2', 'second', 3)
    client.queueTurn({
      turnId: 'turn_model_2',
      notifications: [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_model_2',
            item: { id: 'answer_model_2', type: 'agentMessage', text: 'luna answer' },
          },
        },
        usageNotification('thread_1', 'turn_model_2', {
          total: breakdown(150, 30, 45, 6),
          last: breakdown(25, 5, 8, 1),
        }),
        completedNotification('thread_1', 'turn_model_2'),
      ],
    })
    const lunaArgs = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    lunaArgs.selection = { ...lunaArgs.selection, modelId: 'gpt-5.6-luna' }

    const result = await runCodexSubscriptionChat(lunaArgs)

    expect(result.threadId).toBe('thread_1')
    expect(client.startThreadCalls).toHaveLength(1)
    expect(client.deleteThreadCalls).toEqual([])
    expect(client.resumeThreadCalls).toHaveLength(1)
    expect(client.resumeThreadCalls[0]).toMatchObject({ threadId: 'thread_1', model: 'gpt-5.6-luna' })
    expect(client.startTurnCalls[1]).toMatchObject({
      threadId: 'thread_1',
      model: 'gpt-5.6-luna',
      input: [{ type: 'text', text: 'second' }],
    })
    const secondAssistant = assistantMessages(conversation.id)[1]
    expect(secondAssistant.model).toEqual({
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-luna',
    })
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({
      threadId: 'thread_1',
      modelId: 'gpt-5.6-luna',
      lastMessageId: secondAssistant.id,
    })
  })

  it('registers the route before resumeThread to handle approval replay during resume', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const client = new FakeCodexClient()
    persistUser(conversation.id, 'user_replay_1', 'first', 1)
    client.queueTurn({
      turnId: 'turn_replay_1',
      notifications: [completedNotification('thread_1', 'turn_replay_1')],
    })
    const firstArgs = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    firstArgs.mode = 'agent'
    await runCodexSubscriptionChat(firstArgs)

    persistUser(conversation.id, 'user_replay_2', 'second', 3)
    client.queueTurn({ turnId: 'turn_replay_2', notifications: [] })
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    let replayed: Promise<unknown> | null = null
    client.resumeHook = () => {
      replayed = client.serverRequest({
        id: 'replayed_approval',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_replay_1',
          itemId: 'replayed_item',
          command: 'git status',
          availableDecisions: ['accept', 'decline'],
        },
      })
    }
    const secondArgs = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    secondArgs.mode = 'agent'
    secondArgs.broker = broker
    const running = runCodexSubscriptionChat(secondArgs)

    await vi.waitFor(() => expect(broker.pendingFor(conversation.id)).toHaveLength(1))
    broker.reply({ requestId: broker.pendingFor(conversation.id)[0].id, reply: 'once' })
    await expect(replayed).resolves.toEqual({ decision: 'accept' })
    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(2))

    client.emit(completedNotification('thread_1', 'turn_replay_2'))
    await running
  })

  it('creates a new thread, replays the transcript and resets the old cumulative baseline when resume fails', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const client = new FakeCodexClient()
    persistUser(conversation.id, 'user_1', 'old question', 1)
    client.queueTurn({
      turnId: 'turn_1',
      notifications: [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_1',
            item: { id: 'answer_1', type: 'agentMessage', text: 'old answer' },
          },
        },
        usageNotification('thread_1', 'turn_1', {
          total: breakdown(1_000, 400, 300, 90),
          last: breakdown(1_000, 400, 300, 90),
        }),
        completedNotification('thread_1', 'turn_1'),
      ],
    })
    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    persistUser(conversation.id, 'user_2', 'new question', 3)
    client.resumeError = new Error('thread no longer exists')
    client.queueTurn({
      turnId: 'turn_2',
      notifications: [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_2',
            turnId: 'turn_2',
            item: { id: 'answer_2', type: 'agentMessage', text: 'new answer' },
          },
        },
        usageNotification('thread_2', 'turn_2', {
          total: breakdown(10, 2, 3, 1),
          last: breakdown(10, 2, 3, 1),
        }),
        completedNotification('thread_2', 'turn_2'),
      ],
    })

    const result = await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    expect(result.threadId).toBe('thread_2')
    expect(client.resumeThreadCalls).toHaveLength(1)
    expect(client.startThreadCalls).toHaveLength(2)
    const secondInput = client.startTurnCalls[1] as { input: Array<{ type: string; text: string }> }
    expect(secondInput.input[0].text).toContain('Context imported from the existing Maestrly conversation')
    expect(secondInput.input[0].text).toContain('old question')
    expect(secondInput.input[0].text).toContain('old answer')
    expect(secondInput.input[0].text).toContain('new question')

    const secondAssistant = assistantMessages(conversation.id)[1]
    // Regression: leaking the lost thread snapshot (1000/400/300) would make all these deltas zero.
    expect(secondAssistant.usage).toEqual({
      usageVersion: 2,
      input: 8,
      cachedInput: 2,
      output: 3,
      contextInput: 10,
      contextOutput: 3,
      modelContextWindow: 200_000,
    })
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({
      threadId: 'thread_2',
      lastMessageId: secondAssistant.id,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
    })
  })

  it('routes subagent requests and accounts for their usage outside the root agent context', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_subagent', 'Delegate the investigation', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root', notifications: [] })
    const assertDecision = vi.fn(async () => 'once' as const)
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    args.broker = { assert: vi.fn(async () => {}), assertDecision } as unknown as RunCodexSubscriptionChatArgs['broker']
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    client.emit({
      method: 'thread/started',
      params: { thread: { id: 'thread_child', parentThreadId: 'thread_1' } },
    })
    client.emit({
      method: 'item/started',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_root',
        item: {
          id: 'task_1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'inProgress',
          senderThreadId: 'thread_1',
          receiverThreadIds: ['thread_child'],
          prompt: 'Investigate',
          model: 'gpt-5.6-mini',
        },
      },
    })
    client.emit(
      usageNotification('thread_child', 'turn_child', {
        total: breakdown(70, 20, 15, 4),
        last: breakdown(70, 20, 15, 4),
      })
    )

    await expect(
      client.serverRequest({
        id: 'permission_child',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread_child',
          turnId: 'turn_child',
          itemId: 'permission_item',
          cwd: conversation.cwd,
          reason: 'Export the result',
          permissions: {
            fileSystem: {
              entries: [{ access: 'write', path: { type: 'path', path: '/tmp/maestrly-export' } }],
            },
            network: { enabled: true },
          },
        },
      })
    ).resolves.toEqual({
      permissions: {
        fileSystem: {
          entries: [{ access: 'write', path: { type: 'path', path: '/tmp/maestrly-export' } }],
        },
        network: { enabled: true },
      },
      scope: 'turn',
    })
    expect(assertDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.id,
        resources: ['write:/tmp/maestrly-export', 'network'],
        save: ['write:/tmp/maestrly-export', 'network'],
        toolCallId: 'permission_item',
      })
    )

    client.emit(completedNotification('thread_child', 'turn_child'))
    client.emit(
      usageNotification('thread_1', 'turn_root', {
        total: breakdown(100, 20, 30, 5),
        last: breakdown(100, 20, 30, 5),
      })
    )
    client.emit(completedNotification('thread_1', 'turn_root'))
    await running

    expect(assistantMessages(conversation.id)[0].usage).toEqual({
      usageVersion: 2,
      input: 80,
      cachedInput: 20,
      output: 30,
      contextInput: 100,
      contextOutput: 30,
      modelContextWindow: 200_000,
      subInput: 50,
      subOutput: 15,
      subCachedInput: 20,
      subagentUsage: [
        {
          providerId: 'builtin_codex_subscription',
          modelId: 'gpt-5.6-mini',
          input: 50,
          output: 15,
          cachedInput: 20,
        },
      ],
    })
  })

  it('interrupts the child, waits for terminal state and accepts cleanup of an unpersisted thread', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_wait_child', 'Delegate and finish', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_wait', notifications: [] })
    const lifecycle: string[] = []
    client.interruptTurnHook = (params) => {
      const call = params as { threadId?: string; turnId?: string }
      if (call.threadId !== 'thread_child_wait') return
      lifecycle.push('interrupt')
      client.emit(completedNotification('thread_child_wait', call.turnId ?? 'turn_child_wait', 'interrupted'))
    }
    client.deleteThreadHook = (params) => {
      if ((params as { threadId?: string }).threadId !== 'thread_child_wait') return
      lifecycle.push('delete')
      throw new Error('thread is not persisted and cannot be deleted: 019f9f96-8d5a-7280-969d-3e9b6e007b74')
    }
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    args.permMode = 'full'

    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    client.emit({
      method: 'thread/started',
      params: { thread: { id: 'thread_child_wait', parentThreadId: 'thread_1', ephemeral: false } },
    })
    client.emit({
      method: 'turn/started',
      params: {
        threadId: 'thread_child_wait',
        turn: { id: 'turn_child_wait', status: 'inProgress', error: null },
      },
    })
    client.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_root_wait',
        item: {
          id: 'spawn_wait',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'thread_1',
          receiverThreadIds: ['thread_child_wait'],
          agentsStates: { thread_child_wait: { status: 'running' } },
        },
      },
    })
    client.emit(completedNotification('thread_1', 'turn_root_wait'))

    await expect(running).resolves.toEqual({ planSubmitted: false, threadId: 'thread_1' })
    expect(lifecycle).toEqual(['interrupt', 'delete'])
    expect(client.interruptTurnCalls).toContainEqual({
      threadId: 'thread_child_wait',
      turnId: 'turn_child_wait',
    })
    expect(client.deleteThreadCalls).toEqual([{ threadId: 'thread_child_wait' }])
    expect(assistantMessages(conversation.id)[0].finishReason).toBe('stop')
    expect(assistantMessages(conversation.id)[0].error).toBeUndefined()
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({
      threadId: 'thread_1',
      lastMessageId: assistantMessages(conversation.id)[0].id,
    })
  })

  it('cleans up an already terminal persisted child without sending a redundant interrupt', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_terminal_persisted_child', 'Delegate and finish', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_terminal_child', notifications: [] })
    const running = runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    client.emit({
      method: 'thread/started',
      params: { thread: { id: 'thread_child_terminal', parentThreadId: 'thread_1', ephemeral: false } },
    })
    client.emit(completedNotification('thread_child_terminal', 'turn_child_terminal'))
    client.emit(completedNotification('thread_1', 'turn_root_terminal_child'))

    await running
    expect(client.interruptTurnCalls).not.toContainEqual({
      threadId: 'thread_child_terminal',
      turnId: 'turn_child_terminal',
    })
    expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_child_terminal' })
    expect(assistantMessages(conversation.id)[0].finishReason).toBe('stop')
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({ threadId: 'thread_1' })
  })

  it('accepts the race where interrupt fails but the child confirms terminal state afterward', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_interrupt_race', 'Delegate and finish', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_interrupt_race', notifications: [] })
    client.interruptTurnHook = (params) => {
      const call = params as { threadId?: string; turnId?: string }
      if (call.threadId !== 'thread_child_interrupt_race') return
      setImmediate(() => {
        client.emit(completedNotification('thread_child_interrupt_race', call.turnId ?? 'turn_child_interrupt_race'))
      })
      throw new Error('turn already completed')
    }
    const running = runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    client.emit({
      method: 'thread/started',
      params: { thread: { id: 'thread_child_interrupt_race', parentThreadId: 'thread_1', ephemeral: true } },
    })
    client.emit({
      method: 'turn/started',
      params: {
        threadId: 'thread_child_interrupt_race',
        turn: { id: 'turn_child_interrupt_race', status: 'inProgress', error: null },
      },
    })
    client.emit(completedNotification('thread_1', 'turn_root_interrupt_race'))

    await running
    expect(client.interruptTurnCalls).toContainEqual({
      threadId: 'thread_child_interrupt_race',
      turnId: 'turn_child_interrupt_race',
    })
    expect(assistantMessages(conversation.id)[0].finishReason).toBe('stop')
    expect(assistantMessages(conversation.id)[0].error).toBeUndefined()
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({ threadId: 'thread_1' })
  })

  it('does not persist child tools and interrupts an ephemeral thread without trying to delete it', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_hidden_child_tools', 'Delegate without polluting the context', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_hidden_tools', notifications: [] })
    client.interruptTurnHook = (params) => {
      const call = params as { threadId?: string; turnId?: string }
      if (call.threadId === 'thread_child_hidden') {
        client.emit(completedNotification('thread_child_hidden', call.turnId ?? 'turn_child_hidden', 'interrupted'))
      }
    }
    const events: ChatStreamEvent[] = []
    const running = runCodexSubscriptionChat(
      runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => events.push(event))
    )

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    client.emit({
      method: 'thread/started',
      params: { thread: { id: 'thread_child_hidden', parentThreadId: 'thread_1', ephemeral: true } },
    })
    client.emit({
      method: 'turn/started',
      params: {
        threadId: 'thread_child_hidden',
        turn: { id: 'turn_child_hidden', status: 'inProgress', error: null },
      },
    })
    await expect(
      client.serverRequest({
        id: 'child_glob_request',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_child_hidden',
          turnId: 'turn_child_hidden',
          itemId: 'child_glob_item',
          callId: 'child_glob_call',
          tool: 'glob',
          arguments: { pattern: '__maestrly_no_match__' },
        },
      })
    ).resolves.toMatchObject({ success: true })
    client.emit({
      method: 'item/started',
      params: {
        threadId: 'thread_child_hidden',
        turnId: 'turn_child_hidden',
        item: {
          id: 'child_grep_notification',
          type: 'dynamicToolCall',
          tool: 'grep',
          arguments: { pattern: 'secret', path: 'src' },
        },
      },
    })
    client.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread_child_hidden',
        turnId: 'turn_child_hidden',
        item: {
          id: 'child_grep_notification',
          type: 'dynamicToolCall',
          tool: 'grep',
          arguments: { pattern: 'secret', path: 'src' },
          status: 'completed',
          content: 'large internal output',
        },
      },
    })
    client.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread_child_hidden',
        turnId: 'turn_child_hidden',
        itemId: 'child_answer_hidden',
        delta: 'internal answer',
      },
    })
    client.emit({
      method: 'item/plan/delta',
      params: {
        threadId: 'thread_child_hidden',
        turnId: 'turn_child_hidden',
        itemId: 'child_plan_hidden',
        delta: 'internal plan',
      },
    })
    client.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thread_child_hidden',
        turnId: 'turn_child_hidden',
        itemId: 'child_reasoning_hidden',
        delta: 'internal reasoning',
      },
    })
    client.emit(
      usageNotification('thread_1', 'turn_root_hidden_tools', {
        total: breakdown(20, 5, 8),
        last: breakdown(20, 5, 8),
      })
    )
    client.emit(completedNotification('thread_1', 'turn_root_hidden_tools'))

    await running
    expect(client.interruptTurnCalls).toContainEqual({
      threadId: 'thread_child_hidden',
      turnId: 'turn_child_hidden',
    })
    expect(client.deleteThreadCalls).not.toContainEqual({ threadId: 'thread_child_hidden' })
    expect(events).not.toContainEqual(expect.objectContaining({ toolCallId: 'child_glob_call' }))
    expect(events).not.toContainEqual(expect.objectContaining({ toolCallId: 'child_grep_notification' }))
    expect(events).not.toContainEqual(expect.objectContaining({ partId: 'child_answer_hidden' }))
    expect(events).not.toContainEqual(expect.objectContaining({ partId: 'child_plan_hidden' }))
    expect(events).not.toContainEqual(expect.objectContaining({ partId: 'child_reasoning_hidden' }))
    expect(assistantMessages(conversation.id)[0].parts).not.toContainEqual(
      expect.objectContaining({ toolCallId: 'child_glob_call' })
    )
    expect(assistantMessages(conversation.id)[0].parts).not.toContainEqual(
      expect.objectContaining({ toolCallId: 'child_grep_notification' })
    )
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({
      threadId: 'thread_1',
      lastMessageId: assistantMessages(conversation.id)[0].id,
    })
  })

  it('preserves strict failure when persisted child cleanup truly fails', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_child_cleanup_failure', 'Delegate and finish', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_cleanup_failure', notifications: [] })
    client.interruptTurnHook = (params) => {
      const call = params as { threadId?: string; turnId?: string }
      if (call.threadId === 'thread_child_cleanup_failure') {
        client.emit(
          completedNotification(
            'thread_child_cleanup_failure',
            call.turnId ?? 'turn_child_cleanup_failure',
            'interrupted'
          )
        )
      }
    }
    client.deleteThreadHook = (params) => {
      if ((params as { threadId?: string }).threadId === 'thread_child_cleanup_failure') {
        throw new Error('child cleanup database not found')
      }
    }
    const running = runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    client.emit({
      method: 'thread/started',
      params: {
        thread: { id: 'thread_child_cleanup_failure', parentThreadId: 'thread_1', ephemeral: false },
      },
    })
    client.emit({
      method: 'turn/started',
      params: {
        threadId: 'thread_child_cleanup_failure',
        turn: { id: 'turn_child_cleanup_failure', status: 'inProgress', error: null },
      },
    })
    client.emit(completedNotification('thread_1', 'turn_root_cleanup_failure'))

    await running
    expect(client.deleteThreadCalls).toEqual([{ threadId: 'thread_child_cleanup_failure' }, { threadId: 'thread_1' }])
    expect(assistantMessages(conversation.id)[0].error).toContain(
      'Failed to stop Codex subagents before completing the turn: child cleanup database not found'
    )
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
  })

  it('keeps subagent usage without a model in the total without inventing model attribution', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_subagent_unknown', 'Delegate without an explicit model', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_unknown', notifications: [] })
    const running = runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    client.emit({
      method: 'thread/started',
      params: { thread: { id: 'thread_child_unknown', parentThreadId: 'thread_1' } },
    })
    client.emit(
      usageNotification('thread_child_unknown', 'turn_child_unknown', {
        total: breakdown(70, 20, 15, 4),
        last: breakdown(70, 20, 15, 4),
      })
    )
    client.emit(
      usageNotification('thread_1', 'turn_root_unknown', {
        total: breakdown(100, 20, 30, 5),
        last: breakdown(100, 20, 30, 5),
      })
    )
    client.emit(completedNotification('thread_child_unknown', 'turn_child_unknown'))
    client.emit(completedNotification('thread_1', 'turn_root_unknown'))
    await running

    expect(assistantMessages(conversation.id)[0].usage).toEqual({
      usageVersion: 2,
      input: 80,
      cachedInput: 20,
      output: 30,
      contextInput: 100,
      contextOutput: 30,
      modelContextWindow: 200_000,
      subInput: 50,
      subOutput: 15,
      subCachedInput: 20,
    })
  })

  it('limits persistent approvals to actual commands and files and respects availableDecisions', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_approval', 'Run the tests', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_approval', notifications: [] })
    const assertDecision = vi
      .fn()
      .mockResolvedValueOnce('always')
      .mockResolvedValueOnce('once')
      .mockResolvedValueOnce('always')
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    args.broker = { assert: vi.fn(async () => {}), assertDecision } as unknown as RunCodexSubscriptionChatArgs['broker']
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    await expect(
      client.serverRequest({
        id: 'command_approval',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_approval',
          itemId: 'command_item',
          command: 'npm test && git status',
          cwd: conversation.cwd,
          reason: 'Validate the change',
          additionalPermissions: {
            fileSystem: {
              entries: [{ access: 'write', path: { type: 'path', path: '/tmp/codex-cache' } }],
            },
          },
          networkApprovalContext: { protocol: 'https', host: 'api.example.com' },
          availableDecisions: ['accept', 'acceptForSession', 'decline'],
        },
      })
    ).resolves.toEqual({ decision: 'acceptForSession' })
    expect(assertDecision).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: 'bash',
        resources: ['npm test', 'git status', 'write:/tmp/codex-cache', 'network:https://api.example.com'],
        save: ['npm test *', 'git status *', 'write:/tmp/codex-cache', 'network:https://api.example.com'],
        title: expect.stringContaining('Validate the change'),
      })
    )

    await expect(
      client.serverRequest({
        id: 'command_once',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_approval',
          itemId: 'command_once_item',
          command: 'rm temporary.txt',
          availableDecisions: ['accept', 'decline'],
        },
      })
    ).resolves.toEqual({ decision: 'accept' })
    expect(assertDecision).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ save: expect.anything() }))

    client.emit({
      method: 'item/started',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_approval',
        item: {
          id: 'file_item',
          type: 'fileChange',
          status: 'inProgress',
          changes: [
            { path: '/workspace/src/a.ts', kind: 'update', diff: 'diff-a' },
            { path: '/workspace/src/b.ts', kind: 'create', diff: 'diff-b' },
          ],
        },
      },
    })
    await expect(
      client.serverRequest({
        id: 'file_approval',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_approval',
          itemId: 'file_item',
          reason: 'Apply the patch',
        },
      })
    ).resolves.toEqual({ decision: 'acceptForSession' })
    expect(assertDecision).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        action: 'edit',
        resources: ['/workspace/src/a.ts', '/workspace/src/b.ts'],
        save: ['/workspace/src/a.ts', '/workspace/src/b.ts'],
      })
    )

    client.emit(completedNotification('thread_1', 'turn_approval'))
    await running
  })

  it('runs a Codex Fast task from the snapshot, ignoring the live Standard conversation preference', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_managed_task', 'Delegate the investigation', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_managed', notifications: [] })
    client.queueTurn({
      turnId: 'turn_child_managed',
      notifications: [
        {
          method: 'turn/started',
          params: { threadId: 'thread_2', turn: { id: 'turn_child_managed', status: 'inProgress' } },
        },
        usageNotification('thread_2', 'turn_child_managed', {
          total: breakdown(70, 20, 15, 4),
          last: breakdown(70, 20, 15, 4),
        }),
        {
          method: 'item/started',
          params: {
            threadId: 'thread_2',
            turnId: 'turn_child_managed',
            item: { id: 'child_command', type: 'commandExecution', command: 'rg auth src' },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_2',
            turnId: 'turn_child_managed',
            item: { id: 'child_command', type: 'commandExecution', command: 'rg auth src', status: 'completed' },
          },
        },
        {
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread_2', turnId: 'turn_child_managed', itemId: 'child_answer', delta: 'result' },
        },
        completedNotification('thread_2', 'turn_child_managed'),
      ],
    })
    const profile = {
      version: 1 as const,
      agentName: 'explore',
      category: 'exploration',
      effective: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-mini',
        configuredEffort: 'high',
        sentEffort: 'high',
        fastMode: true,
        source: 'conversation-agent' as const,
        ruleKey: 'explore',
        candidateIndex: 0,
      },
      attempts: [],
    }
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: {
        name: 'explore',
        category: 'exploration',
        description: 'Explore',
        prompt: 'Inspect the requested code read-only.',
        source: 'built-in',
      },
      profile,
    })
    patchConvUiPrefs(conversation.id, { chat: { fastMode: false } })
    const events: ChatStreamEvent[] = []
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => events.push(event))
    args.mode = 'agent'
    args.permMode = 'auto'
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    const taskResult = client.serverRequest({
      id: 'task_request',
      method: 'item/tool/call',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_root_managed',
        itemId: 'task_call',
        callId: 'task_call',
        tool: 'task',
        arguments: { agent: 'explore', prompt: 'Map the authentication flow.' },
      },
    })

    await expect(taskResult).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'result' }],
      success: true,
    })
    expect(resolveSubagentExecutionProfileMock).toHaveBeenCalledTimes(1)
    expect(client.startThreadCalls).toHaveLength(2)
    expect(client.startThreadCalls[0]).toMatchObject({
      config: { 'features.multi_agent': false, 'features.multi_agent_v2': false },
      dynamicTools: expect.arrayContaining([
        expect.objectContaining({ name: 'generate_image' }),
        expect.objectContaining({ name: 'task' }),
      ]),
    })
    expect(client.startThreadCalls[1]).toMatchObject({
      model: 'gpt-5.6-mini',
      serviceTier: 'priority',
      ephemeral: true,
      environments: [],
      config: {
        'features.multi_agent': false,
        'features.multi_agent_v2': false,
        'features.image_generation': false,
      },
    })
    const childDynamicTools = (client.startThreadCalls[1] as { dynamicTools: Array<{ name: string }> }).dynamicTools
    expect(childDynamicTools).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'task' })]))
    expect(childDynamicTools).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'generate_image' })]))
    expect(
      (
        client.startThreadCalls[1] as {
          dynamicTools: Array<{ deferLoading?: boolean }>
        }
      ).dynamicTools.every((spec) => spec.deferLoading !== true)
    ).toBe(true)
    expect(client.startTurnCalls[1]).toMatchObject({
      threadId: 'thread_2',
      model: 'gpt-5.6-mini',
      serviceTier: 'priority',
      effort: 'high',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    expect(client.deleteThreadCalls).not.toContainEqual({ threadId: 'thread_2' })

    client.emit(
      usageNotification('thread_1', 'turn_root_managed', {
        total: breakdown(100, 20, 30, 5),
        last: breakdown(100, 20, 30, 5),
      })
    )
    client.emit(completedNotification('thread_1', 'turn_root_managed'))
    await running

    const completedTask = events.find(
      (event) => event.kind === 'tool-state' && event.toolCallId === 'task_call' && event.state.status === 'completed'
    )
    expect(completedTask).toMatchObject({
      state: {
        status: 'completed',
        output: 'result',
        sub: {
          profile,
          usage: { input: 50, output: 15, cacheRead: 20, cacheCreate: 0 },
          durationMs: expect.any(Number),
        },
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool-state',
        toolCallId: 'task_call',
        state: expect.objectContaining({ status: 'running', output: expect.stringContaining('Running rg auth src') }),
      })
    )
    expect(events).not.toContainEqual(expect.objectContaining({ toolCallId: 'child_command' }))
    expect(assistantMessages(conversation.id)[0]).toMatchObject({
      usage: {
        subInput: 50,
        subOutput: 15,
        subCachedInput: 20,
        subagentUsage: [
          {
            providerId: 'builtin_codex_subscription',
            modelId: 'gpt-5.6-mini',
            input: 50,
            output: 15,
            cachedInput: 20,
          },
        ],
      },
      parts: [
        expect.objectContaining({
          type: 'tool',
          toolCallId: 'task_call',
          state: expect.objectContaining({ status: 'completed', sub: expect.objectContaining({ profile }) }),
        }),
      ],
    })
    expect(assistantMessages(conversation.id)[0].parts).not.toContainEqual(
      expect.objectContaining({ toolCallId: 'child_command' })
    )
  })

  it('exposes a virtual agent (#testing via byAgent) in the task enum, blocks general-purpose and runs with logical identity', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: {
        subagentProfiles: {
          version: 1,
          byAgent: { testing: [{ providerId: 'byok-provider', modelId: 'deepseek-v4-flash', effort: 'max' }] },
        },
      },
    })
    // STRUCTURED selection: the composer `#testing` chip becomes an agent-mention part in the user message.
    // Plain typed `#testing` text would NOT force the agent; turn-request unit tests cover that case.
    const userMsg: ChatMessage = {
      id: 'user_virtual_agent',
      conversationId: conversation.id,
      role: 'user',
      createdAt: 1,
      parts: [
        { type: 'text', id: 'user_virtual_agent_text', text: 'run a simple validation' },
        { type: 'agent-mention', id: 'user_virtual_agent_mention', name: 'testing', start: 0, end: 8 },
      ],
    }
    upsertChatMessage(userMsg)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_virtual', notifications: [] })
    client.queueTurn({
      turnId: 'turn_child_virtual',
      notifications: [
        {
          method: 'turn/started',
          params: { threadId: 'thread_2', turn: { id: 'turn_child_virtual', status: 'inProgress' } },
        },
        usageNotification('thread_2', 'turn_child_virtual', {
          total: breakdown(60, 10, 12, 3),
          last: breakdown(60, 10, 12, 3),
        }),
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread_2',
            turnId: 'turn_child_virtual',
            itemId: 'child_answer_virtual',
            delta: 'validation ok',
          },
        },
        completedNotification('thread_2', 'turn_child_virtual'),
      ],
    })
    const profile = {
      version: 1 as const,
      agentName: 'testing',
      category: 'custom',
      effective: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-mini',
        configuredEffort: 'high',
        sentEffort: 'high',
        source: 'conversation-agent' as const,
        ruleKey: 'testing',
        candidateIndex: 0,
      },
      attempts: [],
    }
    const virtualDefinition = {
      name: 'testing',
      category: 'custom',
      description: 'Custom virtual agent based on general-purpose with a dedicated host-managed profile.',
      prompt: 'You are a worker subagent with full tools.',
      tools: ['bash', 'write', 'edit', 'read'],
      source: 'virtual-profile',
      virtual: true,
      baseAgentName: 'general-purpose',
    }
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({ definition: virtualDefinition, profile })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    const rootDynamicTools = (
      client.startThreadCalls[0] as { dynamicTools: Array<{ name: string; inputSchema: unknown }> }
    ).dynamicTools
    const taskSpec = rootDynamicTools.find((spec) => spec.name === 'task')
    expect(
      (taskSpec?.inputSchema as { properties?: { agent?: { enum?: string[] } } })?.properties?.agent?.enum
    ).toContain('testing')

    // general-purpose while #testing is pending: the guard rejects BEFORE resolution/execution.
    await expect(
      client.serverRequest({
        id: 'task_virtual_wrong',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_root_virtual',
          itemId: 'task_virtual_wrong',
          callId: 'task_virtual_wrong',
          tool: 'task',
          arguments: { agent: 'general-purpose', prompt: 'Run it yourself.' },
        },
      })
    ).resolves.toMatchObject({
      success: false,
      contentItems: [
        { type: 'inputText', text: expect.stringContaining('explicitly requested the available subagent') },
      ],
    })
    expect(resolveSubagentExecutionProfileMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'general-purpose' })
    )
    expect(client.startThreadCalls).toHaveLength(1)

    // task.agent='testing' runs with base (general-purpose) prompt/tools and the configured DeepSeek profile.
    await expect(
      client.serverRequest({
        id: 'task_virtual',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_root_virtual',
          itemId: 'task_virtual',
          callId: 'task_virtual',
          tool: 'task',
          arguments: { agent: 'testing', prompt: 'Validate the flow.' },
        },
      })
    ).resolves.toEqual({ contentItems: [{ type: 'inputText', text: 'validation ok' }], success: true })
    expect(resolveSubagentExecutionProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'testing',
        conversationId: conversation.id,
        // The resolved definition comes from the effective catalog: the virtual agent has logical identity
        // testing and base general-purpose (prompt/tool inheritance is covered by the domain test).
        agents: expect.arrayContaining([
          expect.objectContaining({
            name: 'testing',
            virtual: true,
            baseAgentName: 'general-purpose',
            source: 'virtual-profile',
          }),
        ]),
      })
    )
    // The child thread runs on the configured profile model, not the conversation model.
    expect(client.startThreadCalls[1]).toMatchObject({ model: 'gpt-5.6-mini', ephemeral: true })

    client.emit(
      usageNotification('thread_1', 'turn_root_virtual', {
        total: breakdown(100, 20, 30, 5),
        last: breakdown(100, 20, 30, 5),
      })
    )
    client.emit(completedNotification('thread_1', 'turn_root_virtual'))
    await running

    // Card and usage are attributed to logical agent testing / effective model DeepSeek.
    const taskPart = assistantMessages(conversation.id)[0].parts.find(
      (part) => part.type === 'tool' && part.toolCallId === 'task_virtual'
    )
    expect(taskPart).toMatchObject({
      type: 'tool',
      toolName: 'task',
      state: { status: 'completed', output: 'validation ok', sub: { profile } },
    })
    expect(assistantMessages(conversation.id)[0].usage).toMatchObject({
      subagentUsage: [expect.objectContaining({ providerId: 'builtin_codex_subscription', modelId: 'gpt-5.6-mini' })],
    })
  })

  it('waits for in-flight subagent creation before tearing down the parent route', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_late_child_start', 'Delegate and finish', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_late_child', notifications: [] })
    let releaseChildStart!: () => void
    client.startThreadHook = (params) => {
      if ((params as { ephemeral?: boolean }).ephemeral !== true) return
      return new Promise<void>((resolve) => {
        releaseChildStart = resolve
      })
    }
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: {
        name: 'explore',
        description: 'Explore',
        prompt: 'Inspect read-only.',
        source: 'built-in',
      },
      profile: {
        version: 1,
        agentName: 'explore',
        effective: {
          providerId: 'builtin_codex_subscription',
          modelId: 'gpt-5.6-mini',
          configuredEffort: 'high',
          sentEffort: 'high',
          source: 'conversation-agent',
          candidateIndex: 0,
        },
        attempts: [],
      },
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    let rootResolved = false
    const running = runCodexSubscriptionChat(args).then((result) => {
      rootResolved = true
      return result
    })

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    const task = client.serverRequest({
      id: 'task_late_child',
      method: 'item/tool/call',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_root_late_child',
        itemId: 'task_late_child',
        callId: 'task_late_child',
        tool: 'task',
        arguments: { agent: 'explore', prompt: 'Inspect the flow.' },
      },
    })
    await vi.waitFor(() => expect(client.startThreadCalls).toHaveLength(2))
    client.emit(completedNotification('thread_1', 'turn_root_late_child'))
    await waitImmediate()
    expect(rootResolved).toBe(false)

    releaseChildStart()
    await expect(task).resolves.toMatchObject({ success: false })
    await expect(running).resolves.toEqual({ planSubmitted: false, threadId: 'thread_1' })
    expect(client.startTurnCalls).toHaveLength(1)
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({ threadId: 'thread_1' })
  })

  it('releases the child when turn/start rejects without creating a phantom turn in the parent', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_child_turn_rejected', 'Delegate and finish', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_child_rejected', notifications: [] })
    client.startTurnHook = (params) => {
      if ((params as { threadId?: string }).threadId === 'thread_2') {
        throw new Error('child turn/start rejected')
      }
    }
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: {
        name: 'explore',
        description: 'Explore',
        prompt: 'Inspect read-only.',
        source: 'built-in',
      },
      profile: {
        version: 1,
        agentName: 'explore',
        effective: {
          providerId: 'builtin_codex_subscription',
          modelId: 'gpt-5.6-mini',
          configuredEffort: 'high',
          sentEffort: 'high',
          source: 'conversation-agent',
          candidateIndex: 0,
        },
        attempts: [],
      },
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    await expect(
      client.serverRequest({
        id: 'task_child_turn_rejected',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_root_child_rejected',
          itemId: 'task_child_turn_rejected',
          callId: 'task_child_turn_rejected',
          tool: 'task',
          arguments: { agent: 'explore', prompt: 'Inspect the flow.' },
        },
      })
    ).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'Subagent "explore" failed: child turn/start rejected' }],
      success: false,
    })

    client.emit(completedNotification('thread_1', 'turn_root_child_rejected'))
    await expect(running).resolves.toEqual({ planSubmitted: false, threadId: 'thread_1' })
    expect(client.deleteThreadCalls).not.toContainEqual({ threadId: 'thread_2' })
    expect(getCodexThreadBinding(conversation.id)).toMatchObject({ threadId: 'thread_1' })
  })

  it('dispatches a Codex parent to BYOK and aggregates cost by effective provider/model', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_cross_provider', 'Use the BYOK worker', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_cross_provider', notifications: [] })
    const profile = {
      version: 1 as const,
      agentName: 'general-purpose',
      effective: {
        providerId: 'byok-provider',
        modelId: 'worker-model',
        configuredEffort: 'high',
        sentEffort: 'high',
        source: 'conversation-agent' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: {
        name: 'general-purpose',
        description: 'Worker',
        prompt: 'Implement the task.',
        source: 'built-in',
        tools: ['read', 'edit'],
      },
      profile,
    })
    runSubagentMock.mockResolvedValueOnce({
      text: 'BYOK result',
      model: { providerId: 'byok-provider', modelId: 'worker-model' },
      usage: { input: 30, output: 9, cacheRead: 7, cacheCreate: 3, totalInput: 40 },
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    await expect(
      client.serverRequest({
        id: 'task_cross_provider',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          itemId: 'task_cross_provider',
          callId: 'task_cross_provider',
          tool: 'task',
          arguments: { agent: 'general-purpose', prompt: 'Make the isolated change.' },
        },
      })
    ).resolves.toMatchObject({ success: true })
    expect(client.startThreadCalls).toHaveLength(1)
    expect(runSubagentMock).toHaveBeenCalledWith(
      expect.objectContaining({ profile, agentName: 'general-purpose', task: 'Make the isolated change.' })
    )

    client.emit(
      usageNotification('thread_1', 'turn_cross_provider', {
        total: breakdown(50, 10, 12),
        last: breakdown(50, 10, 12),
      })
    )
    client.emit(completedNotification('thread_1', 'turn_cross_provider'))
    await running

    expect(assistantMessages(conversation.id)[0].usage).toMatchObject({
      subInput: 30,
      subOutput: 9,
      subCachedInput: 7,
      subCacheCreate: 3,
      subagentUsage: [
        {
          providerId: 'byok-provider',
          modelId: 'worker-model',
          input: 30,
          output: 9,
          cachedInput: 7,
          cacheCreate: 3,
        },
      ],
    })
  })

  it('orchestrates a specialist plus helpers and blocks general-purpose while the specialist is pending', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    // Agents in the real catalog (.claude/agents files under cwd) make them available to the guard.
    const agentsDirectory = path.join(conversation.cwd, '.claude', 'agents')
    mkdirSync(agentsDirectory, { recursive: true })
    writeFileSync(
      path.join(agentsDirectory, 'api-integration-engineer.md'),
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
      path.join(agentsDirectory, 'runtime-reviewer.md'),
      [
        '---',
        'name: runtime-reviewer',
        'description: Reviews the runtime.',
        'tools: read, bash',
        '---',
        'Review the runtime carefully.',
      ].join('\n')
    )
    persistUser(
      conversation.id,
      'user_multi_agent',
      'Use api-integration-engineer to implement. First, use explore to map the points and then runtime-reviewer to review.',
      1
    )
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_multi_agent', notifications: [] })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    // The runner already created the root thread at turn start; the guard must not open a child thread.
    const rootThreadCount = client.startThreadCalls.length

    // 1) Helper explore is allowed independently of the pending specialist.
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: {
        name: 'explore',
        description: 'Read-only search agent.',
        prompt: 'Explore.',
        source: 'built-in',
      },
      profile: {
        version: 1 as const,
        agentName: 'explore',
        effective: {
          providerId: 'byok-provider',
          modelId: 'explore-model',
          configuredEffort: 'low',
          sentEffort: 'low',
          source: 'parent' as const,
          candidateIndex: 0,
        },
        attempts: [],
      },
    })
    runSubagentMock.mockResolvedValueOnce({
      text: 'integration map',
      model: { providerId: 'byok-provider', modelId: 'explore-model' },
      usage: { input: 12, output: 4, cacheRead: 1, cacheCreate: 0, totalInput: 16 },
    })
    await expect(
      client.serverRequest({
        id: 'task_explore',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          itemId: 'task_explore',
          callId: 'task_explore',
          tool: 'task',
          arguments: { agent: 'explore', prompt: 'Map the integration points.' },
        },
      })
    ).resolves.toMatchObject({ success: true })
    expect(resolveSubagentExecutionProfileMock).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'explore' }))

    // 2) general-purpose: the guard rejects BEFORE resolving a profile/opening a thread/recording usage.
    await expect(
      client.serverRequest({
        id: 'task_wrong_agent',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          itemId: 'task_wrong_agent',
          callId: 'task_wrong_agent',
          tool: 'task',
          arguments: { agent: 'general-purpose', prompt: 'Implement the integration.' },
        },
      })
    ).resolves.toMatchObject({
      success: false,
      contentItems: [
        { type: 'inputText', text: expect.stringContaining('explicitly requested the available subagent') },
      ],
    })
    expect(resolveSubagentExecutionProfileMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'general-purpose' })
    )
    expect(client.startThreadCalls).toHaveLength(rootThreadCount)

    // 3) The specialist resolves its configured profile (provider A) normally.
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
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: {
        name: 'api-integration-engineer',
        description: 'Integrates third-party APIs.',
        prompt: 'You are the API integration specialist. Analyze the integration and report.',
        source: '.claude/agents/api-integration-engineer.md',
        tools: ['read', 'bash', 'write', 'edit'],
      },
      profile: specialistProfile,
    })
    runSubagentMock.mockResolvedValueOnce({
      text: 'integration implementation',
      model: { providerId: 'provider-a', modelId: 'model-a' },
      usage: { input: 40, output: 11, cacheRead: 5, cacheCreate: 2, totalInput: 45 },
    })
    await expect(
      client.serverRequest({
        id: 'task_specialist',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          itemId: 'task_specialist',
          callId: 'task_specialist',
          tool: 'task',
          arguments: { agent: 'api-integration-engineer', prompt: 'Implement the integration.' },
        },
      })
    ).resolves.toMatchObject({ success: true })
    expect(resolveSubagentExecutionProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'api-integration-engineer' })
    )
    expect(runSubagentMock).toHaveBeenCalledWith(
      expect.objectContaining({ profile: specialistProfile, agentName: 'api-integration-engineer' })
    )
    expect(runSubagentMock).not.toHaveBeenCalledWith(expect.objectContaining({ agentName: 'general-purpose' }))

    // 4) After specialist dispatch, the helper reviewer is allowed.
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: {
        name: 'runtime-reviewer',
        description: 'Reviews the runtime.',
        prompt: 'Review the runtime carefully.',
        source: '.claude/agents/runtime-reviewer.md',
        tools: ['read', 'bash'],
      },
      profile: {
        version: 1 as const,
        agentName: 'runtime-reviewer',
        effective: {
          providerId: 'byok-provider',
          modelId: 'reviewer-model',
          configuredEffort: 'medium',
          sentEffort: 'medium',
          source: 'parent' as const,
          candidateIndex: 0,
        },
        attempts: [],
      },
    })
    runSubagentMock.mockResolvedValueOnce({
      text: 'review ok',
      model: { providerId: 'byok-provider', modelId: 'reviewer-model' },
      usage: { input: 15, output: 6, cacheRead: 2, cacheCreate: 0, totalInput: 21 },
    })
    await expect(
      client.serverRequest({
        id: 'task_reviewer',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          itemId: 'task_reviewer',
          callId: 'task_reviewer',
          tool: 'task',
          arguments: { agent: 'runtime-reviewer', prompt: 'Review the implementation.' },
        },
      })
    ).resolves.toMatchObject({ success: true })
    expect(resolveSubagentExecutionProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'runtime-reviewer' })
    )
    expect(client.startThreadCalls).toHaveLength(rootThreadCount)

    client.emit(
      usageNotification('thread_1', 'turn_multi_agent', {
        total: breakdown(60, 12, 14),
        last: breakdown(60, 12, 14),
      })
    )
    client.emit(completedNotification('thread_1', 'turn_multi_agent'))
    await running

    // Card and aggregate usage for all 3 subagents (explore 12/4 + specialist 40/11 + reviewer 15/6).
    const usage = assistantMessages(conversation.id)[0].usage
    expect(usage).toMatchObject({
      subInput: 67,
      subOutput: 21,
      subCachedInput: 8,
      subCacheCreate: 2,
    })
    // Usage is attributed to the effective specialist model (provider A), not general-purpose.
    expect(usage?.subagentUsage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'provider-a',
          modelId: 'model-a',
          input: 40,
          output: 11,
          cachedInput: 5,
          cacheCreate: 2,
        }),
      ])
    )
    expect(usage?.subagentUsage?.some((entry) => entry.modelId === 'general-purpose-model')).toBe(false)
  })

  it('does not restrict selection when the user only asks about or mentions agents', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(
      conversation.id,
      'user_descriptive_question',
      'Why was `api-integration-engineer` replaced with `general-purpose`?',
      1
    )
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_descriptive', notifications: [] })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))

    // Without an explicit request, the guard does not restrict selection: general-purpose runs normally.
    const profile = {
      version: 1 as const,
      agentName: 'general-purpose',
      effective: {
        providerId: 'byok-provider',
        modelId: 'worker-model',
        configuredEffort: 'high',
        sentEffort: 'high',
        source: 'conversation-default' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: {
        name: 'general-purpose',
        description: 'Worker',
        prompt: 'Complete the delegated task.',
        source: 'built-in',
        tools: ['read', 'grep'],
      },
      profile,
    })
    runSubagentMock.mockResolvedValueOnce({
      text: 'answer',
      model: { providerId: 'byok-provider', modelId: 'worker-model' },
      usage: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0, totalInput: 15 },
    })
    await expect(
      client.serverRequest({
        id: 'task_any',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          itemId: 'task_any',
          callId: 'task_any',
          tool: 'task',
          arguments: { agent: 'general-purpose', prompt: 'Answer.' },
        },
      })
    ).resolves.toMatchObject({ success: true })
    expect(runSubagentMock).toHaveBeenCalledWith(expect.objectContaining({ profile, agentName: 'general-purpose' }))

    client.emit(
      usageNotification('thread_1', 'turn_descriptive', {
        total: breakdown(20, 5, 3),
        last: breakdown(20, 5, 3),
      })
    )
    client.emit(completedNotification('thread_1', 'turn_descriptive'))
    await running
  })

  it('blocks silent replacement of a user-named specialist and resolves the retry with the correct agent', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    // An agent in the real catalog (a .claude/agents file under cwd) makes it available to the guard.
    const agentsDirectory = path.join(conversation.cwd, '.claude', 'agents')
    mkdirSync(agentsDirectory, { recursive: true })
    writeFileSync(
      path.join(agentsDirectory, 'api-integration-engineer.md'),
      [
        '---',
        'name: api-integration-engineer',
        'description: Integrates third-party APIs.',
        'tools: read, bash, write, edit',
        '---',
        'You are the API integration specialist. Analyze the integration and report.',
      ].join('\n')
    )
    persistUser(
      conversation.id,
      'user_explicit_specialist',
      'Use api-integration-engineer to analyze this integration.',
      1
    )
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_explicit_specialist', notifications: [] })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    // The runner already created the root thread at turn start; the guard must not open a child thread.
    const rootThreadCount = client.startThreadCalls.length

    // 1) The model tries general-purpose: the guard rejects BEFORE profile resolution/thread creation/usage recording.
    await expect(
      client.serverRequest({
        id: 'task_wrong_agent',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          itemId: 'task_wrong_agent',
          callId: 'task_wrong_agent',
          tool: 'task',
          arguments: { agent: 'general-purpose', prompt: 'Analyze the integration.' },
        },
      })
    ).resolves.toMatchObject({
      success: false,
      contentItems: [
        { type: 'inputText', text: expect.stringContaining('explicitly requested the available subagent') },
      ],
    })
    expect(resolveSubagentExecutionProfileMock).not.toHaveBeenCalled()
    expect(client.startThreadCalls).toHaveLength(rootThreadCount)

    // 2) Retrying with the named agent resolves its configured profile (provider A) normally.
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
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: {
        name: 'api-integration-engineer',
        description: 'Integrates third-party APIs.',
        prompt: 'You are the API integration specialist. Analyze the integration and report.',
        source: '.claude/agents/api-integration-engineer.md',
        tools: ['read', 'bash', 'write', 'edit'],
      },
      profile: specialistProfile,
    })
    runSubagentMock.mockResolvedValueOnce({
      text: 'integration analysis',
      model: { providerId: 'provider-a', modelId: 'model-a' },
      usage: { input: 40, output: 11, cacheRead: 5, cacheCreate: 2, totalInput: 45 },
    })
    await expect(
      client.serverRequest({
        id: 'task_right_agent',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          itemId: 'task_right_agent',
          callId: 'task_right_agent',
          tool: 'task',
          arguments: { agent: 'api-integration-engineer', prompt: 'Analyze the integration.' },
        },
      })
    ).resolves.toMatchObject({ success: true })
    // The BYOK route runs in-process (runSubagent) without opening a native child thread.
    expect(client.startThreadCalls).toHaveLength(rootThreadCount)
    expect(resolveSubagentExecutionProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'api-integration-engineer' })
    )
    expect(runSubagentMock).toHaveBeenCalledWith(
      expect.objectContaining({ profile: specialistProfile, agentName: 'api-integration-engineer' })
    )
    expect(runSubagentMock).not.toHaveBeenCalledWith(expect.objectContaining({ agentName: 'general-purpose' }))

    client.emit(
      usageNotification('thread_1', 'turn_explicit_specialist', {
        total: breakdown(60, 12, 14),
        last: breakdown(60, 12, 14),
      })
    )
    client.emit(completedNotification('thread_1', 'turn_explicit_specialist'))
    await running

    // Card and usage are attributed to the effective specialist model (provider A), not general-purpose.
    expect(assistantMessages(conversation.id)[0].usage).toMatchObject({
      subInput: 40,
      subOutput: 11,
      subCachedInput: 5,
      subCacheCreate: 2,
      subagentUsage: [
        {
          providerId: 'provider-a',
          modelId: 'model-a',
          input: 40,
          output: 11,
          cachedInput: 5,
          cacheCreate: 2,
        },
      ],
    })
  })

  it('dispatches a Codex parent to official Claude Opus with the configured model and effort', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_codex_to_claude', 'Use Claude Opus as a worker', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_codex_to_claude', notifications: [] })
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
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: {
        name: 'general-purpose',
        description: 'Worker',
        prompt: 'Complete the delegated task.',
        source: 'built-in',
        tools: ['read', 'grep'],
      },
      profile,
    })
    runClaudeSubagentMock.mockImplementationOnce(async (args) => {
      args.progress?.('Starting subagent general-purpose')
      return {
        text: 'Claude Opus result',
        model: { providerId: 'builtin_claude_subscription', modelId: 'opus[1m]' },
        usage: { input: 11, output: 17, cacheRead: 130, cacheCreate: 42, totalInput: 183 },
        runtimeEstimatedCostUsd: 0.0064,
      }
    })
    const events: ChatStreamEvent[] = []
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => events.push(event))
    args.mode = 'agent'
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    await expect(
      client.serverRequest({
        id: 'task_codex_to_claude',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          itemId: 'task_codex_to_claude',
          callId: 'task_codex_to_claude',
          tool: 'task',
          arguments: { agent: 'general-purpose', prompt: 'Review the flow with Opus.' },
        },
      })
    ).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'Claude Opus result' }],
      success: true,
    })
    expect(runClaudeSubagentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        agentName: 'general-purpose',
        task: 'Review the flow with Opus.',
        accountIdentity: {
          fingerprint: 'sha256:claude-account',
          epoch: 3,
        },
      })
    )
    expect(client.startThreadCalls).toHaveLength(1)

    client.emit(
      usageNotification('thread_1', 'turn_codex_to_claude', {
        total: breakdown(60, 10, 13),
        last: breakdown(60, 10, 13),
      })
    )
    client.emit(completedNotification('thread_1', 'turn_codex_to_claude'))
    await running

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool-state',
        toolCallId: 'task_codex_to_claude',
        state: expect.objectContaining({
          status: 'completed',
          output: 'Claude Opus result',
          sub: expect.objectContaining({
            profile,
            usage: {
              input: 11,
              output: 17,
              cacheRead: 130,
              cacheCreate: 42,
            },
            runtimeEstimatedCostUsd: 0.0064,
            startedAt: expect.any(Number),
            durationMs: expect.any(Number),
            sessionId: expect.stringMatching(/^subagent-/),
          }),
        }),
      })
    )
    expect(assistantMessages(conversation.id)[0].usage).toMatchObject({
      subInput: 11,
      subOutput: 17,
      subCachedInput: 130,
      subCacheCreate: 42,
      subagentUsage: [
        {
          providerId: 'builtin_claude_subscription',
          modelId: 'opus[1m]',
          input: 11,
          output: 17,
          cachedInput: 130,
          cacheCreate: 42,
          runtimeEstimatedCostUsd: 0.0064,
        },
      ],
    })
  })

  it('dispatches a Codex parent to official GitHub Copilot without falling through to the BYOK runner', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_codex_to_copilot', 'Use Copilot as a worker', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_codex_to_copilot', notifications: [] })
    const profile = {
      version: 1 as const,
      agentName: 'general-purpose',
      effective: {
        providerId: 'builtin_github_copilot_subscription',
        modelId: 'claude-sonnet-4.6',
        configuredEffort: 'high',
        sentEffort: 'high',
        source: 'conversation-default' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: {
        name: 'general-purpose',
        description: 'Worker',
        prompt: 'Complete the delegated task.',
        source: 'built-in',
        tools: ['read', 'grep'],
      },
      profile,
    })
    runGitHubCopilotSubagentMock.mockResolvedValueOnce({
      text: 'Copilot result',
      model: { providerId: 'builtin_github_copilot_subscription', modelId: 'claude-sonnet-4.6' },
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.mode = 'agent'
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    await expect(
      client.serverRequest({
        id: 'task_codex_to_copilot',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          itemId: 'task_codex_to_copilot',
          callId: 'task_codex_to_copilot',
          tool: 'task',
          arguments: { agent: 'general-purpose', prompt: 'Review the flow with Copilot.' },
        },
      })
    ).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'Copilot result' }],
      success: true,
    })
    expect(runGitHubCopilotSubagentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        agentName: 'general-purpose',
        task: 'Review the flow with Copilot.',
        accountIdentity: { fingerprint: 'sha256:copilot-account', epoch: 5 },
        allowSkillLoader: false,
      })
    )
    expect(runSubagentMock).not.toHaveBeenCalled()

    client.emit(completedNotification('thread_1', 'turn_codex_to_copilot'))
    await running
  })

  it('preserves the snapshot and releases the ephemeral thread when the Codex subagent fails', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_child_failure', 'Delegate a failing task', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_failure', notifications: [] })
    client.queueTurn({
      turnId: 'turn_child_failure',
      notifications: [
        usageNotification('thread_2', 'turn_child_failure', {
          total: breakdown(25, 5, 4),
          last: breakdown(25, 5, 4),
        }),
        {
          method: 'turn/completed',
          params: {
            threadId: 'thread_2',
            turn: { id: 'turn_child_failure', status: 'failed', error: { message: 'child exploded' } },
          },
        },
      ],
    })
    const profile = {
      version: 1 as const,
      agentName: 'explore',
      effective: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-child',
        configuredEffort: 'medium',
        sentEffort: 'medium',
        source: 'parent' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: { name: 'explore', description: 'Explore', prompt: 'Inspect.', source: 'built-in' },
      profile,
    })
    const events: ChatStreamEvent[] = []
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => events.push(event))
    args.mode = 'agent'
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    await expect(
      client.serverRequest({
        id: 'task_failure',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          itemId: 'task_failure',
          callId: 'task_failure',
          tool: 'task',
          arguments: { agent: 'explore', prompt: 'Fail in a controlled way.' },
        },
      })
    ).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'Subagent "explore" failed: child exploded' }],
      success: false,
    })
    expect(client.interruptTurnCalls).not.toContainEqual({ threadId: 'thread_2', turnId: 'turn_child_failure' })
    expect(client.deleteThreadCalls).not.toContainEqual({ threadId: 'thread_2' })
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool-state',
        toolCallId: 'task_failure',
        state: expect.objectContaining({
          status: 'error',
          sub: expect.objectContaining({ profile, usage: { input: 20, output: 4, cacheRead: 5, cacheCreate: 0 } }),
        }),
      })
    )

    client.emit(completedNotification('thread_1', 'turn_root_failure'))
    await running
  })

  it('interrupts the ephemeral thread on abort without trying to delete it or losing the card snapshot', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_child_abort', 'Delegate and interrupt', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_root_abort', notifications: [] })
    client.queueTurn({ turnId: 'turn_child_abort', notifications: [] })
    const profile = {
      version: 1 as const,
      agentName: 'explore',
      effective: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-child',
        configuredEffort: 'high',
        sentEffort: 'high',
        source: 'parent' as const,
        candidateIndex: 0,
      },
      attempts: [],
    }
    resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
      definition: { name: 'explore', description: 'Explore', prompt: 'Inspect.', source: 'built-in' },
      profile,
    })
    const events: ChatStreamEvent[] = []
    const controller = new AbortController()
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => events.push(event))
    args.mode = 'agent'
    args.signal = controller.signal
    const running = runCodexSubscriptionChat(args)

    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    const task = client.serverRequest({
      id: 'task_abort',
      method: 'item/tool/call',
      params: {
        threadId: 'thread_1',
        itemId: 'task_abort',
        callId: 'task_abort',
        tool: 'task',
        arguments: { agent: 'explore', prompt: 'Continue until interrupted.' },
      },
    })
    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(2))
    controller.abort()
    client.emit(completedNotification('thread_2', 'turn_child_abort', 'interrupted'))

    await expect(task).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'Subagent aborted' }],
      success: false,
    })
    expect(client.interruptTurnCalls).toEqual(
      expect.arrayContaining([
        { threadId: 'thread_1', turnId: 'turn_root_abort' },
        { threadId: 'thread_2', turnId: 'turn_child_abort' },
      ])
    )
    expect(client.deleteThreadCalls).not.toContainEqual({ threadId: 'thread_2' })
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool-state',
        toolCallId: 'task_abort',
        state: expect.objectContaining({
          status: 'error',
          sub: expect.objectContaining({ profile, durationMs: expect.any(Number) }),
        }),
      })
    )

    client.emit(completedNotification('thread_1', 'turn_root_abort', 'interrupted'))
    await running
  })

  it('compacts via immediate RPC, waits for turn/completed and returns the latest cumulative total', async () => {
    const client = new FakeCodexClient()
    const controller = new AbortController()
    let settled = false

    const compacting = compactCodexSubscriptionThread(
      client as unknown as CodexAppServerClient,
      'thread_compact',
      controller.signal
    ).finally(() => {
      settled = true
    })

    await vi.waitFor(() => expect(client.requestCalls).toHaveLength(1))
    expect(client.requestCalls[0]).toMatchObject({
      method: 'thread/compact/start',
      params: { threadId: 'thread_compact' },
      options: { signal: controller.signal, timeoutMs: 30_000 },
    })
    expect(settled).toBe(false)

    client.emit({
      method: 'turn/started',
      params: { threadId: 'thread_compact', turn: { id: 'turn_compact' } },
    })
    client.emit(
      usageNotification('thread_compact', 'turn_compact', {
        total: breakdown(900, 300, 200, 75),
        last: breakdown(80, 20, 10, 4),
      })
    )
    await waitImmediate()
    expect(settled).toBe(false)

    client.emit(completedNotification('thread_compact', 'turn_compact'))

    await expect(compacting).resolves.toEqual({
      inputTokens: 900,
      cachedInputTokens: 300,
      outputTokens: 200,
      reasoningOutputTokens: 75,
    })
    expect(settled).toBe(true)
  })

  it('injects the multi-agent mode hint into the thread (the catalog gates the process, not the thread)', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_catalog', 'Investigate the flow', 1)
    const client = new FakeCodexClient()
    client.queueTurn({ turnId: 'turn_catalog', notifications: [completedNotification('thread_1', 'turn_catalog')] })

    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    const config = (client.startThreadCalls[0] as { config: Record<string, unknown> }).config
    expect(config['features.multi_agent_v2.multi_agent_mode_hint_text']).toBe(NATIVE_SUBAGENT_MODE_HINT)
    expect(config['features.multi_agent']).toBe(false)
    expect(config['features.multi_agent_v2']).toBe(false)
    // Per-thread `model_catalog_json` has no effect (measured in a real turn) and only adds invalid RPC risk.
    expect(config).not.toHaveProperty('model_catalog_json')
  })

  it('also injects the multi-agent mode hint into the Codex subagent thread', async () => {
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_child_catalog',
      notifications: [
        {
          method: 'turn/started',
          params: { threadId: 'thread_1', turn: { id: 'turn_child_catalog', status: 'inProgress' } },
        },
        completedNotification('thread_1', 'turn_child_catalog'),
      ],
    })

    await runCodexSubagent({
      client: client as unknown as CodexAppServerClient,
      cwd: '/workspace',
      profile: {
        version: 1,
        agentName: 'explore',
        effective: {
          providerId: 'builtin_codex_subscription',
          modelId: 'gpt-5.6-sol',
          configuredEffort: 'high',
          sentEffort: 'high',
          source: 'conversation-agent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: { name: 'explore', description: 'Explore', prompt: 'Inspect read-only.', source: 'test' },
      signal: new AbortController().signal,
      agentName: 'explore',
      task: 'Inspect the flow.',
      readOnly: true,
      serviceTier: 'default',
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      dynamicTools: [],
      registerThread: () => true,
      removeThread: () => {},
    })

    expect(client.startThreadCalls[0]).toMatchObject({
      ephemeral: true,
      config: { 'features.multi_agent_v2.multi_agent_mode_hint_text': NATIVE_SUBAGENT_MODE_HINT },
    })
    expect((client.startThreadCalls[0] as { config: Record<string, unknown> }).config).not.toHaveProperty(
      'model_catalog_json'
    )
  })

  // --- native imagegen -----------------------------------------------------------------------------------
  // The `imageGeneration` item carries a base64 image in `result`. Bytes must become an app-owned file and
  // the part must store ONLY the handle: base64 in parts_json would inflate the DB and overflow transcript reseeding.
  it('ephemeralSession: ephemeral thread, no main binding write, persisted message and cleanup', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    putCodexThreadBinding({
      conversationId: conversation.id,
      threadId: 'thread_main',
      modelId: 'gpt-5.6-sol',
      toolSignature: 'main-sig',
      lastMessageId: 'main-assistant',
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
    })
    const mainBefore = structuredClone(getCodexThreadBinding(conversation.id))
    const executionId = 'exec-codex-1'
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
      id: 'iso_user_codex',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'iso_user_codex_text', text: 'review in isolation' }],
      createdAt: 1,
      ...messageMeta,
    })
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_iso',
      notifications: [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_iso',
            item: { id: 'answer_iso', type: 'agentMessage', text: 'isolated ok' },
          },
        },
        usageNotification('thread_1', 'turn_iso', {
          total: breakdown(50, 10, 5),
          last: breakdown(50, 10, 5),
        }),
        completedNotification('thread_1', 'turn_iso'),
      ],
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.ephemeralSession = true
    args.messageMeta = messageMeta
    await runCodexSubscriptionChat(args)

    expect(client.startThreadCalls).toHaveLength(1)
    expect(client.startThreadCalls[0]).toMatchObject({ ephemeral: true })
    expect(client.resumeThreadCalls).toEqual([])
    expect(getCodexThreadBinding(conversation.id)).toEqual(mainBefore)
    expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_1' })
    expect(listCodexThreadCleanup()).toEqual([])
    const assistants = listChatMessages(conversation.id).filter(
      (m) => m.role === 'assistant' && m.executionScope?.kind === 'review-loop'
    )
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'isolated ok' })])
    )
    expect(assistants[0]?.usage).toMatchObject({ output: 5, cachedInput: 10 })
  })

  describe('generated image (imagegen)', () => {
    const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const artifactsRoot = path.join(os.tmpdir(), 'agents-test-electron', 'chat-generated-images')

    afterEach(() => rmSync(artifactsRoot, { recursive: true, force: true }))

    const imageItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: 'item_img',
      type: 'imageGeneration',
      status: 'completed',
      revisedPrompt: 'A pragmatic teal robot on a white background',
      result: PNG_1X1,
      ...overrides,
    })

    const imageTurn = (client: FakeCodexClient, item: Record<string, unknown>): void => {
      client.queueTurn({
        turnId: 'turn_img',
        notifications: [
          { method: 'item/started', params: { threadId: 'thread_1', turnId: 'turn_img', item } },
          { method: 'item/completed', params: { threadId: 'thread_1', turnId: 'turn_img', item } },
          // SAME item burst: without the pending-write barrier, the turn would persist before the part.
          completedNotification('thread_1', 'turn_img'),
        ],
      })
    }

    it('writes the artifact, emits the part with an opaque handle and keeps base64 out of parts_json', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_img', 'Generate a robot', 1)
      const client = new FakeCodexClient()
      imageTurn(client, imageItem())
      const emitted: ChatStreamEvent[] = []
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => emitted.push(event))
      args.mode = 'agent'

      await runCodexSubscriptionChat(args)

      // The part already exists when the turn returns (writes are awaited before settling).
      const parts = assistantMessages(conversation.id)[0].parts
      const image = parts.find((part) => part.type === 'generated-image')
      expect(image).toMatchObject({
        type: 'generated-image',
        id: 'item_img',
        name: 'A-pragmatic-teal-robot-on-a-white-background.png',
        mediaType: 'image/png',
        revisedPrompt: 'A pragmatic teal robot on a white background',
      })
      if (image?.type !== 'generated-image') throw new Error('missing generated image part')
      expect(image.artifactId).toMatch(/^[a-f0-9]{32}$/)
      expect(image.byteSize).toBeGreaterThan(0)

      // Invariant from the 1 MB incident: no base64 reaches SQLite (part, tool input OR output).
      const serialized = JSON.stringify(parts)
      expect(serialized).not.toContain(PNG_1X1)
      expect(serialized).not.toContain(PNG_1X1.slice(0, 32))

      // The tool card completes with the revised prompt as text (without bytes).
      const card = parts.find((part) => part.type === 'tool' && part.toolName === 'image_generation')
      expect(card).toMatchObject({ state: { status: 'completed' } })
      if (card?.type !== 'tool' || card.state.status !== 'completed') throw new Error('missing tool card')
      expect(card.state.output).toContain('Image generated.')
      expect(card.state.output).toContain('A pragmatic teal robot on a white background')

      // The file exists on disk under the conversation and can be read through the read channel.
      expect(existsSync(path.join(artifactsRoot, conversation.id, `${image.artifactId}.png`))).toBe(true)
      const { readGeneratedImage } = await import('../../src/main/chat/generated-images')
      await expect(readGeneratedImage(conversation.id, image.artifactId)).resolves.toMatchObject({
        ok: true,
        mediaType: 'image/png',
      })

      // The stream event reaches the renderer with the handle, never the path.
      const event = emitted.find((e) => e.kind === 'generated-image')
      expect(event).toMatchObject({ kind: 'generated-image', partId: 'item_img', artifactId: image.artifactId })
      expect(JSON.stringify(event)).not.toContain(artifactsRoot)
    })

    it('produces an error card without an image part when base64 is invalid', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_img_bad', 'Generate a robot', 1)
      const client = new FakeCodexClient()
      imageTurn(client, imageItem({ result: 'not base64 !!!' }))
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
      args.mode = 'agent'

      await runCodexSubscriptionChat(args)

      const parts = assistantMessages(conversation.id)[0].parts
      expect(parts.some((part) => part.type === 'generated-image')).toBe(false)
      const card = parts.find((part) => part.type === 'tool' && part.toolName === 'image_generation')
      expect(card).toMatchObject({ state: { status: 'error' } })
      if (card?.type !== 'tool' || card.state.status !== 'error') throw new Error('missing tool card')
      expect(card.state.error).toMatch(/Failed to store the generated image/)
      expect(existsSync(path.join(artifactsRoot, conversation.id))).toBe(false)
    })

    it('produces an error card when the result is empty', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_img_empty', 'Generate a robot', 1)
      const client = new FakeCodexClient()
      imageTurn(client, imageItem({ result: '' }))
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
      args.mode = 'agent'

      await runCodexSubscriptionChat(args)

      const parts = assistantMessages(conversation.id)[0].parts
      expect(parts.some((part) => part.type === 'generated-image')).toBe(false)
      const card = parts.find((part) => part.type === 'tool' && part.toolName === 'image_generation')
      if (card?.type !== 'tool' || card.state.status !== 'error') throw new Error('missing tool card')
      expect(card.state.error).toMatch(/empty/i)
    })

    it('propagates runtime failure without attempting any writes', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_img_failed', 'Generate a robot', 1)
      const client = new FakeCodexClient()
      imageTurn(client, imageItem({ status: 'failed', result: PNG_1X1 }))
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
      args.mode = 'agent'

      await runCodexSubscriptionChat(args)

      const parts = assistantMessages(conversation.id)[0].parts
      expect(parts.some((part) => part.type === 'generated-image')).toBe(false)
      const card = parts.find((part) => part.type === 'tool' && part.toolName === 'image_generation')
      expect(card).toMatchObject({ state: { status: 'error', error: 'Image generation failed.' } })
      expect(existsSync(path.join(artifactsRoot, conversation.id))).toBe(false)
    })

    it('uses the host-managed tool in Agent and blocks native imagegen and the tool in Ask and Plan', async () => {
      const workspace = makeWorkspace()
      const agentConversation = makeConversation(workspace.id, {})
      persistUser(agentConversation.id, 'user_img_cfg_agent', 'Generate a robot', 1)
      const agentClient = new FakeCodexClient()
      agentClient.queueTurn({
        turnId: 'turn_cfg_agent',
        notifications: [completedNotification('thread_1', 'turn_cfg_agent')],
      })
      const agentArgs = runArgs(agentConversation.id, workspace.id, agentConversation.cwd, agentClient)
      agentArgs.mode = 'agent'
      agentArgs.permMode = 'full'
      await runCodexSubscriptionChat(agentArgs)
      expect(agentClient.startThreadCalls[0]).toMatchObject({
        config: { 'features.image_generation': false },
        dynamicTools: expect.arrayContaining([expect.objectContaining({ name: 'generate_image' })]),
      })

      const askConversation = makeConversation(workspace.id, {})
      persistUser(askConversation.id, 'user_img_cfg_ask', 'Generate a robot', 1)
      const askClient = new FakeCodexClient()
      askClient.queueTurn({
        turnId: 'turn_cfg_ask',
        notifications: [completedNotification('thread_1', 'turn_cfg_ask')],
      })
      await runCodexSubscriptionChat(runArgs(askConversation.id, workspace.id, askConversation.cwd, askClient))
      expect(askClient.startThreadCalls[0]).toMatchObject({
        config: { 'features.image_generation': false },
        dynamicTools: expect.not.arrayContaining([expect.objectContaining({ name: 'generate_image' })]),
      })

      // Plan is read-only, but the RUNTIME default for image_generation is `true` (0.153.4). Without the explicit
      // flag, the mode would gain artifact writing by omission.
      const planConversation = makeConversation(workspace.id, {})
      persistUser(planConversation.id, 'user_img_cfg_plan', 'Plan a robot', 1)
      const planClient = new FakeCodexClient()
      planClient.queueTurn({
        turnId: 'turn_cfg_plan',
        notifications: [completedNotification('thread_1', 'turn_cfg_plan')],
      })
      const planArgs = runArgs(planConversation.id, workspace.id, planConversation.cwd, planClient)
      planArgs.mode = 'plan'
      await runCodexSubscriptionChat(planArgs)
      expect(planClient.startThreadCalls[0]).toMatchObject({
        config: { 'features.image_generation': false },
        dynamicTools: expect.not.arrayContaining([expect.objectContaining({ name: 'generate_image' })]),
      })
    })

    it('runs generate_image through the default Codex account, creates the asset and persists the preview', async () => {
      const workspace = makeWorkspace()
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'maestrly-codex-image-'))
      const conversation = makeConversation(workspace.id, { cwd })
      persistUser(conversation.id, 'user_host_image', 'Create and use a hero image', 1)
      const client = new FakeCodexClient()
      // The main turn stays open while the dynamic tool starts a second, ephemeral thread on the same client.
      client.queueTurn({ turnId: 'turn_root_host_image', notifications: [] })
      client.queueTurn({
        turnId: 'turn_ephemeral_image',
        notifications: [
          usageNotification('thread_2', 'turn_ephemeral_image', {
            total: breakdown(120, 20, 7),
            last: breakdown(120, 20, 7),
          }),
          {
            method: 'item/completed',
            params: {
              threadId: 'thread_2',
              turnId: 'turn_ephemeral_image',
              item: imageItem(),
            },
          },
          completedNotification('thread_2', 'turn_ephemeral_image'),
        ],
      })
      const emitted: ChatStreamEvent[] = []
      const args = runArgs(conversation.id, workspace.id, cwd, client, (event) => emitted.push(event))
      args.mode = 'agent'
      args.permMode = 'full'

      try {
        const running = runCodexSubscriptionChat(args)
        await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))

        const response = client.serverRequest({
          id: 'generate_image_request',
          method: 'item/tool/call',
          params: {
            threadId: 'thread_1',
            turnId: 'turn_root_host_image',
            itemId: 'generate_image_call',
            callId: 'generate_image_call',
            tool: 'generate_image',
            arguments: {
              prompt: 'A polished teal robot for a landing page hero',
              outputPath: 'public/images/hero.webp',
            },
          },
        })

        await expect(response).resolves.toMatchObject({
          success: true,
          contentItems: [
            {
              type: 'inputText',
              text: expect.stringContaining('public/images/hero.png'),
            },
          ],
        })
        client.emit(completedNotification('thread_1', 'turn_root_host_image'))
        await running

        expect(client.startThreadCalls).toHaveLength(2)
        expect(client.startThreadCalls[0]).toMatchObject({ model: 'gpt-5.6-sol' })
        expect(client.startThreadCalls[0]).toMatchObject({
          config: { 'features.image_generation': false },
          dynamicTools: expect.arrayContaining([expect.objectContaining({ name: 'generate_image' })]),
        })
        expect(client.startThreadCalls[1]).toMatchObject({
          ephemeral: true,
          model: 'gpt-5.6-mini',
          dynamicTools: [],
          config: { 'features.image_generation': true },
        })
        const imageConfig = (client.startThreadCalls[1] as { config: Record<string, unknown> }).config
        expect(imageConfig).not.toHaveProperty('model_auto_compact_token_limit')
        expect(imageConfig).not.toHaveProperty('model_auto_compact_token_limit_scope')
        expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_2' })
        expect(args.broker.assert).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'edit',
            resources: expect.arrayContaining([
              path.join(cwd, 'public/images/hero.webp'),
              path.join(cwd, 'public/images/hero.png'),
            ]),
          })
        )
        expect(readFileSync(path.join(cwd, 'public/images/hero.png'))).toEqual(Buffer.from(PNG_1X1, 'base64'))

        const parts = assistantMessages(conversation.id)[0].parts
        const preview = parts.find((part) => part.type === 'generated-image')
        expect(preview).toMatchObject({ type: 'generated-image', id: 'generate_image_call_image' })
        expect(JSON.stringify(parts)).not.toContain(PNG_1X1.slice(0, 32))
        expect(emitted).toContainEqual(expect.objectContaining({ kind: 'generated-image' }))
        expect(emitted.find((event) => event.kind === 'finish')).toMatchObject({
          usage: {
            subInput: 100,
            subOutput: 7,
            subCachedInput: 20,
            subagentUsage: [
              {
                providerId: 'builtin_codex_subscription',
                modelId: 'gpt-5.6-mini',
                input: 100,
                output: 7,
                cachedInput: 20,
                catalogInput: 100,
                catalogOutput: 7,
                catalogCacheRead: 20,
              },
            ],
          },
        })
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('consistently uses the default Codex account when the conversation uses a secondary account', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_secondary_account_image', 'Generate an image', 1)
      const secondaryClient = new FakeCodexClient()
      const defaultClient = new FakeCodexClient()
      secondaryClient.queueTurn({ turnId: 'turn_secondary_root_image', notifications: [] })
      defaultClient.queueTurn({
        turnId: 'turn_default_image',
        notifications: [
          usageNotification('thread_1', 'turn_default_image', {
            total: breakdown(120, 20, 7),
            last: breakdown(120, 20, 7),
          }),
          {
            method: 'item/completed',
            params: { threadId: 'thread_1', turnId: 'turn_default_image', item: imageItem() },
          },
          completedNotification('thread_1', 'turn_default_image'),
        ],
      })
      const emitted: ChatStreamEvent[] = []
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, secondaryClient, (event) =>
        emitted.push(event)
      )
      codexManagerBridge.setClient(secondaryClient, 'secondary')
      codexManagerBridge.setClient(defaultClient, null)
      args.selection = {
        providerId: 'builtin_codex_subscription@secondary',
        modelId: 'secondary-chat-model',
      }
      args.mode = 'agent'
      args.permMode = 'full'

      const running = runCodexSubscriptionChat(args)
      await vi.waitFor(() => expect(secondaryClient.startTurnCalls).toHaveLength(1))
      const response = secondaryClient.serverRequest({
        id: 'secondary_account_image_request',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_secondary_root_image',
          itemId: 'secondary_account_image_call',
          callId: 'secondary_account_image_call',
          tool: 'generate_image',
          arguments: { prompt: 'A default-account image' },
        },
      })

      await expect(response).resolves.toMatchObject({ success: true })
      secondaryClient.emit(completedNotification('thread_1', 'turn_secondary_root_image'))
      await running

      expect(secondaryClient.startThreadCalls).toHaveLength(1)
      expect(secondaryClient.startThreadCalls[0]).toMatchObject({ model: 'secondary-chat-model' })
      expect(defaultClient.startThreadCalls).toHaveLength(1)
      expect(defaultClient.startThreadCalls[0]).toMatchObject({
        model: 'gpt-5.6-mini',
        ephemeral: true,
        config: { 'features.image_generation': true },
      })
      expect(codexManagerBridge.getCodexSubscriptionManager).toHaveBeenCalledWith(null)
      expect(chatDiagMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'model-call-usage',
          provider: 'builtin_codex_subscription',
          model: 'gpt-5.6-mini',
        })
      )
      expect(emitted.find((event) => event.kind === 'finish')).toMatchObject({
        usage: {
          subagentUsage: [
            expect.objectContaining({
              providerId: 'builtin_codex_subscription',
              modelId: 'gpt-5.6-mini',
              input: 100,
              output: 7,
              cachedInput: 20,
            }),
          ],
        },
      })
    })

    it('preserves auxiliary tokens when generate_image fails after consumption and before asset creation', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_host_image_failure', 'Generate an image', 1)
      const client = new FakeCodexClient()
      client.queueTurn({ turnId: 'turn_root_host_image_failure', notifications: [] })
      client.queueTurn({
        turnId: 'turn_ephemeral_image_failure',
        notifications: [
          usageNotification('thread_2', 'turn_ephemeral_image_failure', {
            total: breakdown(40, 0, 3),
            last: breakdown(40, 0, 3),
          }),
          completedNotification('thread_2', 'turn_ephemeral_image_failure', 'failed'),
        ],
      })
      const emitted: ChatStreamEvent[] = []
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => emitted.push(event))
      args.mode = 'agent'
      args.permMode = 'full'

      const running = runCodexSubscriptionChat(args)
      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
      const response = client.serverRequest({
        id: 'generate_image_failure_request',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_root_host_image_failure',
          itemId: 'generate_image_failure_call',
          callId: 'generate_image_failure_call',
          tool: 'generate_image',
          arguments: { prompt: 'A failed teal robot image' },
        },
      })

      await expect(response).resolves.toMatchObject({ success: false })
      client.emit(completedNotification('thread_1', 'turn_root_host_image_failure'))
      await running

      expect(emitted.find((event) => event.kind === 'finish')).toMatchObject({
        usage: {
          subInput: 40,
          subOutput: 3,
          subagentUsage: [
            {
              providerId: 'builtin_codex_subscription',
              modelId: 'gpt-5.6-mini',
              input: 40,
              output: 3,
              catalogInput: 40,
              catalogOutput: 3,
            },
          ],
        },
      })
      expect(assistantMessages(conversation.id)[0].parts.some((part) => part.type === 'generated-image')).toBe(false)
    })

    it('runs generate_image in a Codex worker, namespaces the call and publishes the preview in the parent', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_worker_image', 'Delegate image creation', 1)
      const client = new FakeCodexClient()
      client.queueTurn({ turnId: 'turn_root_worker_image', notifications: [] })
      client.queueTurn({
        turnId: 'turn_child_worker_image',
        notifications: [
          {
            method: 'turn/started',
            params: { threadId: 'thread_2', turn: { id: 'turn_child_worker_image', status: 'inProgress' } },
          },
        ],
      })
      client.queueTurn({
        turnId: 'turn_ephemeral_worker_image',
        notifications: [
          {
            method: 'item/completed',
            params: {
              threadId: 'thread_3',
              turnId: 'turn_ephemeral_worker_image',
              item: imageItem({ id: 'worker_image_item' }),
            },
          },
          completedNotification('thread_3', 'turn_ephemeral_worker_image'),
        ],
      })
      const profile = {
        version: 1 as const,
        agentName: 'general-purpose',
        category: 'implementation',
        effective: {
          providerId: 'builtin_codex_subscription',
          modelId: 'gpt-5.6-mini',
          configuredEffort: 'high',
          sentEffort: 'high',
          source: 'conversation-agent' as const,
          ruleKey: 'general-purpose',
          candidateIndex: 0,
        },
        attempts: [],
      }
      resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
        definition: {
          name: 'general-purpose',
          category: 'implementation',
          description: 'Worker',
          prompt: 'Implement the requested image task.',
          source: 'built-in',
          tools: ['bash', 'generate_image'],
        },
        profile,
      })
      const emitted: ChatStreamEvent[] = []
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => emitted.push(event))
      args.mode = 'agent'
      args.permMode = 'full'

      const running = runCodexSubscriptionChat(args)
      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
      const task = client.serverRequest({
        id: 'worker_task_request',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_root_worker_image',
          itemId: 'worker_task_call',
          callId: 'worker_task_call',
          tool: 'task',
          arguments: { agent: 'general-purpose', prompt: 'Generate the requested hero image.' },
        },
      })

      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(2))
      const childImage = client.serverRequest({
        id: 'worker_image_request',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_2',
          turnId: 'turn_child_worker_image',
          itemId: 'child_generate_image_call',
          callId: 'child_generate_image_call',
          tool: 'generate_image',
          arguments: { prompt: 'A polished teal robot hero image' },
        },
      })

      await expect(childImage).resolves.toMatchObject({ success: true })
      client.emit(completedNotification('thread_2', 'turn_child_worker_image'))
      await expect(task).resolves.toMatchObject({ success: true })
      client.emit(completedNotification('thread_1', 'turn_root_worker_image'))
      await running

      const childStart = client.startThreadCalls[1] as {
        dynamicTools: Array<{ name: string }>
        config: Record<string, unknown>
      }
      expect(childStart.dynamicTools).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'generate_image' })])
      )
      expect(childStart.config['features.image_generation']).toBe(false)
      expect(client.startThreadCalls[2]).toMatchObject({
        ephemeral: true,
        dynamicTools: [],
        config: { 'features.image_generation': true },
      })
      expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_3' })
      const parts = assistantMessages(conversation.id)[0].parts
      expect(parts).toContainEqual(
        expect.objectContaining({
          type: 'generated-image',
          id: 'subagent:worker_task_call:child_generate_image_call_image',
        })
      )
      expect(JSON.stringify(parts)).not.toContain(PNG_1X1.slice(0, 32))
      expect(emitted).toContainEqual(
        expect.objectContaining({
          kind: 'generated-image',
          partId: 'subagent:worker_task_call:child_generate_image_call_image',
        })
      )
    })

    it('the global/conversation image generation toggle removes the host-managed tool from Agent', async () => {
      const { patchConvUiPrefs, setAppFlag } = await import('../../src/main/store')
      const workspace = makeWorkspace()

      // (a) Disabled GLOBALLY.
      setAppFlag('chat.imageGen', false)
      const globalOff = makeConversation(workspace.id, {})
      persistUser(globalOff.id, 'user_img_off_global', 'Generate a robot', 1)
      const globalClient = new FakeCodexClient()
      globalClient.queueTurn({
        turnId: 'turn_img_off_global',
        notifications: [completedNotification('thread_1', 'turn_img_off_global')],
      })
      const globalArgs = runArgs(globalOff.id, workspace.id, globalOff.cwd, globalClient)
      globalArgs.mode = 'agent'
      await runCodexSubscriptionChat(globalArgs)
      expect(globalClient.startThreadCalls[0]).toMatchObject({
        config: { 'features.image_generation': false },
        dynamicTools: expect.not.arrayContaining([expect.objectContaining({ name: 'generate_image' })]),
      })

      // (b) Enabled globally again, but DISABLED for this conversation (the override wins).
      setAppFlag('chat.imageGen', true)
      const convOff = makeConversation(workspace.id, {})
      persistUser(convOff.id, 'user_img_off_conv', 'Generate a robot', 1)
      patchConvUiPrefs(convOff.id, { chat: { tools: { imageGen: false } } })
      const convClient = new FakeCodexClient()
      convClient.queueTurn({
        turnId: 'turn_img_off_conv',
        notifications: [completedNotification('thread_1', 'turn_img_off_conv')],
      })
      const convArgs = runArgs(convOff.id, workspace.id, convOff.cwd, convClient)
      convArgs.mode = 'agent'
      await runCodexSubscriptionChat(convArgs)
      expect(convClient.startThreadCalls[0]).toMatchObject({
        config: { 'features.image_generation': false },
        dynamicTools: expect.not.arrayContaining([expect.objectContaining({ name: 'generate_image' })]),
      })
    })

    it('replaying item/completed for the same image does not write a second file', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_img_replay', 'Generate a robot', 1)
      const client = new FakeCodexClient()
      const item = imageItem()
      client.queueTurn({
        turnId: 'turn_img_replay',
        notifications: [
          { method: 'item/started', params: { threadId: 'thread_1', turnId: 'turn_img_replay', item } },
          { method: 'item/completed', params: { threadId: 'thread_1', turnId: 'turn_img_replay', item } },
          // Identical REPLAY: without deduplication, a second write would orphan the first file.
          { method: 'item/completed', params: { threadId: 'thread_1', turnId: 'turn_img_replay', item } },
          completedNotification('thread_1', 'turn_img_replay'),
        ],
      })
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
      args.mode = 'agent'

      await runCodexSubscriptionChat(args)

      const parts = assistantMessages(conversation.id)[0].parts
      const images = parts.filter((part) => part.type === 'generated-image')
      expect(images).toHaveLength(1)
      if (images[0].type !== 'generated-image') throw new Error('missing generated image part')
      // Exactly ONE file in the conversation directory, referenced by the part.
      const files = readdirSync(path.join(artifactsRoot, conversation.id))
      expect(files).toEqual([`${images[0].artifactId}.png`])
    })

    it('waits for the in-flight write even when app-server dies before turn/completed', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_img_exit', 'Generate a robot', 1)

      // This client process dies just after item/completed: the turn NEVER receives turn/completed and the
      // runner takes the error path. The finally block must await the write; otherwise the part would not be
      // persisted and the write would outlive the runner (potentially recreating the directory after deletion/wiping).
      let triggerExit!: () => void
      const exit = new Promise<never>((_resolve, reject) => {
        triggerExit = () => reject(new Error('Codex app-server exited before the turn completed'))
      })
      void exit.catch(() => {})
      class ExitingFakeCodexClient extends FakeCodexClient {
        waitForExit(): Promise<never> {
          return exit
        }
      }
      const client = new ExitingFakeCodexClient()
      client.queueTurn({
        turnId: 'turn_img_exit',
        notifications: [
          { method: 'item/started', params: { threadId: 'thread_1', turnId: 'turn_img_exit', item: imageItem() } },
          { method: 'item/completed', params: { threadId: 'thread_1', turnId: 'turn_img_exit', item: imageItem() } },
        ],
      })
      client.onNotification((notification) => {
        // One tick after the item: the write (mkdir/write/rename) is still in flight when exit fires.
        if (notification.method === 'item/completed') setImmediate(triggerExit)
      })
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
      args.mode = 'agent'

      await runCodexSubscriptionChat(args)

      // The runner converts transport failure to a message error event (without rejecting)...
      const message = assistantMessages(conversation.id)[0]
      expect(message.error).toMatch(/exited/)
      // ...but finally awaited the in-flight write: the part exists in SQLite and the file is intact.
      const image = message.parts.find((part) => part.type === 'generated-image')
      if (image?.type !== 'generated-image') throw new Error('missing generated image part')
      const files = readdirSync(path.join(artifactsRoot, conversation.id))
      expect(files).toEqual([`${image.artifactId}.png`])
    })
  })

  describe('root account failover', () => {
    const PRIMARY = 'builtin_codex_subscription'
    const FALLBACK = 'builtin_codex_subscription@acc_b'
    const SECOND_FALLBACK = 'builtin_codex_subscription@acc_c'

    function halfOpenLease(): { leaseId: string; generation: number } {
      const router = getSubscriptionFailoverRouter()
      const now = Date.now()
      router.markExhausted(PRIMARY, {
        reason: 'quota',
        source: 'structured-error',
        resetsAt: now - 1,
        now: now - 2,
      })
      const admitted = router.tryAdmit(PRIMARY, now)
      if (!admitted.ok || !admitted.lease) throw new Error('expected half-open lease')
      return admitted.lease
    }

    function expectFutureProbe(): void {
      const router = getSubscriptionFailoverRouter()
      const health = router.getHealth(PRIMARY)
      expect(health.state).toBe('exhausted')
      expect(router.tryAdmit(PRIMARY, health.exhaustion!.nextProbeAt).ok).toBe(true)
    }

    function failoverTarget(
      client: FakeCodexClient,
      providerId: string,
      accountId: string | null,
      contextWindow?: number,
      requestedContextWindow?: number | null,
      manager?: {
        observeModelContextWindow(modelId: string, value: number, requestedNominal?: number | null): void
      },
      effectiveContextWindow?: number
    ) {
      return {
        providerId,
        accountId,
        client: client as unknown as CodexAppServerClient,
        model: {
          id: 'gpt-5.6-sol',
          model: 'gpt-5.6',
          ...(contextWindow !== undefined ? { contextWindow } : {}),
        },
        runtimeModelId: 'gpt-5.6-sol',
        serviceTier: 'priority' as string | null,
        dropImages: false,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(requestedContextWindow != null ? { requestedContextWindow } : {}),
        ...(manager ? { manager } : {}),
        ...(effectiveContextWindow !== undefined ? { effectiveContextWindow } : {}),
      }
    }

    it('quota before output switches to B with one bubble and binding accountId B', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_pre', 'Hello', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')

      clientA.queueStartTurnError(new Error('UsageLimitExceeded: weekly quota exhausted'))
      clientB.queueTurn({
        turnId: 'turn_b1',
        notifications: [
          {
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread_1', turnId: 'turn_b1', itemId: 'answer_b', delta: 'From account B.' },
          },
          usageNotification('thread_1', 'turn_b1', {
            total: breakdown(40, 5, 8),
            last: breakdown(40, 5, 8),
          }),
          completedNotification('thread_1', 'turn_b1'),
        ],
      })

      const emitted: ChatStreamEvent[] = []
      const resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b'))
      const onFailoverTransition = vi.fn()
      const onEffectiveTargetChanged = vi.fn()
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA, (e) => emitted.push(e))
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = resolveNextTarget
      args.onFailoverTransition = onFailoverTransition
      args.onEffectiveTargetChanged = onEffectiveTargetChanged

      await expect(runCodexSubscriptionChat(args)).resolves.toMatchObject({
        planSubmitted: false,
        threadId: 'thread_1',
      })

      expect(resolveNextTarget).toHaveBeenCalledOnce()
      expect(onFailoverTransition).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'root', fromProviderId: PRIMARY, toProviderId: FALLBACK })
      )
      expect(onEffectiveTargetChanged).toHaveBeenCalledWith({ providerId: FALLBACK, accountId: 'acc_b' })
      expect(emitted.filter((e) => e.kind === 'message-start')).toHaveLength(1)
      expect(emitted.filter((e) => e.kind === 'finish')).toHaveLength(1)
      expect(emitted.filter((e) => e.kind === 'error')).toEqual([])
      expect(clientA.startThreadCalls).toHaveLength(1)
      expect(clientB.startThreadCalls).toHaveLength(1)
      expect(getCodexThreadBinding(conversation.id)?.accountId).toBe('acc_b')
      expect(assistantMessages(conversation.id)).toHaveLength(1)
    })

    it('updates and removes the nominal window before each failover thread/start and associates observations', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_requested_window', 'Continue with the next account', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      const clientC = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      codexManagerBridge.setClient(clientC, 'acc_c')

      clientA.startThreadError = new Error('UsageLimitExceeded: weekly quota exhausted')
      clientB.queueTurn({
        turnId: 'turn_b_requested_window',
        notifications: [
          usageNotification(
            'thread_1',
            'turn_b_requested_window',
            { total: breakdown(40, 5, 8), last: breakdown(40, 5, 8) },
            280_000
          ),
          completedNotification('thread_1', 'turn_b_requested_window', 'failed', 'UsageLimitExceeded: weekly'),
        ],
      })
      clientC.queueTurn({
        turnId: 'turn_c_requested_window',
        notifications: [
          usageNotification(
            'thread_1',
            'turn_c_requested_window',
            { total: breakdown(20, 0, 4), last: breakdown(20, 0, 4) },
            185_000
          ),
          completedNotification('thread_1', 'turn_c_requested_window'),
        ],
      })

      const observeB = vi.fn()
      const observeC = vi.fn()
      const onModelContextWindow = vi.fn()
      const onEffectiveTargetChanged = vi.fn()
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA)
      args.requestedContextWindow = 1_000_000
      args.failoverChain = [PRIMARY, FALLBACK, SECOND_FALLBACK]
      args.resolveNextTarget = vi.fn(async (_failure, attempted) =>
        attempted.has(FALLBACK)
          ? failoverTarget(
              clientC,
              SECOND_FALLBACK,
              'acc_c',
              100_000,
              null,
              { observeModelContextWindow: observeC },
              190_000
            )
          : failoverTarget(
              clientB,
              FALLBACK,
              'acc_b',
              200_000,
              300_000,
              { observeModelContextWindow: observeB },
              285_000
            )
      )
      args.onModelContextWindow = onModelContextWindow
      args.onEffectiveTargetChanged = onEffectiveTargetChanged

      await runCodexSubscriptionChat(args)

      const configA = (clientA.startThreadCalls[0] as { config: Record<string, unknown> }).config
      const configB = (clientB.startThreadCalls[0] as { config: Record<string, unknown> }).config
      const configC = (clientC.startThreadCalls[0] as { config: Record<string, unknown> }).config
      expect(configA.model_context_window).toBe(1_000_000)
      expect(configB.model_context_window).toBe(300_000)
      expect(configC).not.toHaveProperty('model_context_window')
      for (const config of [configA, configB, configC]) {
        expect({
          model_auto_compact_token_limit: config.model_auto_compact_token_limit,
          model_auto_compact_token_limit_scope: config.model_auto_compact_token_limit_scope,
        }).toEqual(ROOT_THREAD_NATIVE_AUTO_COMPACTION_CONFIG)
      }
      expect(onEffectiveTargetChanged).toHaveBeenNthCalledWith(1, {
        providerId: FALLBACK,
        accountId: 'acc_b',
        contextWindow: 285_000,
        requestedContextWindow: 300_000,
      })
      expect(onEffectiveTargetChanged).toHaveBeenNthCalledWith(2, {
        providerId: SECOND_FALLBACK,
        accountId: 'acc_c',
        contextWindow: 190_000,
      })
      expect(onModelContextWindow).toHaveBeenNthCalledWith(1, 280_000, 300_000)
      expect(onModelContextWindow).toHaveBeenNthCalledWith(2, 185_000, null)
      expect(observeB).toHaveBeenCalledWith('gpt-5.6-sol', 280_000, 300_000)
      expect(observeC).toHaveBeenCalledWith('gpt-5.6-sol', 185_000, null)
    })

    it('waits for image saving before resolving and continuing root failover', async () => {
      const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      const artifactsRoot = path.join(os.tmpdir(), 'agents-test-electron', 'chat-generated-images')
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_image', 'Create and continue with an image', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')

      const defaultSaveGeneratedImage = saveGeneratedImageMock.getMockImplementation()
      if (!defaultSaveGeneratedImage) throw new Error('missing generated image save implementation')
      let notifySaveStarted!: () => void
      const saveStarted = new Promise<void>((resolve) => {
        notifySaveStarted = resolve
      })
      let releaseSave!: () => void
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve
      })
      saveGeneratedImageMock.mockImplementation(async (args) => {
        notifySaveStarted()
        await saveGate
        return defaultSaveGeneratedImage(args)
      })

      const image = {
        id: 'root_image_failover',
        type: 'imageGeneration',
        status: 'completed',
        revisedPrompt: 'A pragmatic teal robot on a white background',
        result: PNG_1X1,
      }
      clientA.queueStartTurnError(new Error('UsageLimitExceeded: weekly quota exhausted'))
      clientA.startTurnHook = () => {
        clientA.emit({
          method: 'item/started',
          params: { threadId: 'thread_1', turnId: 'turn_a_image_failover', item: image },
        })
        clientA.emit({
          method: 'item/completed',
          params: { threadId: 'thread_1', turnId: 'turn_a_image_failover', item: image },
        })
      }
      clientB.queueTurn({
        turnId: 'turn_b_image_failover',
        notifications: [
          {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread_1',
              turnId: 'turn_b_image_failover',
              itemId: 'answer_b_image_failover',
              delta: 'Continued once on B.',
            },
          },
          completedNotification('thread_1', 'turn_b_image_failover'),
        ],
      })

      const resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b'))
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA)
      args.mode = 'agent'
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = resolveNextTarget
      let running: ReturnType<typeof runCodexSubscriptionChat> | undefined
      try {
        running = runCodexSubscriptionChat(args)
        await saveStarted
        await waitImmediate()

        expect(resolveNextTarget).not.toHaveBeenCalled()
        expect(clientB.startThreadCalls).toHaveLength(0)

        releaseSave()
        await expect(running).resolves.toMatchObject({ planSubmitted: false, threadId: 'thread_1' })

        expect(resolveNextTarget).toHaveBeenCalledOnce()
        expect(clientB.startTurnCalls).toHaveLength(1)
        expect(JSON.stringify(clientB.startTurnCalls[0])).toContain(
          'revised prompt: A pragmatic teal robot on a white background'
        )

        const message = assistantMessages(conversation.id)[0]
        const images = message.parts.filter((part) => part.type === 'generated-image')
        expect(images).toHaveLength(1)
        if (images[0].type !== 'generated-image') throw new Error('missing generated image part')
        expect(saveGeneratedImageMock).toHaveBeenCalledOnce()
        expect(readdirSync(path.join(artifactsRoot, conversation.id))).toEqual([`${images[0].artifactId}.png`])
      } finally {
        releaseSave()
        if (running) await running.catch(() => {})
        saveGeneratedImageMock.mockImplementation(defaultSaveGeneratedImage)
        rmSync(path.join(artifactsRoot, conversation.id), { recursive: true, force: true })
      }
    })

    it('keeps an in-flight Codex task during root failover without repeating the side effect', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_child_in_flight', 'Delegate and continue', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      clientA.queueTurn({ turnId: 'turn_root_child_in_flight', notifications: [] })
      clientA.queueTurn({
        turnId: 'turn_child_in_flight',
        notifications: [
          {
            method: 'turn/started',
            params: { threadId: 'thread_2', turn: { id: 'turn_child_in_flight', status: 'inProgress' } },
          },
        ],
      })
      clientB.queueTurn({
        turnId: 'turn_b_after_child_in_flight',
        notifications: [completedNotification('thread_1', 'turn_b_after_child_in_flight')],
      })
      clientA.interruptTurnHook = async (params) => {
        const request = params as { threadId?: string; turnId?: string }
        if (request.threadId === 'thread_2' && request.turnId === 'turn_child_in_flight') {
          clientA.emit(completedNotification('thread_2', 'turn_child_in_flight', 'interrupted'))
        }
      }
      resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
        definition: {
          name: 'explore',
          description: 'Explore',
          prompt: 'Inspect the task.',
          source: 'built-in',
        },
        profile: {
          version: 1,
          agentName: 'explore',
          effective: {
            providerId: PRIMARY,
            modelId: 'gpt-child',
            configuredEffort: 'medium',
            sentEffort: 'medium',
            source: 'conversation-agent',
            candidateIndex: 0,
          },
          attempts: [],
        },
      })

      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA)
      args.mode = 'agent'
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b'))
      const running = runCodexSubscriptionChat(args)

      await vi.waitFor(() => expect(clientA.startTurnCalls).toHaveLength(1))
      const taskResult = clientA.serverRequest({
        id: 'task_root_failover_in_flight',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_root_child_in_flight',
          itemId: 'task_root_failover_in_flight',
          callId: 'task_root_failover_in_flight',
          tool: 'task',
          arguments: { agent: 'explore', prompt: 'Run the side effect once.' },
        },
      })
      let taskSettled = false
      void taskResult.then(() => {
        taskSettled = true
      })
      await vi.waitFor(() => expect(clientA.startTurnCalls).toHaveLength(2))

      clientA.emit(
        completedNotification(
          'thread_1',
          'turn_root_child_in_flight',
          'failed',
          'UsageLimitExceeded: weekly quota exhausted'
        )
      )
      await waitImmediate()

      expect(taskSettled).toBe(false)
      expect(clientA.interruptTurnCalls).not.toContainEqual({
        threadId: 'thread_2',
        turnId: 'turn_child_in_flight',
      })

      clientA.emit({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread_2',
          turnId: 'turn_child_in_flight',
          itemId: 'child_result',
          delta: 'Side effect completed once.',
        },
      })
      clientA.emit(completedNotification('thread_2', 'turn_child_in_flight'))

      await expect(taskResult).resolves.toMatchObject({
        success: true,
        contentItems: [{ type: 'inputText', text: 'Side effect completed once.' }],
      })
      await running

      expect(clientA.startThreadCalls).toHaveLength(2)
      expect(clientA.startTurnCalls).toHaveLength(2)
      expect(clientB.startThreadCalls).toHaveLength(1)
      expect(clientB.startTurnCalls).toHaveLength(1)
    })

    it('aborts an in-flight Codex task when the root fails with a non-quota error', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_non_quota_root_failure', 'Delegate and stop on failure', 1)
      const client = new FakeCodexClient()
      client.queueTurn({ turnId: 'turn_root_non_quota_failure', notifications: [] })
      client.queueTurn({ turnId: 'turn_child_non_quota_failure', notifications: [] })
      client.interruptTurnHook = async (params) => {
        const request = params as { threadId?: string; turnId?: string }
        if (request.threadId === 'thread_2' && request.turnId === 'turn_child_non_quota_failure') {
          client.emit(completedNotification('thread_2', 'turn_child_non_quota_failure', 'interrupted'))
        }
      }
      resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
        definition: {
          name: 'explore',
          description: 'Explore',
          prompt: 'Inspect the task.',
          source: 'built-in',
        },
        profile: {
          version: 1,
          agentName: 'explore',
          effective: {
            providerId: PRIMARY,
            modelId: 'gpt-child',
            configuredEffort: 'medium',
            sentEffort: 'medium',
            source: 'conversation-agent',
            candidateIndex: 0,
          },
          attempts: [],
        },
      })

      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
      args.mode = 'agent'
      const running = runCodexSubscriptionChat(args)

      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
      const taskResult = client.serverRequest({
        id: 'task_root_non_quota_failure',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_root_non_quota_failure',
          itemId: 'task_root_non_quota_failure',
          callId: 'task_root_non_quota_failure',
          tool: 'task',
          arguments: { agent: 'explore', prompt: 'Run a task that must be aborted.' },
        },
      })
      let taskSettled = false
      void taskResult.then(() => {
        taskSettled = true
      })
      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(2))

      client.emit(
        completedNotification('thread_1', 'turn_root_non_quota_failure', 'failed', 'Model runtime failed unexpectedly')
      )

      await expect(taskResult).resolves.toMatchObject({
        success: false,
        contentItems: [{ type: 'inputText', text: 'Subagent aborted' }],
      })
      expect(taskSettled).toBe(true)
      expect(client.interruptTurnCalls).toContainEqual({
        threadId: 'thread_2',
        turnId: 'turn_child_non_quota_failure',
      })
      await running
    })

    it('confirms root suspect with a healthy snapshot before cancelling an in-flight task', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_healthy_suspect_root', 'Delegate and stop on transient limit', 1)
      const client = new FakeCodexClient()
      codexManagerBridge.setClient(client, null)
      codexManagerBridge.setRateLimits(
        {
          primary: { usedPercent: 42, resetsAt: 123 },
          secondary: { usedPercent: 10, resetsAt: 456 },
        },
        null
      )
      client.queueTurn({ turnId: 'turn_root_healthy_suspect', notifications: [] })
      client.queueTurn({ turnId: 'turn_child_healthy_suspect', notifications: [] })
      client.interruptTurnHook = async (params) => {
        const request = params as { threadId?: string; turnId?: string }
        if (request.threadId === 'thread_2' && request.turnId === 'turn_child_healthy_suspect') {
          client.emit(completedNotification('thread_2', 'turn_child_healthy_suspect', 'interrupted'))
        }
      }
      resolveSubagentExecutionProfileMock.mockResolvedValueOnce({
        definition: {
          name: 'explore',
          description: 'Explore',
          prompt: 'Inspect the task.',
          source: 'built-in',
        },
        profile: {
          version: 1,
          agentName: 'explore',
          effective: {
            providerId: 'builtin_codex_subscription',
            modelId: 'gpt-child',
            configuredEffort: 'medium',
            sentEffort: 'medium',
            source: 'conversation-agent',
            candidateIndex: 0,
          },
          attempts: [],
        },
      })

      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
      args.mode = 'agent'
      const running = runCodexSubscriptionChat(args)

      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
      const taskResult = client.serverRequest({
        id: 'task_healthy_suspect_root',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_root_healthy_suspect',
          itemId: 'task_healthy_suspect_root',
          callId: 'task_healthy_suspect_root',
          tool: 'task',
          arguments: { agent: 'explore', prompt: 'Run a task that must be aborted.' },
        },
      })
      let taskSettled = false
      void taskResult.then(() => {
        taskSettled = true
      })
      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(2))

      client.emit(
        completedNotification('thread_1', 'turn_root_healthy_suspect', 'failed', '429 rate limit from upstream')
      )

      await expect(taskResult).resolves.toMatchObject({
        success: false,
        contentItems: [{ type: 'inputText', text: 'Subagent aborted' }],
      })
      expect(taskSettled).toBe(true)
      expect(client.interruptTurnCalls).toContainEqual({
        threadId: 'thread_2',
        turnId: 'turn_child_healthy_suspect',
      })
      await running
    })

    it('resume quota emits the physical transition from A to B', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_resume_failover_1', 'First turn', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      clientA.queueTurn({
        turnId: 'turn_resume_failover_1',
        notifications: [completedNotification('thread_1', 'turn_resume_failover_1')],
      })

      await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, clientA))

      persistUser(conversation.id, 'user_resume_failover_2', 'Second turn', 3)
      clientA.resumeError = new Error('UsageLimitExceeded: weekly quota exhausted')
      clientB.queueTurn({
        turnId: 'turn_resume_failover_2',
        notifications: [completedNotification('thread_1', 'turn_resume_failover_2')],
      })

      const onFailoverTransition = vi.fn()
      const onEffectiveTargetChanged = vi.fn()
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA)
      args.requestedContextWindow = 1_000_000
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b', undefined, 300_000))
      args.onFailoverTransition = onFailoverTransition
      args.onEffectiveTargetChanged = onEffectiveTargetChanged

      await runCodexSubscriptionChat(args)

      expect(onFailoverTransition).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'root', fromProviderId: PRIMARY, toProviderId: FALLBACK })
      )
      expect(onEffectiveTargetChanged).toHaveBeenCalledWith({
        providerId: FALLBACK,
        accountId: 'acc_b',
        requestedContextWindow: 300_000,
      })
      expect((clientA.resumeThreadCalls[0] as { config: Record<string, unknown> }).config.model_context_window).toBe(
        1_000_000
      )
      expect((clientB.startThreadCalls[0] as { config: Record<string, unknown> }).config.model_context_window).toBe(
        300_000
      )
    })

    it('initial thread/start quota emits the physical transition from A to B', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_initial_failover', 'Hello', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      clientA.startThreadError = new Error('UsageLimitExceeded: weekly quota exhausted')
      clientB.queueTurn({
        turnId: 'turn_initial_failover',
        notifications: [completedNotification('thread_1', 'turn_initial_failover')],
      })

      const onFailoverTransition = vi.fn()
      const onEffectiveTargetChanged = vi.fn()
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA)
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b'))
      args.onFailoverTransition = onFailoverTransition
      args.onEffectiveTargetChanged = onEffectiveTargetChanged

      await runCodexSubscriptionChat(args)

      expect(onFailoverTransition).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'root', fromProviderId: PRIMARY, toProviderId: FALLBACK })
      )
      expect(onEffectiveTargetChanged).toHaveBeenCalledWith({ providerId: FALLBACK, accountId: 'acc_b' })
    })

    it('retires a late thread/start response from account A through manager A after failover to B', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_late_start', 'Hello', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      const lateA = clientA.queueLateThreadStart('thread_late_a')
      clientB.queueTurn({
        turnId: 'turn_b_late_start',
        notifications: [completedNotification('thread_1', 'turn_b_late_start')],
      })

      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA)
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b'))

      const running = runCodexSubscriptionChat(args)
      await vi.waitFor(() => expect(clientB.startThreadCalls).toHaveLength(1))
      lateA.release()
      await running
      await vi.waitFor(() => expect(clientA.deleteThreadCalls).toContainEqual({ threadId: 'thread_late_a' }))

      expect(clientB.deleteThreadCalls).not.toContainEqual({ threadId: 'thread_late_a' })
    })

    it('retains ownership of a late fresh compaction start on account A after failover to B', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_late_compact', 'Continue the task', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      clientA.queueTurn({
        turnId: 'turn_compact_late_start',
        notifications: [
          usageNotification(
            'thread_1',
            'turn_compact_late_start',
            { total: breakdown(950, 0, 1), last: breakdown(950, 0, 1) },
            1_000
          ),
          completedNotification('thread_1', 'turn_compact_late_start', 'interrupted'),
        ],
      })
      let lateA!: LateThreadStartRequest
      clientA.startThreadHook = () => {
        if (!lateA) lateA = clientA.queueLateThreadStart('thread_late_compaction_a')
      }
      clientB.queueTurn({
        turnId: 'turn_b_after_compaction',
        notifications: [completedNotification('thread_1', 'turn_b_after_compaction')],
      })

      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA)
      args.contextWindow = 1_000
      args.compactHistory = vi.fn(async () => ({ summary: 'Portable summary' }))
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b'))

      const running = runCodexSubscriptionChat(args)
      await vi.waitFor(() => expect(clientB.startThreadCalls).toHaveLength(1))
      lateA.release()
      await running
      await vi.waitFor(() => expect(clientA.deleteThreadCalls).toContainEqual({ threadId: 'thread_late_compaction_a' }))

      expect(clientB.deleteThreadCalls).not.toContainEqual({ threadId: 'thread_late_compaction_a' })
    })

    it('quota after text + completed tool continues same bubble without second message-start', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_mid', 'Do work', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')

      clientA.queueTurn({
        turnId: 'turn_a1',
        notifications: [
          {
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread_1', turnId: 'turn_a1', itemId: 'partial_a', delta: 'Partial A.' },
          },
          {
            method: 'item/started',
            params: {
              threadId: 'thread_1',
              turnId: 'turn_a1',
              item: {
                id: 'tool_done',
                type: 'commandExecution',
                command: 'pwd',
                status: 'inProgress',
              },
            },
          },
          {
            method: 'item/completed',
            params: {
              threadId: 'thread_1',
              turnId: 'turn_a1',
              item: {
                id: 'tool_done',
                type: 'commandExecution',
                command: 'pwd',
                status: 'completed',
                aggregatedOutput: 'file contents',
                exitCode: 0,
              },
            },
          },
          usageNotification('thread_1', 'turn_a1', {
            total: breakdown(100, 10, 20),
            last: breakdown(100, 10, 20),
          }),
          completedNotification('thread_1', 'turn_a1', 'failed', 'UsageLimitExceeded: weekly'),
        ],
      })
      clientB.queueTurn({
        turnId: 'turn_b1',
        notifications: [
          {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread_1',
              turnId: 'turn_b1',
              itemId: 'continue_b',
              delta: ' Continued on B.',
            },
          },
          usageNotification('thread_1', 'turn_b1', {
            total: breakdown(30, 5, 6),
            last: breakdown(30, 5, 6),
          }),
          completedNotification('thread_1', 'turn_b1'),
        ],
      })

      const emitted: ChatStreamEvent[] = []
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA, (e) => emitted.push(e))
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b'))

      await runCodexSubscriptionChat(args)

      expect(emitted.filter((e) => e.kind === 'message-start')).toHaveLength(1)
      expect(emitted.filter((e) => e.kind === 'finish')).toHaveLength(1)
      expect(emitted.some((e) => e.kind === 'compaction')).toBe(false)
      const assistant = assistantMessages(conversation.id)[0]
      expect(assistant.parts.some((p) => p.type === 'text' && p.text.includes('Partial A.'))).toBe(true)
      expect(assistant.parts.some((p) => p.type === 'text' && p.text.includes('Continued on B.'))).toBe(true)
      expect(assistant.parts.some((p) => p.type === 'tool' && p.toolCallId === 'tool_done')).toBe(true)
    })

    it('all accounts exhausted emits one codex-accounts-exhausted error', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_exhausted', 'Hello', 1)
      const clientA = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      clientA.queueStartTurnError(new Error('UsageLimitExceeded: weekly quota exhausted'))

      const emitted: ChatStreamEvent[] = []
      const resolveNextTarget = vi.fn(async () => null)
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA, (e) => emitted.push(e))
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = resolveNextTarget

      await runCodexSubscriptionChat(args)

      expect(resolveNextTarget).toHaveBeenCalledOnce()
      const errors = emitted.filter((e) => e.kind === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: 'codex-accounts-exhausted' })
      expect(assistantMessages(conversation.id)[0].errorCode).toBe('codex-accounts-exhausted')
    })

    it('quota plus disconnected fallback emits a non-quota resolution error', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_mixed_unavailable', 'Hello', 1)
      const clientA = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      clientA.queueStartTurnError(new Error('UsageLimitExceeded: weekly quota exhausted'))

      const emitted: ChatStreamEvent[] = []
      const resolveNextTarget = vi.fn(async () => ({
        reason: 'unavailable' as const,
        message: 'No eligible Codex subscription account is currently available.',
      }))
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA, (e) => emitted.push(e))
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = resolveNextTarget

      await runCodexSubscriptionChat(args)

      expect(resolveNextTarget).toHaveBeenCalledOnce()
      const errors = emitted.filter((e) => e.kind === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({
        message: 'No eligible Codex subscription account is currently available.',
      })
      expect(errors[0]).not.toHaveProperty('code')
      expect(assistantMessages(conversation.id)[0].errorCode).toBeUndefined()
    })

    it('generic 429 / network does not rotate', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_429', 'Hello', 1)
      const clientA = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      clientA.queueStartTurnError(new CodexAppServerRpcError('Too Many Requests', 429, 'turn/start', 1))

      const emitted: ChatStreamEvent[] = []
      const resolveNextTarget = vi.fn(async () => failoverTarget(clientA, FALLBACK, 'acc_b'))
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA, (e) => emitted.push(e))
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = resolveNextTarget

      await runCodexSubscriptionChat(args)

      expect(resolveNextTarget).not.toHaveBeenCalled()
      expect(emitted.some((e) => e.kind === 'error')).toBe(true)
      expect(emitted.some((e) => e.kind === 'error' && e.code === 'codex-accounts-exhausted')).toBe(false)
    })

    it('half-open failed turn settles as other and permits a future probe', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_half_open_failed', 'Hello', 1)
      const client = new FakeCodexClient()
      client.queueTurn({
        turnId: 'turn_half_open_failed',
        notifications: [completedNotification('thread_1', 'turn_half_open_failed', 'failed', 'socket hang up')],
      })
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
      args.failoverChain = [PRIMARY]
      args.availabilityLease = halfOpenLease()

      await runCodexSubscriptionChat(args)

      expectFutureProbe()
    })

    it('half-open interrupted turn settles as other', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_half_open_interrupted', 'Hello', 1)
      const client = new FakeCodexClient()
      client.queueTurn({
        turnId: 'turn_half_open_interrupted',
        notifications: [completedNotification('thread_1', 'turn_half_open_interrupted', 'interrupted')],
      })
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
      args.failoverChain = [PRIMARY]
      args.availabilityLease = halfOpenLease()

      await runCodexSubscriptionChat(args)

      expectFutureProbe()
    })

    it('half-open aborted turn settles as other', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_half_open_aborted', 'Hello', 1)
      const client = new FakeCodexClient()
      client.queueTurn({ turnId: 'turn_half_open_aborted', notifications: [] })
      const controller = new AbortController()
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
      args.failoverChain = [PRIMARY]
      args.availabilityLease = halfOpenLease()
      args.signal = controller.signal

      const running = runCodexSubscriptionChat(args)
      await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
      controller.abort()
      client.emit(completedNotification('thread_1', 'turn_half_open_aborted', 'interrupted'))
      await running

      expectFutureProbe()
    })

    it('stop during switch does not start B', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_stop', 'Hello', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      clientA.queueStartTurnError(new Error('UsageLimitExceeded: weekly quota exhausted'))

      const controller = new AbortController()
      const emitted: ChatStreamEvent[] = []
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA, (e) => emitted.push(e))
      args.signal = controller.signal
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => {
        controller.abort()
        return failoverTarget(clientB, FALLBACK, 'acc_b')
      })

      await runCodexSubscriptionChat(args)

      expect(clientB.startThreadCalls).toHaveLength(0)
      expect(clientB.startTurnCalls).toHaveLength(0)
    })

    it('usage accumulates across failover attempts', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_usage', 'Hello', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')

      clientA.queueTurn({
        turnId: 'turn_a1',
        notifications: [
          {
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread_1', turnId: 'turn_a1', itemId: 'partial_a', delta: 'A partial.' },
          },
          usageNotification('thread_1', 'turn_a1', {
            total: breakdown(80, 10, 15),
            last: breakdown(80, 10, 15),
          }),
          completedNotification('thread_1', 'turn_a1', 'failed', 'UsageLimitExceeded: weekly'),
        ],
      })
      clientB.queueTurn({
        turnId: 'turn_b1',
        notifications: [
          {
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread_1', turnId: 'turn_b1', itemId: 'final_b', delta: ' Done.' },
          },
          usageNotification('thread_1', 'turn_b1', {
            total: breakdown(40, 5, 7),
            last: breakdown(40, 5, 7),
          }),
          completedNotification('thread_1', 'turn_b1'),
        ],
      })

      const emitted: ChatStreamEvent[] = []
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA, (e) => emitted.push(e))
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b'))

      await runCodexSubscriptionChat(args)

      const finish = emitted.find((e) => e.kind === 'finish')
      expect(finish).toMatchObject({
        usage: expect.objectContaining({
          // A: input 70 (80-10), output 15; B: input 35 (40-5), output 7
          input: 105,
          output: 22,
          cachedInput: 15,
        }),
      })
    })

    it('reduces the portable ceiling before continuation when the fallback has a smaller window', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_smaller_window', 'Continue the task', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')

      clientA.queueTurn({
        turnId: 'turn_a_smaller_window',
        notifications: [
          usageNotification(
            'thread_1',
            'turn_a_smaller_window',
            { total: breakdown(20, 0, 10), last: breakdown(20, 0, 10) },
            2_000
          ),
          completedNotification('thread_1', 'turn_a_smaller_window', 'failed', 'UsageLimitExceeded: weekly'),
        ],
      })
      clientB.queueTurn({
        turnId: 'turn_b_smaller_window',
        notifications: [
          // No runtime window is reported here: the continuation must use the physical target metadata.
          usageNotification(
            'thread_1',
            'turn_b_smaller_window',
            { total: breakdown(95_000, 0, 0), last: breakdown(95_000, 0, 0) },
            0
          ),
          completedNotification('thread_1', 'turn_b_smaller_window', 'interrupted'),
        ],
      })
      clientB.queueTurn({
        turnId: 'turn_b_after_smaller_window_compact',
        notifications: [completedNotification('thread_2', 'turn_b_after_smaller_window_compact')],
      })

      const compactHistory = vi.fn(async () => ({ summary: 'Portable continuation summary' }))
      const onEffectiveTargetChanged = vi.fn()
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA)
      args.contextWindow = 200_000
      args.compactHistory = compactHistory
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b', 100_000))
      args.onEffectiveTargetChanged = onEffectiveTargetChanged

      await runCodexSubscriptionChat(args)

      expect(onEffectiveTargetChanged).toHaveBeenCalledWith({
        providerId: FALLBACK,
        accountId: 'acc_b',
        contextWindow: 100_000,
      })
      expect(compactHistory).toHaveBeenCalledOnce()
      expect(clientB.startTurnCalls).toHaveLength(2)
    })

    it('compacts before thread/start when replay exceeds 90% without physical overflow', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_failover_boundary_prior', 'prior state '.repeat(42_000), 1)
      persistUser(conversation.id, 'user_failover_boundary_current', 'Continue the task', 2)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')

      clientA.queueTurn({
        turnId: 'turn_a_boundary_replay',
        notifications: [
          {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread_1',
              turnId: 'turn_a_boundary_replay',
              itemId: 'partial_boundary',
              delta: 'Partial.',
            },
          },
          completedNotification('thread_1', 'turn_a_boundary_replay', 'failed', 'UsageLimitExceeded: weekly'),
        ],
      })
      clientB.queueTurn({
        turnId: 'turn_b_boundary_replay',
        notifications: [completedNotification('thread_1', 'turn_b_boundary_replay')],
      })

      const compactHistory = vi.fn(async () => ({ summary: 'Summary of the state at the limit.' }))
      clientB.startThreadHook = () => expect(compactHistory).toHaveBeenCalledOnce()
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA)
      args.contextWindow = 1_000_000
      args.compactHistory = compactHistory
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b', 200_000))

      await runCodexSubscriptionChat(args)

      expect(compactHistory).toHaveBeenCalledOnce()
      expect(clientB.startThreadCalls).toHaveLength(1)
      expect(clientB.startTurnCalls).toHaveLength(1)
    })

    it('compacts a long transcript before continuation on a smaller fallback', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      const priorTranscript = 'prior state '.repeat(36_000)
      persistUser(conversation.id, 'user_failover_long_prior', priorTranscript, 1)
      persistUser(conversation.id, 'user_failover_long_current', 'Continue the task', 2)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')

      clientA.queueTurn({
        turnId: 'turn_a_long_replay',
        notifications: [
          {
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread_1', turnId: 'turn_a_long_replay', itemId: 'partial_long', delta: 'Partial.' },
          },
          completedNotification('thread_1', 'turn_a_long_replay', 'failed', 'UsageLimitExceeded: weekly'),
        ],
      })
      clientB.queueTurn({
        turnId: 'turn_b_long_replay',
        notifications: [completedNotification('thread_1', 'turn_b_long_replay')],
      })

      const compactHistory = vi.fn(async () => ({ summary: 'Summary of the previous state.' }))
      clientB.startThreadHook = () => expect(compactHistory).toHaveBeenCalledOnce()
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA)
      args.contextWindow = 1_000_000
      args.compactHistory = compactHistory
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b', 100_000))

      await runCodexSubscriptionChat(args)

      expect(compactHistory).toHaveBeenCalledOnce()
      expect(clientB.startTurnCalls).toHaveLength(1)
      const replayInput = (clientB.startTurnCalls[0] as { input: Array<{ text?: string }> }).input
      expect(replayInput[0]?.text).toContain('Summary of the previous state.')
      expect(replayInput[0]?.text).not.toContain(priorTranscript)
    })

    it('compacts the original seed without output before starting the smaller fallback', async () => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      const priorTranscript = 'original context '.repeat(36_000)
      persistUser(conversation.id, 'user_failover_original_prior', priorTranscript, 1)
      persistUser(conversation.id, 'user_failover_original_current', 'Continue from the original request', 2)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')

      clientA.queueTurn({
        turnId: 'turn_a_original_replay',
        notifications: [
          completedNotification('thread_1', 'turn_a_original_replay', 'failed', 'UsageLimitExceeded: weekly'),
        ],
      })
      clientB.queueTurn({
        turnId: 'turn_b_original_replay',
        notifications: [completedNotification('thread_1', 'turn_b_original_replay')],
      })

      const compactHistory = vi.fn(async () => ({ summary: 'Summary for the original seed.' }))
      const args = runArgs(conversation.id, workspace.id, conversation.cwd, clientA)
      args.contextWindow = 1_000_000
      args.compactHistory = compactHistory
      args.failoverChain = [PRIMARY, FALLBACK]
      args.resolveNextTarget = vi.fn(async () => failoverTarget(clientB, FALLBACK, 'acc_b', 100_000))

      await runCodexSubscriptionChat(args)

      expect(compactHistory).toHaveBeenCalledOnce()
      expect(clientB.startTurnCalls).toHaveLength(1)
      const replayInput = (clientB.startTurnCalls[0] as { input: Array<{ text?: string }> }).input
      expect(replayInput[0]?.text).toContain('Summary for the original seed.')
      expect(replayInput[0]?.text).toContain('Continue from the original request')
      expect(replayInput[0]?.text).not.toContain(priorTranscript)
    })
  })

  describe('task/subagent account failover', () => {
    const PRIMARY = 'builtin_codex_subscription'
    const FALLBACK = 'builtin_codex_subscription@acc_b'

    function enableChain(): void {
      setAppSetting(
        'chat.subscriptionAccounts',
        JSON.stringify([{ id: 'acc_b', kind: 'codex-subscription', label: 'Account B', createdAt: 1 }])
      )
      setFailoverRoute({
        primaryProviderId: PRIMARY,
        enabled: true,
        fallbackProviderIds: [FALLBACK],
      })
    }

    function exploreProfile(modelId = 'gpt-5.6-mini') {
      return {
        version: 1 as const,
        agentName: 'explore',
        category: 'exploration',
        effective: {
          providerId: PRIMARY,
          modelId,
          configuredEffort: 'high',
          sentEffort: 'high',
          source: 'conversation-agent' as const,
          ruleKey: 'explore',
          candidateIndex: 0,
        },
        attempts: [],
      }
    }

    function mockExploreProfile(modelId = 'gpt-5.6-mini'): ReturnType<typeof exploreProfile> {
      const profile = exploreProfile(modelId)
      resolveSubagentExecutionProfileMock.mockResolvedValue({
        definition: {
          name: 'explore',
          category: 'exploration',
          description: 'Explore',
          prompt: 'Inspect the requested code read-only.',
          source: 'built-in',
        },
        profile,
      })
      return profile
    }

    async function runManagedTask(args: {
      clientA: FakeCodexClient
      clientB?: FakeCodexClient
      conversationId: string
      workspaceId: string
      cwd: string
      events?: ChatStreamEvent[]
      signal?: AbortSignal
      acquirePhysicalProvider?: (providerId: string) => void
      releasePhysicalProvider?: (providerId: string) => void
      onFailoverTransition?: RunCodexSubscriptionChatArgs['onFailoverTransition']
    }) {
      const events = args.events ?? []
      const run = runArgs(args.conversationId, args.workspaceId, args.cwd, args.clientA, (e) => events.push(e))
      run.mode = 'agent'
      run.permMode = 'auto'
      if (args.signal) run.signal = args.signal
      if (args.acquirePhysicalProvider) run.acquirePhysicalProvider = args.acquirePhysicalProvider
      if (args.releasePhysicalProvider) run.releasePhysicalProvider = args.releasePhysicalProvider
      if (args.onFailoverTransition) run.onFailoverTransition = args.onFailoverTransition
      const running = runCodexSubscriptionChat(run)
      await vi.waitFor(() => expect(args.clientA.startTurnCalls).toHaveLength(1))
      const taskResult = args.clientA.serverRequest({
        id: 'task_failover',
        method: 'item/tool/call',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_root_failover',
          itemId: 'task_call',
          callId: 'task_call',
          tool: 'task',
          arguments: { agent: 'explore', prompt: 'Map the auth flow.' },
        },
      })
      return { running, taskResult, events }
    }

    it('primary exhausted → starts on B', async () => {
      enableChain()
      getSubscriptionFailoverRouter().markExhausted(PRIMARY, {
        reason: 'UsageLimitExceeded: weekly',
        source: 'usage-limit-marker',
      })
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_sub_failover_pre', 'Delegate', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      clientA.queueTurn({ turnId: 'turn_root_failover', notifications: [] })
      clientB.queueTurn({
        turnId: 'turn_child_b',
        notifications: [
          {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread_1',
              turnId: 'turn_child_b',
              itemId: 'answer_b',
              delta: 'from B',
            },
          },
          usageNotification('thread_1', 'turn_child_b', {
            total: breakdown(40, 5, 8),
            last: breakdown(40, 5, 8),
          }),
          completedNotification('thread_1', 'turn_child_b'),
        ],
      })
      mockExploreProfile()
      const acquires: string[] = []
      const releases: string[] = []
      const { running, taskResult, events } = await runManagedTask({
        clientA,
        clientB,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        cwd: conversation.cwd,
        acquirePhysicalProvider: (id) => acquires.push(id),
        releasePhysicalProvider: (id) => releases.push(id),
      })

      await expect(taskResult).resolves.toMatchObject({
        success: true,
        contentItems: [{ type: 'inputText', text: 'from B' }],
      })
      expect(clientA.startThreadCalls).toHaveLength(1)
      expect(clientB.startThreadCalls).toHaveLength(1)
      expect(acquires).toEqual([FALLBACK])
      expect(releases).toEqual([FALLBACK])

      clientA.emit(completedNotification('thread_1', 'turn_root_failover'))
      await running
      expect(
        events.some((e) => e.kind === 'tool-state' && e.toolCallId === 'task_call' && e.state.status === 'completed')
      ).toBe(true)
    })

    it('half-open subagent network error settles as other and permits a future probe', async () => {
      enableChain()
      const router = getSubscriptionFailoverRouter()
      const now = Date.now()
      router.markExhausted(PRIMARY, {
        reason: 'quota',
        source: 'structured-error',
        resetsAt: now - 1,
        now: now - 2,
      })

      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_half_open_subagent', 'Delegate', 1)
      const clientA = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      clientA.queueTurn({ turnId: 'turn_root_half_open_subagent', notifications: [] })
      clientA.queueTurn({
        turnId: 'turn_child_half_open_subagent',
        notifications: [completedNotification('thread_2', 'turn_child_half_open_subagent', 'failed', 'socket hang up')],
      })
      mockExploreProfile()

      const { running, taskResult } = await runManagedTask({
        clientA,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        cwd: conversation.cwd,
      })

      await expect(taskResult).resolves.toMatchObject({ success: false })
      const health = router.getHealth(PRIMARY)
      expect(health.state).toBe('exhausted')
      expect(router.tryAdmit(PRIMARY, health.exhaustion!.nextProbeAt).ok).toBe(true)

      clientA.emit(completedNotification('thread_1', 'turn_root_half_open_subagent'))
      await running
    })

    it('mid-task quota → same card continues on B with checkpoint', async () => {
      enableChain()
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_sub_failover_mid', 'Delegate', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      clientA.queueTurn({ turnId: 'turn_root_failover', notifications: [] })
      clientA.queueTurn({
        turnId: 'turn_child_a',
        notifications: [
          {
            method: 'item/started',
            params: {
              threadId: 'thread_2',
              turnId: 'turn_child_a',
              item: { id: 'cmd_1', type: 'commandExecution', command: 'rg auth src', status: 'inProgress' },
            },
          },
          {
            method: 'item/completed',
            params: {
              threadId: 'thread_2',
              turnId: 'turn_child_a',
              item: {
                id: 'cmd_1',
                type: 'commandExecution',
                command: 'rg auth src',
                status: 'completed',
                aggregatedOutput: 'matches',
                exitCode: 0,
              },
            },
          },
          {
            method: 'item/started',
            params: {
              threadId: 'thread_2',
              turnId: 'turn_child_a',
              item: {
                id: 'dynamic_completed_item',
                callId: 'dynamic_completed_call',
                type: 'dynamicToolCall',
                tool: 'grep',
                arguments: { pattern: 'auth', path: 'src' },
                status: 'inProgress',
              },
            },
          },
          {
            method: 'item/completed',
            params: {
              threadId: 'thread_2',
              turnId: 'turn_child_a',
              item: {
                id: 'dynamic_completed_item',
                callId: 'dynamic_completed_call',
                type: 'dynamicToolCall',
                tool: 'grep',
                arguments: { pattern: 'auth', path: 'src' },
                status: 'completed',
                success: true,
              },
            },
          },
          {
            method: 'item/started',
            params: {
              threadId: 'thread_2',
              turnId: 'turn_child_a',
              item: {
                id: 'dynamic_inflight_item',
                callId: 'dynamic_inflight_call',
                type: 'dynamicToolCall',
                tool: 'grep',
                arguments: { pattern: 'auth', path: 'src/main' },
                status: 'inProgress',
              },
            },
          },
          {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread_2',
              turnId: 'turn_child_a',
              itemId: 'partial_a',
              delta: 'Found auth matches.',
            },
          },
          usageNotification('thread_2', 'turn_child_a', {
            total: breakdown(80, 10, 12),
            last: breakdown(80, 10, 12),
          }),
          completedNotification('thread_2', 'turn_child_a', 'failed', 'UsageLimitExceeded: weekly'),
        ],
      })
      clientB.queueTurn({
        turnId: 'turn_child_b',
        notifications: [
          {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread_1',
              turnId: 'turn_child_b',
              itemId: 'answer_b',
              delta: 'Continued summary.',
            },
          },
          usageNotification('thread_1', 'turn_child_b', {
            total: breakdown(30, 4, 6),
            last: breakdown(30, 4, 6),
          }),
          completedNotification('thread_1', 'turn_child_b'),
        ],
      })
      mockExploreProfile()
      const onFailoverTransition = vi.fn()
      const events: ChatStreamEvent[] = []
      const { running, taskResult } = await runManagedTask({
        clientA,
        clientB,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        cwd: conversation.cwd,
        events,
        onFailoverTransition,
      })

      await expect(taskResult).resolves.toMatchObject({
        success: true,
        contentItems: [{ type: 'inputText', text: 'Continued summary.' }],
      })
      expect(onFailoverTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'subagent',
          fromProviderId: PRIMARY,
          toProviderId: FALLBACK,
        })
      )
      const childPrompt = (clientB.startTurnCalls[0] as { input: Array<{ text?: string }> }).input[0]?.text ?? ''
      expect(childPrompt).toContain('Map the auth flow.')
      expect(childPrompt).toContain('account failover continuation')
      expect(childPrompt).toContain('rg auth src')
      expect(childPrompt).toContain('Dynamic tools already completed')
      expect(childPrompt).toContain('itemId=dynamic_completed_item')
      expect(childPrompt).toContain('callId=dynamic_completed_call')
      expect(childPrompt).toContain('Dynamic tools with uncertain completion')
      expect(childPrompt).toContain('itemId=dynamic_inflight_item')
      expect(childPrompt).toContain('callId=dynamic_inflight_call')
      const completedDynamicToolsStart = childPrompt.indexOf('Dynamic tools already completed')
      const uncertainDynamicToolsStart = childPrompt.indexOf('Dynamic tools with uncertain completion')
      expect(completedDynamicToolsStart).toBeGreaterThanOrEqual(0)
      expect(uncertainDynamicToolsStart).toBeGreaterThan(completedDynamicToolsStart)
      expect(childPrompt.slice(completedDynamicToolsStart, uncertainDynamicToolsStart)).not.toContain(
        'dynamic_inflight_item'
      )
      expect(events.filter((e) => e.kind === 'tool-input-start' && e.toolCallId === 'task_call')).toHaveLength(1)
      expect(
        events.some(
          (e) =>
            e.kind === 'tool-state' &&
            e.toolCallId === 'task_call' &&
            e.state.status === 'running' &&
            typeof e.state.output === 'string' &&
            e.state.output.includes('hit limit; continuing on')
        )
      ).toBe(true)

      clientA.emit(completedNotification('thread_1', 'turn_root_failover'))
      await running
    })

    it('usage A+B aggregated once', async () => {
      enableChain()
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_sub_failover_usage', 'Delegate', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      clientA.queueTurn({ turnId: 'turn_root_failover', notifications: [] })
      clientA.queueTurn({
        turnId: 'turn_child_a',
        notifications: [
          usageNotification('thread_2', 'turn_child_a', {
            total: breakdown(80, 10, 12),
            last: breakdown(80, 10, 12),
          }),
          completedNotification('thread_2', 'turn_child_a', 'failed', 'UsageLimitExceeded: weekly'),
        ],
      })
      clientB.queueTurn({
        turnId: 'turn_child_b',
        notifications: [
          {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread_1',
              turnId: 'turn_child_b',
              itemId: 'answer_b',
              delta: 'done',
            },
          },
          usageNotification('thread_1', 'turn_child_b', {
            total: breakdown(40, 5, 7),
            last: breakdown(40, 5, 7),
          }),
          completedNotification('thread_1', 'turn_child_b'),
        ],
      })
      const profile = mockExploreProfile()
      const events: ChatStreamEvent[] = []
      const { running, taskResult } = await runManagedTask({
        clientA,
        clientB,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        cwd: conversation.cwd,
        events,
      })

      await expect(taskResult).resolves.toMatchObject({ success: true })
      clientA.emit(
        usageNotification('thread_1', 'turn_root_failover', {
          total: breakdown(10, 0, 2),
          last: breakdown(10, 0, 2),
        })
      )
      clientA.emit(completedNotification('thread_1', 'turn_root_failover'))
      await running

      const completedTask = events.find(
        (e) => e.kind === 'tool-state' && e.toolCallId === 'task_call' && e.state.status === 'completed'
      )
      // A: input 70 (80-10), output 12; B: input 35 (40-5), output 7
      expect(completedTask).toMatchObject({
        state: {
          status: 'completed',
          sub: {
            profile,
            usage: { input: 105, output: 19, cacheRead: 15, cacheCreate: 0 },
          },
        },
      })
      expect(assistantMessages(conversation.id)[0].usage?.subagentUsage).toEqual([
        expect.objectContaining({
          modelId: 'gpt-5.6-mini',
          input: 105,
          output: 19,
          cachedInput: 15,
        }),
      ])
    })

    it('incompatible subagent target reports model/effort incompatibility without quota exhaustion', async () => {
      enableChain()
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_sub_failover_incompatible', 'Delegate', 1)
      const clientA = new FakeCodexClient()
      clientA.queueTurn({ turnId: 'turn_root_incompatible', notifications: [] })
      mockExploreProfile('gpt-not-supported')

      const { running, taskResult } = await runManagedTask({
        clientA,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        cwd: conversation.cwd,
      })

      const result = await taskResult
      expect(result).toMatchObject({
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: expect.stringMatching(/requested model, reasoning effort, or Fast mode/i),
          },
        ],
      })
      expect(JSON.stringify(result)).not.toMatch(/exhausted/i)
      expect(getSubscriptionFailoverRouter().getHealth(PRIMARY).state).not.toBe('exhausted')
      expect(getSubscriptionFailoverRouter().getHealth(FALLBACK).state).not.toBe('exhausted')

      clientA.emit(completedNotification('thread_1', 'turn_root_incompatible'))
      await running
    })

    it('unauthenticated subagent target asks for Codex login without quota exhaustion', async () => {
      enableChain()
      codexManagerBridge.setAuthenticated(false)
      codexManagerBridge.setAuthenticated(false, 'acc_b')
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_sub_failover_unauthenticated', 'Delegate', 1)
      const clientA = new FakeCodexClient()
      clientA.queueTurn({ turnId: 'turn_root_unauthenticated', notifications: [] })
      mockExploreProfile()

      const { running, taskResult } = await runManagedTask({
        clientA,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        cwd: conversation.cwd,
      })

      const result = await taskResult
      expect(result).toMatchObject({
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: expect.stringMatching(/Connect your ChatGPT \(Codex\) account/i),
          },
        ],
      })
      expect(JSON.stringify(result)).not.toMatch(/exhausted/i)
      expect(getSubscriptionFailoverRouter().getHealth(PRIMARY).state).not.toBe('exhausted')
      expect(getSubscriptionFailoverRouter().getHealth(FALLBACK).state).not.toBe('exhausted')

      clientA.emit(completedNotification('thread_1', 'turn_root_unauthenticated'))
      await running
    })

    it('all exhausted → single task error', async () => {
      enableChain()
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_sub_failover_all', 'Delegate', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      clientA.queueTurn({ turnId: 'turn_root_failover', notifications: [] })
      clientA.queueTurn({
        turnId: 'turn_child_a',
        notifications: [completedNotification('thread_2', 'turn_child_a', 'failed', 'UsageLimitExceeded: weekly')],
      })
      clientB.queueTurn({
        turnId: 'turn_child_b',
        notifications: [completedNotification('thread_1', 'turn_child_b', 'failed', 'UsageLimitExceeded: weekly')],
      })
      mockExploreProfile()
      const events: ChatStreamEvent[] = []
      const { running, taskResult } = await runManagedTask({
        clientA,
        clientB,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        cwd: conversation.cwd,
        events,
      })

      const result = await taskResult
      expect(result).toMatchObject({
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: expect.stringContaining('All Codex subscription accounts in the failover chain are exhausted'),
          },
        ],
      })
      expect(JSON.stringify(result)).toMatch(/exhausted/i)
      const errorStates = events.filter(
        (e) => e.kind === 'tool-state' && e.toolCallId === 'task_call' && e.state.status === 'error'
      )
      expect(errorStates).toHaveLength(1)

      clientA.emit(completedNotification('thread_1', 'turn_root_failover'))
      await running
    })

    it('stop aborts current and does not start fallback', async () => {
      enableChain()
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, {})
      persistUser(conversation.id, 'user_sub_failover_stop', 'Delegate', 1)
      const clientA = new FakeCodexClient()
      const clientB = new FakeCodexClient()
      codexManagerBridge.setClient(clientA, null)
      codexManagerBridge.setClient(clientB, 'acc_b')
      clientA.queueTurn({ turnId: 'turn_root_failover', notifications: [] })
      // Child turn never completes until aborted.
      clientA.queueTurn({
        turnId: 'turn_child_a',
        notifications: [
          {
            method: 'turn/started',
            params: { threadId: 'thread_2', turn: { id: 'turn_child_a', status: 'inProgress' } },
          },
        ],
      })
      clientA.interruptTurnHook = async (params) => {
        const threadId = (params as { threadId?: string }).threadId
        const turnId = (params as { turnId?: string }).turnId
        if (threadId && turnId) {
          clientA.emit(completedNotification(threadId, turnId, 'interrupted'))
        }
      }
      mockExploreProfile()
      const controller = new AbortController()
      const { running, taskResult } = await runManagedTask({
        clientA,
        clientB,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        cwd: conversation.cwd,
        signal: controller.signal,
      })

      await vi.waitFor(() => expect(clientA.startTurnCalls.length).toBeGreaterThanOrEqual(2))
      controller.abort()
      await expect(taskResult).resolves.toMatchObject({ success: false })
      expect(clientB.startThreadCalls).toHaveLength(0)
      expect(clientB.startTurnCalls).toHaveLength(0)

      clientA.emit(completedNotification('thread_1', 'turn_root_failover', 'interrupted'))
      await running
    })
  })

  it('a normal turn after isolated review-loop rounds seeds only the main context', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_main', 'main question', 1)
    upsertChatMessage({
      id: 'asst_main',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 't', text: 'main answer' }],
      model: { providerId: 'builtin_codex_subscription', modelId: 'gpt-5.6-sol' },
      createdAt: 2,
    })
    const round = (executionId: string, iteration: number, userText: string, asstText: string, at: number) => {
      const scope = { kind: 'review-loop' as const, executionId, loopId: 'loop-1', iteration, maxIterations: 10 }
      upsertChatMessage({
        id: `${executionId}-user`,
        conversationId: conversation.id,
        role: 'user',
        parts: [{ type: 'text', id: `${executionId}-u`, text: userText }],
        internal: true,
        source: 'chatgpt-web-review-loop',
        executionScope: scope,
        createdAt: at,
      })
      upsertChatMessage({
        id: `${executionId}-asst`,
        conversationId: conversation.id,
        role: 'assistant',
        parts: [{ type: 'text', id: `${executionId}-a`, text: asstText }],
        model: { providerId: 'builtin_codex_subscription', modelId: 'gpt-5.6-mini' },
        source: 'chatgpt-web-review-loop',
        executionScope: scope,
        createdAt: at + 1,
      })
    }
    round('exec-a', 1, 'findings round a', 'fix round a', 3)
    round('exec-b', 2, 'findings round b', 'fix round b', 5)
    // MANUAL turn after the loop: before the fix, the runner selected r2-asst as currentUser and aborted;
    // with the fix, the seed must come only from the main context.
    persistUser(conversation.id, 'user_after_loop', 'manual turn after the loop', 7)

    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_after_loop',
      notifications: [completedNotification('thread_1', 'turn_after_loop')],
    })
    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))

    expect(client.resumeThreadCalls).toEqual([])
    expect(client.startThreadCalls).toHaveLength(1)
    expect(client.startTurnCalls).toHaveLength(1)
    const input = JSON.stringify((client.startTurnCalls[0] as { input: unknown }).input)
    // Only the main context (current message + main seed).
    expect(input).toContain('manual turn after the loop')
    expect(input).toContain('main question')
    expect(input).toContain('main answer')
    // No isolated round leaks into the seed.
    expect(input).not.toContain('findings round a')
    expect(input).not.toContain('fix round a')
    expect(input).not.toContain('findings round b')
    expect(input).not.toContain('fix round b')
  })

  it('creates profile boundaries for default → Astra → default while preserving same-profile model resume', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const client = new FakeCodexClient()
    client.initializeResult = {
      capabilities: { turnSteer: true, turnSettingsUpdate: true, requestUserInputAsync: true },
    }

    persistUser(conversation.id, 'user_default_profile', 'default turn', 1)
    client.queueTurn({
      turnId: 'turn_default_profile',
      notifications: [completedNotification('thread_1', 'turn_default_profile')],
    })
    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))
    expect(getCodexThreadBinding(conversation.id)?.harnessProfile).toBe('openai-default-v1')

    persistUser(conversation.id, 'user_astra_profile', 'astra turn', 3)
    const astraArgs = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    astraArgs.selection = { providerId: 'builtin_codex_subscription', modelId: 'gpt-6-astra' }
    astraArgs.runtimeModel = astraRuntimeModel()
    astraArgs.reasoningEffort = 'ultra'
    client.queueTurn({
      turnId: 'turn_astra_profile',
      notifications: [completedNotification('thread_2', 'turn_astra_profile')],
    })
    await runCodexSubscriptionChat(astraArgs)
    expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_1' })
    expect(getCodexThreadBinding(conversation.id)?.harnessProfile).toBe('openai-gpt-6-astra-v1')
    const astraThread = client.startThreadCalls[1] as Record<string, any>
    expect(astraThread.personality).toBeUndefined()
    expect(astraThread.config.model_auto_compact_token_limit).toBeUndefined()
    expect(astraThread.config['features.context_management.experimental_mode']).toBe(true)
    expect(astraThread.developerInstructions).toContain('Native multi-agent tools are disabled')
    expect((client.startTurnCalls[1] as Record<string, unknown>).personality).toBeUndefined()
    expect(client.startTurnCalls[1]).toMatchObject({ effort: 'ultra' })

    persistUser(conversation.id, 'user_restored_profile', 'back to current', 5)
    client.queueTurn({
      turnId: 'turn_restored_profile',
      notifications: [completedNotification('thread_3', 'turn_restored_profile')],
    })
    await runCodexSubscriptionChat(runArgs(conversation.id, workspace.id, conversation.cwd, client))
    expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_2' })
    expect(getCodexThreadBinding(conversation.id)?.harnessProfile).toBe('openai-default-v1')
    expect((client.startThreadCalls[2] as Record<string, any>).personality).toBe('pragmatic')
  })

  it('publishes Astra steering and live-effort controls only for the active turn', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_astra_controls', 'start long task', 1)
    const client = new FakeCodexClient()
    client.initializeResult = { capabilities: { turnSteer: true, turnSettingsUpdate: true } }
    client.queueTurn({
      turnId: 'turn_astra_controls',
      notifications: [
        {
          method: 'turn/started',
          params: { threadId: 'thread_1', turn: { id: 'turn_astra_controls', status: 'inProgress' } },
        },
      ],
    })
    const controls: Array<NonNullable<Parameters<NonNullable<RunCodexSubscriptionChatArgs['onTurnControl']>>[0]>> = []
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.selection = { providerId: 'builtin_codex_subscription', modelId: 'gpt-6-astra' }
    args.runtimeModel = astraRuntimeModel()
    args.onTurnControl = (control) => {
      if (control) controls.push(control)
    }

    const running = runCodexSubscriptionChat(args)
    await vi.waitFor(() => expect(controls).toHaveLength(1))
    await expect(controls[0].steer('also inspect tests', 'client-steer-1')).resolves.toBe('accepted')
    await expect(controls[0].updateReasoning('ultra')).resolves.toBe('applied')
    await expect(controls[0].updateReasoning('minimal')).resolves.toBe('invalid-effort')
    expect(client.steerTurnCalls).toEqual([
      {
        threadId: 'thread_1',
        expectedTurnId: 'turn_astra_controls',
        input: [{ type: 'text', text: 'also inspect tests', text_elements: [] }],
        clientUserMessageId: 'client-steer-1',
      },
    ])
    expect(client.updateTurnSettingsCalls).toEqual([
      { threadId: 'thread_1', expectedTurnId: 'turn_astra_controls', effort: 'ultra' },
    ])
    client.emit(completedNotification('thread_1', 'turn_astra_controls'))
    await running
    await expect(controls[0].steer('too late', 'client-steer-2')).resolves.toBe('target-unavailable')
  })

  it('compacts Astra natively in the same thread and bypasses the portable fallback on success', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_astra_compaction', 'long astra task', 1)
    const client = new FakeCodexClient()
    client.queueTurn({
      turnId: 'turn_astra_compact_1',
      notifications: [
        usageNotification(
          'thread_1',
          'turn_astra_compact_1',
          { total: breakdown(950, 100, 10), last: breakdown(950, 100, 10) },
          1_000
        ),
        completedNotification('thread_1', 'turn_astra_compact_1', 'interrupted'),
      ],
    })
    client.queueTurn({
      turnId: 'turn_astra_compact_2',
      notifications: [
        usageNotification(
          'thread_1',
          'turn_astra_compact_2',
          { total: breakdown(1_100, 120, 20), last: breakdown(150, 20, 10) },
          1_000
        ),
        completedNotification('thread_1', 'turn_astra_compact_2'),
      ],
    })
    client.requestHook = (method) => {
      if (method !== 'thread/compact/start') return
      setImmediate(() => {
        client.emit({
          method: 'turn/started',
          params: { threadId: 'thread_1', turn: { id: 'turn_native_compact', status: 'inProgress' } },
        })
        client.emit(
          usageNotification(
            'thread_1',
            'turn_native_compact',
            { total: breakdown(1_000, 110, 15), last: breakdown(50, 10, 5) },
            1_000
          )
        )
        client.emit(completedNotification('thread_1', 'turn_native_compact'))
      })
    }
    const emitted: ChatStreamEvent[] = []
    const compactHistory = vi.fn(async () => ({ summary: 'portable fallback' }))
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client, (event) => emitted.push(event))
    args.selection = { providerId: 'builtin_codex_subscription', modelId: 'gpt-6-astra' }
    args.runtimeModel = astraRuntimeModel()
    args.contextWindow = 1_000
    args.compactHistory = compactHistory

    await runCodexSubscriptionChat(args)
    expect(client.requestCalls).toContainEqual(
      expect.objectContaining({ method: 'thread/compact/start', params: { threadId: 'thread_1' } })
    )
    expect(compactHistory).not.toHaveBeenCalled()
    expect(client.startThreadCalls).toHaveLength(1)
    expect(client.deleteThreadCalls).toEqual([])
    expect(emitted.find((event) => event.kind === 'compaction')).toMatchObject({ strategy: 'codex-native' })
  })

  it('retries one fresh Astra thread with experimental context disabled when the account is ineligible', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_astra_context_fallback', 'run with astra', 1)
    const client = new FakeCodexClient()
    let rejected = false
    client.startThreadHook = (params) => {
      const config = (params as { config: Record<string, unknown> }).config
      if (!rejected && config['features.context_management.experimental_mode'] === true) {
        rejected = true
        throw new Error('experimental context management is unavailable for this account')
      }
    }
    client.queueTurn({
      turnId: 'turn_astra_context_fallback',
      notifications: [completedNotification('thread_1', 'turn_astra_context_fallback')],
    })
    const args = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    args.selection = { providerId: 'builtin_codex_subscription', modelId: 'gpt-6-astra' }
    args.runtimeModel = astraRuntimeModel()

    await runCodexSubscriptionChat(args)
    expect(client.startThreadCalls).toHaveLength(2)
    expect((client.startThreadCalls[0] as any).config['features.context_management.experimental_mode']).toBe(true)
    expect((client.startThreadCalls[1] as any).config['features.context_management.experimental_mode']).toBe(false)
    expect(getCodexThreadBinding(conversation.id)?.harnessProfile).toBe('openai-gpt-6-astra-v1')

    persistUser(conversation.id, 'user_astra_context_fallback_2', 'continue with astra', 3)
    client.queueTurn({
      turnId: 'turn_astra_context_fallback_2',
      notifications: [completedNotification('thread_1', 'turn_astra_context_fallback_2')],
    })
    const resumed = runArgs(conversation.id, workspace.id, conversation.cwd, client)
    resumed.selection = { providerId: 'builtin_codex_subscription', modelId: 'gpt-6-astra' }
    resumed.runtimeModel = astraRuntimeModel()
    await runCodexSubscriptionChat(resumed)
    expect(client.startThreadCalls).toHaveLength(2)
    expect(client.resumeThreadCalls).toEqual([
      expect.objectContaining({
        threadId: 'thread_1',
        config: expect.objectContaining({ 'features.context_management.experimental_mode': false }),
      }),
    ])
  })
})
