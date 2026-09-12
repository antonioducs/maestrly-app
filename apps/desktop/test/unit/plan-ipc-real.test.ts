import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPlan, getPending, stagePlan } from '../../src/main/plan-broker'
import { createTestRegistrar } from './ipc-registrar-test-utils'

const h = vi.hoisted(() => ({
  sendToConversation: vi.fn(),
  getLocale: vi.fn(() => 'en'),
  getConversation: vi.fn(),
  resolvePlanReview: vi.fn(),
  runApprovedPlan: vi.fn(),
  runPlanRevision: vi.fn(),
  setChatMode: vi.fn(),
}))

vi.mock('../../src/main/window-ipc', () => ({
  sendToConversation: h.sendToConversation,
  broadcast: vi.fn(),
}))
vi.mock('../../src/main/store', () => ({
  getLocale: h.getLocale,
  getConversation: h.getConversation,
}))
vi.mock('../../src/main/floating-manager', () => ({
  focusFloatIfAny: vi.fn(() => false),
}))
vi.mock('../../src/main/git-service', () => ({
  excludeFromGitInfo: vi.fn(),
}))
vi.mock('../../src/main/platform', () => ({
  toForwardSlashes: vi.fn((value: string) => value.replace(/\\/g, '/')),
}))
vi.mock('../../src/main/chat/service', () => ({
  runApprovedPlan: h.runApprovedPlan,
  runPlanRevision: h.runPlanRevision,
  setChatMode: h.setChatMode,
}))

import { registerPlanIpc } from '../../src/main/plan-ipc'

describe('plan IPC with a real broker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.getConversation.mockReturnValue({ cli: 'chat' })
    h.resolvePlanReview.mockReturnValue({ ok: false, error: 'plan-review-unavailable' })
  })

  afterEach(() => {
    clearPlan('conv-web-real')
    clearPlan('conv-maestro-real')
  })

  it('keeps the Web plan visible after external resolution fails and clears it only after an accepted retry', () => {
    stagePlan({
      agentId: 'conv-web-real',
      cwd: '/tmp/project',
      plan: '# Web plan',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_real' },
    })
    const { reg, mhandles } = createTestRegistrar()
    registerPlanIpc(reg, {
      sendToWindow: vi.fn(),
      resolveChatGptWebPlanReview: h.resolvePlanReview,
    })

    const decide = mhandles.get('plan:decide')!
    expect(decide({} as never, 'conv-web-real', { action: 'revise', feedback: 'retry' })).toEqual({
      ok: false,
      error: 'plan-review-unavailable',
    })
    expect(getPending('conv-web-real')).toMatchObject({ plan: '# Web plan', version: 1 })
    expect(h.sendToConversation.mock.calls.some(([, channel]) => channel === 'plan:cleared')).toBe(false)

    h.resolvePlanReview.mockReturnValue({ ok: true })
    expect(decide({} as never, 'conv-web-real', { action: 'revise', feedback: 'retry' })).toEqual({ ok: true })
    expect(getPending('conv-web-real')).toBeNull()
  })

  it('keeps the local plan visible when the Maestro conversation cannot be created', async () => {
    stagePlan({
      agentId: 'conv-maestro-real',
      cwd: '/tmp/project',
      plan: '# Maestro plan',
    })
    h.getConversation.mockReturnValue({
      id: 'conv-maestro-real',
      name: 'Feature',
      experience: 'standard',
    })
    const createMaestroSibling = vi.fn().mockRejectedValue(new Error('sibling-blocked'))
    const { reg, mhandles } = createTestRegistrar()
    registerPlanIpc(reg, {
      sendToWindow: vi.fn(),
      createMaestroSibling,
      deleteConversation: vi.fn(),
      applyMaestroStrategyProfile: vi.fn().mockResolvedValue({ ok: true }),
    })

    await expect(
      mhandles.get('plan:decide')?.({} as never, 'conv-maestro-real', {
        action: 'approve',
        implementationTarget: 'maestro',
      })
    ).resolves.toEqual({ ok: false, error: 'sibling-blocked' })

    expect(getPending('conv-maestro-real')).toMatchObject({ plan: '# Maestro plan', version: 1 })
    expect(h.runApprovedPlan).not.toHaveBeenCalled()
  })
})
