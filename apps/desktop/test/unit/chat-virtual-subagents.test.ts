import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS, type ChatAgent } from '../../src/main/chat/agents'
import { mergeVirtualSubagents, VIRTUAL_AGENT_DESCRIPTION } from '../../src/main/chat/virtual-subagents'
import type { SubagentProfileCandidate, SubagentProfileRulesV1 } from '../../src/shared/subagent-profiles'

const candidate = (providerId: string, modelId: string, effort = 'high'): SubagentProfileCandidate => ({
  providerId,
  modelId,
  effort,
})
const rules = (value: Partial<SubagentProfileRulesV1>): SubagentProfileRulesV1 => ({ version: 1, ...value })
const agent = (value: Partial<ChatAgent> = {}): ChatAgent => ({
  name: 'explore',
  description: 'Read-only.',
  prompt: 'Explore.',
  source: 'built-in',
  ...value,
})
const builtinGp = BUILTIN_AGENTS.find((item) => item.name === 'general-purpose')!

describe('mergeVirtualSubagents (virtual agents from byAgent)', () => {
  it('creates executable virtual agents from custom byAgent keys', () => {
    const out = mergeVirtualSubagents({
      agents: [agent({ name: 'explore' })],
      conversationRules: rules({ byAgent: { testing: [candidate('p', 'm')] } }),
    })
    const virtual = out.find((item) => item.name === 'testing')
    expect(virtual).toBeDefined()
    expect(virtual).toMatchObject({
      name: 'testing',
      virtual: true,
      baseAgentName: 'general-purpose',
      source: 'virtual-profile',
      category: 'custom',
      description: VIRTUAL_AGENT_DESCRIPTION,
      prompt: builtinGp.prompt,
    })
    expect(virtual?.tools).toEqual(builtinGp.tools)
    expect(out).toHaveLength(2) // explore + testing (general-purpose is the base, not a catalog entry).
  })

  it('uses a customized PHYSICAL general-purpose profile as the effective virtual base', () => {
    const customGp: ChatAgent = {
      name: 'general-purpose',
      description: 'Custom worker.',
      prompt: 'Custom worker prompt.',
      tools: ['bash', 'edit'],
      source: '.claude/agents/general-purpose.md',
    }
    const out = mergeVirtualSubagents({
      agents: [customGp],
      conversationRules: rules({ byAgent: { testing: [candidate('p', 'm')] } }),
    })
    const virtual = out.find((item) => item.name === 'testing')
    expect(virtual?.prompt).toBe(customGp.prompt)
    expect(virtual?.tools).toEqual(customGp.tools)
    expect(virtual?.baseAgentName).toBe('general-purpose')
  })

  it('inherits virtual behavior without base frontmatter or identity', () => {
    const customGp: ChatAgent = {
      name: 'general-purpose',
      description: 'Custom worker.',
      prompt: 'Custom worker prompt.',
      tools: ['bash', 'edit'],
      source: '.claude/agents/general-purpose.md',
      provider: 'openai',
      model: 'gpt-test',
      effort: 'high',
      legacyModel: 'gpt-legacy',
      profile: { providerId: 'openai', modelId: 'gpt-test', effort: 'high' },
      profileDiagnostics: [{ code: 'invalid-effort', severity: 'warning', message: 'x' }],
    }
    const out = mergeVirtualSubagents({
      agents: [customGp],
      conversationRules: rules({ byAgent: { testing: [candidate('p', 'm')] } }),
    })
    const virtual = out.find((item) => item.name === 'testing')
    expect(virtual?.provider).toBeUndefined()
    expect(virtual?.model).toBeUndefined()
    expect(virtual?.effort).toBeUndefined()
    expect(virtual?.legacyModel).toBeUndefined()
    expect(virtual?.profile).toBeUndefined()
    expect(virtual?.profileDiagnostics).toBeUndefined()
    expect(virtual?.prompt).toBe(customGp.prompt) // comportamento herda
  })

  it('prefers real agents over homonymous virtual agents', () => {
    const real = agent({
      name: 'testing',
      description: 'Real file agent.',
      prompt: 'Real prompt.',
      source: '.claude/agents/testing.md',
    })
    const out = mergeVirtualSubagents({
      agents: [real],
      conversationRules: rules({ byAgent: { testing: [candidate('p', 'm')] } }),
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.name).toBe('testing')
    expect(out[0]?.source).toBe('.claude/agents/testing.md')
    expect(out[0]?.virtual).toBeUndefined()
  })

  it('deduplicates global and conversation aliases with conversation precedence', () => {
    const out = mergeVirtualSubagents({
      agents: [],
      conversationRules: rules({ byAgent: { testing: [candidate('c', 'm1')] } }),
      globalRules: rules({ byAgent: { testing: [candidate('g', 'm2')] } }),
    })
    const virtuals = out.filter((item) => item.virtual === true)
    expect(virtuals).toHaveLength(1)
    expect(virtuals[0]?.name).toBe('testing')
  })

  it('includes global aliases unless overridden by the conversation', () => {
    const out = mergeVirtualSubagents({
      agents: [],
      conversationRules: null,
      globalRules: rules({ byAgent: { reviewer: [candidate('g', 'm2')] } }),
    })
    const virtuals = out.filter((item) => item.virtual === true)
    expect(virtuals.map((item) => item.name)).toEqual(['reviewer'])
  })

  it('deduplicates normalized keys', () => {
    const out = mergeVirtualSubagents({
      agents: [],
      conversationRules: rules({
        byAgent: { 'Testing-Foo': [candidate('p', 'm')], ' testing foo ': [candidate('p', 'm')] },
      }),
    })
    const virtuals = out.filter((item) => item.virtual === true)
    expect(virtuals).toHaveLength(1)
    expect(virtuals[0]?.name).toBe('testing-foo')
  })

  it('does not create virtual agents from empty lists', () => {
    const out = mergeVirtualSubagents({
      agents: [],
      conversationRules: rules({ byAgent: { testing: [] } }),
    })
    expect(out.filter((item) => item.virtual === true)).toHaveLength(0)
  })

  it('byCategory and default do NOT create virtual agents', () => {
    const out = mergeVirtualSubagents({
      agents: [],
      conversationRules: rules({
        byCategory: { integration: [candidate('p', 'm')] },
        default: [candidate('p', 'm')],
      }),
    })
    expect(out.filter((item) => item.virtual === true)).toHaveLength(0)
  })

  it('does not create virtual agents for disabled profiles', () => {
    const out = mergeVirtualSubagents({
      agents: [agent({ name: 'explore' })],
      conversationRules: rules({ byAgent: { testing: [candidate('p', 'm')] } }),
      profilesEnabled: false,
    })
    expect(out.some((item) => item.virtual === true)).toBe(false)
  })

  it('uses built-in general-purpose when no physical base exists', () => {
    const out = mergeVirtualSubagents({
      agents: [agent({ name: 'explore' })],
      conversationRules: rules({ byAgent: { testing: [candidate('p', 'm')] } }),
    })
    const virtual = out.find((item) => item.name === 'testing')
    expect(virtual?.baseAgentName).toBe('general-purpose')
    expect(virtual?.prompt).toBe(builtinGp.prompt)
    expect(virtual?.tools).toEqual(builtinGp.tools)
  })
})
