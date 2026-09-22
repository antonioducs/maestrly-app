import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonSchema } from 'ai'
import type { SDKMessage } from '@cursor/sdk'
import type { ChatStreamEvent } from '../../src/shared/chat'

const h = vi.hoisted(() => ({
  resolveSubagentExecutionProfile: vi.fn(),
  runCursorSubagent: vi.fn(),
  getCursorSubscriptionManager: vi.fn(),
  getClaudeSubscriptionManager: vi.fn(),
  runClaudeSubagent: vi.fn(),
  buildMcpTools: vi.fn(),
  buildAppTools: vi.fn(),
  describeEphemeralToolImage: vi.fn(),
}))
vi.mock('../../src/main/chat/subagent-execution-profile', () => ({
  resolveSubagentExecutionProfile: h.resolveSubagentExecutionProfile,
}))
vi.mock('../../src/main/chat/cursor-subscription/subagent-runner', () => ({
  runCursorSubagent: h.runCursorSubagent,
}))
vi.mock('../../src/main/chat/cursor-subscription/manager', () => ({
  getCursorSubscriptionManager: h.getCursorSubscriptionManager,
  cursorModelSelectionsEqual: (
    left: { modelId: string; params: Array<{ id: string; value: string }> },
    right: { modelId: string; params: Array<{ id: string; value: string }> }
  ) =>
    left.modelId === right.modelId &&
    left.params.length === right.params.length &&
    left.params.every((param, index) => {
      const other = right.params[index]
      return other?.id === param.id && other.value === param.value
    }),
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  getClaudeSubscriptionManager: h.getClaudeSubscriptionManager,
}))
vi.mock('../../src/main/chat/claude-agent-sdk/subagent-runner', () => ({
  runClaudeSubagent: h.runClaudeSubagent,
}))
vi.mock('../../src/main/chat/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/mcp')>()
  h.buildMcpTools.mockImplementation(actual.buildMcpTools)
  h.buildAppTools.mockImplementation(actual.buildAppTools)
  return {
    ...actual,
    buildMcpTools: h.buildMcpTools,
    buildAppTools: h.buildAppTools,
  }
})
vi.mock('../../src/main/chat/image-interpreter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/image-interpreter')>()),
  describeEphemeralToolImage: h.describeEphemeralToolImage,
}))

vi.mock('../../src/main/chat/chat-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/chat-store')>()
  return { ...actual, upsertChatMessage: vi.fn(actual.upsertChatMessage) }
})
vi.mock('../../src/main/chat/cursor-subscription/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/cursor-subscription/session-store')>()
  return { ...actual, putCursorAgentBinding: vi.fn(actual.putCursorAgentBinding) }
})
import { chatHistoryStats, listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import { putCursorAgentBinding } from '../../src/main/chat/cursor-subscription/session-store'
import type {
  CursorSubscriptionAccountIdentity,
  CursorSubscriptionManager,
} from '../../src/main/chat/cursor-subscription/manager'
import {
  CURSOR_HARNESS_PROFILE,
  getCursorAgentBinding,
  listCursorAgentCleanup,
} from '../../src/main/chat/cursor-subscription/session-store'
import { currentUserInput, runCursorSubscriptionChat } from '../../src/main/chat/cursor-subscription/runner'
import { supportsChatToolImages } from '../../src/main/chat/tool-capabilities'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { REVIEWER_READONLY_TOOL_NAMES } from '../../src/main/chat/tools'

type Script = () => AsyncGenerator<SDKMessage, void>

class FakeRun {
  readonly cancel: ReturnType<typeof vi.fn>
  readonly id: string
  constructor(
    readonly agentId: string,
    private readonly script: Script,
    private readonly waitStatus: string = 'finished',
    private readonly waitSupported = true,
    hangCancel = false
  ) {
    this.cancel = hangCancel ? vi.fn(() => new Promise<never>(() => {})) : vi.fn(async () => undefined)
    this.id = `run-${Math.random().toString(16).slice(2, 8)}`
  }
  supports(op: string): boolean {
    if (op === 'wait' && !this.waitSupported) return false
    return op === 'stream' || op === 'wait' || op === 'cancel'
  }
  stream(): AsyncGenerator<SDKMessage, void> {
    return this.script()
  }
  async wait(): Promise<{ id: string; status: string; result?: string; error?: { message: string } }> {
    if (this.waitStatus === 'hang') {
      return new Promise<never>(() => {})
    }
    return {
      id: this.id,
      status: this.waitStatus,
      ...(this.waitStatus === 'error' ? { error: { message: 'provider run error' } } : {}),
    }
  }
}

class FakeAgent {
  readonly close = vi.fn()
  readonly sends: Array<{ message: unknown; options: unknown }> = []
  constructor(
    readonly agentId: string,
    private readonly runFactory: () => FakeRun
  ) {}
  async send(message: unknown, options?: unknown): Promise<FakeRun> {
    this.sends.push({ message, options })
    return this.runFactory()
  }
}

let fakeAgentSeq = 0

interface FakeLease {
  agent: FakeAgent
  release: ReturnType<typeof vi.fn>
}

class FakeManager {
  readonly identity: CursorSubscriptionAccountIdentity = { fingerprint: 'user:7', epoch: 3 }
  readonly assertAccountIdentity = vi.fn((expected: CursorSubscriptionAccountIdentity) => {
    if (expected.fingerprint !== this.identity.fingerprint || expected.epoch !== this.identity.epoch) {
      throw new Error('account changed')
    }
  })
  readonly accountId: string | null = null
  readonly resolveModelSelection = vi.fn(async () => ({
    modelId: 'composer-2.5',
    params: [{ id: 'fast', value: 'false' }],
    note: 'standard',
  }))
  readonly createCalls: unknown[] = []
  readonly resumeCalls: Array<{ agentId: string; options: unknown }> = []
  deleteAgent = vi.fn(async () => undefined)
  private readonly agents: FakeAgent[] = []
  private readonly leases: FakeLease[] = []
  private readonly runs: FakeRun[] = []
  private readonly pending: Array<{ script: Script; waitStatus: string; waitSupported: boolean; hangCancel: boolean }> =
    []
  private createError: unknown = null

  queue(script: Script, waitStatus = 'finished', waitSupported = true, hangCancel = false): void {
    this.pending.push({ script, waitStatus, waitSupported, hangCancel })
  }
  failCreate(error: unknown): void {
    this.createError = error
  }
  lastAgent(): FakeAgent | undefined {
    return this.agents.at(-1)
  }
  lastLease(): FakeLease | undefined {
    return this.leases.at(-1)
  }
  lastRun(): FakeRun | undefined {
    return this.runs.at(-1)
  }
  async createAgent(options: unknown): Promise<FakeLease> {
    if (this.createError) throw this.createError
    this.createCalls.push(options)
    const agentId = `agent-${++fakeAgentSeq}`
    const agent = new FakeAgent(agentId, () => {
      const next = this.nextRun()
      const run = new FakeRun(agentId, next.script, next.waitStatus, next.waitSupported, next.hangCancel)
      this.runs.push(run)
      return run
    })
    this.agents.push(agent)
    const lease: FakeLease = { agent, release: vi.fn() }
    this.leases.push(lease)
    return lease
  }
  async resumeAgent(agentId: string, options: unknown): Promise<FakeLease> {
    this.resumeCalls.push({ agentId, options })
    const agent = new FakeAgent(agentId, () => {
      const next = this.nextRun()
      const run = new FakeRun(agentId, next.script, next.waitStatus, next.waitSupported, next.hangCancel)
      this.runs.push(run)
      return run
    })
    this.agents.push(agent)
    const lease: FakeLease = { agent, release: vi.fn() }
    this.leases.push(lease)
    return lease
  }
  private nextRun(): { script: Script; waitStatus: string; waitSupported: boolean; hangCancel: boolean } {
    return (
      this.pending.shift() ?? {
        script: async function* () {} as Script,
        waitStatus: 'finished',
        waitSupported: true,
        hangCancel: false,
      }
    )
  }
}

function msg(type: string, data: Record<string, unknown>): SDKMessage {
  return { type, agent_id: 'agent-x', run_id: 'run-x', ...data } as unknown as SDKMessage
}

function baseArgs(
  manager: FakeManager,
  conversationId: string,
  cwd: string
): Parameters<typeof runCursorSubscriptionChat>[0] {
  return {
    conversationId,
    projectId: 'ws-1',
    cwd,
    selection: { providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5' },
    mode: 'agent',
    fastMode: false,
    manager: manager as unknown as CursorSubscriptionManager,

    accountIdentity: { fingerprint: manager.identity.fingerprint, epoch: manager.identity.epoch },
    broker: { assert: vi.fn(async () => undefined) } as never,
    questionBroker: { ask: vi.fn(async () => []) } as never,
    emit: vi.fn(),
    signal: new AbortController().signal,
    contextWindow: 200_000,
    canPersistSession: () => true,
  }
}

function persistUser(conversationId: string, id: string, text: string, createdAt: number): void {
  upsertChatMessage({
    id,
    conversationId,
    role: 'user',
    parts: [{ type: 'text', id: `${id}-text`, text }],
    createdAt: Date.now() + createdAt,
  } as never)
}

let uniqueUserSeq = 0

function persistUniqueUser(conversationId: string, text: string, createdAt: number): void {
  persistUser(conversationId, `unique-user-${++uniqueUserSeq}`, text, createdAt)
}

const SCREENSHOT_DATA = 'aGVsbG8='

function browserScreenshotTool() {
  return {
    inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
    execute: vi.fn(async () => ({
      type: 'content',
      value: [
        { type: 'text', text: 'Screenshot captured.' },
        { type: 'file', data: { type: 'data', data: SCREENSHOT_DATA }, mediaType: 'image/png' },
      ],
    })),
  }
}

async function runBrowserScreenshot(
  manager: FakeManager,
  conversationId: string,
  cwd: string,
  dropImages: boolean
): Promise<unknown> {
  h.buildMcpTools.mockResolvedValueOnce({
    tools: { browser_screenshot: browserScreenshotTool() },
    close: vi.fn(async () => undefined),
  })
  manager.queue(async function* () {
    yield msg('status', { status: 'FINISHED' })
  })
  let screenshotResult: unknown
  const originalCreate = manager.createAgent.bind(manager)
  manager.createAgent = vi.fn(async (options) => {
    const lease = await originalCreate(options)
    const customTools = (
      options as {
        local?: { customTools?: Record<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }> }
      }
    ).local?.customTools
    screenshotResult = await customTools?.browser_screenshot?.execute({}, { toolCallId: 'screenshot-1' })
    return lease
  }) as FakeManager['createAgent']
  await runCursorSubscriptionChat({ ...baseArgs(manager, conversationId, cwd), dropImages, emit: () => undefined })
  return screenshotResult
}

describe('Cursor subscription runner', () => {
  let cwd: string

  beforeEach(() => {
    freshDb()
    cwd = mkdtempSync(path.join(os.tmpdir(), 'maestrly-cursor-runner-'))
    h.resolveSubagentExecutionProfile.mockReset()
    h.runCursorSubagent.mockReset()
    h.getCursorSubscriptionManager.mockReset()
    h.runClaudeSubagent.mockReset()
    h.buildMcpTools.mockClear()
    h.buildAppTools.mockClear()
    h.describeEphemeralToolImage.mockReset()
    h.describeEphemeralToolImage.mockResolvedValue(null)

    h.getClaudeSubscriptionManager.mockImplementation(() => ({
      assertAccountIdentity: vi.fn(),
      status: vi.fn(async () => ({ authenticated: false, accountFingerprint: null, accountEpoch: 0 })),
    }))
  })

  afterEach(() => {
    closeDb()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('maps text, reasoning, and tools and persists a successful binding', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'Analise o projeto', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'Vou olhar' }] },
      })
      yield msg('tool_call', {
        call_id: 't1',
        name: 'bash',
        status: 'completed',
        args: { command: 'ls' },
        result: { text: 'src' },
      })
      yield msg('assistant', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'Pronto.' }] },
      })
      yield msg('status', { status: 'FINISHED' })
    })

    const emitted: ChatStreamEvent[] = []
    const args = { ...baseArgs(manager, conversation.id, cwd), emit: (event: ChatStreamEvent) => emitted.push(event) }
    const result = await runCursorSubscriptionChat(args)

    expect(result.agentId).toBe('agent-1')
    const kinds = emitted.map((event) => event.kind)
    expect(kinds).toContain('message-start')
    expect(kinds).toContain('text-delta')
    expect(kinds).toContain('tool-call')
    expect(kinds).toContain('tool-state')
    expect(kinds).toContain('finish')

    const binding = getCursorAgentBinding(conversation.id)
    expect(binding).toMatchObject({
      agentId: 'agent-1',
      modelId: 'composer-2.5',
      modelParams: [{ id: 'fast', value: 'false' }],
      harnessProfile: CURSOR_HARNESS_PROFILE,
      accountFingerprint: 'user:7',
    })
    expect(binding?.lastMessageId).toBeTruthy()

    const agent = manager.lastAgent()!
    expect(agent.close).toHaveBeenCalled()
    const send = agent.sends[0]
    const text = (send.message as { text: string }).text
    expect(text).toContain('Maestrly harness')
    expect(text).toContain('Analise o projeto')
    expect((send.options as { model: { params?: unknown } }).model.params).toEqual([{ id: 'fast', value: 'false' }])
    const createOptions = manager.createCalls[0] as {
      tools?: unknown
      local?: { customTools?: Record<string, unknown> }
    }

    expect(createOptions.tools).toBeUndefined()
    expect(createOptions.local?.customTools?.bash).toBeTruthy()
    expect(createOptions.local?.customTools?.edit).toBeTruthy()
  })

  it('interprets screenshots when vision is unknown and an interpreter is ready', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-screenshot-interpreter', 'capture', 1)
    const manager = new FakeManager()
    h.describeEphemeralToolImage.mockResolvedValue({ text: 'A screenshot of the browser.', model: 'vision-test' })

    const result = await runBrowserScreenshot(
      manager,
      conversation.id,
      cwd,
      !supportsChatToolImages({ unknownVision: 'unsupported', imageInterpreterConfigured: true })
    )

    expect(h.describeEphemeralToolImage).toHaveBeenCalledWith(
      expect.objectContaining({ image: expect.objectContaining({ mediaType: 'image/png' }) })
    )
    expect(result).toEqual({
      content: [{ type: 'text', text: expect.stringContaining('A screenshot of the browser.') }],
    })
    expect(JSON.stringify(result)).not.toContain(SCREENSHOT_DATA)
  })

  it('preserves screenshots when vision is unknown and no interpreter is ready', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-screenshot-optimistic', 'capture', 1)
    const manager = new FakeManager()

    const result = await runBrowserScreenshot(
      manager,
      conversation.id,
      cwd,
      !supportsChatToolImages({ unknownVision: 'unsupported', imageInterpreterConfigured: false })
    )

    expect(h.describeEphemeralToolImage).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).toContain(SCREENSHOT_DATA)
  })

  it('passes effective reasoning effort through model resolution and send', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-effort', 'Pense profundamente', 1)
    const manager = new FakeManager()
    manager.resolveModelSelection.mockResolvedValue({
      modelId: 'composer-2.5',
      params: [
        { id: 'fast', value: 'true' },
        { id: 'reasoning_effort', value: 'xhigh' },
      ],
      note: 'fast + xhigh',
    })
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })

    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      fastMode: true,
      reasoningEffort: 'xhigh',
    })

    expect(manager.resolveModelSelection).toHaveBeenCalledWith('composer-2.5', true, false, 'xhigh')
    expect((manager.lastAgent()!.sends[0].options as { model: unknown }).model).toEqual({
      id: 'composer-2.5',
      params: [
        { id: 'fast', value: 'true' },
        { id: 'reasoning_effort', value: 'xhigh' },
      ],
    })
  })

  it('rejects effective model or parameter drift in an isolated loop', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-drift', 'round', 1)
    const manager = new FakeManager()
    manager.resolveModelSelection.mockResolvedValue({
      modelId: 'composer-2.5',
      params: [{ id: 'fast', value: 'true' }],
      note: 'fast',
    })

    await expect(
      runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        frozenModelSelection: { modelId: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
      })
    ).rejects.toThrow('executor-unavailable')
    expect(manager.createCalls).toHaveLength(0)
  })

  it('resumes compatible agents without duplicating the seed transcript', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'primeira', 1)
    persistUser(conversation.id, 'user-2', 'segunda', 2)

    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    const binding = getCursorAgentBinding(conversation.id)!
    const agentAfterFirst = manager.lastAgent()!
    expect((agentAfterFirst.sends[0].message as { text: string }).text).toContain('primeira')

    persistUser(conversation.id, 'user-3', 'terceira', 3)

    const manager2 = new FakeManager()
    manager2.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({ ...baseArgs(manager2, conversation.id, cwd), emit: () => undefined })
    expect(manager2.resumeCalls).toHaveLength(1)
    expect(manager2.resumeCalls[0].agentId).toBe(binding.agentId)
    const resumeOptions = manager2.resumeCalls[0].options as {
      tools?: unknown
      local?: { customTools?: unknown }
      model?: unknown
    }

    expect(resumeOptions.tools).toBeUndefined()
    expect(resumeOptions.local?.customTools).toBeTruthy()
    expect(resumeOptions.model).toMatchObject({ id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] })
    const agent2 = manager2.lastAgent()!
    const text2 = (agent2.sends[0].message as { text: string }).text
    expect(text2).not.toContain('primeira')
    expect(text2).not.toContain('Maestrly harness')
    expect(text2).not.toContain('projectContext')
    expect(text2).toContain('terceira')

    expect(manager2.createCalls).toHaveLength(0)
  })

  it('creates and reseeds when the instruction envelope changes', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'primeira', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: () => undefined,
      maestrlyUltra: true,
    })
    const binding = getCursorAgentBinding(conversation.id)!
    persistUser(conversation.id, 'user-2', 'segunda', 2)

    const manager2 = new FakeManager()
    manager2.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({ ...baseArgs(manager2, conversation.id, cwd), emit: () => undefined })
    expect(manager2.createCalls).toHaveLength(1)
    expect(manager2.resumeCalls).toHaveLength(0)

    expect(getCursorAgentBinding(conversation.id)?.agentId).toBe(manager2.lastAgent()!.agentId)
    expect(binding.agentId).not.toBe(manager2.lastAgent()!.agentId)
    const text = (manager2.lastAgent()!.sends[0].message as { text: string }).text
    expect(text).toContain('Maestrly harness')

    expect(listCursorAgentCleanup()).toHaveLength(0)
  })

  it('deletes a newly created agent after cancellation', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'demora', 1)
    const controller = new AbortController()
    const manager = new FakeManager()
    manager.queue(async function* () {
      controller.abort()
      yield msg('status', { status: 'CANCELLED' })
    })
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      signal: controller.signal,
      emit: () => undefined,
    })
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
    expect(listCursorAgentCleanup()).toHaveLength(0)
  })

  it('persists an error message and deletes a new failed agent', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })
      yield msg('status', { status: 'ERROR', message: 'provider exploded' })
    }, 'error')
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: () => undefined,
    })

    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
    expect(listCursorAgentCleanup()).toHaveLength(0)

    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].error).toBeTruthy()
  })

  it('cleans up a new agent on provider cancellation', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'CANCELLED' })
    }, 'cancelled')
    const emitted: ChatStreamEvent[] = []
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    expect(emitted.some((event) => event.kind === 'aborted')).toBe(true)
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
    expect(listCursorAgentCleanup()).toHaveLength(0)

    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].finishReason).toBe('aborted')
  })

  it('cleans up a new expired agent despite a successful wait', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'EXPIRED' })
    }, 'finished')
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: () => undefined,
    })
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].error).toBeTruthy()
  })

  it('preserves the previous binding when a resumed agent fails', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'primeira', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    const binding = getCursorAgentBinding(conversation.id)!
    persistUser(conversation.id, 'user-2', 'segunda', 2)

    const manager2 = new FakeManager()
    manager2.queue(async function* () {
      yield msg('status', { status: 'ERROR', message: 'provider exploded' })
    }, 'error')
    await runCursorSubscriptionChat({ ...baseArgs(manager2, conversation.id, cwd), emit: () => undefined })
    expect(manager2.resumeCalls).toHaveLength(1)

    expect(getCursorAgentBinding(conversation.id)).toMatchObject({
      agentId: binding.agentId,
      lastMessageId: binding.lastMessageId,
    })
    expect(manager2.deleteAgent).not.toHaveBeenCalled()

    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants.at(-1)?.error).toBeTruthy()
  })

  it('preserves resumed bindings after cancellation or expiry', async () => {
    const seed = async (): Promise<{ conversationId: string; binding: ReturnType<typeof getCursorAgentBinding> }> => {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, { cwd })
      persistUniqueUser(conversation.id, 'primeira', 1)
      const manager = new FakeManager()
      manager.queue(async function* () {
        yield msg('status', { status: 'FINISHED' })
      })
      await runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
      return { conversationId: conversation.id, binding: getCursorAgentBinding(conversation.id) }
    }

    const cancelled = await seed()
    persistUniqueUser(cancelled.conversationId, 'segunda', 2)
    const managerC = new FakeManager()
    managerC.queue(async function* () {
      yield msg('status', { status: 'CANCELLED' })
    }, 'cancelled')
    await runCursorSubscriptionChat({ ...baseArgs(managerC, cancelled.conversationId, cwd), emit: () => undefined })
    expect(managerC.resumeCalls).toHaveLength(1)
    expect(getCursorAgentBinding(cancelled.conversationId)?.agentId).toBe(cancelled.binding!.agentId)
    expect(managerC.deleteAgent).not.toHaveBeenCalled()

    const expired = await seed()
    persistUniqueUser(expired.conversationId, 'segunda', 2)
    const managerE = new FakeManager()
    managerE.queue(async function* () {
      yield msg('status', { status: 'EXPIRED' })
    }, 'finished')
    await runCursorSubscriptionChat({ ...baseArgs(managerE, expired.conversationId, cwd), emit: () => undefined })
    expect(managerE.resumeCalls).toHaveLength(1)
    expect(getCursorAgentBinding(expired.conversationId)?.agentId).toBe(expired.binding!.agentId)
    expect(managerE.deleteAgent).not.toHaveBeenCalled()
  })

  it('flushes final deltas and clears coalescer timers on all terminal paths', async () => {
    vi.useFakeTimers()
    try {
      const runTurn = async (script: Script, waitStatus: string, signal?: AbortSignal): Promise<ChatStreamEvent[]> => {
        const workspace = makeWorkspace()
        const conversation = makeConversation(workspace.id, { cwd })
        persistUniqueUser(conversation.id, 'x', 1)
        const manager = new FakeManager()
        manager.queue(script, waitStatus)
        const emitted: ChatStreamEvent[] = []
        await runCursorSubscriptionChat({
          ...baseArgs(manager, conversation.id, cwd),
          emit: (event) => emitted.push(event),
          ...(signal ? { signal } : {}),
        })
        return emitted
      }
      const deltaThen = (status: string): Script =>
        async function* () {
          yield msg('assistant', {
            message: { role: 'assistant', content: [{ type: 'text', text: 'último delta' }] },
          })
          yield msg('status', { status })
        }

      const ok = await runTurn(deltaThen('FINISHED'), 'finished')
      expect(ok.some((e) => e.kind === 'text-delta' && (e as { delta?: string }).delta === 'último delta')).toBe(true)
      expect(vi.getTimerCount()).toBe(0)

      const err = await runTurn(deltaThen('ERROR'), 'error')
      expect(err.some((e) => e.kind === 'text-delta')).toBe(true)
      expect(vi.getTimerCount()).toBe(0)

      const controller = new AbortController()
      const aborted = await runTurn(
        async function* () {
          yield* deltaThen('CANCELLED')()
          controller.abort()
        },
        'cancelled',
        controller.signal
      )
      expect(aborted.some((e) => e.kind === 'text-delta')).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('deletes new agents when session persistence is disabled', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      canPersistSession: () => false,
      emit: () => undefined,
    })
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(manager.lastAgent()!.agentId)
    expect(listCursorAgentCleanup()).toHaveLength(0)
  })

  it('records a durable cleanup tombstone when deletion fails', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const controller = new AbortController()
    const manager = new FakeManager()
    manager.deleteAgent = vi.fn(async () => {
      throw new Error('store locked')
    })
    manager.queue(async function* () {
      controller.abort()
      yield msg('status', { status: 'CANCELLED' })
    })
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      signal: controller.signal,
      emit: () => undefined,
    })
    const cleanup = listCursorAgentCleanup()
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]).toMatchObject({
      agentId: manager.lastAgent()!.agentId,
      attempts: 1,
      conversationId: conversation.id,
    })
  })

  it('preserves a previously valid agent after a resumed turn throws', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'primeira', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    const binding = getCursorAgentBinding(conversation.id)!
    persistUser(conversation.id, 'user-2', 'segunda', 2)

    const manager2 = new FakeManager()
    manager2.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    const realResume = manager2.resumeAgent.bind(manager2)
    manager2.resumeAgent = vi.fn(async (agentId, options) => {
      manager2.identity.epoch = 99
      return realResume(agentId, options)
    }) as FakeManager['resumeAgent']
    await expect(
      runCursorSubscriptionChat({
        ...baseArgs(manager2, conversation.id, cwd),
        emit: () => undefined,
      })
    ).rejects.toThrow('account changed')
    expect(manager2.deleteAgent).not.toHaveBeenCalled()

    expect(getCursorAgentBinding(conversation.id)?.agentId).toBe(binding.agentId)
  })

  it('normalizes streamed tool names to their host identities', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'roda', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('tool_call', {
        call_id: 't1',
        name: 'mcp__custom-user-tools__bash',
        status: 'completed',
        args: { command: 'ls' },
        result: { text: 'src' },
      })
      yield msg('status', { status: 'FINISHED' })
    })
    const emitted: ChatStreamEvent[] = []
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    const toolCalls = emitted.filter((event) => event.kind === 'tool-call')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].kind === 'tool-call' && toolCalls[0].toolName).toBe('bash')
    const inputStarts = emitted.filter((event) => event.kind === 'tool-input-start')
    expect(inputStarts[0].kind === 'tool-input-start' && inputStarts[0].toolName).toBe('bash')
  })

  it('reconciles unfinished tools before publishing the terminal event', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'roda', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('tool_call', { call_id: 'stuck', name: 'bash', status: 'running', args: {} })
      yield msg('status', { status: 'FINISHED' })
    })
    const emitted: ChatStreamEvent[] = []
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })

    const toolStates = emitted.filter((event) => event.kind === 'tool-state')
    const lastToolState = toolStates.at(-1)
    expect(lastToolState?.kind).toBe('tool-state')
    if (lastToolState?.kind === 'tool-state') {
      expect(lastToolState.state.status).not.toBe('running')
      expect(lastToolState.state.status).toBe('error')
    }
    const finishIndex = emitted.findIndex((event) => event.kind === 'finish')
    const lastToolIndex = emitted.findIndex((event) => event.kind === 'tool-state' && event.toolCallId === 'stuck')
    expect(lastToolIndex).toBeLessThan(finishIndex)
  })

  it('cancels exactly once on stream abort and removes the listener', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'demora', 1)
    const controller = new AbortController()
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '1' }] } })
      controller.abort()
      yield msg('status', { status: 'CANCELLED' })
    })
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const emitted: ChatStreamEvent[] = []
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      signal: controller.signal,
      emit: (event) => emitted.push(event),
    })
    expect(emitted.some((event) => event.kind === 'aborted')).toBe(true)
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    const run = manager.lastRun()
    expect(run).toBeTruthy()

    expect(run!.cancel).toHaveBeenCalledTimes(1)

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('rejects an already aborted turn without creating or sending an agent', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'stop', 1)
    const controller = new AbortController()
    controller.abort()
    const manager = new FakeManager()
    await expect(
      runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        signal: controller.signal,
      })
    ).rejects.toThrow()
    expect(manager.createCalls).toHaveLength(0)
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
  })

  it('persists the error message and deletes a new agent when send throws', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    const realCreate = manager.createAgent.bind(manager)
    manager.createAgent = vi.fn(async (options) => {
      const lease = await realCreate(options)
      lease.agent.send = async () => {
        throw new Error('stream exploded')
      }
      return lease
    }) as FakeManager['createAgent']

    await expect(
      runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    ).rejects.toThrow('stream exploded')

    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].error).toBeTruthy()

    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(manager.lastAgent()!.agentId)
    expect(listCursorAgentCleanup()).toHaveLength(0)
  })

  it('cleans up a new agent when streaming throws', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'CANCELLED' })
      throw new Error('stream broke')
    })
    await expect(
      runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    ).rejects.toThrow('stream broke')
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(manager.lastAgent()!.agentId)
    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].error).toBeTruthy()
  })

  it('persists the message and records failed cleanup when send and deletion throw', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    const realCreate = manager.createAgent.bind(manager)
    manager.createAgent = vi.fn(async (options) => {
      const lease = await realCreate(options)
      lease.agent.send = async () => {
        throw new Error('stream exploded')
      }
      return lease
    }) as FakeManager['createAgent']
    manager.deleteAgent = vi.fn(async () => {
      throw new Error('store locked')
    })
    await expect(
      runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    ).rejects.toThrow('stream exploded')
    const cleanup = listCursorAgentCleanup()
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]).toMatchObject({
      agentId: manager.lastAgent()!.agentId,
      attempts: 1,
      conversationId: conversation.id,
    })
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
  })

  it('aborts active host tools on watchdog expiry and cancels exactly once', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'roda', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('tool_call', {
        call_id: 't1',
        name: 'task',
        status: 'running',
        args: { agent: 'explore', prompt: 'x' },
      })

      await new Promise<never>(() => {})
    })
    let toolObservedAbort = false
    const runTask = vi.fn(async (_input: unknown, _toolCallId: string, signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      toolObservedAbort = true
      return { output: 'aborted' }
    })
    const originalCreate = manager.createAgent.bind(manager)
    manager.createAgent = vi.fn(async (options) => {
      const lease = await originalCreate(options)
      const customTools = (
        options as {
          local?: { customTools?: Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }> }
        }
      ).local?.customTools
      const send = lease.agent.send.bind(lease.agent)
      lease.agent.send = async (message, sendOptions) => {
        if (customTools?.task) {
          void customTools.task.execute({ agent: 'explore', prompt: 'x' }, { toolCallId: 't1' }).catch(() => undefined)
        }
        return send(message, sendOptions)
      }
      return lease
    }) as FakeManager['createAgent']

    const emitted: ChatStreamEvent[] = []
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      runTask: runTask as never,
      emit: (event) => emitted.push(event),
      watchdog: { timeoutMs: 25, graceMs: 25 },
    })

    expect(runTask).toHaveBeenCalledTimes(1)
    expect(toolObservedAbort).toBe(true)

    const terminals = emitted.filter(
      (event) => event.kind === 'finish' || event.kind === 'error' || event.kind === 'aborted'
    )
    expect(terminals).toHaveLength(1)
    expect(terminals[0].kind).toBe('error')
    expect(emitted.some((event) => event.kind === 'finish')).toBe(false)

    expect(manager.lastRun()!.cancel).toHaveBeenCalledTimes(1)
    expect(result.diagnostics.stalled).toBe('stream')
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
  })

  it('emits one sanitized error when message persistence fails after provider success', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('usage', { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
      yield msg('status', { status: 'FINISHED' })
    })

    const realUpsert = vi.mocked(upsertChatMessage).getMockImplementation() ?? (() => {})
    const secret = 'crsr_live_AbCdEf1234567890'
    vi.mocked(upsertChatMessage).mockImplementation((message) => {
      if ((message as { finishReason?: string }).finishReason === 'stop') {
        throw new Error(`db locked: Authorization: Bearer ${secret}`)
      }
      realUpsert(message)
    })
    try {
      const emitted: ChatStreamEvent[] = []
      const result = await runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        emit: (event) => emitted.push(event),
      })

      expect(result.agentId).toBeTruthy()
      const terminals = emitted.filter(
        (event) => event.kind === 'finish' || event.kind === 'error' || event.kind === 'aborted'
      )
      expect(terminals).toHaveLength(1)
      expect(terminals[0].kind).toBe('error')
      expect(emitted.some((event) => event.kind === 'finish')).toBe(false)
      if (terminals[0].kind === 'error') {
        expect(terminals[0].message).toContain('db locked')
        expect(terminals[0].message).not.toContain(secret)
      }

      expect(getCursorAgentBinding(conversation.id)).toBeNull()
      expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
    } finally {
      vi.mocked(upsertChatMessage).mockImplementation(realUpsert)
    }
  })

  it('emits one error and cleans the agent when binding persistence fails', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    vi.mocked(putCursorAgentBinding).mockImplementationOnce(() => {
      throw new Error('binding store locked')
    })
    try {
      const emitted: ChatStreamEvent[] = []
      const result = await runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        emit: (event) => emitted.push(event),
      })
      expect(result.agentId).toBeTruthy()
      const terminals = emitted.filter(
        (event) => event.kind === 'finish' || event.kind === 'error' || event.kind === 'aborted'
      )
      expect(terminals).toHaveLength(1)
      expect(terminals[0].kind).toBe('error')
      expect(emitted.some((event) => event.kind === 'finish')).toBe(false)

      const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
      expect(assistants).toHaveLength(1)

      expect(getCursorAgentBinding(conversation.id)).toBeNull()
      expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
    } finally {
      vi.mocked(putCursorAgentBinding).mockClear()
    }
  })

  it('redacts credentials in durable cleanup errors', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const controller = new AbortController()
    const secret = 'crsr_live_AbCdEf1234567890'
    const manager = new FakeManager()
    manager.deleteAgent = vi.fn(async () => {
      throw new Error(`store locked: Authorization: Bearer ${secret}`)
    })
    manager.queue(async function* () {
      controller.abort()
      yield msg('status', { status: 'CANCELLED' })
    })
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      signal: controller.signal,
      emit: () => undefined,
    })
    const cleanup = listCursorAgentCleanup()
    expect(cleanup).toHaveLength(1)

    expect(cleanup[0].lastError).not.toContain(secret)
    expect(cleanup[0].lastError).toContain('[REDACTED]')
  })

  it('redacts authentication errors before emitting them', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.failCreate(Object.assign(new Error('Invalid API key crsr_leaked'), { name: 'AuthenticationError' }))
    const emitted: ChatStreamEvent[] = []
    await expect(
      runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: (event) => emitted.push(event) })
    ).rejects.toThrow()
    const errorEvent = emitted.find((event) => event.kind === 'error')
    expect(errorEvent?.kind).toBe('error')
    if (errorEvent?.kind === 'error') {
      expect(errorEvent.message).not.toContain('crsr_leaked')
      expect(errorEvent.message).toMatch(/Sign in again/)
    }
  })

  it('does not persist after the account identity changes', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()

    let asserts = 0
    const realCreate = manager.createAgent.bind(manager)
    manager.createAgent = vi.fn(async (options) => {
      asserts += 1

      if (asserts >= 1) manager.identity.epoch = 99
      return realCreate(options)
    }) as FakeManager['createAgent']
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
      yield msg('status', { status: 'FINISHED' })
    })
    const emitted: ChatStreamEvent[] = []
    await expect(
      runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: (event) => emitted.push(event) })
    ).rejects.toThrow('account changed')

    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(0)
  })

  it('returns plan submission from the host tool', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'planeja', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('tool_call', {
        call_id: 'p1',
        name: 'review_plan',
        status: 'completed',
        args: { plan: 'do x' },
        result: { text: 'submitted' },
      })
      yield msg('status', { status: 'FINISHED' })
    })

    const originalCreate = manager.createAgent.bind(manager)
    manager.createAgent = vi.fn(async (options) => {
      const lease = await originalCreate(options)
      const customTools = (
        options as {
          local?: { customTools?: Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }> }
        }
      ).local?.customTools
      const send = lease.agent.send.bind(lease.agent)
      lease.agent.send = async (message, sendOptions) => {
        if (customTools?.review_plan) {
          await customTools.review_plan.execute({ plan: 'do x' }, { toolCallId: 'p1' })
        }
        return send(message, sendOptions)
      }
      return lease
    }) as FakeManager['createAgent']

    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: () => undefined,
    })
    expect(result.planSubmitted).toBe(true)
  })

  it('offers plan review through the current Agent mode tool policy', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-assistant-no-plan', 'Implemente a tarefa.', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })

    await runCursorSubscriptionChat(baseArgs(manager, conversation.id, cwd))

    const customTools = (manager.createCalls[0] as { local?: { customTools?: Record<string, unknown> } }).local
      ?.customTools
    expect(Object.keys(customTools ?? {})).toContain('review_plan')
  })

  it('restricts isolated reviewers to host read-only tools and bypasses reader prompts', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-reviewer-boundary', 'Review the execution.', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    const reviewerRuntime = {
      recordEvidence: vi.fn(),
      submitReview: vi.fn(() => ({ ok: true as const })),
      searchExecutionContext: vi.fn(async () => []),
      readExecutionContext: vi.fn(async () => []),
    }
    let customToolNames: string[] = []
    const originalCreate = manager.createAgent.bind(manager)
    manager.createAgent = vi.fn(async (options) => {
      const lease = await originalCreate(options)
      const customTools = (
        options as {
          local?: { customTools?: Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }> }
        }
      ).local?.customTools
      customToolNames = Object.keys(customTools ?? {}).sort()
      const send = lease.agent.send.bind(lease.agent)
      lease.agent.send = async (message, sendOptions) => {
        await customTools?.glob?.execute({ pattern: '**/*' }, { toolCallId: 'reviewer-glob-1' })
        await customTools?.submit_review?.execute(
          { result: 'clean', summary: 'No findings.' },
          { toolCallId: 'reviewer-submit-1' }
        )
        return send(message, sendOptions)
      }
      return lease
    }) as FakeManager['createAgent']
    const brokerAssert = vi.fn(async () => undefined)

    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      mode: 'agent',
      broker: { assert: brokerAssert } as never,
      ephemeralSession: true,
      reviewerRuntime,
      emit: () => undefined,
    })

    expect(result.planSubmitted).toBe(true)
    expect(customToolNames).toEqual([...REVIEWER_READONLY_TOOL_NAMES].sort())
    expect(h.buildMcpTools).not.toHaveBeenCalled()
    expect(h.buildAppTools).not.toHaveBeenCalled()
    expect(brokerAssert).not.toHaveBeenCalled()
    expect(reviewerRuntime.recordEvidence).toHaveBeenCalledWith('search')
    expect(reviewerRuntime.submitReview).toHaveBeenCalledWith({ result: 'clean', summary: 'No findings.' })
    expect(manager.createCalls[0]).toMatchObject({ mode: 'plan' })
    expect(manager.lastAgent()?.sends[0].options).toMatchObject({ mode: 'plan' })
  })

  it('closes MCP and app connections after errors', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.failCreate(new Error('boom'))
    await expect(
      runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    ).rejects.toThrow('boom')
    expect(listCursorAgentCleanup()).toHaveLength(0)
  })

  it('releases the lease exactly once after closing the agent', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    const lease = manager.lastLease()!
    const agent = manager.lastAgent()!

    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(agent.close.mock.invocationCallOrder[0]).toBeLessThan(lease.release.mock.invocationCallOrder[0])
  })

  it('rejects missing terminal evidence without inventing success', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(
      async function* () {
        yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })
        // The stream has no terminal status and wait is unsupported.
      },
      'finished',
      false
    )
    const emitted: ChatStreamEvent[] = []
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })

    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
    expect(listCursorAgentCleanup()).toHaveLength(0)

    expect(emitted.some((event) => event.kind === 'finish')).toBe(false)
    const errorEvent = emitted.find((event) => event.kind === 'error')
    expect(errorEvent?.kind).toBe('error')
    if (errorEvent?.kind === 'error') {
      expect(errorEvent.message).toContain('without a terminal status')
    }
    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].error).toBeTruthy()
  })

  it('rejects unknown wait status without advancing the binding', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })
      // The stream has no status and wait returns an unknown status.
    }, 'unknown-status')
    const emitted: ChatStreamEvent[] = []
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
    expect(listCursorAgentCleanup()).toHaveLength(0)
    expect(emitted.some((event) => event.kind === 'finish')).toBe(false)
    const errorEvent = emitted.find((event) => event.kind === 'error')
    expect(errorEvent?.kind).toBe('error')
    if (errorEvent?.kind === 'error') {
      expect(errorEvent.message).toContain('without a terminal status')
    }
  })

  it('preserves the prior binding when a resumed agent has no terminal evidence', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'primeira', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    const binding = getCursorAgentBinding(conversation.id)!
    persistUser(conversation.id, 'user-2', 'segunda', 2)

    const manager2 = new FakeManager()
    manager2.queue(
      async function* () {
        yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })
        // Neither stream nor wait supplies terminal evidence.
      },
      'finished',
      false
    )
    await runCursorSubscriptionChat({ ...baseArgs(manager2, conversation.id, cwd), emit: () => undefined })
    expect(manager2.resumeCalls).toHaveLength(1)

    expect(getCursorAgentBinding(conversation.id)).toMatchObject({
      agentId: binding.agentId,
      lastMessageId: binding.lastMessageId,
    })
    expect(manager2.deleteAgent).not.toHaveBeenCalled()

    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants.at(-1)?.error).toBeTruthy()
  })

  it('rejects conflicting successful stream and failed wait evidence', async () => {
    for (const waitStatus of ['error', 'cancelled', 'expired']) {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, { cwd })
      persistUniqueUser(conversation.id, 'x', 1)
      const manager = new FakeManager()
      manager.queue(async function* () {
        yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
        yield msg('status', { status: 'FINISHED' })
      }, waitStatus)
      const emitted: ChatStreamEvent[] = []
      const result = await runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        emit: (event) => emitted.push(event),
      })

      expect(getCursorAgentBinding(conversation.id)).toBeNull()
      expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
      expect(listCursorAgentCleanup()).toHaveLength(0)

      const errorEvent = emitted.find((event) => event.kind === 'error')
      expect(errorEvent?.kind).toBe('error')
      if (errorEvent?.kind === 'error') {
        expect(errorEvent.message).toContain('conflicting terminal evidence')
      }
      const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
      expect(assistants).toHaveLength(1)
      expect(assistants[0].error).toBeTruthy()
    }
  })

  it('preserves streamed provider failures despite a successful wait', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })
      yield msg('status', { status: 'ERROR', message: 'provider exploded' })
    }, 'finished')
    const emitted: ChatStreamEvent[] = []
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
    expect(listCursorAgentCleanup()).toHaveLength(0)

    expect(emitted.some((event) => event.kind === 'finish')).toBe(false)
    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].error).toContain('provider exploded')
  })

  it('preserves resumed bindings when terminal evidence conflicts', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'primeira', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    const binding = getCursorAgentBinding(conversation.id)!
    persistUser(conversation.id, 'user-2', 'segunda', 2)

    const manager2 = new FakeManager()
    manager2.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
      yield msg('status', { status: 'FINISHED' })
    }, 'error')
    await runCursorSubscriptionChat({ ...baseArgs(manager2, conversation.id, cwd), emit: () => undefined })
    expect(manager2.resumeCalls).toHaveLength(1)

    expect(getCursorAgentBinding(conversation.id)).toMatchObject({
      agentId: binding.agentId,
      lastMessageId: binding.lastMessageId,
    })
    expect(manager2.deleteAgent).not.toHaveBeenCalled()
    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants.at(-1)?.error).toBeTruthy()
  })

  it('bounds a stalled stream and releases its lease after cancellation', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })

      await new Promise<never>(() => {})
    })
    const emitted: ChatStreamEvent[] = []
    const startedAt = Date.now()
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
      watchdog: { timeoutMs: 25, graceMs: 25 },
    })

    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(manager.lastRun()!.cancel).toHaveBeenCalledTimes(1)

    expect(emitted.some((event) => event.kind === 'finish')).toBe(false)
    const errorEvent = emitted.find((event) => event.kind === 'error')
    expect(errorEvent?.kind).toBe('error')
    if (errorEvent?.kind === 'error') {
      expect(errorEvent.message).toContain('stalled')
    }

    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)

    const lease = manager.lastLease()!
    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(manager.lastAgent()!.close).toHaveBeenCalled()
    expect(result.diagnostics.stalled).toBe('stream')
    expect(result.diagnostics.runId).toBeTruthy()
  })

  it('bounds a stalled wait and releases its lease after cancellation', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
      yield msg('status', { status: 'FINISHED' })
    }, 'hang')
    const emitted: ChatStreamEvent[] = []
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
      watchdog: { timeoutMs: 25, graceMs: 25 },
    })
    expect(manager.lastRun()!.cancel).toHaveBeenCalledTimes(1)
    expect(emitted.some((event) => event.kind === 'finish')).toBe(false)
    const errorEvent = emitted.find((event) => event.kind === 'error')
    expect(errorEvent?.kind).toBe('error')
    if (errorEvent?.kind === 'error') {
      expect(errorEvent.message).toContain('stalled')
    }
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
    expect(manager.lastLease()!.release).toHaveBeenCalledTimes(1)
    expect(manager.lastAgent()!.close).toHaveBeenCalled()
    expect(result.diagnostics.stalled).toBe('wait')
  })

  it('finishes after the grace window even when cancel hangs', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(
      async function* () {
        yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })
        await new Promise<never>(() => {})
      },
      'finished',
      true,
      true
    )
    const startedAt = Date.now()
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: () => undefined,
      watchdog: { timeoutMs: 25, graceMs: 25 },
    })

    const run = manager.lastRun()!
    expect(run.cancel).toHaveBeenCalledTimes(1)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.lastLease()!.release).toHaveBeenCalledTimes(1)
    expect(result.diagnostics.stalled).toBe('stream')
    expect(result.diagnostics.cancelInvoked).toBe(true)
  })

  it('allows lifecycle transitions after a stalled run changes identity', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })

      manager.identity.epoch = 99
      await new Promise<never>(() => {})
    })
    await expect(
      runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        emit: () => undefined,
        watchdog: { timeoutMs: 25, graceMs: 25 },
      })
    ).rejects.toThrow('account changed')

    expect(manager.lastRun()!.cancel).toHaveBeenCalledTimes(1)
    expect(manager.lastAgent()!.close).toHaveBeenCalled()
    expect(manager.lastLease()!.release).toHaveBeenCalledTimes(1)

    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(0)
  })

  it('preserves resumed bindings after watchdog expiry', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'primeira', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    const binding = getCursorAgentBinding(conversation.id)!
    persistUser(conversation.id, 'user-2', 'segunda', 2)

    const manager2 = new FakeManager()
    manager2.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })
      await new Promise<never>(() => {})
    })
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager2, conversation.id, cwd),
      emit: () => undefined,
      watchdog: { timeoutMs: 25, graceMs: 25 },
    })
    expect(manager2.resumeCalls).toHaveLength(1)

    expect(getCursorAgentBinding(conversation.id)).toMatchObject({
      agentId: binding.agentId,
      lastMessageId: binding.lastMessageId,
    })
    expect(manager2.deleteAgent).not.toHaveBeenCalled()

    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants.at(-1)?.error).toBeTruthy()
    expect(result.diagnostics.stalled).toBe('stream')
  })

  it('emits exactly one error for conflicting successful stream and failed wait', async () => {
    for (const waitStatus of ['error', 'cancelled', 'expired']) {
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, { cwd })
      persistUniqueUser(conversation.id, 'x', 1)
      const manager = new FakeManager()
      manager.queue(async function* () {
        yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
        yield msg('status', { status: 'FINISHED' })
      }, waitStatus)
      const emitted: ChatStreamEvent[] = []
      await runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        emit: (event) => emitted.push(event),
      })
      const terminals = emitted.filter(
        (event) => event.kind === 'finish' || event.kind === 'error' || event.kind === 'aborted'
      )
      expect(terminals).toHaveLength(1)
      expect(terminals[0].kind).toBe('error')
      expect(emitted.some((event) => event.kind === 'finish')).toBe(false)
      expect(getCursorAgentBinding(conversation.id)).toBeNull()
    }
  })

  it('emits exactly one finish when both terminal sources succeed', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
      yield msg('status', { status: 'FINISHED' })
    }, 'finished')
    const emitted: ChatStreamEvent[] = []
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    const terminals = emitted.filter(
      (event) => event.kind === 'finish' || event.kind === 'error' || event.kind === 'aborted'
    )
    expect(terminals).toHaveLength(1)
    expect(terminals[0].kind).toBe('finish')
    expect(getCursorAgentBinding(conversation.id)).toBeTruthy()
  })

  it('emits exactly one aborted event when both terminal sources cancel', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'CANCELLED' })
    }, 'cancelled')
    const emitted: ChatStreamEvent[] = []
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    const terminals = emitted.filter(
      (event) => event.kind === 'finish' || event.kind === 'error' || event.kind === 'aborted'
    )
    expect(terminals).toHaveLength(1)
    expect(terminals[0].kind).toBe('aborted')
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
  })

  it('emits one error when terminal evidence is missing', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(
      async function* () {
        yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })
        // Neither stream nor wait supplies terminal evidence.
      },
      'finished',
      false
    )
    const emitted: ChatStreamEvent[] = []
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    const terminals = emitted.filter(
      (event) => event.kind === 'finish' || event.kind === 'error' || event.kind === 'aborted'
    )
    expect(terminals).toHaveLength(1)
    expect(terminals[0].kind).toBe('error')
    expect(emitted.some((event) => event.kind === 'finish')).toBe(false)
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
  })

  it('captures provider correlation IDs without requiring them', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('system', { agent_id: 'agent-1', run_id: 'run-42', model: { id: 'composer-2.5' }, tools: [] })
      yield msg('request', { agent_id: 'agent-1', run_id: 'run-42', request_id: 'req-77' })
      yield msg('status', { run_id: 'run-42', status: 'FINISHED' })
    })
    const emitted: ChatStreamEvent[] = []
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    expect(result.diagnostics.runId).toBe('run-42')
    expect(result.diagnostics.requestId).toBe('req-77')
    expect(result.diagnostics.stalled).toBeNull()
    expect(result.diagnostics.cancelInvoked).toBe(false)

    const workspace2 = makeWorkspace()
    const conversation2 = makeConversation(workspace2.id, { cwd })
    persistUniqueUser(conversation2.id, 'y', 1)
    const manager2 = new FakeManager()
    manager2.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    const result2 = await runCursorSubscriptionChat({
      ...baseArgs(manager2, conversation2.id, cwd),
      emit: () => undefined,
    })
    expect(result2.diagnostics.runId).toBeTruthy()
    expect(result2.diagnostics.requestId).toBeNull()
  })

  it('keeps correlation IDs out of events and redacts provider errors', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('request', { agent_id: 'agent-1', run_id: 'run-42', request_id: 'req-77' })
      yield msg('status', { status: 'ERROR', message: 'boom crsr_leaked_secret_123' })
    }, 'error')
    const emitted: ChatStreamEvent[] = []
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    expect(result.diagnostics.requestId).toBe('req-77')

    for (const event of emitted) {
      const text = JSON.stringify(event)
      expect(text).not.toContain('req-77')
      expect(text).not.toContain('crsr_leaked_secret_123')
      expect(text).not.toContain('run-42')
    }
    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants.at(-1)?.error).toContain('[REDACTED]')
    expect(assistants.at(-1)?.error).not.toContain('crsr_leaked_secret_123')
  })

  it('bounds a stopped stream by the cancellation grace window', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const controller = new AbortController()
    const manager = new FakeManager()
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    manager.queue(async function* () {
      abortTimer = setTimeout(() => controller.abort(), 20)
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })

      await new Promise<never>(() => {})
    })
    const startedAt = Date.now()
    const emitted: ChatStreamEvent[] = []
    try {
      const result = await runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        signal: controller.signal,
        emit: (event) => emitted.push(event),
        watchdog: { timeoutMs: 10_000, graceMs: 25 },
      })

      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(manager.lastRun()!.cancel).toHaveBeenCalledTimes(1)

      const terminals = emitted.filter(
        (event) => event.kind === 'finish' || event.kind === 'error' || event.kind === 'aborted'
      )
      expect(terminals).toHaveLength(1)
      expect(terminals[0].kind).toBe('aborted')
      expect(emitted.some((event) => event.kind === 'finish')).toBe(false)

      expect(getCursorAgentBinding(conversation.id)).toBeNull()
      expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
      expect(manager.lastAgent()!.close).toHaveBeenCalled()
      expect(manager.lastLease()!.release).toHaveBeenCalledTimes(1)

      expect(result.diagnostics.stalled).toBeNull()
    } finally {
      clearTimeout(abortTimer)
    }
  })

  it('bounds a stopped wait and releases the lease', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const controller = new AbortController()
    const manager = new FakeManager()
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    manager.queue(async function* () {
      abortTimer = setTimeout(() => controller.abort(), 20)
      yield msg('status', { status: 'FINISHED' })
    }, 'hang')
    const startedAt = Date.now()
    const emitted: ChatStreamEvent[] = []
    try {
      const result = await runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        signal: controller.signal,
        emit: (event) => emitted.push(event),
        watchdog: { timeoutMs: 10_000, graceMs: 25 },
      })
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(manager.lastRun()!.cancel).toHaveBeenCalledTimes(1)
      const terminals = emitted.filter(
        (event) => event.kind === 'finish' || event.kind === 'error' || event.kind === 'aborted'
      )
      expect(terminals).toHaveLength(1)
      expect(terminals[0].kind).toBe('aborted')
      expect(emitted.some((event) => event.kind === 'finish')).toBe(false)

      expect(getCursorAgentBinding(conversation.id)).toBeNull()
      expect(manager.lastLease()!.release).toHaveBeenCalledTimes(1)
      expect(manager.lastAgent()!.close).toHaveBeenCalled()
      expect(result.diagnostics.stalled).toBeNull()
    } finally {
      clearTimeout(abortTimer)
    }
  })

  it('keeps local cancellation authoritative over concurrent provider success', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'x', 1)
    const controller = new AbortController()
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
      controller.abort()

      yield msg('status', { status: 'FINISHED' })
    })
    const emitted: ChatStreamEvent[] = []
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      signal: controller.signal,
      emit: (event) => emitted.push(event),
      watchdog: { timeoutMs: 10_000, graceMs: 100 },
    })
    expect(manager.lastRun()!.cancel).toHaveBeenCalledTimes(1)
    const terminals = emitted.filter(
      (event) => event.kind === 'finish' || event.kind === 'error' || event.kind === 'aborted'
    )
    expect(terminals).toHaveLength(1)
    expect(terminals[0].kind).toBe('aborted')
    expect(emitted.some((event) => event.kind === 'finish')).toBe(false)

    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(manager.deleteAgent).toHaveBeenCalledWith(result.agentId)
    expect(result.diagnostics.stalled).toBeNull()
  })

  it('preserves a resumed binding on local cancellation', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'primeira', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), emit: () => undefined })
    const binding = getCursorAgentBinding(conversation.id)!
    persistUser(conversation.id, 'user-2', 'segunda', 2)

    const controller = new AbortController()
    const manager2 = new FakeManager()
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    manager2.queue(async function* () {
      abortTimer = setTimeout(() => controller.abort(), 20)
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })
      await new Promise<never>(() => {})
    })
    const startedAt = Date.now()
    try {
      await runCursorSubscriptionChat({
        ...baseArgs(manager2, conversation.id, cwd),
        signal: controller.signal,
        emit: () => undefined,
        watchdog: { timeoutMs: 10_000, graceMs: 25 },
      })
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(manager2.resumeCalls).toHaveLength(1)

      expect(getCursorAgentBinding(conversation.id)).toMatchObject({
        agentId: binding.agentId,
        lastMessageId: binding.lastMessageId,
      })
      expect(manager2.deleteAgent).not.toHaveBeenCalled()
      expect(manager2.lastAgent()!.close).toHaveBeenCalled()
      expect(manager2.lastLease()!.release).toHaveBeenCalledTimes(1)
    } finally {
      clearTimeout(abortTimer)
    }
  })

  const runTaskInSend = (manager: FakeManager): void => {
    const originalCreate = manager.createAgent.bind(manager)
    manager.createAgent = vi.fn(async (options) => {
      const lease = await originalCreate(options)
      const customTools = (
        options as {
          local?: { customTools?: Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }> }
        }
      ).local?.customTools
      const send = lease.agent.send.bind(lease.agent)
      lease.agent.send = async (message, sendOptions) => {
        if (customTools?.task) {
          await customTools.task.execute({ agent: 'explore', prompt: 'subtask' }, { toolCallId: 't1' })
        }
        return send(message, sendOptions)
      }
      return lease
    }) as FakeManager['createAgent']
  }

  const mockSubagent = (providerId = 'builtin_cursor_subscription'): void => {
    h.resolveSubagentExecutionProfile.mockResolvedValue({
      definition: {
        name: 'explore',
        description: 'Read-only exploration',
        prompt: 'Investigate.',
        source: 'built-in',
      },
      profile: {
        version: 1,
        agentName: 'explore',
        effective: {
          providerId,
          modelId: 'composer-2.5',
          configuredEffort: '',
          sentEffort: null,
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
    })
    h.runCursorSubagent.mockResolvedValue({
      text: 'subagent ok',
      model: { providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5' },
      usage: { input: 10, output: 30, cacheRead: 5, cacheCreate: 2, totalInput: 17 },
      runtimeEstimatedCostUsd: 0.000501,
    })
  }

  it('hydrates another Cursor account before admitting a child', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'delega', 1)
    const parentManager = new FakeManager()
    parentManager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })

    let hydrated = false
    const profileManager = {
      assertAccountIdentity: vi.fn(),
      getAccountIdentity: vi.fn(() => {
        throw new Error('identity read before cold-start hydration')
      }),
      getStatus: vi.fn(async () => {
        hydrated = true
        return { authenticated: true, accountFingerprint: 'user:7', accountEpoch: 4 }
      }),
    }
    h.getCursorSubscriptionManager.mockReturnValue(profileManager)
    mockSubagent('builtin_cursor_subscription@account-b')
    h.runCursorSubagent.mockImplementation(async (args: { accountIdentity: CursorSubscriptionAccountIdentity }) => {
      expect(hydrated).toBe(true)
      expect(args.accountIdentity).toEqual({ fingerprint: 'user:7', epoch: 4 })
      return {
        text: 'subagent ok',
        model: { providerId: 'builtin_cursor_subscription@account-b', modelId: 'composer-2.5' },
        usage: { input: 1, output: 2, cacheRead: 0, cacheCreate: 0, totalInput: 3 },
      }
    })
    runTaskInSend(parentManager)

    await runCursorSubscriptionChat({ ...baseArgs(parentManager, conversation.id, cwd), emit: () => undefined })

    expect(h.getCursorSubscriptionManager).toHaveBeenCalledWith('account-b')
    expect(profileManager.getStatus).toHaveBeenCalledTimes(1)
    expect(profileManager.getAccountIdentity).not.toHaveBeenCalled()
    expect(h.runCursorSubagent).toHaveBeenCalledTimes(1)
  })

  it('includes child usage in the finish event and persisted binding', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'delega', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('usage', {
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 180 },
      })
      yield msg('status', { status: 'FINISHED' })
    })
    mockSubagent()
    runTaskInSend(manager)

    const emitted: ChatStreamEvent[] = []
    const result = await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    expect(h.runCursorSubagent).toHaveBeenCalledTimes(1)
    expect(h.runCursorSubagent).not.toHaveBeenCalledWith(expect.objectContaining({ fastMode: expect.anything() }))

    const finish = emitted.find((event) => event.kind === 'finish')
    expect(finish?.kind).toBe('finish')
    if (finish?.kind === 'finish') {
      expect(finish.usage).toMatchObject({
        input: 100,
        output: 50,
        modelContextWindow: 200_000,
        cachedInput: 20,
        cacheCreate: 10,
        subInput: 10,
        subOutput: 30,
        subCachedInput: 5,
        subCacheCreate: 2,
        subagentUsage: [
          {
            providerId: 'builtin_cursor_subscription',
            modelId: 'composer-2.5',
            input: 10,
            output: 30,
            cachedInput: 5,
            cacheCreate: 2,
          },
        ],
      })
      expect(finish.usage?.runtimeEstimatedCostUsd).toBeUndefined()
    }

    const binding = getCursorAgentBinding(conversation.id)!
    expect(binding.agentId).toBe(result.agentId)
    const persisted = JSON.parse(binding.usageJson) as {
      input?: number
      subInput?: number
      subOutput?: number
      subagentUsage?: Array<{ providerId: string; modelId: string; input: number; output: number }>
    }
    expect(persisted.input).toBe(100)
    expect(persisted.subInput).toBe(10)
    expect(persisted.subOutput).toBe(30)
    expect(persisted.subagentUsage).toEqual([
      {
        providerId: 'builtin_cursor_subscription',
        modelId: 'composer-2.5',
        input: 10,
        output: 30,
        cachedInput: 5,
        cacheCreate: 2,
        catalogInput: 0,
        catalogOutput: 0,
        catalogCacheRead: 0,
        catalogCacheCreate: 0,
        runtimeEstimatedCostUsd: 0.000501,
      },
    ])
  })

  it('creates and completes host task cards before provider stream events arrive', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'delega', 1)
    const manager = new FakeManager()

    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    mockSubagent()
    runTaskInSend(manager)

    const emitted: ChatStreamEvent[] = []
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })

    expect(emitted).toContainEqual({
      kind: 'tool-call',
      messageId: expect.any(String),
      toolCallId: 't1',
      toolName: 'task',
      input: { agent: 'explore', prompt: 'subtask' },
    })
    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    expect(assistant?.usage?.billingOnly).toBe(true)
    expect(chatHistoryStats(conversation.id).lastUsage).toBeNull()
    const taskPart = assistant?.parts.find((part) => part.type === 'tool' && part.toolCallId === 't1')
    expect(taskPart).toMatchObject({
      type: 'tool',
      toolName: 'task',
      input: { agent: 'explore', prompt: 'subtask' },
      state: {
        status: 'completed',
        output: 'subagent ok',
        sub: {
          profile: { agentName: 'explore' },
          usage: { input: 10, output: 30, cacheRead: 5, cacheCreate: 2 },
        },
      },
    })
  })

  it('preserves host task terminal state and metadata against late provider events', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'delega', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('tool_call', {
        call_id: 't1',
        name: 'mcp__custom-user-tools_task',
        status: 'completed',
        args: { agent: 'explore', prompt: 'subtask' },
        result: { text: 'late SDK summary' },
      })
      yield msg('status', { status: 'FINISHED' })
    })
    mockSubagent()
    runTaskInSend(manager)

    await runCursorSubscriptionChat(baseArgs(manager, conversation.id, cwd))

    const assistant = listChatMessages(conversation.id).find((message) => message.role === 'assistant')
    const taskParts = assistant?.parts.filter((part) => part.type === 'tool' && part.toolCallId === 't1') ?? []
    expect(taskParts).toHaveLength(1)
    expect(taskParts[0]).toMatchObject({
      toolName: 'task',
      state: {
        status: 'completed',
        output: 'subagent ok',
        sub: { profile: { agentName: 'explore' }, durationMs: expect.any(Number) },
      },
    })
  })

  it('preserves child usage on provider failure without persisting a binding', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'delega', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('usage', {
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 180 },
      })
      yield msg('status', { status: 'ERROR', message: 'provider exploded' })
    }, 'error')
    mockSubagent()
    runTaskInSend(manager)

    const emitted: ChatStreamEvent[] = []
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    const errorEvent = emitted.find((event) => event.kind === 'error')
    expect(errorEvent?.kind).toBe('error')
    if (errorEvent?.kind === 'error') {
      expect(errorEvent.usage).toMatchObject({
        input: 100,
        output: 50,
        subInput: 10,
        subOutput: 30,
        subagentUsage: [{ providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5', input: 10, output: 30 }],
      })
    }

    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].usage).toMatchObject({
      subInput: 10,
      subOutput: 30,
      subagentUsage: [{ providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5', input: 10, output: 30 }],
    })
  })

  it('preserves child usage on cancellation without main provider usage', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'delega', 1)
    const controller = new AbortController()
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })
      controller.abort()
      throw new Error('stream broke')
    })
    mockSubagent()
    runTaskInSend(manager)

    const emitted: ChatStreamEvent[] = []
    await expect(
      runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        signal: controller.signal,
        emit: (event) => emitted.push(event),
      })
    ).rejects.toThrow('stream broke')
    const aborted = emitted.find((event) => event.kind === 'aborted')
    expect(aborted?.kind).toBe('aborted')
    if (aborted?.kind === 'aborted') {
      expect(aborted.usage).toMatchObject({
        usageVersion: 2,
        input: 0,
        output: 0,
        subInput: 10,
        subOutput: 30,
        subagentUsage: [{ providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5', input: 10, output: 30 }],
      })
    }
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
  })

  it('preserves child usage when a non-cancellation error escapes', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'delega', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] } })
      throw new Error('stream broke')
    })
    mockSubagent()
    runTaskInSend(manager)

    const emitted: ChatStreamEvent[] = []
    await expect(
      runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        emit: (event) => emitted.push(event),
      })
    ).rejects.toThrow('stream broke')

    const errorEvent = emitted.find((event) => event.kind === 'error')
    expect(errorEvent?.kind).toBe('error')
    if (errorEvent?.kind === 'error') {
      expect(errorEvent.message).toBe('stream broke')
      expect(errorEvent.usage).toMatchObject({
        usageVersion: 2,
        input: 0,
        output: 0,
        subInput: 10,
        subOutput: 30,
        subagentUsage: [{ providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5', input: 10, output: 30 }],
      })
    }

    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    const assistants = listChatMessages(conversation.id).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].error).toBe('stream broke')
    expect(assistants[0].usage).toMatchObject({
      subInput: 10,
      subOutput: 30,
      subagentUsage: [{ providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5', input: 10, output: 30 }],
    })
  })

  const mockClaudeSubagent = (runtimeEstimatedCostUsd: number): void => {
    h.resolveSubagentExecutionProfile.mockResolvedValue({
      definition: {
        name: 'explore',
        description: 'Read-only exploration',
        prompt: 'Investigate.',
        source: 'built-in',
      },
      profile: {
        version: 1,
        agentName: 'explore',
        effective: {
          providerId: 'builtin_claude_subscription',
          modelId: 'opus[1m]',
          configuredEffort: '',
          sentEffort: null,
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
    })
    h.getClaudeSubscriptionManager.mockImplementation(() => ({
      assertAccountIdentity: vi.fn(),
      status: vi.fn(async () => ({ authenticated: true, accountFingerprint: 'fp:1', accountEpoch: 1 })),
    }))
    h.runClaudeSubagent.mockResolvedValue({
      text: 'claude subagent ok',
      model: { providerId: 'builtin_claude_subscription', modelId: 'opus[1m]' },
      usage: { input: 10, output: 30, cacheRead: 5, cacheCreate: 2, totalInput: 17 },
      runtimeEstimatedCostUsd,
    })
  }

  it('preserves authoritative Claude child cost without duplicate catalog estimates', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'delega', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    mockClaudeSubagent(0.0042)
    runTaskInSend(manager)

    const emitted: ChatStreamEvent[] = []
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      emit: (event) => emitted.push(event),
    })
    expect(h.runClaudeSubagent).toHaveBeenCalledTimes(1)

    const finish = emitted.find((event) => event.kind === 'finish')
    expect(finish?.kind).toBe('finish')
    if (finish?.kind === 'finish') {
      const entry = finish.usage?.subagentUsage?.[0]
      expect(entry).toMatchObject({
        providerId: 'builtin_claude_subscription',
        modelId: 'opus[1m]',
        input: 10,
        output: 30,
        cachedInput: 5,
        cacheCreate: 2,
        runtimeEstimatedCostUsd: 0.0042,
      })

      expect(entry?.catalogInput).toBe(0)
      expect(entry?.catalogOutput).toBe(0)
    }

    const binding = getCursorAgentBinding(conversation.id)!
    const persisted = JSON.parse(binding.usageJson) as {
      subagentUsage?: Array<{ runtimeEstimatedCostUsd?: number; catalogInput?: number }>
    }
    expect(persisted.subagentUsage?.[0]).toMatchObject({
      runtimeEstimatedCostUsd: 0.0042,
      catalogInput: 0,
    })

    const toolStates = emitted.filter((event) => event.kind === 'tool-state')
    const lastSub = toolStates.at(-1)
    expect(lastSub?.kind).toBe('tool-state')
    if (lastSub?.kind === 'tool-state' && 'sub' in lastSub.state) {
      expect(lastSub.state.sub?.runtimeEstimatedCostUsd).toBe(0.0042)
    }
  })

  it('preserves measured Claude child cost when the child throws', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-1', 'delega', 1)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('status', { status: 'FINISHED' })
    })
    h.resolveSubagentExecutionProfile.mockResolvedValue({
      definition: {
        name: 'explore',
        description: 'Read-only exploration',
        prompt: 'Investigate.',
        source: 'built-in',
      },
      profile: {
        version: 1,
        agentName: 'explore',
        effective: {
          providerId: 'builtin_claude_subscription',
          modelId: 'opus[1m]',
          configuredEffort: '',
          sentEffort: null,
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
    })
    h.getClaudeSubscriptionManager.mockImplementation(() => ({
      assertAccountIdentity: vi.fn(),
      status: vi.fn(async () => ({ authenticated: true, accountFingerprint: 'fp:1', accountEpoch: 1 })),
    }))

    h.runClaudeSubagent.mockImplementation(async () => {
      throw Object.assign(new Error('Subagent aborted'), {
        subagentUsage: { input: 7, output: 9, cacheRead: 1, cacheCreate: 0, totalInput: 8 },
        subagentModel: { providerId: 'builtin_claude_subscription', modelId: 'opus[1m]' },
        subagentRuntimeEstimatedCostUsd: 0.005,
      })
    })
    runTaskInSend(manager)

    const emitted: ChatStreamEvent[] = []
    await expect(
      runCursorSubscriptionChat({
        ...baseArgs(manager, conversation.id, cwd),
        emit: (event) => emitted.push(event),
      })
    ).rejects.toThrow('Subagent aborted')

    const abortedEvent = emitted.find((event) => event.kind === 'aborted')
    expect(abortedEvent?.kind).toBe('aborted')
    if (abortedEvent?.kind === 'aborted') {
      const entry = abortedEvent.usage?.subagentUsage?.[0]
      expect(entry).toMatchObject({
        providerId: 'builtin_claude_subscription',
        modelId: 'opus[1m]',
        input: 7,
        output: 9,
        cachedInput: 1,
        cacheCreate: 0,
        runtimeEstimatedCostUsd: 0.005,
      })
      expect(entry?.catalogInput).toBe(0)
      expect(abortedEvent.usage).toMatchObject({ subInput: 7, subOutput: 9 })
    }

    const toolStates = emitted.filter((event) => event.kind === 'tool-state')
    const lastSub = toolStates.at(-1)
    expect(lastSub?.kind).toBe('tool-state')
    if (lastSub?.kind === 'tool-state' && 'sub' in lastSub.state) {
      expect(lastSub.state.sub?.runtimeEstimatedCostUsd).toBe(0.005)
      expect(lastSub.state.sub?.usage).toEqual({ input: 7, output: 9, cacheRead: 1, cacheCreate: 0 })
    }
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
  })

  it('keeps isolated messages while preserving the main binding and deleting the temporary agent', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })

    putCursorAgentBinding({
      conversationId: conversation.id,
      agentId: 'main-agent',
      modelId: 'composer-2.5',
      modelParams: [{ id: 'fast', value: 'false' }],
      cwd,
      harnessProfile: CURSOR_HARNESS_PROFILE,
      instructionHash: 'main-instruction',
      toolSignature: 'main-tools',
      lastMessageId: 'main-assistant',
      accountFingerprint: 'user:7',
      usageJson: '{"input":1}',
    })
    const mainBefore = structuredClone(getCursorAgentBinding(conversation.id))
    const executionId = 'exec-cursor-1'
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
      id: 'iso-user-1',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'iso-user-1-text', text: 'revise' }],
      createdAt: Date.now(),
      ...messageMeta,
    } as never)
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok isolado' }] },
      })
      yield msg('status', { status: 'FINISHED' })
    })
    await runCursorSubscriptionChat({
      ...baseArgs(manager, conversation.id, cwd),
      ephemeralSession: true,
      messageMeta,
      canPersistSession: () => false,
      emit: () => undefined,
    })
    expect(getCursorAgentBinding(conversation.id)).toEqual(mainBefore)
    expect(
      vi.mocked(putCursorAgentBinding).mock.calls.every((call) => call[0].agentId !== manager.lastAgent()!.agentId)
    ).toBe(true)
    const assistants = listChatMessages(conversation.id).filter(
      (m) => m.role === 'assistant' && m.executionScope?.kind === 'review-loop'
    )
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.parts.some((p) => p.type === 'text' && p.text.includes('ok isolado'))).toBe(true)
    expect(manager.deleteAgent).toHaveBeenCalledWith(manager.lastAgent()!.agentId)
    expect(listCursorAgentCleanup()).toHaveLength(0)
  })
  it('cleans up an agent that resolves after creation was cancelled', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-late-create', 'work', 1)
    const manager = new FakeManager()
    const originalCreate = manager.createAgent.bind(manager)
    let finishCreate!: () => void
    let creationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve
    })
    manager.createAgent = vi.fn(async (options) => {
      const lease = await originalCreate(options)
      creationStarted()
      await new Promise<void>((resolve) => {
        finishCreate = resolve
      })
      return lease
    }) as FakeManager['createAgent']
    const controller = new AbortController()
    const result = runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), signal: controller.signal })
    const rejection = expect(result).rejects.toThrow()
    await started
    controller.abort()
    await rejection
    expect(manager.lastLease()!.release).not.toHaveBeenCalled()
    finishCreate()
    await vi.waitFor(() => expect(manager.deleteAgent).toHaveBeenCalledWith(manager.lastAgent()!.agentId))
    expect(manager.lastAgent()!.close).toHaveBeenCalledTimes(1)
    expect(manager.lastLease()!.release).toHaveBeenCalledTimes(1)
  })

  it('keeps an unresolved send lease until its late run is cancelled and closed', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    persistUser(conversation.id, 'user-late-send', 'work', 1)
    const manager = new FakeManager()
    const originalCreate = manager.createAgent.bind(manager)
    let finishSend!: () => void
    let sendStarted!: () => void
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve
    })
    manager.createAgent = vi.fn(async (options) => {
      const lease = await originalCreate(options)
      const send = lease.agent.send.bind(lease.agent)
      lease.agent.send = async (input, options) => {
        sendStarted()
        await new Promise<void>((resolve) => {
          finishSend = resolve
        })
        return send(input, options)
      }
      return lease
    }) as FakeManager['createAgent']
    const controller = new AbortController()
    const result = runCursorSubscriptionChat({ ...baseArgs(manager, conversation.id, cwd), signal: controller.signal })
    const rejection = expect(result).rejects.toThrow()
    await started
    controller.abort()
    await rejection
    expect(manager.lastLease()!.release).not.toHaveBeenCalled()
    expect(manager.lastAgent()!.close).not.toHaveBeenCalled()
    finishSend()
    await vi.waitFor(() => expect(manager.lastLease()!.release).toHaveBeenCalledTimes(1))
    expect(manager.lastRun()!.cancel).toHaveBeenCalledTimes(1)
    expect(manager.lastAgent()!.close).toHaveBeenCalledTimes(1)
    expect(manager.deleteAgent).toHaveBeenCalledWith(manager.lastAgent()!.agentId)
  })
})

describe('Cursor input image policy', () => {
  it.each([
    { data: 'data:image/png;base64,aW1hZ2U=' },
    { artifactId: 'artifact-1' },
    { artifactId: 'artifact-1', data: 'data:image/png;base64,aW1hZ2U=' },
  ])('drops inline and artifact images before resolving bytes: %j', (storage) => {
    const message = {
      id: 'message',
      conversationId: 'conversation',
      role: 'user',
      createdAt: 1,
      parts: [{ type: 'file', id: 'image', name: 'image.png', mediaType: 'image/png', kind: 'image', ...storage }],
    } as import('../../src/shared/chat').ChatMessage
    const result = currentUserInput(message, '', true)
    expect(result.images).toEqual([])
    expect(result.text).toContain('image.png')
    expect(result.text).not.toContain('aW1hZ2U=')
  })
})
