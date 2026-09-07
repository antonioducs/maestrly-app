import type { ChatMode } from './chat'

/** Structural conversation experience. Maestro may explicitly hand off to Standard while idle. */
export type ConversationExperience = 'standard' | 'maestro'

/** Effective behavior frozen for one turn. Maestro remains separate from the Standard chat modes. */
export type ChatBehavior = ChatMode | 'maestro'

export type MaestroToStandardError =
  | 'invalid-conversation'
  | 'not-maestro'
  | 'conversation-busy'
  | 'conversation-reserved'
  | 'conversation-migrating'

export type MaestroToStandardResult = { ok: true } | { ok: false; error: MaestroToStandardError }

export type StandardToMaestroError =
  | 'invalid-conversation'
  | 'not-standard'
  | 'conversation-busy'
  | 'conversation-reserved'
  | 'conversation-migrating'

export type StandardToMaestroResult = { ok: true } | { ok: false; error: StandardToMaestroError }

export function normalizeConversationExperience(value: unknown): ConversationExperience {
  return value === 'maestro' ? 'maestro' : 'standard'
}

export function resolveChatBehavior(
  experience: ConversationExperience | null | undefined,
  mode: ChatMode
): ChatBehavior {
  return experience === 'maestro' ? 'maestro' : mode
}
