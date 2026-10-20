export interface CompactionSummarizer {
  providerId: string
  modelId: string
  effort: string
  fastMode: boolean
}

const resolvers = new Map<string, () => CompactionSummarizer | null>()
const focuses = new Map<string, string>()

export function setCompactionSummarizer(conversationId: string, resolver: () => CompactionSummarizer | null): void {
  resolvers.set(conversationId, resolver)
}

export function clearCompactionSummarizer(conversationId: string): void {
  resolvers.delete(conversationId)
}

export function getCompactionSummarizer(conversationId: string): (() => CompactionSummarizer | null) | undefined {
  return resolvers.get(conversationId)
}

/**
 * What a conversation's compaction summary must keep besides the usual: a conversation whose turns are not a person's
 * requests, such as a bot's with another bot, loses what was already asked and settled to a generic summary.
 */
export function setCompactionFocus(conversationId: string, focus: string | null): void {
  if (focus) focuses.set(conversationId, focus)
  else focuses.delete(conversationId)
}

export function getCompactionFocus(conversationId: string): string | null {
  return focuses.get(conversationId) ?? null
}
