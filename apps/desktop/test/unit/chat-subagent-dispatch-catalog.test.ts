import { describe, expect, it } from 'vitest'
import type { ChatAgent } from '../../src/main/chat/agents'
import {
  buildSubagentDispatchCatalog,
  renderSubagentDispatchCatalog,
  SUBAGENT_DISPATCH_SELECTION_RULES,
} from '../../src/main/chat/subagent-dispatch-catalog'
import { SUBAGENT_PROFILE_RULES_VERSION } from '../../src/shared/subagent-profiles'

const specialist: ChatAgent = {
  name: 'api-integration-engineer',
  category: 'integration',
  description: 'Specialist for API integrations.',
  tools: ['bash', 'write', 'edit', 'read'],
  prompt: 'You integrate APIs.',
  source: '.claude/agents/api-integration-engineer.md',
}

const explore: ChatAgent = {
  name: 'explore',
  category: 'exploration',
  description: 'Read-only search agent.',
  prompt: 'Explore.',
  source: 'built-in',
}

const generalPurpose: ChatAgent = {
  name: 'general-purpose',
  category: 'implementation',
  description: 'Worker agent with FULL tools.',
  tools: ['bash', 'write', 'edit', 'read'],
  prompt: 'Work.',
  source: 'built-in',
}

const imageOnly: ChatAgent = {
  name: 'image-maker',
  category: 'creative',
  description: 'Creates images.',
  tools: ['generate_image'],
  prompt: 'Create images.',
  source: '.claude/agents/image-maker.md',
}

describe('subagent dispatch catalog', () => {
  it('marks byAgent configuration as dedicated profile', () => {
    const entries = buildSubagentDispatchCatalog({
      agents: [specialist],
      conversationId: 'conv-1',
      profilesEnabled: true,
      globalRules: {
        version: SUBAGENT_PROFILE_RULES_VERSION,
        byAgent: {
          'api-integration-engineer': [{ providerId: 'openai', modelId: 'gpt-test', effort: 'high' }],
        },
      },
      conversationRules: null,
    })
    expect(entries[0]).toMatchObject({
      name: 'api-integration-engineer',
      capability: 'worker',
      routing: 'dedicated',
    })
  })

  it('marks byCategory configuration as dedicated profile', () => {
    const entries = buildSubagentDispatchCatalog({
      agents: [specialist],
      conversationId: 'conv-1',
      profilesEnabled: true,
      globalRules: {
        version: SUBAGENT_PROFILE_RULES_VERSION,
        byCategory: {
          integration: [{ providerId: 'openai', modelId: 'gpt-test', effort: 'medium' }],
        },
      },
      conversationRules: null,
    })
    expect(entries[0].routing).toBe('dedicated')
  })

  it('keeps default-only rules as inherited for individual agents', () => {
    const entries = buildSubagentDispatchCatalog({
      agents: [specialist],
      conversationId: 'conv-1',
      profilesEnabled: true,
      globalRules: {
        version: SUBAGENT_PROFILE_RULES_VERSION,
        default: [{ providerId: 'openai', modelId: 'gpt-default', effort: 'low' }],
      },
      conversationRules: null,
    })
    expect(entries[0].routing).toBe('inherited')
  })

  it('forces inherited routing when conversation profiles are disabled', () => {
    const entries = buildSubagentDispatchCatalog({
      agents: [specialist],
      conversationId: 'conv-1',
      profilesEnabled: false,
      globalRules: {
        version: SUBAGENT_PROFILE_RULES_VERSION,
        byAgent: {
          'api-integration-engineer': [{ providerId: 'openai', modelId: 'gpt-test', effort: 'high' }],
        },
      },
      conversationRules: null,
    })
    expect(entries[0].routing).toBe('inherited')
  })

  it('labels general-purpose as generic fallback and reflects capabilities', () => {
    const entries = buildSubagentDispatchCatalog({
      agents: [explore, generalPurpose],
      conversationId: 'conv-1',
      profilesEnabled: true,
      globalRules: null,
      conversationRules: null,
    })
    const text = renderSubagentDispatchCatalog(entries)
    expect(text).toContain(SUBAGENT_DISPATCH_SELECTION_RULES)
    expect(text).toContain('- explore [specialist, read-only, inherited profile]: Read-only search agent.')
    expect(text).toContain(
      '- general-purpose [generic fallback, worker, inherited profile]: Worker agent with FULL tools.'
    )
  })

  it('forceReadOnly overrides worker tools in Plan/Ask modes', () => {
    const entries = buildSubagentDispatchCatalog({
      agents: [generalPurpose],
      conversationId: 'conv-1',
      forceReadOnly: true,
      profilesEnabled: true,
      globalRules: null,
      conversationRules: null,
    })
    expect(entries[0].capability).toBe('read-only')
  })

  it('advertises a generate_image-only custom agent as a worker', () => {
    const entries = buildSubagentDispatchCatalog({
      agents: [imageOnly],
      conversationId: 'conv-1',
      profilesEnabled: true,
      globalRules: null,
      conversationRules: null,
    })
    expect(entries[0].capability).toBe('worker')
  })

  it.each(['Plan', 'Ask'] as const)('forceReadOnly clamps image workers in %s mode', (mode) => {
    const entries = buildSubagentDispatchCatalog({
      agents: [imageOnly],
      conversationId: 'conv-1',
      forceReadOnly: true,
      profilesEnabled: true,
      globalRules: null,
      conversationRules: null,
    })
    expect(entries[0].capability, mode).toBe('read-only')
  })

  it('normalizes and truncates descriptions without exposing provider/model', () => {
    const noisy: ChatAgent = {
      name: 'big',
      description: `multi\n  line   ${'x'.repeat(600)}`,
      prompt: 'p',
      source: 's',
      profile: { providerId: 'openai', modelId: 'secret-model', effort: 'high' },
    }
    const entries = buildSubagentDispatchCatalog({
      agents: [noisy],
      conversationId: 'conv-1',
      profilesEnabled: true,
      globalRules: null,
      conversationRules: null,
    })
    const text = renderSubagentDispatchCatalog(entries, { descriptionMaxChars: 40 })
    expect(text).toContain('- big [specialist, read-only, dedicated profile]: multi line')
    expect(text).not.toContain('\n  line')
    expect(text).not.toContain('openai')
    expect(text).not.toContain('secret-model')
    expect(text).not.toContain('effort')
  })
})
