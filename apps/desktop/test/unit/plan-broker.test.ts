import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  broadcast: vi.fn(),
  sendToConversation: vi.fn(),
  getLocale: vi.fn(),
}))

vi.mock('../../src/main/window-ipc', () => ({
  broadcast: h.broadcast,
  sendToConversation: h.sendToConversation,
}))
vi.mock('../../src/main/store', () => ({
  getLocale: h.getLocale,
}))

import {
  clearPlan,
  commitPlanDecision,
  decidePlan,
  getPending,
  releasePlanRevision,
  stagePlan,
  stripProposedPlanTag,
} from '../../src/main/plan-broker'

describe('plan-broker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    h.getLocale.mockReturnValue('en')
  })

  afterEach(() => {
    clearPlan('conv-plan')
    clearPlan('conv-chat')
    vi.useRealTimers()
  })

  it('stagePlan (chat) registers and broadcasts the plan without blocking or resolving the promise', () => {
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '## Chat plan' })

    expect(h.sendToConversation).toHaveBeenCalledWith(
      'conv-chat',
      'plan:received',
      expect.objectContaining({ agentId: 'conv-chat', plan: '## Chat plan', version: 1 }),
      { panel: 'plan' }
    )
    expect(getPending('conv-chat')).toEqual(expect.objectContaining({ agentId: 'conv-chat', plan: '## Chat plan' }))
  })

  it('stagePlan (chat): approve returns the edited plan, revise returns feedback, discard clears it', () => {
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '## Original', title: 'Checkout' })
    expect(decidePlan('conv-chat', { action: 'approve', editedPlan: '## Edited' })).toEqual({
      action: 'approve',
      approvedPlan: '## Edited',
      // Version and title key and name a handoff to a new conversation.
      version: 1,
      title: 'Checkout',
    })

    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '## v2' })
    const revised = decidePlan('conv-chat', { action: 'revise', feedback: 'adjust X' })
    expect(revised?.action).toBe('revise')
    expect(revised?.feedbackText).toContain('adjust X')

    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '## v3' })
    expect(decidePlan('conv-chat', { action: 'discard' })).toEqual({ action: 'discard' })
    expect(getPending('conv-chat')).toBeNull()
  })

  it('stagePlan drops the <proposed_plan> wrapper a model puts around the plan', () => {
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '<proposed_plan>\n# Add tests\n\n- step one\n- step two\n</proposed_plan>\n',
    })

    expect(getPending('conv-chat')?.plan).toBe('# Add tests\n\n- step one\n- step two')
    expect(h.sendToConversation).toHaveBeenCalledWith(
      'conv-chat',
      'plan:received',
      expect.objectContaining({ plan: '# Add tests\n\n- step one\n- step two' }),
      { panel: 'plan' }
    )
    // The approved plan, and the next version's diff base, are the cleaned text too.
    expect(decidePlan('conv-chat', { action: 'approve' })).toMatchObject({
      approvedPlan: '# Add tests\n\n- step one\n- step two',
    })
  })

  it('stripProposedPlanTag handles a lone opening or closing tag, keeps the middle and plain plans', () => {
    expect(stripProposedPlanTag('<proposed_plan>\n## Plan\n- one')).toBe('## Plan\n- one')
    expect(stripProposedPlanTag('## Plan\n- one\n</proposed_plan>')).toBe('## Plan\n- one')
    expect(stripProposedPlanTag('  <proposed_plan>## Plan</proposed_plan>  ')).toBe('## Plan')
    expect(stripProposedPlanTag('## Plan\nUse the <proposed_plan> tag as is\n- one')).toBe(
      '## Plan\nUse the <proposed_plan> tag as is\n- one'
    )
    expect(stripProposedPlanTag('## Plan\n- one')).toBe('## Plan\n- one')
    expect(stripProposedPlanTag('<proposed_plan></proposed_plan>')).toBe('<proposed_plan></proposed_plan>')
  })

  it('decidePlan returns null when nothing is pending', () => {
    expect(decidePlan('missing', { action: 'approve' })).toBeNull()
  })

  it('combines general feedback, line comments, and manual edits into the revision feedback', () => {
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '## Original\n- step one\n- step two',
    })

    const result = decidePlan('conv-chat', {
      action: 'revise',
      feedback: 'Include validation',
      lineComments: [{ line: 2, text: 'Expand this step' }],
      editedPlan: '## Edited\n- revised step',
    })

    expect(result).toMatchObject({ action: 'revise', revisionVersion: 1 })
    expect(result).not.toHaveProperty('route')
    expect(result?.feedbackText).toContain('Include validation')
    expect(result?.feedbackText).toContain('step one')
    expect(result?.feedbackText).toContain('Expand this step')
    expect(result?.feedbackText).toContain('## Edited')
  })

  it('revise preserves previousPlan/version; approve and discard restart the cycle', () => {
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v1' })
    decidePlan('conv-chat', { action: 'revise', feedback: 'redo' })
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v2' })
    expect(getPending('conv-chat')).toMatchObject({ version: 2, previousPlan: '# v1' })

    decidePlan('conv-chat', { action: 'approve' })
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# new cycle' })
    expect(getPending('conv-chat')).toMatchObject({ version: 1, previousPlan: null })
    decidePlan('conv-chat', { action: 'discard' })
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# another cycle' })
    expect(getPending('conv-chat')).toMatchObject({ version: 1, previousPlan: null })
  })

  it('a resubmission before the decision supersedes the pending plan and versions the diff', () => {
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# first' })
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# second' })

    expect(getPending('conv-chat')).toMatchObject({ plan: '# second', version: 2, previousPlan: '# first' })
    const received = h.sendToConversation.mock.calls.filter(([, channel]) => channel === 'plan:received')
    expect(received).toHaveLength(2)
    expect(received[1][2]).toMatchObject({ version: 2, previousPlan: '# first' })
    // Only the latest version is decidable, and the decision consumes it.
    expect(decidePlan('conv-chat', { action: 'approve' })).toMatchObject({ approvedPlan: '# second', version: 2 })
    expect(getPending('conv-chat')).toBeNull()
  })

  it('keeps the revision reservation between revise and v2, then consumes it when v2 arrives', () => {
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v1' })
    const decision = decidePlan('conv-chat', { action: 'revise', feedback: 'redo' })
    expect(decision).toMatchObject({ action: 'revise', revisionVersion: 1 })
    expect(getPending('conv-chat')).toBeNull()

    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v2' })
    expect(getPending('conv-chat')).toMatchObject({ version: 2, previousPlan: '# v1' })
    // v2 consumed the reservation: there is nothing left to release.
    expect(releasePlanRevision('conv-chat', 1)).toBe(false)
    expect(releasePlanRevision('conv-chat')).toBe(false)
    expect(getPending('conv-chat')).toMatchObject({ version: 2 })
  })

  it('releases a failed revision so the next plan starts a fresh cycle', () => {
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v1' })
    const first = decidePlan('conv-chat', { action: 'revise' })

    expect(releasePlanRevision('conv-chat', first?.revisionVersion)).toBe(true)
    // Already released: a second release is a no-op.
    expect(releasePlanRevision('conv-chat', first?.revisionVersion)).toBe(false)
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# unrelated' })
    expect(getPending('conv-chat')).toMatchObject({ plan: '# unrelated', version: 1, previousPlan: null })
  })

  it('does not release a revision reservation that belongs to another version', () => {
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v1' })
    decidePlan('conv-chat', { action: 'revise' })
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v2' })
    const second = decidePlan('conv-chat', { action: 'revise' })
    expect(second?.revisionVersion).toBe(2)

    // A stale cleanup from the first revision must not clear the later reservation.
    expect(releasePlanRevision('conv-chat', 1)).toBe(false)
    expect(releasePlanRevision('conv-chat', 2)).toBe(true)
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# restart' })
    expect(getPending('conv-chat')).toMatchObject({ version: 1, previousPlan: null })
  })

  it('releasePlanRevision without an expected version releases the current reservation', () => {
    expect(releasePlanRevision('conv-chat')).toBe(false)
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v1' })
    decidePlan('conv-chat', { action: 'revise' })

    expect(releasePlanRevision('conv-chat')).toBe(true)
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v1 again' })
    expect(getPending('conv-chat')).toMatchObject({ version: 1, previousPlan: null })
  })

  it('clearPlan drops the pending plan, the reservation and the version history', () => {
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v1' })
    clearPlan('conv-chat')
    expect(getPending('conv-chat')).toBeNull()
    expect(decidePlan('conv-chat', { action: 'approve' })).toBeNull()

    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v1' })
    decidePlan('conv-chat', { action: 'revise' })
    clearPlan('conv-chat')
    expect(releasePlanRevision('conv-chat')).toBe(false)
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# fresh' })
    expect(getPending('conv-chat')).toMatchObject({ version: 1, previousPlan: null })
  })

  it('deferred decisions remain pending until they are committed', () => {
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# plan' })

    expect(decidePlan('conv-chat', { action: 'revise', feedback: 'retry' }, { deferCommit: true })).toMatchObject({
      action: 'revise',
    })
    expect(getPending('conv-chat')).toMatchObject({ plan: '# plan' })
    h.sendToConversation.mockClear()

    expect(decidePlan('conv-chat', { action: 'discard' }, { deferCommit: true })).toEqual({ action: 'discard' })
    expect(getPending('conv-chat')).toMatchObject({ plan: '# plan' })
    expect(h.sendToConversation).not.toHaveBeenCalled()

    expect(commitPlanDecision('conv-chat', 'discard')).toBe(true)
    expect(getPending('conv-chat')).toBeNull()
    expect(h.sendToConversation).toHaveBeenCalledWith('conv-chat', 'plan:cleared', { agentId: 'conv-chat' }, {
      panel: 'plan',
    })
    // A second commit has nothing left to finalize.
    expect(commitPlanDecision('conv-chat', 'discard')).toBe(false)
  })
})
