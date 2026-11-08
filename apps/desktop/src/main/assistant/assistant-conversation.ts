import type { StandaloneConversation } from '../../shared/conversation'
import { ASSISTANT_CONVERSATION_SETTING } from '../../shared/assistant'
import { getMainLocale } from '../i18n'
import { createStandaloneConversation } from '../standalone-conversation-service'
import { getAppSetting, getConversation, setAppSetting, setConversationPinned } from '../store'

type Archive = (conversationId: string) => Promise<void>

let archive: Archive | null = null

/** The archive path of the conversation list (stops the agent and its processes first), wired at startup. */
export function setAssistantConversationArchiver(fn: Archive | null): void {
  archive = fn
}

function usable(id: string | null): StandaloneConversation | null {
  if (!id) return null
  const conversation = getConversation(id)
  if (!conversation || conversation.archived || conversation.scope !== 'standalone') return null
  return conversation
}

/** The conversation playing the assistant role, or null when it no longer exists, was archived or is not a chat. */
export function getAssistantConversationId(): string | null {
  return usable(getAppSetting(ASSISTANT_CONVERSATION_SETTING))?.id ?? null
}

export function isAssistantConversation(id: string | undefined | null): boolean {
  if (!id) return false
  return getAssistantConversationId() === id
}

async function create(): Promise<StandaloneConversation> {
  const conversation = await createStandaloneConversation({
    name: getMainLocale() === 'pt-BR' ? 'Assistente' : 'Assistant',
  })
  const pinnedAt = setConversationPinned(conversation.id, true)
  setAppSetting(ASSISTANT_CONVERSATION_SETTING, conversation.id)
  return { ...conversation, pinnedAt }
}

let pending: Promise<StandaloneConversation> | null = null

/** The assistant conversation, created and pinned on first use. Concurrent callers share one creation. */
export async function ensureAssistantConversation(): Promise<StandaloneConversation> {
  const current = usable(getAppSetting(ASSISTANT_CONVERSATION_SETTING))
  if (current) return current
  pending ??= create().finally(() => {
    pending = null
  })
  return pending
}

/** Archives the current assistant conversation (its history stays) and starts a new one. */
export async function startNewAssistantSession(): Promise<StandaloneConversation> {
  const current = getAssistantConversationId()
  if (current) {
    if (!archive) throw new Error('The assistant cannot archive its conversation yet.')
    await archive(current)
  }
  return create()
}
