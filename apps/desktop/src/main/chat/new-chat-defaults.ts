/**
 * What a new chat starts with when the person has not configured it: the mode of the standalone chat they last
 * switched and the model they last picked in any conversation. Both live in `app_settings`; an unreadable value is
 * ignored rather than repaired, so the next choice simply replaces it.
 */
import type { ChatMode, ChatModelRef } from '../../shared/chat'
import { isChatMode } from '../../shared/chat-mode'
import { getAppSetting, setAppSetting } from '../store'

const LAST_STANDALONE_MODE_KEY = 'chat.lastStandaloneMode'
const LAST_SELECTION_KEY = 'chat.lastSelection'

/** Standalone chats start in Ask until the person switches one to another mode. */
export function initialStandaloneChatMode(): ChatMode {
  const saved = getAppSetting(LAST_STANDALONE_MODE_KEY)
  return isChatMode(saved) ? saved : 'ask'
}

export function rememberStandaloneChatMode(mode: ChatMode): void {
  setAppSetting(LAST_STANDALONE_MODE_KEY, mode)
}

export function rememberedChatSelection(): ChatModelRef | null {
  try {
    const parsed = JSON.parse(getAppSetting(LAST_SELECTION_KEY) ?? 'null') as Partial<ChatModelRef> | null
    return typeof parsed?.providerId === 'string' &&
      parsed.providerId &&
      typeof parsed.modelId === 'string' &&
      parsed.modelId
      ? { providerId: parsed.providerId, modelId: parsed.modelId }
      : null
  } catch {
    return null
  }
}

export function rememberChatSelection(selection: ChatModelRef): void {
  setAppSetting(LAST_SELECTION_KEY, JSON.stringify({ providerId: selection.providerId, modelId: selection.modelId }))
}
