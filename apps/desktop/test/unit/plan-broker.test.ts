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

import { clearPlan, decidePlan, getPending, releasePlanRevision, stagePlan } from '../../src/main/plan-broker'
import { createChatGptWebSession } from '../../src/main/chat/chatgpt-web/session'

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
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '## Original' })
    expect(decidePlan('conv-chat', { action: 'approve', editedPlan: '## Edited' })).toEqual({
      action: 'approve',
      approvedPlan: '## Edited',
    })

    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '## v2' })
    const revised = decidePlan('conv-chat', { action: 'revise', feedback: 'adjust X' })
    expect(revised?.action).toBe('revise')
    expect(revised?.feedbackText).toContain('adjust X')

    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '## v3' })
    expect(decidePlan('conv-chat', { action: 'discard' })).toEqual({ action: 'discard' })
    expect(getPending('conv-chat')).toBeNull()
  })

  it('decidePlan returns null when nothing is pending', () => {
    expect(decidePlan('missing', { action: 'approve' })).toBeNull()
  })

  it('freezes Web origin and combines general feedback, line comments, and manual edits', () => {
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '## Original\n- step one\n- step two',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_web_v1' },
    })

    const result = decidePlan('conv-chat', {
      action: 'revise',
      feedback: 'Include validation',
      lineComments: [{ line: 2, text: 'Expand this step' }],
      editedPlan: '## Edited\n- revised step',
    })

    expect(result).toMatchObject({
      action: 'revise',
      route: { kind: 'chatgpt-web', reviewId: 'pr_web_v1' },
    })
    expect(result?.feedbackText).toContain('Include validation')
    expect(result?.feedbackText).toContain('step one')
    expect(result?.feedbackText).toContain('Expand this step')
    expect(result?.feedbackText).toContain('## Edited')
  })

  it('revise preserves previousPlan/version; approve and discard restart the cycle', () => {
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# v1',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_v1' },
    })
    decidePlan('conv-chat', { action: 'revise', feedback: 'redo' })
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# v2',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_v2' },
    })
    expect(getPending('conv-chat')).toMatchObject({ version: 2, previousPlan: '# v1' })

    decidePlan('conv-chat', { action: 'approve' })
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# new cycle' })
    expect(getPending('conv-chat')).toMatchObject({ version: 1, previousPlan: null })
    decidePlan('conv-chat', { action: 'discard' })
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# another cycle' })
    expect(getPending('conv-chat')).toMatchObject({ version: 1, previousPlan: null })
  })

  it('rejects Maestrly over pending Web while allowing same-origin supersession', () => {
    const firstLifecycle = vi.fn()
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# web',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_old' },
      onLifecycle: firstLifecycle,
    })
    expect(stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# maestrly' })).toEqual({
      ok: false,
      error: 'plan-origin-conflict',
    })
    expect(firstLifecycle).not.toHaveBeenCalled()
    expect(getPending('conv-chat')).toMatchObject({ plan: '# web', version: 1, previousPlan: null })

    expect(
      stagePlan({
        agentId: 'conv-chat',
        cwd: '/tmp/project',
        plan: '# new web',
        origin: { kind: 'chatgpt-web', reviewId: 'pr_new' },
        onLifecycle: firstLifecycle,
      })
    ).toEqual({ ok: true })
    expect(firstLifecycle).toHaveBeenCalledExactlyOnceWith('superseded')
    expect(getPending('conv-chat')).toMatchObject({ plan: '# new web', version: 2, previousPlan: '# web' })
  })

  it('rejects Web over pending Maestrly without destroying it', () => {
    const webLifecycle = vi.fn()
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# maestrly' })
    expect(
      stagePlan({
        agentId: 'conv-chat',
        cwd: '/tmp/project',
        plan: '# web',
        origin: { kind: 'chatgpt-web', reviewId: 'pr_web' },
        onLifecycle: webLifecycle,
      })
    ).toEqual({ ok: false, error: 'plan-origin-conflict' })
    expect(webLifecycle).not.toHaveBeenCalled()
    expect(getPending('conv-chat')).toMatchObject({ plan: '# maestrly', version: 1, previousPlan: null })
  })

  it('preserves the Web reservation between revision and v2, then consumes it when Web v2 arrives', () => {
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# web v1',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_web_v1' },
    })
    decidePlan('conv-chat', { action: 'revise', feedback: 'redo' })

    expect(stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# maestrly' })).toEqual({
      ok: false,
      error: 'plan-origin-conflict',
    })
    expect(
      stagePlan({
        agentId: 'conv-chat',
        cwd: '/tmp/project',
        plan: '# web v2',
        origin: { kind: 'chatgpt-web', reviewId: 'pr_web_v2' },
      })
    ).toEqual({ ok: true })
    expect(getPending('conv-chat')).toMatchObject({ version: 2, previousPlan: '# web v1' })
  })

  it('preserves the Maestrly reservation between revision and v2, then consumes it when Maestrly v2 arrives', () => {
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# maestrly v1' })
    const decision = decidePlan('conv-chat', { action: 'revise', feedback: 'redo' })
    expect(decision).toMatchObject({ action: 'revise', revisionVersion: 1 })

    expect(
      stagePlan({
        agentId: 'conv-chat',
        cwd: '/tmp/project',
        plan: '# web',
        origin: { kind: 'chatgpt-web', reviewId: 'pr_web_during_revision' },
      })
    ).toEqual({ ok: false, error: 'plan-origin-conflict' })
    expect(stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# maestrly v2' })).toEqual({ ok: true })
    expect(getPending('conv-chat')).toMatchObject({ version: 2, previousPlan: '# maestrly v1' })
  })

  it('releases the versioned reservation on failure without clearing a later revision reservation', () => {
    stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# v1' })
    const first = decidePlan('conv-chat', { action: 'revise' })
    expect(releasePlanRevision('conv-chat', 'maestrly-chat', first?.revisionVersion)).toBe(true)
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# web v1',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_web_v1' },
    })
    decidePlan('conv-chat', { action: 'revise' })
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# web v2',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_web_v2' },
    })
    decidePlan('conv-chat', { action: 'revise' })
    expect(releasePlanRevision('conv-chat', 'chatgpt-web', 1)).toBe(false)
    expect(stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# maestrly' })).toEqual({
      ok: false,
      error: 'plan-origin-conflict',
    })
    expect(releasePlanRevision('conv-chat', 'chatgpt-web', 2)).toBe(true)
    expect(stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# maestrly' })).toEqual({ ok: true })
  })

  it('origin-scoped release preserves the opposite reservation', () => {
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# web v1',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_web_cleanup' },
    })
    const webRevision = decidePlan('conv-chat', { action: 'revise' })

    expect(releasePlanRevision('conv-chat', 'maestrly-chat', webRevision?.revisionVersion)).toBe(false)
    expect(stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# maestrly' })).toEqual({
      ok: false,
      error: 'plan-origin-conflict',
    })
    expect(releasePlanRevision('conv-chat', 'chatgpt-web', webRevision?.revisionVersion)).toBe(true)
    expect(stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# maestrly' })).toEqual({ ok: true })

    const maestrlyRevision = decidePlan('conv-chat', { action: 'revise' })
    expect(releasePlanRevision('conv-chat', 'chatgpt-web', maestrlyRevision?.revisionVersion)).toBe(false)
    expect(stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# web during Maestrly cleanup',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_web_during_maestrly' },
    })).toEqual({
      ok: false,
      error: 'plan-origin-conflict',
    })
    expect(releasePlanRevision('conv-chat', 'maestrly-chat', maestrlyRevision?.revisionVersion)).toBe(true)
    expect(stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# web after Maestrly cleanup',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_web_after_maestrly' },
    })).toEqual({ ok: true })
  })

  it('Web turnCompleted releases an abandoned Web reservation but preserves a Maestrly reservation', async () => {
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# web abandonado',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_web_abandoned' },
    })
    decidePlan('conv-chat', { action: 'revise' })
    const webSession = createChatGptWebSession({
      conversationId: 'conv-chat',
      cwd: '/tmp/project',
      onTurnCompleted: () => releasePlanRevision('conv-chat', 'chatgpt-web'),
    })
    try {
      await webSession.bridge.callTool('notify_turn_complete', { idempotency_key: 'web-abandoned-turn' })
      expect(stagePlan({ agentId: 'conv-chat', cwd: '/tmp/project', plan: '# maestrly desbloqueado' })).toEqual({
        ok: true,
      })
    } finally {
      webSession.end()
    }

    decidePlan('conv-chat', { action: 'revise' })
    expect(getPending('conv-chat')).toBeNull()
    const secondWebSession = createChatGptWebSession({
      conversationId: 'conv-chat',
      cwd: '/tmp/project',
      onTurnCompleted: () => releasePlanRevision('conv-chat', 'chatgpt-web'),
    })
    try {
      await secondWebSession.bridge.callTool('notify_turn_complete', { idempotency_key: 'web-during-maestrly' })
      expect(stagePlan({
        agentId: 'conv-chat',
        cwd: '/tmp/project',
        plan: '# Web blocked by Maestrly reservation',
        origin: { kind: 'chatgpt-web', reviewId: 'pr_web_during_maestrly' },
      })).toEqual({
        ok: false,
        error: 'plan-origin-conflict',
      })
    } finally {
      secondWebSession.end()
    }
  })

  it('clear closes the matching Web waiter', () => {
    const lifecycle = vi.fn()
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# web',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_new' },
      onLifecycle: lifecycle,
    })
    clearPlan('conv-chat')
    expect(lifecycle).toHaveBeenCalledExactlyOnceWith('cancelled')
  })

  it('deferred decisions remain pending until external confirmation', () => {
    stagePlan({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# web',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_deferred' },
    })

    expect(decidePlan('conv-chat', { action: 'revise', feedback: 'retry' }, { deferCommit: true })).toMatchObject({
      action: 'revise',
      route: { kind: 'chatgpt-web', reviewId: 'pr_deferred' },
    })
    expect(getPending('conv-chat')).toMatchObject({ plan: '# web' })
    expect(decidePlan('conv-chat', { action: 'discard' })).toBeTruthy()
    expect(getPending('conv-chat')).toBeNull()
  })
})
