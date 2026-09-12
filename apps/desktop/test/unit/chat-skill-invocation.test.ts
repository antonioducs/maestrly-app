import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * User slash invocation is recognized at message start and
 * persisted as an expanded skill-invocation part with instructions, root and inventory.
 * The UI shows only the chip; body text remains separate. Mocks match plan revision tests.
 */

const h = vi.hoisted(() => ({
  getMainWebContents: vi.fn(),
  getConversation: vi.fn(),
  getConvUiPrefs: vi.fn(),
  getAppFlag: vi.fn(),
  getAppSetting: vi.fn(),
  updateConversationStatus: vi.fn(),
  upsertChatMessage: vi.fn(),
  listChatMessages: vi.fn(() => []),

  listConversationContextMessages: vi.fn(() => []),
  runChat: vi.fn(),
}))

vi.mock('../../src/main/window-ipc', () => ({ getMainWebContents: h.getMainWebContents }))

vi.mock('../../src/main/store', () => ({
  getConversation: h.getConversation,
  getConvUiPrefs: h.getConvUiPrefs,
  getAppFlag: h.getAppFlag,
  getAppSetting: h.getAppSetting,
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(() => undefined), all: vi.fn(() => []), run: vi.fn() })),
  })),
  getLocale: vi.fn(() => 'pt-BR'),
  updateConversationStatus: h.updateConversationStatus,
  patchConvUiPrefs: vi.fn(),
  setAppFlag: vi.fn(),
  setAppSetting: vi.fn(),
}))

vi.mock('../../src/main/chat/catalog', () => ({
  PROVIDER_PRESETS: [],
  CODEX_SUBSCRIPTION_PROVIDER_ID: 'builtin_codex_subscription',
  getProvider: vi.fn(() => ({ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' })),
  getProviderKind: vi.fn(() => 'openai'),
  isClaudeSubscriptionProvider: vi.fn(() => false),
  isGrokSubscriptionProvider: vi.fn(() => false),
  isCodexSubscriptionProvider: vi.fn(() => false),
  isGitHubCopilotSubscriptionProvider: vi.fn(() => false),
  isSubscriptionProvider: vi.fn(() => false),
  isChatGptWebProvider: vi.fn(() => false),
  subscriptionAccountId: vi.fn(() => null),
  subscriptionProviderIdFor: vi.fn(() => 'builtin'),
  getSubscriptionAccount: vi.fn(() => undefined),
  addSubscriptionAccount: vi.fn(),
  renameSubscriptionAccount: vi.fn(),
  removeSubscriptionAccount: vi.fn(),
  listAvailableChatProviders: vi.fn(() => [{ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' }]),
  listProviders: vi.fn(() => [{ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' }]),
}))

vi.mock('../../src/main/chat/credentials', () => ({
  apiKeyStorageMode: vi.fn(() => 'secure'),
  hasApiKey: vi.fn(() => true),
}))

vi.mock('../../src/main/chat/chat-store', () => ({
  getChatMessage: vi.fn(() => null),
  chatHistoryStats: vi.fn(() => ({ lastUsage: null })),
  listChatMessages: h.listChatMessages,

  listConversationContextMessages: h.listConversationContextMessages,
  upsertChatMessage: h.upsertChatMessage,
}))

vi.mock('../../src/main/chat/runner', () => ({
  normalizeAiUsage: vi.fn(() => ({ input: 0, output: 0, totalInput: 0, cacheRead: 0, cacheCreate: 0 })),
  runChat: h.runChat,
}))

vi.mock('../../src/main/chat/models', () => ({
  fetchModels: vi.fn(() => Promise.resolve(['model-1'])),
  fetchModelWindow: vi.fn(() => Promise.resolve(undefined)),
  invalidateModels: vi.fn(),
}))

vi.mock('../../src/main/chat/context-limits', () => ({
  getContextLimit: vi.fn(() => undefined),
  setContextLimit: vi.fn(),
  resolveContextWindow: vi.fn(() => undefined),
}))

vi.mock('../../src/main/chat/model-meta', () => ({
  catalogProviderForBaseURL: vi.fn(() => null),
  composeEffectiveMeta: vi.fn(() => null),
  getModelMeta: vi.fn(() => Promise.resolve(null)),
  getProviderModelMeta: vi.fn(() => Promise.resolve(null)),
  filterChatModels: vi.fn((models: string[]) => models),
}))

vi.mock('../../src/main/chat/provider', () => ({
  ChatConfigError: class ChatConfigError extends Error {},
  invalidateProvider: vi.fn(),
  resolveChatHarnessMetadata: vi.fn(() => ({ harnessProfile: 'legacy', capabilities: {} })),
  resolveLanguageModel: vi.fn(),
}))

vi.mock('../../src/main/chat/mcp', () => ({ listMcpServers: vi.fn(() => []) }))

import { registerChatIpc } from '../../src/main/chat/service'
import { __resetCwdActivityForTests } from '../../src/main/cwd-activity-coordinator'
import type { MessagePart } from '../../src/shared/chat'

const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() }

let cwd = ''

function handlersOf(): Map<string, (...args: any[]) => unknown> {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  registerChatIpc({ mhandle: (channel, fn) => void handlers.set(channel, fn), mon: vi.fn(), emitStatus: vi.fn() })
  return handlers
}

function userParts(): MessagePart[] {
  const call = h.upsertChatMessage.mock.calls.find(([message]) => (message as { role: string }).role === 'user') as
    | [{ parts: MessagePart[] }]
    | undefined
  return call?.[0].parts ?? []
}

const mkSkill = (folder: string, content: string) => {
  mkdirSync(path.join(cwd, '.agents/skills', folder), { recursive: true })
  writeFileSync(path.join(cwd, '.agents/skills', folder, 'SKILL.md'), content)
}

describe('chat:send skill invocation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetCwdActivityForTests()
    cwd = mkdtempSync(path.join(os.tmpdir(), 'skill-invocation-'))
    h.getMainWebContents.mockReturnValue(wc)
    h.getConversation.mockReturnValue({ id: 'conv-chat', cli: 'chat', cwd, workspaceId: 'workspace-1' })
    h.getConvUiPrefs.mockReturnValue({ chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent' } })
    h.getAppFlag.mockImplementation((_key: string, fallback: boolean) => fallback)
    h.getAppSetting.mockReturnValue(null)
    h.runChat.mockResolvedValue({ planSubmitted: false })
  })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  it('expands skill parts without duplicate arguments', async () => {
    mkSkill('deploy', '---\nname: deploy\ndescription: deploys to production\n---\nRun the checklist.')
    mkdirSync(path.join(cwd, '.agents/skills/deploy/scripts'), { recursive: true })
    writeFileSync(path.join(cwd, '.agents/skills/deploy/scripts/run.sh'), 'echo ok')

    const result = await handlersOf().get('chat:send')?.(
      { sender: wc },
      { conversationId: 'conv-chat', text: '/deploy prod' }
    )
    expect(result).toEqual({ ok: true })

    const parts = userParts()
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: 'skill-invocation', name: 'deploy', args: 'prod' })
    const body = (parts[0] as Extract<MessagePart, { type: 'skill-invocation' }>).body
    expect(body).toContain('Run the checklist.')
    expect(body).toContain(path.join(cwd, '.agents/skills/deploy')) // root p/ resolver scripts/references
    expect(body).toContain('scripts/run.sh')
    expect(body).toContain('User arguments: prod')
  })

  it('treats globally disabled skill invocations as plain text', async () => {
    mkSkill('deploy', '---\nname: deploy\n---\nRun the checklist.')
    h.getAppSetting.mockImplementation((key: string) => (key === 'chat.skills.disabled' ? '["deploy"]' : null))

    await handlersOf().get('chat:send')?.({ sender: wc }, { conversationId: 'conv-chat', text: '/deploy prod' })

    const parts = userParts()
    expect(parts).toEqual([expect.objectContaining({ type: 'text', text: '/deploy prod' })])
  })

  it('excludes non-user-invocable skills from slash invocation', async () => {
    mkSkill('internal', '---\nname: internal\nuser-invocable: false\n---\nOnly the model uses this.')

    await handlersOf().get('chat:send')?.({ sender: wc }, { conversationId: 'conv-chat', text: '/internal now' })

    expect(userParts()).toEqual([expect.objectContaining({ type: 'text', text: '/internal now' })])
  })

  it('lists skill metadata without bodies in the slash palette', async () => {
    mkSkill('deploy', '---\nname: deploy\ndescription: deploys\nargument-hint: "[env]"\n---\nRun the checklist.')

    const commands = (await handlersOf().get('chat:commands')?.({}, 'conv-chat')) as {
      skills: Record<string, unknown>[]
    }
    // Real global skills may also exist; assert only the project fixture.
    expect(commands.skills.find((skill) => skill.name === 'deploy')).toEqual({
      name: 'deploy',
      description: 'deploys',
      argumentHint: '[env]',
      source: '.agents/skills/deploy/SKILL.md',
    })
    expect(commands.skills.some((skill) => 'content' in skill)).toBe(false)
  })

  it('respects active conversation skill groups in palette and invocation', async () => {
    mkSkill('go-style', '---\nname: go-style\ndescription: Go\n---\nGo rules.')
    mkSkill('react', '---\nname: react\ndescription: React\n---\nReact rules.')
    h.getConvUiPrefs.mockReturnValue({
      chat: {
        providerId: 'provider-1',
        modelId: 'model-1',
        mode: 'agent',
        skillSelection: { kind: 'group', groupId: 'go-backend' },
      },
    })
    h.getAppSetting.mockImplementation((key: string) =>
      key === 'chat.skills.groups.v1'
        ? JSON.stringify([{ id: 'go-backend', name: 'Golang Backend', skills: ['go-style'] }])
        : null
    )

    const commands = (await handlersOf().get('chat:commands')?.({}, 'conv-chat')) as {
      skills: Array<{ name: string }>
    }
    expect(commands.skills.some((skill) => skill.name === 'go-style')).toBe(true)
    expect(commands.skills.some((skill) => skill.name === 'react')).toBe(false)

    await handlersOf().get('chat:send')?.({ sender: wc }, { conversationId: 'conv-chat', text: '/react now' })
    expect(userParts()).toEqual([expect.objectContaining({ type: 'text', text: '/react now' })])
  })
})
