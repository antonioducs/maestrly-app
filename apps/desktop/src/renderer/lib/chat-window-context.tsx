import { createContext, useContext } from 'react'

/** DOM interaction follows the chat; application events and IPC still belong to its renderer. */
export const ChatWindowEnvironment = createContext<{
  document: Document
  portalContainer: HTMLElement
  focusSource?: () => void
  showConversation?: () => void
} | null>(null)

export function useChatDocument(): Document {
  return useContext(ChatWindowEnvironment)?.document ?? document
}

export function useChatOwnerWindow(): Window {
  return useChatDocument().defaultView ?? window
}

export function useChatPortalContainer(): HTMLElement | undefined {
  return useContext(ChatWindowEnvironment)?.portalContainer
}

const noop = () => {}

export function useChatSourceFocus(): () => void {
  return useContext(ChatWindowEnvironment)?.focusSource ?? noop
}

export function useChatSourceConversation(): () => void {
  return useContext(ChatWindowEnvironment)?.showConversation ?? noop
}
