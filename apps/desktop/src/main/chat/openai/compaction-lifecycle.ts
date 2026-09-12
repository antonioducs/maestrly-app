import { reduceOpenAIResponsesStreamEvent } from './ledger'
import type { OpenAIResponsesLedger, OpenAIStreamEventLike } from './types'

export interface OpenAICompactionLifecycle {
  /** Latest candidate, used only while the current process is alive. */
  working: OpenAIResponsesLedger
  /** Last confirmed prefix, updated with the visible tail while the candidate is pending. */
  fallback?: OpenAIResponsesLedger
}

export function createOpenAICompactionLifecycle(ledger: OpenAIResponsesLedger): OpenAICompactionLifecycle {
  return { working: ledger }
}

export function isOpenAINativeCompactionEvent(event: { type: string; kind?: string }): boolean {
  return event.type === 'custom' && event.kind === 'openai.compaction'
}

/**
 * Capture events without making an intermediate checkpoint durable. After the first checkpoint, each visible event
 * also feeds the fallback, preserving the previous prefix and useful tail if interrupted.
 */
export function advanceOpenAICompactionLifecycle(
  state: OpenAICompactionLifecycle,
  event: OpenAIStreamEventLike
): OpenAICompactionLifecycle {
  const working = reduceOpenAIResponsesStreamEvent(state.working, event)
  if (isOpenAINativeCompactionEvent(event)) {
    return { working, fallback: state.fallback ?? state.working }
  }
  return {
    working,
    ...(state.fallback ? { fallback: reduceOpenAIResponsesStreamEvent(state.fallback, event) } : {}),
  }
}

/** Safe SQLite snapshot before a clean terminal event. */
export function durableOpenAILedger(state: OpenAICompactionLifecycle): OpenAIResponsesLedger {
  return state.fallback ?? state.working
}

/** Promote the candidate checkpoint only after a valid response.completed/finish. */
export function commitOpenAICompactionLifecycle(state: OpenAICompactionLifecycle): OpenAICompactionLifecycle {
  return { working: state.working }
}

/** Discard the candidate checkpoint, preserving the tail already applied to the fallback. */
export function rollbackOpenAICompactionLifecycle(state: OpenAICompactionLifecycle): OpenAICompactionLifecycle {
  return { working: durableOpenAILedger(state) }
}
