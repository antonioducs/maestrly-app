/** Where a bot saves owner facts it extracts; the bot runtime registers one per conversation. */
export interface OwnerMemoryWriter {
  list(): Promise<Array<{ id: string; content: string }>>
  save(input: { content: string; replacesId?: string; origin: 'auto' }): Promise<void>
}

const writers = new Map<string, OwnerMemoryWriter>()

export function setOwnerMemoryWriter(conversationId: string, writer: OwnerMemoryWriter): void {
  writers.set(conversationId, writer)
}

export function clearOwnerMemoryWriter(conversationId: string): void {
  writers.delete(conversationId)
}

export function getOwnerMemoryWriter(conversationId: string): OwnerMemoryWriter | undefined {
  return writers.get(conversationId)
}
