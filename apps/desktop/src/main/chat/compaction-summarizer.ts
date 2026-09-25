export interface CompactionSummarizer {
  providerId: string
  modelId: string
  effort: string
  fastMode: boolean
}

const resolvers = new Map<string, () => CompactionSummarizer | null>()

export function setCompactionSummarizer(conversationId: string, resolver: () => CompactionSummarizer | null): void {
  resolvers.set(conversationId, resolver)
}

export function clearCompactionSummarizer(conversationId: string): void {
  resolvers.delete(conversationId)
}

export function getCompactionSummarizer(conversationId: string): (() => CompactionSummarizer | null) | undefined {
  return resolvers.get(conversationId)
}
