import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAgent } from '../../src/main/chat/agents'
import {
  setConversationSubagentProfileRules,
  setConversationSubagentProfilesEnabled,
  setConversationSubagentsEnabled,
  setGlobalSubagentProfileRules,
} from '../../src/main/chat/subagent-profile-config'
import {
  resolveParentSubagentExecutionProfile,
  resolveSubagentExecutionProfile,
} from '../../src/main/chat/subagent-execution-profile'
import { insertConversation, insertWorkspace } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'

vi.mock('../../src/main/chat/subagent-provider-runtime', () => ({
  subagentProviderStatus: vi.fn(async () => 'available'),
  subagentModelCatalog: vi.fn(async () => ({
    status: 'available',
    models: ['parent-model', 'conversation-model', 'global-model', 'frontmatter-model', 'gpt-5.6-luna', 'opus[1m]'],
  })),
}))
vi.mock('../../src/main/chat/subagent-profile-model-meta', () => ({
  getSubagentProfileModelMeta: vi.fn(async () => ({
    status: 'available',
    meta: { reasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
  })),
}))

const candidate = (modelId: string, effort = 'high') => ({ providerId: 'provider', modelId, effort })

beforeEach(() => {
  freshDb()
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
})
afterEach(closeDb)

describe('subagent execution profile conversation switch', () => {
  it('validates only the parent selection without applying the general-purpose override', async () => {
    const agent: ChatAgent = {
      name: 'general-purpose',
      description: 'General worker',
      prompt: 'Complete the delegated task.',
      source: 'test',
    }
    expect(
      setConversationSubagentProfileRules('c', {
        version: 1,
        default: [{ providerId: 'configured-provider', modelId: 'conversation-model', effort: 'low' }],
      }).ok
    ).toBe(true)

    const resolved = await resolveParentSubagentExecutionProfile({
      agent,
      parentFastMode: true,
      parent: {
        providerId: 'provider',
        modelId: 'parent-model',
        effort: 'high',
      },
    })

    expect(resolved.effective).toMatchObject({
      source: 'parent',
      providerId: 'provider',
      modelId: 'parent-model',
      configuredEffort: 'high',
      sentEffort: 'high',
      fastMode: true,
    })
  })

  it('selects a conversation Codex default independently from a Claude parent', async () => {
    const rules = {
      version: 1 as const,
      default: [
        {
          providerId: 'builtin_codex_subscription',
          modelId: 'gpt-5.6-luna',
          effort: 'medium',
        },
      ],
    }
    const agent: ChatAgent = {
      name: 'general-purpose',
      description: 'General worker',
      prompt: 'Complete the delegated task.',
      source: 'test',
    }
    expect(setConversationSubagentProfileRules('c', rules).ok).toBe(true)

    const resolved = await resolveSubagentExecutionProfile({
      agentName: 'general-purpose',
      agents: [agent],
      conversationId: 'c',
      parentFastMode: true,
      parent: {
        providerId: 'builtin_claude_subscription',
        modelId: 'opus[1m]',
        effort: 'xhigh',
      },
    })

    expect(resolved.profile.effective).toMatchObject({
      source: 'conversation-default',
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-luna',
      configuredEffort: 'medium',
      sentEffort: 'medium',
      fastMode: false,
    })
  })

  it('disabling bypasses all deterministic layers and preserves rules for reactivation', async () => {
    const globalRules = { version: 1 as const, default: [candidate('global-model')] }
    const conversationRules = { version: 1 as const, default: [candidate('conversation-model')] }
    const agent: ChatAgent = {
      name: 'reviewer',
      description: 'Review',
      prompt: 'Review carefully.',
      source: 'test',
      profile: candidate('frontmatter-model'),
    }
    expect(setGlobalSubagentProfileRules(globalRules).ok).toBe(true)
    expect(setConversationSubagentProfileRules('c', conversationRules).ok).toBe(true)
    expect(setConversationSubagentProfilesEnabled('c', false).ok).toBe(true)

    const disabled = await resolveSubagentExecutionProfile({
      agentName: 'reviewer',
      agents: [agent],
      conversationId: 'c',
      parentFastMode: true,
      parent: { providerId: 'provider', modelId: 'parent-model', effort: 'low' },
    })
    expect(disabled.profile.effective).toMatchObject({
      source: 'parent',
      providerId: 'provider',
      modelId: 'parent-model',
      configuredEffort: 'low',
      fastMode: true,
    })
    expect(disabled.profile.attempts).toHaveLength(1)

    expect(setConversationSubagentProfilesEnabled('c', true).ok).toBe(true)
    const reenabled = await resolveSubagentExecutionProfile({
      agentName: 'reviewer',
      agents: [agent],
      conversationId: 'c',
      parentFastMode: true,
      parent: { providerId: 'provider', modelId: 'parent-model', effort: 'low' },
    })
    expect(reenabled.profile.effective).toMatchObject({ source: 'conversation-default', modelId: 'conversation-model' })
  })

  it('blocks a prepared delegation if subagents are disabled before execution', async () => {
    const agent: ChatAgent = {
      name: 'reviewer',
      description: 'Review',
      prompt: 'Review carefully.',
      source: 'test',
    }
    expect(setConversationSubagentsEnabled('c', false).ok).toBe(true)

    const disabled = await resolveSubagentExecutionProfile({
      agentName: 'reviewer',
      agents: [agent],
      conversationId: 'c',
      parent: { providerId: 'provider', modelId: 'parent-model', effort: 'low' },
    })

    expect(disabled.definition).toBeNull()
    expect(disabled.profile.effective).toBeNull()
    expect(disabled.profile.attempts).toEqual([])
  })
})
