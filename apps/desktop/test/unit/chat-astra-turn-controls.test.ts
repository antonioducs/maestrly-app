import { describe, expect, it } from 'vitest'
import {
  routeAstraComposerSubmit,
  routeAstraReasoningChange,
} from '../../src/renderer/components/chat/astra-turn-controls'

const plain = {
  streaming: true,
  activeHarnessProfile: 'openai-gpt-6-astra-v1' as const,
  midTurnSteering: true,
  text: 'please also check the tests',
  attachmentCount: 0,
  agentMentionCount: 0,
  invokesSkill: false,
  maestro: false,
}

describe('Astra active-turn renderer routing', () => {
  it('steers only ordinary text when the active runtime advertises support', () => {
    expect(routeAstraComposerSubmit(plain)).toBe('steer')
    expect(routeAstraComposerSubmit({ ...plain, attachmentCount: 1 })).toBe('queue')
    expect(routeAstraComposerSubmit({ ...plain, agentMentionCount: 1 })).toBe('queue')
    expect(routeAstraComposerSubmit({ ...plain, invokesSkill: true })).toBe('queue')
    expect(routeAstraComposerSubmit({ ...plain, maestro: true })).toBe('queue')
    expect(routeAstraComposerSubmit({ ...plain, midTurnSteering: false })).toBe('queue')
    expect(routeAstraComposerSubmit({ ...plain, activeHarnessProfile: 'openai-default-v1' })).toBe('queue')
  })

  it('uses normal send outside streaming', () => {
    expect(routeAstraComposerSubmit({ ...plain, streaming: false })).toBe('send')
  })

  it('applies live effort only for valid Astra values and otherwise keeps next-turn preference', () => {
    const input = {
      streaming: true,
      activeHarnessProfile: 'openai-gpt-6-astra-v1' as const,
      liveReasoningUpdate: true,
      effort: 'ultra' as const,
      supportedEfforts: ['low', 'high', 'ultra'],
    }
    expect(routeAstraReasoningChange(input)).toBe('live-and-next-turn')
    expect(routeAstraReasoningChange({ ...input, effort: 'off' })).toBe('live-and-next-turn')
    expect(routeAstraReasoningChange({ ...input, effort: 'minimal' })).toBe('next-turn-only')
    expect(routeAstraReasoningChange({ ...input, activeHarnessProfile: 'openai-default-v1' })).toBe('next-turn-only')
  })
})
