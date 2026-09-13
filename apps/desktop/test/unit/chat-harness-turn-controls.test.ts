import { describe, expect, it } from 'vitest'
import {
  routeHarnessComposerSubmit,
  routeHarnessReasoningChange,
} from '../../src/renderer/components/chat/harness-turn-controls'

const plain = {
  streaming: true,
  midTurnSteering: true,
  text: 'please also check the tests',
  attachmentCount: 0,
  agentMentionCount: 0,
  invokesSkill: false,
  maestro: false,
}

describe('harness active-turn renderer routing', () => {
  it('steers only ordinary text when the active execution advertises support', () => {
    expect(routeHarnessComposerSubmit(plain)).toBe('steer')
    expect(routeHarnessComposerSubmit({ ...plain, attachmentCount: 1 })).toBe('queue')
    expect(routeHarnessComposerSubmit({ ...plain, agentMentionCount: 1 })).toBe('queue')
    expect(routeHarnessComposerSubmit({ ...plain, invokesSkill: true })).toBe('queue')
    expect(routeHarnessComposerSubmit({ ...plain, maestro: true })).toBe('queue')
    expect(routeHarnessComposerSubmit({ ...plain, text: '   ' })).toBe('queue')
  })

  it('queues when the active execution has no steering capability', () => {
    expect(routeHarnessComposerSubmit({ ...plain, midTurnSteering: false })).toBe('queue')
  })

  it('uses normal send outside streaming', () => {
    expect(routeHarnessComposerSubmit({ ...plain, streaming: false })).toBe('send')
  })

  it('applies a live effort only when the active execution accepts that exact value', () => {
    const input = {
      streaming: true,
      liveReasoningUpdate: true,
      effort: 'ultra' as const,
      liveReasoningEfforts: ['low', 'high', 'ultra'],
      liveReasoningReset: true,
    }
    expect(routeHarnessReasoningChange(input)).toBe('live-and-next-turn')
    expect(routeHarnessReasoningChange({ ...input, effort: 'off' })).toBe('live-and-next-turn')
    expect(routeHarnessReasoningChange({ ...input, effort: 'off', liveReasoningReset: false })).toBe('next-turn-only')
    expect(routeHarnessReasoningChange({ ...input, effort: 'minimal' })).toBe('next-turn-only')
    expect(routeHarnessReasoningChange({ ...input, liveReasoningUpdate: false })).toBe('next-turn-only')
    expect(routeHarnessReasoningChange({ ...input, streaming: false })).toBe('next-turn-only')
    expect(routeHarnessReasoningChange({ ...input, liveReasoningEfforts: [] })).toBe('next-turn-only')
  })

  it('works for any profile with the capability, without naming a model', () => {
    expect(
      routeHarnessReasoningChange({
        streaming: true,
        liveReasoningUpdate: true,
        effort: 'high',
        liveReasoningEfforts: ['high'],
        liveReasoningReset: false,
      })
    ).toBe('live-and-next-turn')
  })
})
