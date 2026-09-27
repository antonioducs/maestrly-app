import { transaction } from '../../store/db'
import { randomUUID } from 'node:crypto'
import { recordChatUsageAttempt } from '../../chat/chat-store'
import { z } from 'zod'
import { MEMORY_TYPES } from '../../../shared/memory'
import type { OneShotSelection, runOneShotText } from '../../chat/one-shot-text'
import { getConsolidationState, saveConsolidationState } from '../../store/memory-extraction-state'
import { memoryContentProblem, normalizeMemoryText } from '../content-safety'
import { createLocalMemory, getLocalMemory, listLocalMemories, updateLocalMemory } from '../local-memory-service'
import type { MemorySpace } from '../spaces'

export const CONSOLIDATION_LIMITS = {
  minNew: 15,
  intervalMs: 86_400_000,
  maxInput: 150,
  inputChars: 48_000,
  maxMerges: 10,
} as const
const merge = z.object({
  ids: z.array(z.string().min(1)).min(2).max(10),
  type: z.enum(MEMORY_TYPES),
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(1_500),
})

/**
 * The running consolidation of each space. A cancelled run writes nothing more, so it frees its space at once: a new
 * run may start before the old provider call returns, and the old run's end never frees the new run's place.
 */
const running = new Map<string, symbol>()

export async function maybeConsolidate(input: {
  space: MemorySpace
  selection: OneShotSelection
  conversationId: string
  cwd: string
  oneShot: typeof runOneShotText
  now: number
  /** Once aborted (the extraction was cancelled), the answer is discarded and nothing is written. */
  signal?: AbortSignal
}): Promise<{ merges: number }> {
  if (running.has(input.space.id) || input.signal?.aborted) return { merges: 0 }
  const run = Symbol(input.space.id)
  running.set(input.space.id, run)
  const release = () => {
    if (running.get(input.space.id) === run) running.delete(input.space.id)
  }
  input.signal?.addEventListener('abort', release, { once: true })
  try {
    const state = getConsolidationState(input.space.id)
    if (!state || state.autoCreatedSince < CONSOLIDATION_LIMITS.minNew) return { merges: 0 }
    if (state.lastRunAt !== null && input.now - state.lastRunAt < CONSOLIDATION_LIMITS.intervalMs) return { merges: 0 }
    const candidates = listLocalMemories(input.space.id, {
      status: 'active',
      pinned: false,
      limit: CONSOLIDATION_LIMITS.maxInput,
    })
    const system =
      'You merge duplicate or overlapping memories of an AI agent. Merge only memories that describe the same thing; never merge different topics. Keep every unique fact in the merged content. Return ONLY {"merges":[{"ids":["<id>","<id>"],"type":"decision|constraint|preference|procedure|lesson|reference","title":"…","content":"…"}]} with at most 10 merges, or {"merges":[]}.'
    const memories: typeof candidates = []
    const lines: string[] = []
    let chars = 0
    for (const memory of candidates) {
      // One line per memory keeps entry boundaries clear; collapsing whitespace loses no facts.
      const line = `${memory.id} · ${memory.type} · ${memory.title} — ${memory.content.replace(/\s+/g, ' ')}`
      const size = line.length + (lines.length ? 1 : 0)
      if (chars + size > CONSOLIDATION_LIMITS.inputChars) break
      memories.push(memory)
      lines.push(line)
      chars += size
    }
    const snapshots = new Map(memories.map((memory) => [memory.id, memory.updatedAt]))
    const prompt = lines.join('\n')
    const result = await input.oneShot({
      selection: input.selection,
      system,
      prompt,
      signal: AbortSignal.any([AbortSignal.timeout(600_000), ...(input.signal ? [input.signal] : [])]),
      conversationId: input.conversationId,
      cwd: input.cwd,
      agent: 'memory-consolidation',
    })
    recordChatUsageAttempt({
      id: `memory-consolidation:${randomUUID()}`,
      conversationId: input.conversationId,
      model: { providerId: input.selection.providerId, modelId: input.selection.modelId },
      usage: result.usage,
    })
    if (input.signal?.aborted) return { merges: 0 }
    let merges = 0
    const text = result.text.replace(/```(?:json)?/gi, '')
    let raw: unknown = null
    try {
      raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    } catch {
      raw = null
    }
    const list = Array.isArray((raw as { merges?: unknown })?.merges) ? (raw as { merges: unknown[] }).merges : []
    for (const item of list.slice(0, CONSOLIDATION_LIMITS.maxMerges)) {
      const parsed = merge.safeParse(item)
      if (!parsed.success) continue
      if (parsed.data.ids.some((id) => !snapshots.has(id))) continue
      const targets = parsed.data.ids.map((id) => getLocalMemory(input.space.id, id))
      if (
        targets.some(
          (target) => target?.status !== 'active' || target.pinned || target.updatedAt !== snapshots.get(target.id)
        )
      )
        continue
      const title = normalizeMemoryText(parsed.data.title)
      const content = normalizeMemoryText(parsed.data.content)
      if (memoryContentProblem(`${title}\n${content}`)) continue
      let applied = false
      transaction(() => {
        const saved = createLocalMemory({
          workspaceId: input.space.id,
          title,
          content,
          type: parsed.data.type,
          source: 'auto',
          originConversationId: input.conversationId,
          supersedesId: targets[0]!.id,
        })
        if (saved.duplicate) return
        for (const target of targets.slice(1)) updateLocalMemory(input.space.id, target!.id, { status: 'superseded' })
        applied = true
      })
      if (applied) merges += 1
    }
    saveConsolidationState({ spaceId: input.space.id, autoCreatedSince: 0, lastRunAt: input.now, updatedAt: input.now })
    return { merges }
  } finally {
    input.signal?.removeEventListener('abort', release)
    release()
  }
}
