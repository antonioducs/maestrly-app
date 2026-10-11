/** Text a conversation's composer starts with, left by whoever opened the conversation for a purpose. */
const pending = new Map<string, string>()

/** Tells a conversation that is already on screen that text was offered to its composer. */
export const COMPOSER_DRAFT_EVENT = 'maestrly:composer-draft'

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

/**
 * Leaves text for a conversation's composer without sending anything. A conversation that is not open yet starts
 * with it; one that is already open hears the event and adds it to what is being written.
 */
export function offerComposerDraft(conversationId: string, text: string): void {
  pending.set(conversationId, text)
  window.dispatchEvent(new CustomEvent(COMPOSER_DRAFT_EVENT, { detail: { conversationId } }))
}

/** What is being written with an offered draft after it, separated by a blank line. */
export function joinDraft(current: string, offered: string): string {
  return current.trim() ? `${current.trimEnd()}\n\n${offered}` : offered
}

/** The composer's text with the offered draft, if any, added after it; the offer is consumed. */
export function takeComposerDraft(conversationId: string, current: string): string {
  const offered = pending.get(conversationId)
  if (offered === undefined) return current
  pending.delete(conversationId)
  return joinDraft(current, offered)
}
