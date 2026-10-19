import { afterEach, describe, expect, it } from 'vitest'
import { parseTaskComplexity, setSubagentRouter, withTaskComplexity } from '../../src/main/chat/subagent-route'
import { parseParts } from '../../src/main/chat/message'

const base = () => ({
  type: 'object',
  properties: { agent: { type: 'string' }, prompt: { type: 'string' } },
  required: ['agent', 'prompt'],
  additionalProperties: false,
})
afterEach(() => setSubagentRouter('c1', null))

describe('task complexity', () => {
  it('leaves the task schema unchanged without a router', () => {
    expect(withTaskComplexity(base(), 'c1')).toEqual(base())
  })

  it('requires complexity once the conversation routes its tasks', () => {
    setSubagentRouter('c1', () => ({
      info: { complexity: 'medium', declared: true, tier: null, upgraded: false },
      candidates: [],
    }))
    const schema = withTaskComplexity(base(), 'c1')
    expect(schema.required).toEqual(['agent', 'prompt', 'complexity'])
    expect((schema.properties as Record<string, unknown>).complexity).toMatchObject({
      type: 'string',
      enum: ['simple', 'medium', 'complex'],
    })
  })

  it('parses only known values', () => {
    expect(parseTaskComplexity('complex')).toBe('complex')
    expect(parseTaskComplexity('huge')).toBeNull()
    expect(parseTaskComplexity(undefined)).toBeNull()
  })

  it('keeps a routed profile when a tool part is read back', () => {
    const profile = {
      version: 1,
      agentName: 'general-purpose',
      effective: {
        providerId: 'builtin_claude_subscription',
        modelId: 'haiku',
        configuredEffort: 'low',
        sentEffort: 'low',
        source: 'bot-delegation',
        ruleKey: 'simple',
        candidateIndex: 0,
      },
      attempts: [],
      delegation: { complexity: 'simple', declared: true, tier: 'fast', upgraded: false },
    }
    const [part] = parseParts(
      JSON.stringify([
        {
          type: 'tool',
          id: 'p1',
          toolCallId: 't1',
          toolName: 'task',
          input: {},
          state: { status: 'completed', output: 'ok', sub: { profile } },
        },
      ])
    )
    expect(part).toMatchObject({ state: { sub: { profile: { delegation: profile.delegation } } } })
  })
})
