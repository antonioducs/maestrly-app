import { describe, expect, it } from 'vitest'
import type { ChatAgent } from '../../src/main/chat/agents'
import { resolveSubagentProfile, type SubagentProfileResolverDeps } from '../../src/main/chat/subagent-profile-resolver'
import type { SubagentProfileCandidate, SubagentProfileRulesV1 } from '../../src/shared/subagent-profiles'

const candidate = (
  providerId: string,
  modelId: string,
  effort = 'high',
  fastMode = false
): SubagentProfileCandidate => ({
  providerId,
  modelId,
  effort,
  ...(fastMode ? { fastMode: true } : {}),
})
const rules = (value: Partial<SubagentProfileRulesV1>): SubagentProfileRulesV1 => ({ version: 1, ...value })
const agent = (value: Partial<ChatAgent> = {}): ChatAgent => ({
  name: 'Explore Agent',
  description: '',
  category: 'Code Review',
  prompt: 'Explore.',
  source: 'test',
  ...value,
})
function deps(overrides: Partial<SubagentProfileResolverDeps> = {}): SubagentProfileResolverDeps {
  return {
    providerStatus: async () => 'available',
    modelCatalog: async (_providerId) => ({ status: 'available', models: ['parent', 'selected', 'fallback', 'front'] }),
    modelMeta: async () => ({
      status: 'available',
      meta: { reasoning: true, reasoningEfforts: ['low', 'high', 'max'], fastModeCapability: true },
    }),
    ...overrides,
  }
}
const parent = candidate('parent-provider', 'parent', 'low')

async function selectedSource(input: Parameters<typeof resolveSubagentProfile>[0]) {
  return (await resolveSubagentProfile(input, deps())).effective?.source
}

describe('resolveSubagentProfile', () => {
  it('applies eight profile layers in order', async () => {
    const a = agent({ profile: candidate('front-provider', 'front', 'high') })
    const conversation = rules({
      default: [candidate('p', 'selected')],
      byCategory: { 'code-review': [candidate('p', 'selected')] },
      byAgent: { 'explore-agent': [candidate('p', 'selected')] },
    })
    const global = rules({
      default: [candidate('p', 'selected')],
      byCategory: { 'code-review': [candidate('p', 'selected')] },
      byAgent: { 'explore-agent': [candidate('p', 'selected')] },
    })
    const cases: Array<[string, SubagentProfileRulesV1 | null, SubagentProfileRulesV1 | null, ChatAgent]> = [
      ['conversation-agent', conversation, global, a],
      ['conversation-category', rules({ ...conversation, byAgent: undefined }), global, a],
      ['conversation-default', rules({ default: conversation.default }), global, a],
      ['global-agent', null, global, a],
      ['global-category', null, rules({ ...global, byAgent: undefined }), a],
      ['global-default', null, rules({ default: global.default }), a],
      ['frontmatter', null, null, a],
      ['parent', null, null, agent()],
    ]
    for (const [expected, conversationRules, globalRules, currentAgent] of cases) {
      expect(await selectedSource({ agent: currentAgent, conversationRules, globalRules, parent })).toBe(expected)
    }
  })

  it('uses parent profiles directly when overrides are disabled', async () => {
    const snapshot = await resolveSubagentProfile(
      {
        agent: agent({ profile: candidate('front-provider', 'front', 'high') }),
        profilesEnabled: false,
        conversationRules: rules({ default: [candidate('conversation', 'selected')] }),
        globalRules: rules({ default: [candidate('global', 'fallback')] }),
        parent,
        parentFastMode: true,
      },
      deps()
    )

    expect(snapshot.effective).toMatchObject({
      source: 'parent',
      providerId: parent.providerId,
      modelId: parent.modelId,
      configuredEffort: parent.effort,
      fastMode: true,
    })
    expect(snapshot.attempts).toHaveLength(1)
    expect(snapshot.attempts[0]?.source).toBe('parent')
  })

  it('inherits parent Fast and materializes explicit configurable overrides', async () => {
    const parentFast = true
    const cases: Array<{
      name: string
      input: Parameters<typeof resolveSubagentProfile>[0]
      expectedSource: NonNullable<Awaited<ReturnType<typeof resolveSubagentProfile>>['effective']>['source']
      expectedFast: boolean
    }> = [
      {
        name: 'parent',
        input: { agent: agent(), parent, parentFastMode: parentFast },
        expectedSource: 'parent',
        expectedFast: true,
      },
      {
        name: 'conversation-agent',
        input: {
          agent: agent(),
          conversationRules: rules({ byAgent: { 'explore-agent': [candidate('p', 'selected', 'high', true)] } }),
          parent,
          parentFastMode: parentFast,
        },
        expectedSource: 'conversation-agent',
        expectedFast: true,
      },
      {
        name: 'conversation-category',
        input: {
          agent: agent(),
          conversationRules: rules({ byCategory: { 'code-review': [candidate('p', 'selected', 'high', true)] } }),
          parent,
          parentFastMode: parentFast,
        },
        expectedSource: 'conversation-category',
        expectedFast: true,
      },
      {
        name: 'conversation-default',
        input: {
          agent: agent(),
          conversationRules: rules({ default: [candidate('p', 'selected', 'high', true)] }),
          parent,
          parentFastMode: parentFast,
        },
        expectedSource: 'conversation-default',
        expectedFast: true,
      },
      {
        name: 'global-agent',
        input: {
          agent: agent(),
          globalRules: rules({ byAgent: { 'explore-agent': [candidate('p', 'selected', 'high', true)] } }),
          parent,
          parentFastMode: parentFast,
        },
        expectedSource: 'global-agent',
        expectedFast: true,
      },
      {
        name: 'global-category',
        input: {
          agent: agent(),
          globalRules: rules({ byCategory: { 'code-review': [candidate('p', 'selected', 'high', true)] } }),
          parent,
          parentFastMode: parentFast,
        },
        expectedSource: 'global-category',
        expectedFast: true,
      },
      {
        name: 'global-default',
        input: {
          agent: agent(),
          globalRules: rules({ default: [candidate('p', 'selected', 'high', true)] }),
          parent,
          parentFastMode: parentFast,
        },
        expectedSource: 'global-default',
        expectedFast: true,
      },
      {
        name: 'frontmatter',
        input: {
          agent: agent({ profile: candidate('front-provider', 'front', 'high', true) }),
          parent,
          parentFastMode: parentFast,
        },
        expectedSource: 'frontmatter',
        expectedFast: true,
      },
    ]

    for (const testCase of cases) {
      const snapshot = await resolveSubagentProfile(testCase.input, deps())
      expect(snapshot.effective, testCase.name).toMatchObject({
        source: testCase.expectedSource,
        fastMode: testCase.expectedFast,
      })
    }

    const parentStandard = await resolveSubagentProfile({ agent: agent(), parent, parentFastMode: false }, deps())
    expect(parentStandard.effective?.fastMode).toBe(false)
  })

  it('uses winning fallback Fast and restores parent Fast only at parent fallback', async () => {
    const configuredFallback = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({
          default: [candidate('rejected-provider', 'selected'), candidate('p', 'fallback')],
        }),
        parent,
        parentFastMode: true,
      },
      deps({ providerStatus: async (providerId) => (providerId === 'rejected-provider' ? 'missing' : 'available') })
    )
    expect(configuredFallback.effective).toMatchObject({ source: 'conversation-default', fastMode: false })

    const fastConfiguredFallback = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({
          default: [candidate('rejected-provider', 'selected', 'high', true), candidate('p', 'fallback', 'high', true)],
        }),
        parent,
        parentFastMode: false,
      },
      deps({ providerStatus: async (providerId) => (providerId === 'rejected-provider' ? 'missing' : 'available') })
    )
    expect(fastConfiguredFallback.effective).toMatchObject({ source: 'conversation-default', fastMode: true })

    const parentFallback = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({ default: [candidate('rejected-provider', 'selected')] }),
        globalRules: rules({ default: [candidate('also-rejected', 'fallback')] }),
        parent,
        parentFastMode: true,
      },
      deps({
        providerStatus: async (providerId) =>
          providerId === 'rejected-provider' || providerId === 'also-rejected' ? 'missing' : 'available',
      })
    )
    expect(parentFallback.effective).toMatchObject({ source: 'parent', fastMode: true })
  })

  it('does not infer Fast overrides from provider/model equality', async () => {
    const sameModelOverride = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({
          byAgent: {
            'explore-agent': [candidate(parent.providerId, parent.modelId, parent.effort)],
          },
        }),
        parent,
        parentFastMode: true,
      },
      deps()
    )
    expect(sameModelOverride.effective).toMatchObject({
      source: 'conversation-agent',
      providerId: parent.providerId,
      modelId: parent.modelId,
      fastMode: false,
    })
  })

  it('falls back after unsupported subscription providers', async () => {
    const snapshot = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({
          default: [candidate('subscription', 'selected'), candidate('byok', 'fallback')],
        }),
        parent,
      },
      deps({ providerStatus: async (id) => (id === 'subscription' ? 'unsupported' : 'available') })
    )
    expect(snapshot.attempts[0]).toMatchObject({
      outcome: 'rejected',
      diagnostics: [{ code: 'provider-unsupported', severity: 'error' }],
    })
    expect(snapshot.effective).toMatchObject({ providerId: 'byok', modelId: 'fallback' })
  })

  it('falls back when Fable is absent from official Claude catalogs', async () => {
    const claudeProvider = 'builtin_claude_subscription'
    const unavailable = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({
          default: [candidate(claudeProvider, 'claude-fable-5'), candidate('byok', 'fallback')],
        }),
        parent,
      },
      deps({
        modelCatalog: async (providerId) => ({
          status: 'available',
          models: providerId === claudeProvider ? ['default', 'opus[1m]', 'sonnet', 'haiku'] : ['fallback', 'parent'],
        }),
      })
    )

    expect(unavailable.attempts[0]).toMatchObject({
      outcome: 'rejected',
      diagnostics: [{ code: 'model-unavailable', severity: 'error' }],
    })
    expect(unavailable.effective).toMatchObject({ providerId: 'byok', modelId: 'fallback' })
    expect(unavailable.attempts[1]?.diagnostics).toContainEqual(expect.objectContaining({ code: 'fallback-selected' }))

    const available = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({ default: [candidate(claudeProvider, 'fable[1m]')] }),
        parent,
      },
      deps({
        modelCatalog: async () => ({
          status: 'available',
          models: ['default', 'claude-fable-5', 'opus[1m]'],
        }),
      })
    )
    expect(available.effective).toMatchObject({
      providerId: claudeProvider,
      modelId: 'fable[1m]',
      source: 'conversation-default',
    })
  })

  it('inherits Codex and accepts cross-provider overrides', async () => {
    const codexParent = candidate('builtin_codex_subscription', 'gpt-5.6-sol', 'xhigh')
    const inherited = await resolveSubagentProfile(
      { agent: agent(), parent: codexParent },
      deps({
        modelCatalog: async () => ({ status: 'available', models: ['gpt-5.6-sol', 'gpt-5.6-mini'] }),
        modelMeta: async () => ({
          status: 'available',
          meta: { reasoning: true, reasoningEfforts: ['high', 'xhigh'] },
        }),
      })
    )
    expect(inherited.effective).toMatchObject({
      source: 'parent',
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-sol',
      sentEffort: 'xhigh',
    })

    const codexOverride = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({
          byAgent: { 'explore-agent': [candidate('builtin_codex_subscription', 'gpt-5.6-mini', 'high')] },
        }),
        parent: codexParent,
      },
      deps({ modelCatalog: async () => ({ status: 'available', models: ['gpt-5.6-sol', 'gpt-5.6-mini'] }) })
    )
    expect(codexOverride.effective).toMatchObject({
      source: 'conversation-agent',
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-mini',
      sentEffort: 'high',
    })

    const crossProvider = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({ default: [candidate('byok', 'fallback', 'high')] }),
        parent: codexParent,
      },
      deps()
    )
    expect(crossProvider.effective).toMatchObject({ providerId: 'byok', modelId: 'fallback' })
  })

  it('falls back deterministically from signed-out Codex', async () => {
    const snapshot = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({
          default: [candidate('builtin_codex_subscription', 'selected'), candidate('byok', 'fallback')],
        }),
        parent,
      },
      deps({
        providerStatus: async (id) => (id === 'builtin_codex_subscription' ? 'disconnected' : 'available'),
      })
    )
    expect(snapshot.attempts[0]).toMatchObject({
      outcome: 'rejected',
      diagnostics: [{ code: 'provider-disconnected', severity: 'error' }],
    })
    expect(snapshot.effective).toMatchObject({ providerId: 'byok', modelId: 'fallback' })
  })

  it('inherits Copilot and falls back after disconnected login', async () => {
    const copilotParent = candidate('builtin_github_copilot_subscription', 'claude-sonnet-4.6', 'high')
    const copilotDeps = deps({
      modelCatalog: async (providerId) => ({
        status: 'available',
        models: providerId === 'builtin_github_copilot_subscription' ? ['claude-sonnet-4.6', 'gpt-5'] : ['fallback'],
      }),
      modelMeta: async () => ({
        status: 'available',
        meta: { reasoning: true, reasoningEfforts: ['low', 'high'] },
      }),
    })
    const inherited = await resolveSubagentProfile({ agent: agent(), parent: copilotParent }, copilotDeps)
    expect(inherited.effective).toMatchObject({
      source: 'parent',
      providerId: 'builtin_github_copilot_subscription',
      modelId: 'claude-sonnet-4.6',
      sentEffort: 'high',
    })

    const overridden = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({
          default: [candidate('builtin_github_copilot_subscription', 'gpt-5', 'low')],
        }),
        parent: copilotParent,
      },
      copilotDeps
    )
    expect(overridden.effective).toMatchObject({
      source: 'conversation-default',
      providerId: 'builtin_github_copilot_subscription',
      modelId: 'gpt-5',
      sentEffort: 'low',
    })

    const crossProvider = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({ default: [candidate('byok', 'fallback', 'high')] }),
        parent: copilotParent,
      },
      copilotDeps
    )
    expect(crossProvider.effective).toMatchObject({ providerId: 'byok', modelId: 'fallback' })

    const disconnected = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({
          default: [
            candidate('builtin_github_copilot_subscription', 'gpt-5', 'high'),
            candidate('byok', 'fallback', 'high'),
          ],
        }),
        parent: copilotParent,
      },
      deps({
        providerStatus: async (providerId) =>
          providerId === 'builtin_github_copilot_subscription' ? 'disconnected' : 'available',
      })
    )
    expect(disconnected.attempts[0]).toMatchObject({
      outcome: 'rejected',
      diagnostics: [{ code: 'provider-disconnected' }],
    })
    expect(disconnected.effective).toMatchObject({ providerId: 'byok', modelId: 'fallback' })
  })

  it('preserves ordered rejection diagnostics across provider fallbacks', async () => {
    const snapshot = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({
          byAgent: {
            'explore-agent': [candidate('missing', 'selected'), candidate('cross-provider', 'fallback')],
          },
        }),
        parent,
      },
      deps({ providerStatus: async (id) => (id === 'missing' ? 'missing' : 'available') })
    )
    expect(snapshot.effective).toMatchObject({
      providerId: 'cross-provider',
      modelId: 'fallback',
      source: 'conversation-agent',
      candidateIndex: 1,
    })
    expect(snapshot.attempts.map((attempt) => attempt.outcome)).toEqual(['rejected', 'selected'])
    expect(snapshot.attempts[0].diagnostics[0].code).toBe('provider-missing')
    expect(snapshot.attempts[1].diagnostics.some((item) => item.code === 'fallback-selected')).toBe(true)
  })

  it('rejects known incompatibility and warns on offline manual model attempts', async () => {
    const configured = rules({
      default: [candidate('no-key', 'selected'), candidate('valid', 'manual', 'vendor-effort')],
    })
    const snapshot = await resolveSubagentProfile(
      { agent: agent(), conversationRules: configured, parent },
      deps({
        providerStatus: async (id) => (id === 'no-key' ? 'no-key' : 'available'),
        modelCatalog: async () => ({ status: 'unavailable', models: [] }),
        modelMeta: async () => ({ status: 'unavailable', meta: null }),
      })
    )
    expect(snapshot.effective).toMatchObject({ modelId: 'manual', sentEffort: 'vendor-effort' })
    expect(snapshot.attempts[0].diagnostics[0].code).toBe('no-key')
    expect(snapshot.attempts[1].diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['catalog-unavailable', 'effort-unverified'])
    )

    const invalid = await resolveSubagentProfile(
      { agent: agent(), conversationRules: rules({ default: [candidate('valid', 'selected', 'max')] }), parent },
      deps({ modelMeta: async () => ({ status: 'available', meta: { reasoning: true, reasoningEfforts: ['low'] } }) })
    )
    expect(invalid.attempts[0].diagnostics[0].code).toBe('invalid-effort')
    expect(invalid.effective?.source).toBe('parent')

    const unknown = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({ default: [candidate('valid', 'selected', 'vendor-effort')] }),
        parent,
      },
      deps({ modelMeta: async () => ({ status: 'available', meta: { contextWindow: 100_000 } }) })
    )
    expect(unknown.effective?.sentEffort).toBe('vendor-effort')
    expect(unknown.attempts[0].diagnostics[0].code).toBe('effort-unverified')
  })

  it('omits off and resolves Ultra to the highest effective effort', async () => {
    const off = await resolveSubagentProfile(
      { agent: agent(), globalRules: rules({ default: [candidate('p', 'selected', 'off')] }), parent },
      deps()
    )
    expect(off.effective?.sentEffort).toBeNull()
    const ultra = await resolveSubagentProfile(
      { agent: agent(), globalRules: rules({ default: [candidate('p', 'selected', 'ultra')] }), parent },
      deps()
    )
    expect(ultra.effective).toMatchObject({ configuredEffort: 'ultra', sentEffort: 'max' })
  })

  it('degrades incompatible inherited efforts to omission with warnings', async () => {
    // Stale inherited reasoning degrades safely like the main turn.
    const parentStale = await resolveSubagentProfile(
      { agent: agent(), parent: candidate('parent-provider', 'parent', 'xhigh') },
      deps({
        modelMeta: async () => ({ status: 'available', meta: { reasoning: true, reasoningEfforts: ['low', 'high'] } }),
      })
    )
    expect(parentStale.effective).toMatchObject({ source: 'parent', configuredEffort: 'xhigh', sentEffort: null })
    expect(parentStale.attempts[0].diagnostics[0]).toMatchObject({ code: 'invalid-effort', severity: 'warning' })

    // Authoritative non-reasoning metadata rejects explicit efforts and omits inherited ones.
    const legacy = await resolveSubagentProfile(
      {
        agent: agent({ legacyModel: 'front', model: 'front' }),
        parent: candidate('parent-provider', 'parent', 'ultra'),
      },
      deps({ modelMeta: async () => ({ status: 'available', meta: { reasoning: false } }) })
    )
    expect(legacy.effective).toMatchObject({ source: 'frontmatter', modelId: 'front', sentEffort: null })
    expect(legacy.attempts[0].diagnostics[0]).toMatchObject({ code: 'invalid-effort', severity: 'warning' })

    const configuredWithoutReasoning = await resolveSubagentProfile(
      { agent: agent(), conversationRules: rules({ default: [candidate('p', 'selected', 'xhigh')] }), parent },
      deps({ modelMeta: async () => ({ status: 'available', meta: { reasoning: false } }) })
    )
    expect(configuredWithoutReasoning.attempts[0]).toMatchObject({ outcome: 'rejected' })
    expect(configuredWithoutReasoning.attempts[0].diagnostics[0]).toMatchObject({
      code: 'invalid-effort',
      severity: 'error',
    })
    expect(configuredWithoutReasoning.effective).toMatchObject({ source: 'parent', sentEffort: null })

    // Configured candidates remain rejected when supported levels are known.
    const configured = await resolveSubagentProfile(
      { agent: agent(), conversationRules: rules({ default: [candidate('p', 'selected', 'xhigh')] }), parent },
      deps({
        modelMeta: async () => ({ status: 'available', meta: { reasoning: true, reasoningEfforts: ['low', 'high'] } }),
      })
    )
    expect(configured.attempts[0]).toMatchObject({ outcome: 'rejected' })
    expect(configured.attempts[0].diagnostics[0]).toMatchObject({ code: 'invalid-effort', severity: 'error' })
  })

  it('synthesizes legacy parent settings and fails if every layer is invalid', async () => {
    const legacy = await resolveSubagentProfile(
      { agent: agent({ legacyModel: 'front', model: 'front' }), parent },
      deps()
    )
    expect(legacy.effective).toMatchObject({
      source: 'frontmatter',
      providerId: 'parent-provider',
      modelId: 'front',
      configuredEffort: 'low',
    })
    const failed = await resolveSubagentProfile(
      { agent: agent(), parent },
      deps({ providerStatus: async () => 'missing' })
    )
    expect(failed.effective).toBeNull()
    expect(failed.attempts.at(-1)?.diagnostics.map((item) => item.code)).toEqual([
      'provider-missing',
      'parent-profile-invalid',
    ])
  })

  it('resolves virtual byAgent overrides while preserving logical names', async () => {
    const virtualAgent = agent({ name: 'testing', virtual: true, baseAgentName: 'general-purpose' })
    const snapshot = await resolveSubagentProfile(
      {
        agent: virtualAgent,
        conversationRules: rules({
          byAgent: { testing: [candidate('deepseek-provider', 'deepseek-v4-flash', 'max')] },
        }),
        globalRules: null,
        parent,
      },
      deps({
        modelCatalog: async () => ({ status: 'available', models: ['deepseek-v4-flash'] }),
        modelMeta: async () => ({
          status: 'available',
          meta: { reasoning: true, reasoningEfforts: ['max'] },
        }),
      })
    )

    expect(snapshot.effective).toMatchObject({
      source: 'conversation-agent',
      ruleKey: 'testing',
      providerId: 'deepseek-provider',
      modelId: 'deepseek-v4-flash',
      sentEffort: 'max',
    })
    expect(snapshot.agentName).toBe('testing')
  })

  it('uses fallback-specific Fast after known incompatibility', async () => {
    const snapshot = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({
          default: [candidate('p', 'selected', 'high', true), candidate('p', 'fallback', 'high', false)],
        }),
        parent,
        parentFastMode: true,
      },
      deps({
        modelMeta: async (_providerId, modelId) => ({
          status: 'available',
          meta: {
            reasoning: true,
            reasoningEfforts: ['low', 'high'],
            fastModeCapability: modelId !== 'selected',
          },
        }),
      })
    )

    expect(snapshot.attempts[0]).toMatchObject({
      outcome: 'rejected',
      diagnostics: [{ code: 'fast-mode-unsupported', severity: 'error' }],
    })
    expect(snapshot.effective).toMatchObject({ source: 'conversation-default', modelId: 'fallback', fastMode: false })
  })

  it('preserves unverified Fast with warnings when metadata is unavailable', async () => {
    const snapshot = await resolveSubagentProfile(
      {
        agent: agent(),
        conversationRules: rules({ default: [candidate('p', 'selected', 'high', true)] }),
        parent,
        parentFastMode: false,
      },
      deps({ modelMeta: async () => ({ status: 'unavailable', meta: null }) })
    )

    expect(snapshot.effective).toMatchObject({ source: 'conversation-default', fastMode: true })
    expect(snapshot.attempts[0].diagnostics.map((item) => item.code)).toContain('fast-mode-unverified')
  })
})
