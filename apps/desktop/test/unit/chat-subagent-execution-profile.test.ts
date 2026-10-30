import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAgent } from '../../src/main/chat/agents'
import { addSubscriptionAccount, subscriptionProviderIdFor } from '../../src/main/chat/catalog'
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
import { setAccountPool } from '../../src/main/chat/subscription-failover/account-pool'
import { insertConversation, insertWorkspace, patchConvUiPrefs } from '../../src/main/store'
import { activeAccountProviderId } from '../../src/shared/chat'
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
    scope: 'project',
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
  it('selects a conversation Cursor default independently from a Codex parent', async () => {
    const rules = {
      version: 1 as const,
      default: [
        {
          providerId: 'builtin_cursor_subscription',
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
        providerId: 'builtin_codex_subscription',
        modelId: 'opus[1m]',
        effort: 'xhigh',
      },
    })

    expect(resolved.profile.effective).toMatchObject({
      source: 'conversation-default',
      providerId: 'builtin_cursor_subscription',
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

describe('subagent execution profile under an active-account selection', () => {
  const agent: ChatAgent = {
    name: 'general-purpose',
    description: 'General worker',
    prompt: 'Complete the delegated task.',
    source: 'test',
  }
  const VIRTUAL = activeAccountProviderId('codex-subscription')

  function setup(): { workId: string; otherId: string } {
    const work = addSubscriptionAccount('codex-subscription', 'Work')
    const other = addSubscriptionAccount('codex-subscription', 'Other')
    return {
      workId: subscriptionProviderIdFor('codex-subscription', work.id),
      otherId: subscriptionProviderIdFor('codex-subscription', other.id),
    }
  }

  const resolveFor = (parentProviderId: string) =>
    resolveSubagentExecutionProfile({
      agentName: 'general-purpose',
      agents: [agent],
      conversationId: 'c',
      parent: { providerId: parentProviderId, modelId: 'parent-model', effort: 'high' },
    })

  it('inherits the virtual selection when the saved conversation selection is a pool holding the physical parent', async () => {
    const { workId } = setup()
    patchConvUiPrefs('c', { chat: { providerId: VIRTUAL, modelId: 'parent-model' } })

    const { profile } = await resolveFor(workId)

    expect(profile.effective).toMatchObject({ source: 'parent', providerId: VIRTUAL, modelId: 'parent-model' })
  })

  it('stays physical when the conversation selected an individual account', async () => {
    const { workId } = setup()
    patchConvUiPrefs('c', { chat: { providerId: workId, modelId: 'parent-model' } })

    const { profile } = await resolveFor(workId)

    expect(profile.effective).toMatchObject({ source: 'parent', providerId: workId })
  })

  it('stays physical when the parent runs outside the pool members', async () => {
    const { workId, otherId } = setup()
    setAccountPool({ kind: 'codex-subscription', memberProviderIds: [workId] })
    patchConvUiPrefs('c', { chat: { providerId: VIRTUAL, modelId: 'parent-model' } })

    const { profile } = await resolveFor(otherId)

    expect(profile.effective).toMatchObject({ source: 'parent', providerId: otherId })
  })

  it('stays physical when the saved selection is the active-account pool of another provider', async () => {
    const { workId } = setup()
    patchConvUiPrefs('c', {
      chat: { providerId: activeAccountProviderId('claude-subscription'), modelId: 'parent-model' },
    })

    const { profile } = await resolveFor(workId)

    expect(profile.effective).toMatchObject({ source: 'parent', providerId: workId })
  })

  it('keeps a parent that already is the virtual selection', async () => {
    setup()
    patchConvUiPrefs('c', { chat: { providerId: VIRTUAL, modelId: 'parent-model' } })

    const { profile } = await resolveFor(VIRTUAL)

    expect(profile.effective).toMatchObject({ source: 'parent', providerId: VIRTUAL })
  })

  it('does not apply the saved selection to a workflow parent', async () => {
    const { workId } = setup()
    patchConvUiPrefs('c', { chat: { providerId: VIRTUAL, modelId: 'parent-model' } })

    const resolved = await resolveParentSubagentExecutionProfile({
      agent,
      parent: { providerId: workId, modelId: 'parent-model', effort: 'high' },
    })

    expect(resolved.effective).toMatchObject({ source: 'parent', providerId: workId })
  })
})
