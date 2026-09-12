export type ReviewLoopDriverId = string

export interface ReviewLoopParticipant {
  /** Driver that owns this participant (for example, a web or local-conversation driver). */
  driver: ReviewLoopDriverId
  conversationId: string
}

export type ReviewLoopParticipants = (
  | readonly [ReviewLoopParticipant]
  | readonly [ReviewLoopParticipant, ReviewLoopParticipant]
) & {
  /** Stable role projection for neutral callers; tuple indexing remains backward compatible. */
  readonly executor: string
  readonly reviewer?: string
}

export type ReviewLoopReservationInput =
  | {
      loopId: string
      driver?: ReviewLoopDriverId
      cwd?: string
      participants:
        | readonly [ReviewLoopParticipant]
        | readonly [ReviewLoopParticipant, ReviewLoopParticipant]
    }
  | {
      loopId: string
      driver: ReviewLoopDriverId
      cwd: string
      participants: { executor: string; reviewer?: string }
    }

export interface ReviewLoopReservation {
  loopId: string
  driver: ReviewLoopDriverId
  cwd: string
  participants: ReviewLoopParticipants
}

export type ReviewLoopReservationError =
  | 'invalid-loop-id'
  | 'invalid-participant'
  | 'duplicate-participant'
  | 'loop-already-reserved'
  | 'conversation-already-reserved'

export type ReviewLoopReservationResult =
  | { ok: true; reservation: ReviewLoopReservation }
  | {
      ok: false
      error: ReviewLoopReservationError
      conflictingLoopId?: string
      conflictingConversationId?: string
    }

function isParticipantArray(
  value: ReviewLoopReservationInput['participants']
): value is readonly [ReviewLoopParticipant] | readonly [ReviewLoopParticipant, ReviewLoopParticipant] {
  return Array.isArray(value)
}

function sameParticipants(left: ReviewLoopParticipants, right: ReviewLoopParticipants): boolean {
  return (
    left.length === right.length &&
    left.every(
      (participant, index) =>
        participant.conversationId === right[index]?.conversationId && participant.driver === right[index]?.driver
    )
  )
}

function freezeReservation(
  loopId: string,
  driver: string,
  cwd: string,
  participants: readonly ReviewLoopParticipant[]
): ReviewLoopReservation {
  const normalized = participants.map((participant) =>
    Object.freeze({ driver: participant.driver.trim(), conversationId: participant.conversationId.trim() })
  ) as unknown as ReviewLoopParticipants
  Object.defineProperty(normalized, 'executor', { value: normalized[0].conversationId, enumerable: false })
  if (normalized[1]) {
    Object.defineProperty(normalized, 'reviewer', { value: normalized[1].conversationId, enumerable: false })
  }
  Object.freeze(normalized)
  return Object.freeze({ loopId: loopId.trim(), driver: driver.trim(), cwd: cwd.trim(), participants: normalized })
}

/**
 * Process-local admission registry shared by review-loop drivers. A reservation validates every participant
 * before updating either index, so a two-conversation acquisition can never be partially installed.
 */
export class ReviewLoopRegistry {
  readonly #byConversation = new Map<string, ReviewLoopReservation>()
  readonly #byLoop = new Map<string, ReviewLoopReservation>()

  reserve(input: ReviewLoopReservationInput): ReviewLoopReservationResult {
    const loopId = input.loopId.trim()
    if (!loopId) return { ok: false, error: 'invalid-loop-id' }
    const namedParticipants = isParticipantArray(input.participants) ? null : input.participants
    const inputDriver = ('driver' in input ? input.driver : undefined)?.trim() ?? ''
    const inputCwd = ('cwd' in input ? input.cwd : undefined)?.trim() ?? ''
    const rawParticipants: readonly ReviewLoopParticipant[] = namedParticipants
      ? [
          { driver: inputDriver, conversationId: namedParticipants.executor },
          ...(namedParticipants.reviewer
            ? [{ driver: inputDriver, conversationId: namedParticipants.reviewer }]
            : []),
        ]
      : (input.participants as readonly ReviewLoopParticipant[])
    if (rawParticipants.length !== 1 && rawParticipants.length !== 2) {
      return { ok: false, error: 'invalid-participant' }
    }

    const participants = rawParticipants.map((participant) => ({
      driver: participant.driver.trim(),
      conversationId: participant.conversationId.trim(),
    })) as unknown as ReviewLoopParticipants
    if (participants.some((participant) => !participant.driver || !participant.conversationId)) {
      return { ok: false, error: 'invalid-participant' }
    }
    if (inputDriver && participants.some((participant) => participant.driver !== inputDriver)) {
      return { ok: false, error: 'invalid-participant' }
    }
    if (participants.length === 2 && participants[0].conversationId === participants[1].conversationId) {
      return {
        ok: false,
        error: 'duplicate-participant',
        conflictingConversationId: participants[0].conversationId,
      }
    }

    const loopConflict = this.#byLoop.get(loopId)
    if (loopConflict) {
      if (
        sameParticipants(loopConflict.participants, participants) &&
        loopConflict.driver === (inputDriver || participants[0].driver) &&
        loopConflict.cwd === inputCwd
      ) {
        return { ok: true, reservation: loopConflict }
      }
      return { ok: false, error: 'loop-already-reserved', conflictingLoopId: loopConflict.loopId }
    }

    // Check every participant first. No index is mutated until the complete acquisition is known to succeed.
    for (const participant of participants) {
      const conflict = this.#byConversation.get(participant.conversationId)
      if (conflict) {
        return {
          ok: false,
          error: 'conversation-already-reserved',
          conflictingLoopId: conflict.loopId,
          conflictingConversationId: participant.conversationId,
        }
      }
    }

    const reservation = freezeReservation(loopId, inputDriver || participants[0].driver, inputCwd, participants)
    this.#byLoop.set(loopId, reservation)
    for (const participant of reservation.participants) {
      this.#byConversation.set(participant.conversationId, reservation)
    }
    return { ok: true, reservation }
  }

  getByConversation(conversationId: string): ReviewLoopReservation | null {
    return this.#byConversation.get(conversationId.trim()) ?? null
  }

  getByLoop(loopId: string): ReviewLoopReservation | null {
    return this.#byLoop.get(loopId.trim()) ?? null
  }

  release(loopId: string): boolean {
    const reservation = this.#byLoop.get(loopId.trim())
    if (!reservation) return false
    this.#byLoop.delete(reservation.loopId)
    for (const participant of reservation.participants) {
      if (this.#byConversation.get(participant.conversationId) === reservation) {
        this.#byConversation.delete(participant.conversationId)
      }
    }
    return true
  }

  reset(): void {
    this.#byConversation.clear()
    this.#byLoop.clear()
  }
}

const globalRegistry = new ReviewLoopRegistry()

export function reserveReviewLoop(input: ReviewLoopReservationInput): ReviewLoopReservationResult {
  return globalRegistry.reserve(input)
}

export function lookupReviewLoopByConversation(conversationId: string): ReviewLoopReservation | null {
  return globalRegistry.getByConversation(conversationId)
}

export function lookupReviewLoopById(loopId: string): ReviewLoopReservation | null {
  return globalRegistry.getByLoop(loopId)
}

export function releaseReviewLoop(loopId: string): boolean {
  return globalRegistry.release(loopId)
}

export function __resetReviewLoopRegistryForTests(): void {
  globalRegistry.reset()
}
