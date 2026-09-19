import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatHistoryStats } from '../../src/shared/chat'
import { registerChatIpc } from '../../src/main/chat/service'
import { listChatMessages, listConversationContextMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import { estimateNativeSeedContextTokens } from '../../src/main/chat/portable-context'
import {
  getCursorSubscriptionManager,
  listCursorSubscriptionManagers,
} from '../../src/main/chat/cursor-subscription/manager'
import {
  CURSOR_HARNESS_PROFILE,
  getCursorAgentBinding,
  putCursorAgentBinding,
} from '../../src/main/chat/cursor-subscription/session-store'
import { buildCursorHarnessContext, hashCursorHarnessEnvelope } from '../../src/main/chat/cursor-subscription/session'
import { hashCursorToolSignature } from '../../src/main/chat/cursor-subscription/tool-bridge'
import { builtinToolNamesForMode } from '../../src/main/chat/tools'
import { GENERATE_IMAGE_TOOL_NAME, generateImageToolEnabled } from '../../src/main/chat/image-gen'
import { getConvUiPrefs, patchConvUiPrefs } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

interface ManagerMock {
  getAccountIdentity: ReturnType<typeof vi.fn>
  accountId: string | null
  listModels: ReturnType<typeof vi.fn>
  resolveModelSelection: ReturnType<typeof vi.fn>
  onAuthUpdated: ReturnType<typeof vi.fn>
  getStatusSnapshot: ReturnType<typeof vi.fn>
}

const managerMocks = new Map<string, ManagerMock>()

function makeManagerMock(): ManagerMock {
  return {
    getAccountIdentity: vi.fn(() => ({ fingerprint: 'fp:1', epoch: 1 })),
    accountId: null,
    getStatusSnapshot: vi.fn(() => null),
    listModels: vi.fn(async () => [
      {
        id: 'composer-2.5',
        parameters: [{ id: 'fast', values: [{ value: 'true' }, { value: 'false' }] }],
      },
    ]),
    resolveModelSelection: vi.fn(async () => ({
      modelId: 'composer-2.5',
      params: [{ id: 'fast', value: 'false' }],
      note: 'standard',
    })),
    onAuthUpdated: vi.fn(() => vi.fn()),
  }
}

function getManagerMockFor(accountId: string | null): ManagerMock {
  const key = accountId ?? ''
  let mock = managerMocks.get(key)
  if (!mock) {
    mock = makeManagerMock()
    managerMocks.set(key, mock)
  }
  return mock
}

vi.mock('../../src/main/chat/cursor-subscription/manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/cursor-subscription/manager')>()
  return {
    ...actual,
    getCursorSubscriptionManager: vi.fn((accountId: string | null) => getManagerMockFor(accountId)),
    listCursorSubscriptionManagers: vi.fn(() => [...managerMocks.values()]),
  }
})

describe('Cursor context projection uses the runner resume boundary', () => {
  let cwd: string

  beforeEach(() => {
    freshDb()
    cwd = mkdtempSync(path.join(os.tmpdir(), 'maestrly-cursor-projection-'))
    managerMocks.clear()
    vi.mocked(getCursorSubscriptionManager).mockClear()
    vi.mocked(listCursorSubscriptionManagers).mockClear()
  })

  afterEach(() => {
    closeDb()
    rmSync(cwd, { recursive: true, force: true })
  })

  async function seedConversation(): Promise<{ conversationId: string; workspaceId: string }> {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd })
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5' },
    })
    upsertChatMessage({
      id: 'user-1',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'u1', text: 'pergunta' }],
      createdAt: Date.now(),
    } as never)
    upsertChatMessage({
      id: 'assistant-1',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'a1', text: 'resposta' }],
      model: { providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5' },
      createdAt: Date.now() + 1,
      usage: {
        usageVersion: 2,
        input: 5000,
        output: 800,
        contextInput: 5000,
        contextOutput: 800,
        modelContextWindow: 200_000,
      },
    } as never)
    return { conversationId: conversation.id, workspaceId: workspace.id }
  }

  async function seedBinding(conversationId: string, workspaceId: string): Promise<void> {
    const { envelope, skills, agents } = await buildCursorHarnessContext({
      projectId: workspaceId,
      cwd,
      conversationId,
      mode: 'agent',
      modelId: 'composer-2.5',
    })
    expect(envelope.instructions).toContain('# Durable project memory')
    expect(envelope.instructions).toContain('Search narrowly and read only the records needed')
    const names = new Set(builtinToolNamesForMode('agent'))
    if (await generateImageToolEnabled(conversationId, 'agent')) names.add(GENERATE_IMAGE_TOOL_NAME)
    if (skills.length) names.add('use_skill')
    if (agents.length) names.add('task')
    putCursorAgentBinding({
      conversationId,
      agentId: 'agent-1',
      modelId: 'composer-2.5',
      modelParams: [{ id: 'fast', value: 'false' }],
      cwd,
      harnessProfile: CURSOR_HARNESS_PROFILE,
      instructionHash: hashCursorHarnessEnvelope(envelope),
      toolSignature: hashCursorToolSignature([...names]),
      lastMessageId: 'assistant-1',
      accountFingerprint: 'fp:1',
      accountId: null,
      usageJson: '{}',
    })
  }

  async function historyStats(conversationId: string): Promise<ChatHistoryStats> {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerChatIpc({
      mhandle: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn)
      }) as unknown as Parameters<typeof registerChatIpc>[0]['mhandle'],
      mon: vi.fn(),
      emitStatus: vi.fn(),
    })
    const statsHandler = handlers.get('chat:history:stats') as (event: unknown, ...args: unknown[]) => unknown
    return (await statsHandler(null, conversationId)) as ChatHistoryStats
  }

  it('reuses runtime usage for a compatible binding', async () => {
    const { conversationId, workspaceId } = await seedConversation()
    await seedBinding(conversationId, workspaceId)
    const stats = await historyStats(conversationId)
    expect(stats.contextProjection?.source).toBe('runtime-usage')
    expect(stats.contextProjection?.quality).toBe('measured')
    expect(stats.contextProjection?.usedTokens).toBeGreaterThan(0)
    expect(stats.contextProjection?.modelContextWindow).toBe(200_000)
  })

  it('estimates current context when only child usage was reported after an older measurement', async () => {
    const { conversationId, workspaceId } = await seedConversation()
    await seedBinding(conversationId, workspaceId)
    upsertChatMessage({
      id: 'assistant-later',
      conversationId,
      role: 'assistant',
      parts: [{ type: 'text', id: 'later-text', text: 'Later report with no main usage.' }],
      model: { providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5' },
      createdAt: Date.now() + 2,
      usage: { usageVersion: 2, input: 0, output: 0, billingOnly: true, subInput: 100, subOutput: 10 },
    })
    putCursorAgentBinding({ ...getCursorAgentBinding(conversationId)!, lastMessageId: 'assistant-later' })
    const stats = await historyStats(conversationId)
    expect(stats.contextProjection?.quality).toBe('estimated')
    expect(stats.contextProjection?.usedTokens).toBe(
      estimateNativeSeedContextTokens(listConversationContextMessages(conversationId))
    )
  })

  it('estimates seed context when model parameters change', async () => {
    const { conversationId, workspaceId } = await seedConversation()
    await seedBinding(conversationId, workspaceId)
    getManagerMockFor(null).resolveModelSelection.mockResolvedValue({
      modelId: 'composer-2.5',
      params: [{ id: 'fast', value: 'true' }],
      note: 'fast',
    })
    const stats = await historyStats(conversationId)
    expect(stats.contextProjection?.source).toBe('portable-transcript')
    expect(stats.contextProjection?.quality).toBe('estimated')
  })

  it('estimates seed context when the harness changes', async () => {
    const { conversationId, workspaceId } = await seedConversation()
    await seedBinding(conversationId, workspaceId)
    expect((await historyStats(conversationId)).contextProjection?.source).toBe('runtime-usage')
    patchConvUiPrefs(conversationId, { chat: { ...getConvUiPrefs(conversationId).chat, reasoning: 'ultra' } })
    const stats = await historyStats(conversationId)
    expect(stats.contextProjection?.source).toBe('portable-transcript')
    expect(stats.contextProjection?.quality).toBe('estimated')
  })

  it('invalidates the binding when subagents are disabled', async () => {
    const { conversationId, workspaceId } = await seedConversation()
    await seedBinding(conversationId, workspaceId)
    const baseline = await buildCursorHarnessContext({
      projectId: workspaceId,
      cwd,
      conversationId,
      mode: 'agent',
      modelId: 'composer-2.5',
    })
    expect(baseline.agents.length).toBeGreaterThan(0)
    expect(baseline.envelope.agentCatalog).toContain('`task`')

    patchConvUiPrefs(conversationId, {
      chat: { ...getConvUiPrefs(conversationId).chat, subagentsEnabled: false },
    })
    const disabled = await buildCursorHarnessContext({
      projectId: workspaceId,
      cwd,
      conversationId,
      mode: 'agent',
      modelId: 'composer-2.5',
    })
    expect(disabled.agents).toEqual([])
    expect(disabled.envelope.agentCatalog).toBe('')

    const stats = await historyStats(conversationId)
    expect(stats.contextProjection?.source).toBe('portable-transcript')
    expect(stats.contextProjection?.quality).toBe('estimated')
  })

  it('excludes isolated review-loop turns from seed estimates', async () => {
    const { conversationId } = await seedConversation()
    const scope = (executionId: string, iteration: number) => ({
      kind: 'review-loop' as const,
      executionId,
      loopId: 'loop-1',
      iteration,
      maxIterations: 10,
    })
    upsertChatMessage({
      id: 'round-1-user',
      conversationId,
      role: 'user',
      parts: [{ type: 'text', id: 'r1u', text: 'findings round um '.repeat(200) }],
      internal: true,
      source: 'chatgpt-web-review-loop',
      executionScope: scope('exec-a', 1),
      createdAt: Date.now() + 10,
    } as never)
    upsertChatMessage({
      id: 'round-1-asst',
      conversationId,
      role: 'assistant',
      parts: [{ type: 'text', id: 'r1a', text: 'fix round um '.repeat(200) }],
      model: { providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5' },
      source: 'chatgpt-web-review-loop',
      executionScope: scope('exec-a', 1),
      createdAt: Date.now() + 11,
    } as never)
    upsertChatMessage({
      id: 'round-2-user',
      conversationId,
      role: 'user',
      parts: [{ type: 'text', id: 'r2u', text: 'findings round dois '.repeat(200) }],
      internal: true,
      source: 'chatgpt-web-review-loop',
      executionScope: scope('exec-b', 2),
      createdAt: Date.now() + 12,
    } as never)
    upsertChatMessage({
      id: 'round-2-asst',
      conversationId,
      role: 'assistant',
      parts: [{ type: 'text', id: 'r2a', text: 'fix round dois '.repeat(200) }],
      model: { providerId: 'builtin_cursor_subscription', modelId: 'composer-2.5' },
      source: 'chatgpt-web-review-loop',
      executionScope: scope('exec-b', 2),
      createdAt: Date.now() + 13,
    } as never)

    const stats = await historyStats(conversationId)
    expect(stats.contextProjection?.source).toBe('portable-transcript')
    expect(stats.contextProjection?.quality).toBe('estimated')
    const mainOnly = listConversationContextMessages(conversationId)
    expect(stats.contextProjection?.usedTokens).toBe(estimateNativeSeedContextTokens(mainOnly))
    expect(stats.contextProjection?.usedTokens).toBeLessThan(
      estimateNativeSeedContextTokens(listChatMessages(conversationId))
    )
  })
})
