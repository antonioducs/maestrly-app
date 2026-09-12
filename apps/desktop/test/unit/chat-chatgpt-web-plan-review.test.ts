import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlanReviewController, PlanReviewError } from '../../src/main/chat/chatgpt-web/plan-review'

describe('ChatGPT Web plan review controller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('notifies permanent discard exactly once', () => {
    const onDispose = vi.fn()
    const controller = createPlanReviewController(onDispose)

    controller.dispose()
    controller.dispose()

    expect(onDispose).toHaveBeenCalledOnce()
  })

  it('deduplicates by delivery key, separates versions, and keeps terminal outcomes readable', async () => {
    const controller = createPlanReviewController()
    const first = controller.create('delivery-plan-v1')
    expect(controller.create('delivery-plan-v1')).toBe(first)
    const second = controller.create('delivery-plan-v2')
    expect(second).not.toBe(first)

    expect(controller.resolve(first, { status: 'revise', feedbackText: 'adjustment' })).toEqual({ ok: true })
    await expect(controller.wait(first)).resolves.toEqual({ status: 'revise', feedbackText: 'adjustment' })
    await expect(controller.wait(first)).resolves.toEqual({ status: 'revise', feedbackText: 'adjustment' })
    expect(controller.stats()).toMatchObject({ reviews: 2, pending: 1, waiters: 0 })
  })

  it('bounds long polling and removes the waiter on timeout', async () => {
    const controller = createPlanReviewController()
    const reviewId = controller.create('delivery-waiting')
    const waiting = controller.wait(reviewId, undefined, 1)
    expect(controller.stats().waiters).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(waiting).resolves.toEqual({ status: 'waiting' })
    expect(controller.stats().waiters).toBe(0)
  })

  it('wakes waiters on approve/discard and rejects unknown IDs without leaking conversations', async () => {
    const controller = createPlanReviewController()
    const approveId = controller.create('delivery-approve')
    const discardId = controller.create('delivery-discard')
    const approved = controller.wait(approveId)
    const discarded = controller.wait(discardId)

    controller.resolve(approveId, { status: 'approved' })
    controller.resolve(discardId, { status: 'discarded' })

    await expect(approved).resolves.toEqual({ status: 'approved' })
    await expect(discarded).resolves.toEqual({ status: 'discarded' })
    await expect(controller.wait('pr_from_another_conversation')).rejects.toMatchObject({
      code: 'plan-review-not-found',
    })
  })

  it('lifecycle abort and dispose clear waiters/promises while retaining outcomes until disposal', async () => {
    const controller = createPlanReviewController()
    const reviewId = controller.create('delivery-abort')
    const signal = new AbortController()
    const waiting = controller.wait(reviewId, signal.signal)
    signal.abort()
    await expect(waiting).rejects.toEqual(expect.any(PlanReviewError))
    expect(controller.stats().waiters).toBe(0)

    const pendingId = controller.create('delivery-dispose')
    const pending = controller.wait(pendingId)
    controller.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'plan-review-controller-disposed' })
    expect(controller.stats()).toEqual({ reviews: 0, pending: 0, waiters: 0, disposed: true })
  })
})
