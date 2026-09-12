import { randomBytes } from 'node:crypto'

export const MAX_PLAN_REVIEW_WAIT_SECONDS = 60
const DEFAULT_PLAN_REVIEW_WAIT_SECONDS = 30
const MAX_COMPLETED_REVIEWS = 256
const MAX_PENDING_REVIEWS = 256

export type PlanReviewTerminalOutcome =
  | { status: 'revise'; feedbackText: string }
  | { status: 'approved' }
  | { status: 'discarded' }
  | { status: 'superseded' }
  | { status: 'cancelled' }

export type PlanReviewOutcome = { status: 'waiting' } | PlanReviewTerminalOutcome

export type PlanReviewErrorCode =
  | 'plan-review-not-found'
  | 'plan-review-already-resolved'
  | 'plan-review-wait-aborted'
  | 'plan-review-controller-disposed'
  | 'plan-review-delivery-conflict'

export class PlanReviewError extends Error {
  readonly code: PlanReviewErrorCode

  constructor(code: PlanReviewErrorCode) {
    super(code)
    this.name = 'PlanReviewError'
    this.code = code
  }
}

interface ReviewWaiter {
  resolve: (outcome: PlanReviewTerminalOutcome) => void
  reject: (error: PlanReviewError) => void
}

interface ReviewEntry {
  reviewId: string
  idempotencyKey: string
  deliveryFingerprint?: string
  delivered: boolean
  outcome: PlanReviewTerminalOutcome | null
  waiters: Set<ReviewWaiter>
}

export interface PlanReviewResolution {
  ok: boolean
  error?: PlanReviewErrorCode
}

export interface PlanReviewController {
  create(idempotencyKey: string, deliveryFingerprint?: string): string
  isDelivered(reviewId: string): boolean
  markDelivered(reviewId: string): PlanReviewResolution
  wait(reviewId: string, signal?: AbortSignal, waitSeconds?: number): Promise<PlanReviewOutcome>
  resolve(reviewId: string, outcome: PlanReviewTerminalOutcome): PlanReviewResolution
  dispose(): void
  stats(): { reviews: number; pending: number; waiters: number; disposed: boolean }
}

/**
 * In-memory channel for human decisions in the Plan tab. Each instance belongs to one conversation;
 * unknown IDs and IDs from other conversations return the same error without revealing ownership.
 */
export function createPlanReviewController(onDispose?: () => void): PlanReviewController {
  const reviews = new Map<string, ReviewEntry>()
  const reviewIdByDeliveryKey = new Map<string, string>()
  let disposed = false

  const settle = (entry: ReviewEntry, outcome: PlanReviewTerminalOutcome): void => {
    entry.outcome = outcome
    for (const waiter of [...entry.waiters]) waiter.resolve(outcome)
    entry.waiters.clear()
  }

  const pruneCompleted = (): void => {
    let completed = [...reviews.values()].filter((entry) => entry.outcome !== null).length
    if (completed <= MAX_COMPLETED_REVIEWS) return
    for (const [reviewId, entry] of reviews) {
      if (!entry.outcome) continue
      reviews.delete(reviewId)
      if (reviewIdByDeliveryKey.get(entry.idempotencyKey) === reviewId) {
        reviewIdByDeliveryKey.delete(entry.idempotencyKey)
      }
      completed--
      if (completed <= MAX_COMPLETED_REVIEWS) break
    }
  }

  const create = (idempotencyKey: string, deliveryFingerprint?: string): string => {
    if (disposed) throw new PlanReviewError('plan-review-controller-disposed')
    const existing = reviewIdByDeliveryKey.get(idempotencyKey)
    if (existing) {
      const entry = reviews.get(existing)
      if (entry) {
        if (entry.deliveryFingerprint && deliveryFingerprint && entry.deliveryFingerprint !== deliveryFingerprint) {
          throw new PlanReviewError('plan-review-delivery-conflict')
        }
        return existing
      }
    }

    const pendingEntries = [...reviews.values()].filter((entry) => !entry.outcome)
    if (pendingEntries.length >= MAX_PENDING_REVIEWS) {
      settle(pendingEntries[0], { status: 'cancelled' })
      pruneCompleted()
    }

    const reviewId = `pr_${randomBytes(16).toString('hex')}`
    reviews.set(reviewId, {
      reviewId,
      idempotencyKey,
      deliveryFingerprint,
      delivered: false,
      outcome: null,
      waiters: new Set(),
    })
    reviewIdByDeliveryKey.set(idempotencyKey, reviewId)
    return reviewId
  }

  const isDelivered = (reviewId: string): boolean => reviews.get(reviewId)?.delivered === true

  const markDelivered = (reviewId: string): PlanReviewResolution => {
    if (disposed) return { ok: false, error: 'plan-review-controller-disposed' }
    const entry = reviews.get(reviewId)
    if (!entry) return { ok: false, error: 'plan-review-not-found' }
    entry.delivered = true
    return { ok: true }
  }

  const wait = (
    reviewId: string,
    signal?: AbortSignal,
    waitSeconds = DEFAULT_PLAN_REVIEW_WAIT_SECONDS
  ): Promise<PlanReviewOutcome> => {
    if (disposed) return Promise.reject(new PlanReviewError('plan-review-controller-disposed'))
    const entry = reviews.get(reviewId)
    if (!entry) return Promise.reject(new PlanReviewError('plan-review-not-found'))
    if (entry.outcome) return Promise.resolve(entry.outcome)
    if (signal?.aborted) return Promise.reject(new PlanReviewError('plan-review-wait-aborted'))

    const boundedSeconds = Math.min(
      MAX_PLAN_REVIEW_WAIT_SECONDS,
      Math.max(1, Number.isSafeInteger(waitSeconds) ? waitSeconds : DEFAULT_PLAN_REVIEW_WAIT_SECONDS)
    )
    return new Promise<PlanReviewOutcome>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        entry.waiters.delete(waiter)
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (outcome: PlanReviewOutcome) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(outcome)
      }
      const fail = (error: PlanReviewError) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const waiter: ReviewWaiter = { resolve: finish, reject: fail }
      const onAbort = () => fail(new PlanReviewError('plan-review-wait-aborted'))
      const timer = setTimeout(() => finish({ status: 'waiting' }), boundedSeconds * 1000)
      entry.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  const resolve = (reviewId: string, outcome: PlanReviewTerminalOutcome): PlanReviewResolution => {
    if (disposed) return { ok: false, error: 'plan-review-controller-disposed' }
    const entry = reviews.get(reviewId)
    if (!entry) return { ok: false, error: 'plan-review-not-found' }
    if (entry.outcome) {
      return JSON.stringify(entry.outcome) === JSON.stringify(outcome)
        ? { ok: true }
        : { ok: false, error: 'plan-review-already-resolved' }
    }
    settle(entry, outcome)
    pruneCompleted()
    return { ok: true }
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    const error = new PlanReviewError('plan-review-controller-disposed')
    for (const entry of reviews.values()) {
      for (const waiter of [...entry.waiters]) waiter.reject(error)
      entry.waiters.clear()
    }
    reviews.clear()
    reviewIdByDeliveryKey.clear()
    try {
      onDispose?.()
    } catch {
      // A broken lifecycle sink must not prevent controller disposal.
    }
  }

  return {
    create,
    isDelivered,
    markDelivered,
    wait,
    resolve,
    dispose,
    stats: () => ({
      reviews: reviews.size,
      pending: [...reviews.values()].filter((entry) => !entry.outcome).length,
      waiters: [...reviews.values()].reduce((total, entry) => total + entry.waiters.size, 0),
      disposed,
    }),
  }
}
