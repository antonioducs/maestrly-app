import type { ChatActiveHarnessProfile, ChatReasoningEffort } from '../../../shared/chat'

export interface AstraComposerRouteInput {
  streaming: boolean
  activeHarnessProfile: ChatActiveHarnessProfile | null
  midTurnSteering: boolean
  text: string
  attachmentCount: number
  agentMentionCount: number
  invokesSkill: boolean
  maestro: boolean
}

/** Renderer routing is capability-based; it never infers Astra from the selected model string. */
export function routeAstraComposerSubmit(input: AstraComposerRouteInput): 'steer' | 'queue' | 'send' {
  if (!input.streaming) return 'send'
  if (
    input.activeHarnessProfile === 'openai-gpt-6-astra-v1' &&
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

export function routeAstraReasoningChange(input: {
  streaming: boolean
  activeHarnessProfile: ChatActiveHarnessProfile | null
  liveReasoningUpdate: boolean
  effort: ChatReasoningEffort
  supportedEfforts: readonly string[]
}): 'live-and-next-turn' | 'next-turn-only' {
  const valid = input.effort === 'off' || input.effort === 'default' || input.supportedEfforts.includes(input.effort)
  return input.streaming &&
    input.activeHarnessProfile === 'openai-gpt-6-astra-v1' &&
    input.liveReasoningUpdate &&
    valid &&
    input.effort !== 'minimal' &&
    input.effort !== 'none'
    ? 'live-and-next-turn'
    : 'next-turn-only'
}
