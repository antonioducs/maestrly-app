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
  stopChatAndWait: vi.fn(async () => true),
  pauseBotForHuman: vi.fn(),
  botSharesConversation: vi.fn(() => false),
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
  stopChatAndWait: h.stopChatAndWait,
}))
vi.mock('../../src/main/bot/control', () => ({
  pauseBotForHuman: h.pauseBotForHuman,
  botSharesConversation: h.botSharesConversation,
}))

import { registerPlanIpc } from '../../src/main/plan-ipc'

describe('plan IPC with a real broker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.getConversation.mockReturnValue({ cli: 'chat' })
    h.stopChatAndWait.mockResolvedValue(true)
    h.botSharesConversation.mockReturnValue(false)
    h.resolvePlanReview.mockReturnValue({ ok: false, error: 'plan-review-unavailable' })
  })

  afterEach(() => {
    clearPlan('conv-web-real')
    clearPlan('conv-maestro-real')
    clearPlan('conv-standard-real')
  })

  it('keeps the Web plan visible after external resolution fails and clears it only after an accepted retry', async () => {
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
    expect(await decide({} as never, 'conv-web-real', { action: 'revise', feedback: 'retry' })).toEqual({
      ok: false,
      error: 'plan-review-unavailable',
    })
    expect(getPending('conv-web-real')).toMatchObject({ plan: '# Web plan', version: 1 })
    expect(h.sendToConversation.mock.calls.some(([, channel]) => channel === 'plan:cleared')).toBe(false)

    h.resolvePlanReview.mockReturnValue({ ok: true })
    expect(await decide({} as never, 'conv-web-real', { action: 'revise', feedback: 'retry' })).toEqual({ ok: true })
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

  it('keeps the plan pending until a Standard destination exists, then delivers the edited plan exactly once', async () => {
    stagePlan({ agentId: 'conv-standard-real', cwd: '/tmp/project', plan: '# Original', title: 'Checkout' })
    h.getConversation.mockReturnValue({ id: 'conv-standard-real', scope: 'project', name: 'Feature' })
    const prepareStandardPlanHandoff = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Model "gone" is not available.' })
      .mockResolvedValue({ ok: true, dispatchId: 'dispatch-1', conversationId: 'conv-new' })
    const startStandardPlanHandoff = vi.fn(async () => undefined)
    const { reg, mhandles } = createTestRegistrar()
    registerPlanIpc(reg, {
      sendToWindow: vi.fn(),
      prepareStandardPlanHandoff,
      discardStandardPlanHandoff: vi.fn(async () => undefined),
      startStandardPlanHandoff,
    })
    const decision = {
      action: 'approve',
      implementationTarget: 'standard',
      editedPlan: '# Edited',
      standardHandoff: {
        settings: { providerId: 'claude', modelId: 'gone', reasoning: 'off', fastMode: false },
        placement: 'shared',
      },
    }

    await expect(mhandles.get('plan:decide')?.({} as never, 'conv-standard-real', decision)).resolves.toEqual({
      ok: false,
      error: 'Model "gone" is not available.',
    })
    expect(getPending('conv-standard-real')).toMatchObject({ plan: '# Original', version: 1 })

    await expect(mhandles.get('plan:decide')?.({} as never, 'conv-standard-real', decision)).resolves.toEqual({
      ok: true,
      conversationId: 'conv-new',
    })
    expect(getPending('conv-standard-real')).toBeNull()
    expect(prepareStandardPlanHandoff).toHaveBeenLastCalledWith(
      expect.objectContaining({ plan: '# Edited', title: 'Checkout', planKey: expect.stringMatching(/^plan:1:/) })
    )
    expect(startStandardPlanHandoff).toHaveBeenCalledExactlyOnceWith('dispatch-1')
    expect(h.runApprovedPlan).not.toHaveBeenCalled()
    expect(h.setChatMode).not.toHaveBeenCalled()
  })

  it.each([
    ['a chat the person never released', false, 1],
    ['a chat they released for their own messages', true, 0],
  ])('decides a plan in %s without changing who holds it', async (_case, shared, pauses) => {
    h.getConversation.mockReturnValue({ cwd: '/tmp/project', botOrigin: { kind: 'bot', botName: 'Grok Bot' } })
    h.botSharesConversation.mockReturnValue(shared)
    stagePlan({ agentId: 'conv-bot-real', cwd: '/tmp/project', plan: '# Bot plan' })
    const { reg, mhandles } = createTestRegistrar()
    registerPlanIpc(reg, { sendToWindow: vi.fn() })

    await mhandles.get('plan:decide')?.({} as never, 'conv-bot-real', { action: 'approve' })

    // Either way the turn under way is stopped before the approved plan runs.
    expect(h.stopChatAndWait).toHaveBeenCalledWith('conv-bot-real')
    expect(h.pauseBotForHuman).toHaveBeenCalledTimes(pauses)
    expect(h.runApprovedPlan).toHaveBeenCalled()
    clearPlan('conv-bot-real')
  })
})
