/** Text a conversation's composer starts with, left by whoever opened the conversation for a purpose. */
const pending = new Map<string, string>()

export function setComposerPrefill(conversationId: string, text: string): void {
  pending.set(conversationId, text)
}

/** Reads without consuming: React may run a state initializer twice, and both runs must see the text. */
export function peekComposerPrefill(conversationId: string): string | undefined {
  return pending.get(conversationId)
}

export function clearComposerPrefill(conversationId: string): void {
  pending.delete(conversationId)
}
