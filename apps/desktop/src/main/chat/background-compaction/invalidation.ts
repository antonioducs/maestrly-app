import { BackgroundCompactionStore } from './store'

/** Persistence-level edits can occur without a live chat service (imports, image enrichment, deletion). */
export function invalidateBackgroundCompaction(conversationId: string): void {
  const store = new BackgroundCompactionStore()
  const record = store.get(conversationId)
  if (!record) return
  store.write(conversationId, {
    generation: record.generation + 1,
    configIdentity: record.configIdentity,
    status: 'idle',
    ready: null,
    work: null,
  })
}
