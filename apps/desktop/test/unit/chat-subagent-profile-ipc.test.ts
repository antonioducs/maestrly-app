import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getAppSetting,
  getConvUiPrefs,
  insertConversation,
  insertWorkspace,
  setHiddenChatModels,
} from '../../src/main/store'
import { registerSubagentProfileIpc } from '../../src/main/chat/subagent-profile-ipc'
import { getProvider } from '../../src/main/chat/catalog'
import { hasApiKey } from '../../src/main/chat/credentials'
import { fetchModelsWithStatus } from '../../src/main/chat/models'
import { getSubagentProfileModelMeta } from '../../src/main/chat/subagent-profile-model-meta'
import { SUBAGENT_PROFILES_SETTING_KEY } from '../../src/main/chat/subagent-profile-config'
import { getClaudeSubscriptionManager } from '../../src/main/chat/claude-agent-sdk/manager'
import { getCodexSubscriptionManager } from '../../src/main/chat/codex-subscription/manager'
import { getGitHubCopilotSubscriptionManager } from '../../src/main/chat/github-copilot/manager'
import { closeDb, freshDb } from '../helpers/db'

vi.mock('../../src/main/chat/catalog', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/catalog')>()
  return { ...original, getProvider: vi.fn(original.getProvider) }
})
vi.mock('../../src/main/chat/credentials', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/credentials')>()
  return { ...original, hasApiKey: vi.fn(original.hasApiKey) }
})
vi.mock('../../src/main/chat/models', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/models')>()
  return { ...original, fetchModelsWithStatus: vi.fn(original.fetchModelsWithStatus) }
})
vi.mock('../../src/main/chat/subagent-profile-model-meta', () => ({ getSubagentProfileModelMeta: vi.fn() }))
vi.mock('../../src/main/chat/github-copilot/manager', () => ({
  getGitHubCopilotSubscriptionManager: vi.fn(),
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  getClaudeSubscriptionManager: vi.fn(),
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: vi.fn(),
}))

const getProviderMock = vi.mocked(getProvider)
const hasApiKeyMock = vi.mocked(hasApiKey)
const fetchModelsWithStatusMock = vi.mocked(fetchModelsWithStatus)
const getSubagentProfileModelMetaMock = vi.mocked(getSubagentProfileModelMeta)
const getClaudeSubscriptionManagerMock = vi.mocked(getClaudeSubscriptionManager)
const getCodexSubscriptionManagerMock = vi.mocked(getCodexSubscriptionManager)
const getGitHubCopilotSubscriptionManagerMock = vi.mocked(getGitHubCopilotSubscriptionManager)

type Handler = (event: never, ...args: any[]) => unknown
let handlers: Map<string, Handler>
const rules = { version: 1 as const, default: [{ providerId: 'removed', modelId: 'manual', effort: 'high' }] }

beforeEach(() => {
  getProviderMock.mockReset()
  hasApiKeyMock.mockReset()
  fetchModelsWithStatusMock.mockReset()
  getSubagentProfileModelMetaMock.mockReset()
  getCodexSubscriptionManagerMock.mockReset()
  getSubagentProfileModelMetaMock.mockResolvedValue({ status: 'unavailable', meta: null })
  getClaudeSubscriptionManagerMock.mockReturnValue({
    status: vi.fn(async () => ({ authenticated: false })),
    listModels: vi.fn(async () => []),
  } as unknown as ReturnType<typeof getClaudeSubscriptionManager>)
  getCodexSubscriptionManagerMock.mockReturnValue({
    getStatus: vi.fn(async () => ({ authenticated: false })),
    listModels: vi.fn(async () => []),
  } as unknown as ReturnType<typeof getCodexSubscriptionManager>)
  getGitHubCopilotSubscriptionManagerMock.mockReturnValue({
    getStatus: vi.fn(async () => ({ authenticated: false, connected: false })),
    listModels: vi.fn(async () => []),
  } as unknown as ReturnType<typeof getGitHubCopilotSubscriptionManager>)
  freshDb()
  handlers = new Map()
  registerSubagentProfileIpc({ mhandle: (channel, fn) => void handlers.set(channel, fn as Handler) })
})
afterEach(closeDb)

describe('subagent profile IPC', () => {
  it('registers nine channels and rejects invalid persistence', async () => {
    expect([...handlers.keys()].sort()).toEqual([
      'chat:subagent-profiles:catalog',
      'chat:subagent-profiles:get-conversation',
      'chat:subagent-profiles:get-global',
      'chat:subagent-profiles:model-catalog',
      'chat:subagent-profiles:model-meta',
      'chat:subagent-profiles:set-conversation',
      'chat:subagent-profiles:set-conversation-enabled',
      'chat:subagent-profiles:set-global',
      'chat:subagents:set-conversation-enabled',
    ])
    const result = (await handlers.get('chat:subagent-profiles:set-global')!({} as never, {
      version: 1,
      default: [{ providerId: 'p' }],
    })) as { ok: boolean }
    expect(result.ok).toBe(false)
    expect(getAppSetting(SUBAGENT_PROFILES_SETTING_KEY)).toBeNull()
    for (const effort of ['off', 'maestrly-ultra']) {
      const pseudo = (await handlers.get('chat:subagent-profiles:set-global')!({} as never, {
        version: 1,
        default: [{ providerId: 'p', modelId: 'm', effort }],
      })) as { ok: boolean }
      expect(pseudo.ok).toBe(false)
    }
    await expect(handlers.get('chat:subagent-profiles:model-meta')!({} as never, '', 'model')).resolves.toEqual({
      status: 'unavailable',
      meta: null,
    })
    await expect(handlers.get('chat:subagent-profiles:model-catalog')!({} as never, '')).resolves.toEqual({
      status: 'unavailable',
      models: [],
    })
    await expect(
      handlers.get('chat:subagent-profiles:model-catalog')!({} as never, 'builtin_claude_subscription')
    ).resolves.toEqual({
      status: 'unavailable',
      models: [],
    })
  })

  it('toggles effective state without deleting conversation overrides', async () => {
    insertWorkspace({ id: 'w', path: '/tmp/w', name: 'W', defaultBranch: 'main', addedAt: 1 })
    insertConversation({
      id: 'c',
      workspaceId: 'w',
      name: 'C',
      branch: 'main',
      mode: 'local',
      experience: 'standard',
      cwd: '/tmp/w',
      status: 'idle',
      createdAt: 1,
      archived: 0,
      pinnedAt: null,
      lastActivityAt: 1,
      isMulti: 0,
    })
    await expect(handlers.get('chat:subagent-profiles:get-conversation')!({} as never, 'c')).resolves.toMatchObject({
      enabled: true,
      subagentsEnabled: true,
      rules: null,
    })
    const saved = (await handlers.get('chat:subagent-profiles:set-conversation')!({} as never, 'c', rules)) as any
    expect(saved.ok).toBe(true)

    const disabled = (await handlers.get('chat:subagent-profiles:set-conversation-enabled')!(
      {} as never,
      'c',
      false
    )) as any
    expect(disabled).toMatchObject({ ok: true, value: { enabled: false, rules } })
    expect(getConvUiPrefs('c').chat?.subagentProfiles).toEqual(rules)

    const enabled = (await handlers.get('chat:subagent-profiles:set-conversation-enabled')!(
      {} as never,
      'c',
      true
    )) as any
    expect(enabled).toMatchObject({ ok: true, value: { enabled: true, rules } })

    const subagentsDisabled = (await handlers.get('chat:subagents:set-conversation-enabled')!(
      {} as never,
      'c',
      false
    )) as any
    expect(subagentsDisabled).toMatchObject({ ok: true, value: { subagentsEnabled: false, rules } })
    await expect(handlers.get('chat:subagent-profiles:catalog')!({} as never, 'c')).resolves.toEqual({
      agents: [],
      categories: [],
    })
    expect(getConvUiPrefs('c').chat?.subagentsEnabled).toBe(false)
  })

  it('rejects disconnected Codex with specific diagnostics', async () => {
    getProviderMock.mockReturnValue({
      id: 'builtin_codex_subscription',
      name: 'Codex',
      baseURL: 'codex://chatgpt-subscription',
      kind: 'codex-subscription',
      builtin: 'codex-subscription',
    })
    const result = (await handlers.get('chat:subagent-profiles:set-global')!({} as never, {
      version: 1,
      default: [{ providerId: 'builtin_codex_subscription', modelId: 'gpt-5.6', effort: 'high' }],
    })) as { ok: boolean; errors?: Array<{ code: string }> }

    expect(result).toMatchObject({ ok: false, errors: [{ code: 'provider-disconnected' }] })
    expect(fetchModelsWithStatusMock).not.toHaveBeenCalled()
    expect(getSubagentProfileModelMetaMock).not.toHaveBeenCalled()
    expect(getAppSetting(SUBAGENT_PROFILES_SETTING_KEY)).toBeNull()
  })

  it('rejects disconnected Copilot with specific diagnostics', async () => {
    getProviderMock.mockReturnValue({
      id: 'builtin_github_copilot_subscription',
      name: 'Copilot',
      baseURL: 'copilot://github-subscription',
      kind: 'github-copilot-subscription',
      builtin: 'github-copilot-subscription',
    })
    const result = (await handlers.get('chat:subagent-profiles:set-global')!({} as never, {
      version: 1,
      default: [{ providerId: 'builtin_github_copilot_subscription', modelId: 'gpt-5', effort: 'high' }],
    })) as { ok: boolean; errors?: Array<{ code: string }> }

    expect(result).toMatchObject({ ok: false, errors: [{ code: 'provider-disconnected' }] })
  })

  it('accepts connected Copilot using official metadata', async () => {
    getProviderMock.mockReturnValue({
      id: 'builtin_github_copilot_subscription',
      name: 'Copilot',
      baseURL: 'copilot://github-subscription',
      kind: 'github-copilot-subscription',
      builtin: 'github-copilot-subscription',
    })
    getGitHubCopilotSubscriptionManagerMock.mockReturnValue({
      getStatus: vi.fn(async () => ({ authenticated: true, connected: true })),
      listModels: vi.fn(async () => [
        {
          id: 'gpt-5',
          policy: { state: 'enabled' },
          capabilities: {
            supports: { vision: false, reasoningEffort: true },
            limits: { max_context_window_tokens: 128_000 },
          },
          supportedReasoningEfforts: ['high'],
        },
      ]),
    } as unknown as ReturnType<typeof getGitHubCopilotSubscriptionManager>)
    getSubagentProfileModelMetaMock.mockResolvedValue({
      status: 'available',
      meta: { reasoning: true, reasoningEfforts: ['high'] },
    })

    const result = (await handlers.get('chat:subagent-profiles:set-global')!({} as never, {
      version: 1,
      default: [{ providerId: 'builtin_github_copilot_subscription', modelId: 'gpt-5', effort: 'high' }],
    })) as { ok: boolean }

    expect(result.ok).toBe(true)
  })

  it('rejects unadvertised manual Fable aliases', async () => {
    getProviderMock.mockReturnValue({
      id: 'builtin_claude_subscription',
      name: 'Claude',
      baseURL: 'claude://subscription',
      kind: 'claude-subscription',
      builtin: 'claude-subscription',
    })
    getClaudeSubscriptionManagerMock.mockReturnValue({
      status: vi.fn(async () => ({ authenticated: true })),
      listModels: vi.fn(async () => {
        throw new Error('catalog failed')
      }),
    } as unknown as ReturnType<typeof getClaudeSubscriptionManager>)
    await expect(
      handlers.get('chat:subagent-profiles:model-catalog')!({} as never, 'builtin_claude_subscription')
    ).resolves.toEqual({
      status: 'unavailable',
      models: [],
    })

    getClaudeSubscriptionManagerMock.mockReturnValue({
      status: vi.fn(async () => ({ authenticated: true })),
      listModels: vi.fn(async () => [
        { value: 'default', resolvedModel: 'claude-opus-5[1m]' },
        { value: 'opus[1m]' },
        { value: 'sonnet' },
        { value: 'haiku' },
      ]),
    } as unknown as ReturnType<typeof getClaudeSubscriptionManager>)
    await expect(
      handlers.get('chat:subagent-profiles:model-catalog')!({} as never, 'builtin_claude_subscription')
    ).resolves.toMatchObject({
      status: 'available',
      models: ['default', 'opus[1m]', 'sonnet', 'haiku'],
    })

    for (const modelId of ['fable', 'fable[1m]', 'claude-fable-5']) {
      const result = (await handlers.get('chat:subagent-profiles:set-global')!({} as never, {
        version: 1,
        default: [{ providerId: 'builtin_claude_subscription', modelId, effort: 'high' }],
      })) as { ok: boolean; errors?: Array<{ code: string }> }

      expect(result).toMatchObject({ ok: false, errors: [{ code: 'model-unavailable' }] })
      expect(getAppSetting(SUBAGENT_PROFILES_SETTING_KEY)).toBeNull()
    }
    expect(getSubagentProfileModelMetaMock).not.toHaveBeenCalled()
  })

  it('applies hidden models without duplicating physical Codex IDs', async () => {
    getCodexSubscriptionManagerMock.mockReturnValue({
      getStatus: vi.fn(async () => ({ authenticated: true })),
      listModels: vi.fn(async () => [
        {
          id: 'gpt-5.6-sol',
          model: 'gpt-5.6-codex',
          hidden: false,
          inputModalities: ['text'],
        },
        {
          id: 'gpt-5.6-terra',
          model: 'gpt-5.6-codex',
          hidden: false,
          inputModalities: ['text'],
        },
        {
          id: 'gpt-5.5',
          model: 'gpt-5.5-codex',
          hidden: false,
          inputModalities: ['text'],
        },
      ]),
    } as unknown as ReturnType<typeof getCodexSubscriptionManager>)
    setHiddenChatModels('builtin_codex_subscription', ['gpt-5.5'])

    await expect(
      handlers.get('chat:subagent-profiles:model-catalog')!({} as never, 'builtin_codex_subscription')
    ).resolves.toEqual({
      status: 'available',
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    })
  })

  it('hides Claude aliases without exposing resolved IDs', async () => {
    getClaudeSubscriptionManagerMock.mockReturnValue({
      status: vi.fn(async () => ({ authenticated: true })),
      listModels: vi.fn(async () => [
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
        { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
        { value: 'opus', resolvedModel: 'claude-opus-5' },
      ]),
    } as unknown as ReturnType<typeof getClaudeSubscriptionManager>)
    setHiddenChatModels('builtin_claude_subscription', ['haiku'])

    await expect(
      handlers.get('chat:subagent-profiles:model-catalog')!({} as never, 'builtin_claude_subscription')
    ).resolves.toEqual({ status: 'available', models: ['sonnet', 'opus'] })
  })

  it('rejects authoritative effort incompatibility before persistence', async () => {
    getProviderMock.mockReturnValue({ id: 'provider', name: 'Provider', baseURL: 'https://api.openai.com/v1' })
    hasApiKeyMock.mockReturnValue(true)
    fetchModelsWithStatusMock.mockResolvedValue({ status: 'available', models: ['model'] })

    for (const meta of [
      { status: 'available' as const, meta: { reasoning: false } },
      { status: 'available' as const, meta: { reasoning: true, reasoningEfforts: ['low'] } },
    ]) {
      getSubagentProfileModelMetaMock.mockResolvedValue(meta)
      const result = (await handlers.get('chat:subagent-profiles:set-global')!({} as never, {
        version: 1,
        default: [{ providerId: 'provider', modelId: 'model', effort: 'high' }],
      })) as { ok: boolean; errors?: Array<{ code: string }> }
      expect(result).toMatchObject({ ok: false, errors: [{ code: 'invalid-effort' }] })
      expect(getAppSetting(SUBAGENT_PROFILES_SETTING_KEY)).toBeNull()
    }
  })

  it('allows supported Fast, rejects known incompatibility and warns on unknown capability', async () => {
    getProviderMock.mockReturnValue({ id: 'provider', name: 'Provider', baseURL: 'https://api.openai.com/v1' })
    hasApiKeyMock.mockReturnValue(true)
    fetchModelsWithStatusMock.mockResolvedValue({ status: 'available', models: ['model'] })
    const fastRules = {
      version: 1 as const,
      default: [{ providerId: 'provider', modelId: 'model', effort: 'high', fastMode: true }],
    }

    getSubagentProfileModelMetaMock.mockResolvedValue({
      status: 'available',
      meta: { reasoning: true, reasoningEfforts: ['high'], fastModeCapability: true },
    })
    await expect(handlers.get('chat:subagent-profiles:set-global')!({} as never, fastRules)).resolves.toMatchObject({
      ok: true,
      value: { rules: fastRules },
    })

    getSubagentProfileModelMetaMock.mockResolvedValue({
      status: 'available',
      meta: { reasoning: true, reasoningEfforts: ['high'], fastModeCapability: false },
    })
    await expect(handlers.get('chat:subagent-profiles:set-global')!({} as never, fastRules)).resolves.toMatchObject({
      ok: false,
      errors: [{ code: 'fast-mode-unsupported', severity: 'error' }],
    })

    getSubagentProfileModelMetaMock.mockResolvedValue({ status: 'unavailable', meta: null })
    const unverified = (await handlers.get('chat:subagent-profiles:set-global')!({} as never, fastRules)) as any
    expect(unverified.ok).toBe(true)
    expect(unverified.value.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'fast-mode-unverified', severity: 'warning' })])
    )
  })

  it('validates canonical metadata for orphaned or keyless providers', async () => {
    getSubagentProfileModelMetaMock.mockResolvedValue({
      status: 'available',
      meta: { reasoning: true, reasoningEfforts: ['low'] },
    })

    for (const provider of [undefined, { id: 'removed', name: 'Removed', baseURL: 'https://api.openai.com/v1' }]) {
      getProviderMock.mockReturnValue(provider)
      hasApiKeyMock.mockReturnValue(false)
      fetchModelsWithStatusMock.mockResolvedValue({ status: 'available', models: ['manual'] })
      const result = (await handlers.get('chat:subagent-profiles:set-global')!({} as never, rules)) as {
        ok: boolean
        errors?: Array<{ code: string }>
      }
      expect(result).toMatchObject({ ok: false, errors: [{ code: 'invalid-effort' }] })
      expect(getAppSetting(SUBAGENT_PROFILES_SETTING_KEY)).toBeNull()
    }
  })

  it('preserves orphaned references with inline warnings', async () => {
    getSubagentProfileModelMetaMock.mockResolvedValue({ status: 'unavailable', meta: null })
    const saved = (await handlers.get('chat:subagent-profiles:set-global')!({} as never, rules)) as any
    expect(saved.ok).toBe(true)
    expect(saved.value.rules).toEqual(rules)
    expect(saved.value.diagnostics).toMatchObject([{ code: 'provider-missing' }, { code: 'effort-unverified' }])
  })

  it('sanitizes catalog prompts and preserves neighboring preferences', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'subagent-ipc-'))
    mkdirSync(path.join(cwd, '.claude/agents'), { recursive: true })
    writeFileSync(
      path.join(cwd, '.claude/agents/reviewer.md'),
      '---\ndescription: Review\ncategory: Code Review\ntools: bash\n---\nSECRET PROMPT'
    )
    insertWorkspace({ id: 'w', path: cwd, name: 'W', defaultBranch: 'main', addedAt: 1 })
    insertConversation({
      id: 'c',
      workspaceId: 'w',
      name: 'C',
      branch: 'main',
      mode: 'local',
      experience: 'standard',
      cwd,
      status: 'idle',
      createdAt: 1,
      archived: 0,
      pinnedAt: null,
      lastActivityAt: 1,
      isMulti: 0,
      uiPrefs: { chat: { providerId: 'parent', modelId: 'model', reasoning: 'ultra' } },
    })
    try {
      const catalog = (await handlers.get('chat:subagent-profiles:catalog')!({} as never, 'c')) as any
      expect(catalog.categories).toContain('code-review')
      const reviewer = catalog.agents.find((agent: { name: string }) => agent.name === 'reviewer')
      expect(reviewer).toEqual({
        name: 'reviewer',
        description: 'Review',
        category: 'code-review',
        source: '.claude/agents/reviewer.md',
      })
      expect(JSON.stringify(catalog)).not.toContain('SECRET PROMPT')
      expect(JSON.stringify(catalog)).not.toContain('bash')

      const saved = (await handlers.get('chat:subagent-profiles:set-conversation')!({} as never, 'c', rules)) as any
      expect(saved.ok).toBe(true)
      expect(getConvUiPrefs('c').chat).toMatchObject({ providerId: 'parent', modelId: 'model', reasoning: 'ultra' })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
