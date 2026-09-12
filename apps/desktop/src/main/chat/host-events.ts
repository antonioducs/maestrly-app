/** Backend observers receive events even when no ChatView is mounted. */
export interface ChatHostEvent {
  channel: string
  payload: unknown
}
const listeners = new Map<string, Set<(e: ChatHostEvent) => void>>()
export function observeChatHost(conversationId: string, listener: (e: ChatHostEvent) => void): () => void {
  const set = listeners.get(conversationId) ?? new Set()
  set.add(listener)
  listeners.set(conversationId, set)
  return () => {
    set.delete(listener)
    if (!set.size) listeners.delete(conversationId)
  }
}
export function emitChatHost(conversationId: string, channel: string, payload: unknown): void {
  for (const listener of listeners.get(conversationId) ?? []) listener({ channel, payload })
}
