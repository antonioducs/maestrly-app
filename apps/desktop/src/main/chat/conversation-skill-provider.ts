import type { ChatSkill } from './skills'

export interface SkillUsage {
  count: number
  lastUsedAt: number
}

/**
 * Skills that belong to one conversation's owner rather than to the project or the profile: a fleet bot registers its
 * own skills for each of its conversations, so they are found there and nowhere else. Registered by the host (the bot
 * runtime) like the memory core extras; the chat layer never knows where they live.
 */
export interface ConversationSkillProvider {
  /** The skills, already read; a skill whose name another source also has is left out by the caller. */
  list(): Promise<ChatSkill[]>
  /** How often this owner loaded each skill (any source), for the catalog's order under its budget. */
  usage?(): Readonly<Record<string, SkillUsage>>
  /** One load of a skill by the conversation, through `use_skill` or `/name`. */
  recordUse?(skill: ChatSkill): Promise<void>
  /** The owner's own skills for memory review, one `name — description` line each, within `maxChars`. */
  ownCatalog?(maxChars: number): Promise<string>
  /**
   * A procedure memory review found in the conversation: a new skill, or a note for one of the owner's own, kept as a
   * proposal for the bot (or its owner) to adopt. Says what became of it.
   */
  suggest?(suggestion: SkillSuggestion): Promise<'proposed' | 'skipped'>
}

export interface SkillSuggestion {
  name: string
  /** Required for a new skill. */
  description?: string
  /** The procedure: a new skill's instructions, or what to add to an existing one. */
  note: string
  reason: string
}

const providers = new Map<string, ConversationSkillProvider>()

export function setConversationSkillProvider(conversationId: string, provider: ConversationSkillProvider | null): void {
  if (provider) providers.set(conversationId, provider)
  else providers.delete(conversationId)
}

export function conversationSkillProvider(conversationId: string | null | undefined): ConversationSkillProvider | null {
  return conversationId ? (providers.get(conversationId) ?? null) : null
}
