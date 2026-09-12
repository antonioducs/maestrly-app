import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/chat/diag-log', () => ({
  chatDiag: vi.fn(),
}))

import { chatDiag } from '../../src/main/chat/diag-log'
import {
  assertSubagentSelection,
  createExplicitSubagentTurnState,
  recordSubagentDispatch,
  SubagentSelectionGuardError,
} from '../../src/main/chat/subagent-selection-guard'

const available = ['api-integration-engineer', 'explore', 'general-purpose', 'runtime-reviewer']

function state(requested: string[], availableNames: string[] = available) {
  return createExplicitSubagentTurnState(requested, availableNames)
}

function assert(input: { state: ReturnType<typeof state>; selectedAgent: string; availableNames?: string[] }) {
  return assertSubagentSelection({
    state: input.state,
    selectedAgent: input.selectedAgent,
    availableAgents: input.availableNames ?? available,
  })
}

describe('createExplicitSubagentTurnState / recordSubagentDispatch', () => {
  it('normalizes and filters requested agents against the current catalog', () => {
    const s = state(['API Integration Engineer', 'missing-agent', 'explore'])
    expect([...s.requested]).toEqual(['api-integration-engineer', 'explore'])
    expect([...s.dispatched]).toEqual([])
  })

  it('records dispatch idempotently and canonically', () => {
    const s = state(['explore'])
    recordSubagentDispatch(s, 'EXPLORE')
    recordSubagentDispatch(s, 'explore')
    expect([...s.dispatched]).toEqual(['explore'])
  })
})

describe('assertSubagentSelection (substitution protection)', () => {
  it('1. blocks general-purpose until the requested specialist is dispatched', () => {
    const s = state(['api-integration-engineer'])
    expect(() =>
      assertSubagentSelection({
        state: s,
        selectedAgent: 'general-purpose',
        availableAgents: available,
        runtime: 'byok',
        conversationId: 'conv-1',
      })
    ).toThrow(SubagentSelectionGuardError)
    expect(chatDiag).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'subagent-selection-corrected',
        requestedAgent: 'api-integration-engineer',
        selectedAgent: 'general-purpose',
        runtime: 'byok',
        conversationId: 'conv-1',
      })
    )
  })

  it('2. allows explore as an auxiliary', () => {
    const s = state(['api-integration-engineer'])
    expect(() => assert({ state: s, selectedAgent: 'explore' })).not.toThrow()
  })

  it('3. allows another specialist as an auxiliary (reviewer)', () => {
    const s = state(['api-integration-engineer'])
    expect(() => assert({ state: s, selectedAgent: 'runtime-reviewer' })).not.toThrow()
  })

  it('4. allows the requested specialist and records dispatch', () => {
    const s = state(['api-integration-engineer'])
    expect(() => assert({ state: s, selectedAgent: 'api-integration-engineer' })).not.toThrow()
    recordSubagentDispatch(s, 'api-integration-engineer')
    expect(s.dispatched.has('api-integration-engineer')).toBe(true)
  })

  it('5. allows general-purpose again after dispatching the specialist', () => {
    const s = state(['api-integration-engineer'])
    recordSubagentDispatch(s, 'api-integration-engineer')
    expect(() => assert({ state: s, selectedAgent: 'general-purpose' })).not.toThrow()
  })

  it('6. dispatches both requested specialists without blocking auxiliaries', () => {
    const s = state(['api-integration-engineer', 'runtime-reviewer'])
    expect(() => assert({ state: s, selectedAgent: 'explore' })).not.toThrow()
    expect(() => assert({ state: s, selectedAgent: 'api-integration-engineer' })).not.toThrow()
    recordSubagentDispatch(s, 'api-integration-engineer')
    // Reviewer still pending: general-purpose remains blocked.
    expect(() => assert({ state: s, selectedAgent: 'general-purpose' })).toThrow(SubagentSelectionGuardError)
    expect(() => assert({ state: s, selectedAgent: 'runtime-reviewer' })).not.toThrow()
    recordSubagentDispatch(s, 'runtime-reviewer')
    expect(() => assert({ state: s, selectedAgent: 'general-purpose' })).not.toThrow()
  })

  it('7. a requested agent removed from the catalog does not block', () => {
    const s = createExplicitSubagentTurnState(['api-integration-engineer'], ['explore', 'general-purpose'])
    expect([...s.requested]).toEqual([])
    expect(() =>
      assertSubagentSelection({
        state: s,
        selectedAgent: 'general-purpose',
        availableAgents: ['explore', 'general-purpose'],
      })
    ).not.toThrow()
  })

  it('8. comparison uses canonical normalization', () => {
    const s = state(['API Integration Engineer'])
    expect(() => assert({ state: s, selectedAgent: 'api-integration-engineer' })).not.toThrow()
  })

  it('does not restrict anything without explicit requests', () => {
    const s = state([])
    expect(() => assert({ state: s, selectedAgent: 'general-purpose' })).not.toThrow()
  })

  it('the error message is retryable and names the pending agent', () => {
    const s = state(['api-integration-engineer', 'runtime-reviewer'])
    let error: unknown = null
    try {
      assert({ state: s, selectedAgent: 'general-purpose' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(SubagentSelectionGuardError)
    expect((error as Error).message).toContain('explicitly requested the available subagent "api-integration-engineer"')
    expect((error as Error).message).toContain('Call task again with agent="api-integration-engineer"')
  })
})
