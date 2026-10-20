import type { ChatBehavior } from '../../shared/conversation-experience'

/**
 * Host guard for Plan mode. PURE module (no store/Electron) so the decision is testable.
 *
 * No runner can force the model to call `review_plan`: a model may answer with the plan as text and end the turn,
 * which leaves nothing in the Plan tab to approve. The host runs ONE internal continuation asking for the submission.
 */
export interface PlanGuardSignals {
  behavior: ChatBehavior
  /** The turn ended through `review_plan`. */
  planSubmitted: boolean
  /** The user aborted the turn. */
  aborted: boolean
  /** The stream emitted an 'error' event. */
  hadError: boolean
  /** The stream was cut (finishReason 'interrupted', 'length', ...). */
  interrupted: boolean
  /** This turn is the guard's own continuation, or runs after it within the same user turn. */
  alreadyGuarded: boolean
  /** Someone can review a plan here: false for unattended executor runs and bot hosts, which have no Plan tab. */
  planReviewAvailable: boolean
}

export function shouldGuardPlanSubmission(signals: PlanGuardSignals): boolean {
  return (
    signals.behavior === 'plan' &&
    !signals.planSubmitted &&
    !signals.aborted &&
    !signals.hadError &&
    !signals.interrupted &&
    !signals.alreadyGuarded &&
    signals.planReviewAvailable
  )
}

/** The internal prompt of the continuation; the model sees it as the next user message. */
export const PLAN_GUARD_PROMPT =
  'Host guard: this conversation is in Plan mode, and your last turn ended without submitting a plan, so ' +
  'nothing reached the Plan tab. Submit now, with `review_plan`, the plan you just wrote. Do not investigate ' +
  'again and do not repeat the plan as text. If you cannot write a plan because the user has to decide ' +
  'something first, ask with `ask_question` instead.'
