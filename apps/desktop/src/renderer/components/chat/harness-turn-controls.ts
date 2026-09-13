import type { ChatReasoningEffort } from '../../../shared/chat'
import { isHarnessReasoningReset } from '../../../shared/harness'

export interface HarnessComposerRouteInput {
  streaming: boolean
  /** Effective capability published by the active execution, not a model or profile name. */
  midTurnSteering: boolean
  text: string
  attachmentCount: number
  agentMentionCount: number
  invokesSkill: boolean
  maestro: boolean
}

/** Composer routing is capability-based: it never infers a harness from the selected model string. */
export function routeHarnessComposerSubmit(input: HarnessComposerRouteInput): 'steer' | 'queue' | 'send' {
  if (!input.streaming) return 'send'
  if (
    input.midTurnSteering &&
    input.text.trim() &&
    input.attachmentCount === 0 &&
    input.agentMentionCount === 0 &&
    !input.invokesSkill &&
    !input.maestro
  )
    return 'steer'
  return 'queue'
}

export interface HarnessReasoningRouteInput {
  streaming: boolean
  liveReasoningUpdate: boolean
  effort: ChatReasoningEffort
  /** Efforts the active execution accepts right now. Empty means no live change is possible. */
  liveReasoningEfforts: readonly string[]
  /** Whether the active execution accepts clearing the override back to the provider default. */
  liveReasoningReset: boolean
}

/** A live effort change requires a running execution that actually accepts that exact value. */
export function routeHarnessReasoningChange(
  input: HarnessReasoningRouteInput
): 'live-and-next-turn' | 'next-turn-only' {
  if (!input.streaming || !input.liveReasoningUpdate) return 'next-turn-only'
  const accepted = isHarnessReasoningReset(input.effort)
    ? input.liveReasoningReset
    : input.liveReasoningEfforts.includes(input.effort)
  return accepted ? 'live-and-next-turn' : 'next-turn-only'
}
