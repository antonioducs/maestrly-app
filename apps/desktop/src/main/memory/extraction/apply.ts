import { memoryContentProblem, normalizeMemoryText } from '../content-safety'
import { createLocalMemory, getLocalMemory, resolveLocalMemoryId } from '../local-memory-service'
import type { MemorySpace } from '../spaces'
import { incrementAutoCreated } from '../../store/memory-extraction-state'
import type { OwnerMemoryWriter } from './owner-writer'
import { EXTRACTION_LIMITS, type ExtractionOutput } from './prompt'

export async function applyExtraction(input: {
  space: MemorySpace
  output: ExtractionOutput
  conversationId: string
  originMessageId: string
  delay?: (ms: number) => Promise<void>
  owner?: OwnerMemoryWriter
  /** Once aborted (the extraction was cancelled), nothing more is written. */
  signal?: AbortSignal
}): Promise<{ created: number; superseded: number; owner: number; rejected: number }> {
  const result = { created: 0, superseded: 0, owner: 0, rejected: 0 }
  if (input.signal?.aborted) return result
  for (const item of input.output.memories) {
    const title = normalizeMemoryText(item.title)
    const content = normalizeMemoryText(item.content)
    if (!title || !content || memoryContentProblem(`${title}\n${content}`)) {
      result.rejected += 1
      continue
    }
    let supersedesId: string | undefined
    if (item.action === 'supersede') {
      const resolved = resolveLocalMemoryId(input.space.id, item.id)
      const target = resolved && resolved !== 'ambiguous' ? getLocalMemory(input.space.id, resolved) : undefined
      if (target?.status !== 'active' || target.pinned) {
        result.rejected += 1
        continue
      }
      supersedesId = target.id
    }
    const saved = createLocalMemory({
      workspaceId: input.space.id,
      title,
      content,
      type: item.type,
      importance: item.importance ?? 0,
      source: 'auto',
      originConversationId: input.conversationId,
      originMessageId: input.originMessageId,
      ...(supersedesId ? { supersedesId } : {}),
    })
    if (saved.duplicate) continue
    if (supersedesId) result.superseded += 1
    else result.created += 1
  }
  if (result.created + result.superseded) incrementAutoCreated(input.space.id, result.created + result.superseded)
  if (input.space.kind === 'bot' && input.owner)
    for (const item of input.output.owner) {
      const content = normalizeMemoryText(item.content)
      if (!content || memoryContentProblem(content)) {
        result.rejected += 1
        continue
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        if (input.signal?.aborted) return result
        try {
          await input.owner.save({
            content,
            ...(item.replacesId ? { replacesId: item.replacesId } : {}),
            origin: 'auto',
          })
          result.owner += 1
          break
        } catch {
          if (attempt === 0)
            await (input.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
              EXTRACTION_LIMITS.ownerRetryMs
            )
          else {
            result.rejected += 1
            console.warn('[memory-extraction] Owner save failed')
          }
        }
      }
    }
  return result
}
