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
  excerpt: 240,
  maxMerges: 10,
} as const
const merge = z.object({
  ids: z.array(z.string().min(1)).min(2).max(10),
  type: z.enum(MEMORY_TYPES),
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(1_500),
})

const running = new Set<string>()

export async function maybeConsolidate(input: {
  space: MemorySpace
  selection: OneShotSelection
  conversationId: string
  cwd: string
  oneShot: typeof runOneShotText
  now: number
}): Promise<{ merges: number }> {
  if (running.has(input.space.id)) return { merges: 0 }
  running.add(input.space.id)
  try {
    const state = getConsolidationState(input.space.id)
    if (!state || state.autoCreatedSince < CONSOLIDATION_LIMITS.minNew) return { merges: 0 }
    if (state.lastRunAt !== null && input.now - state.lastRunAt < CONSOLIDATION_LIMITS.intervalMs) return { merges: 0 }
    const memories = listLocalMemories(input.space.id, {
      status: 'active',
      pinned: false,
      limit: CONSOLIDATION_LIMITS.maxInput,
    })
    const system =
      'You merge duplicate or overlapping memories of an AI agent. Merge only memories that describe the same thing; never merge different topics. Keep every unique fact in the merged content. Return ONLY {"merges":[{"ids":["<id>","<id>"],"type":"decision|constraint|preference|procedure|lesson|reference","title":"…","content":"…"}]} with at most 10 merges, or {"merges":[]}.'
    const prompt = memories
      .map(
        (memory) =>
          `${memory.id} · ${memory.type} · ${memory.title} — ${memory.content.replace(/\s+/g, ' ').slice(0, CONSOLIDATION_LIMITS.excerpt)}`
      )
      .join('\n')
    const result = await input.oneShot({
      selection: input.selection,
      system,
      prompt,
      signal: AbortSignal.timeout(600_000),
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
      const targets = parsed.data.ids.map((id) => getLocalMemory(input.space.id, id))
      if (targets.some((target) => target?.status !== 'active' || target.pinned)) continue
      const title = normalizeMemoryText(parsed.data.title)
      const content = normalizeMemoryText(parsed.data.content)
      if (memoryContentProblem(`${title}\n${content}`)) continue
      const saved = createLocalMemory({
        workspaceId: input.space.id,
        title,
        content,
        type: parsed.data.type,
        source: 'auto',
        originConversationId: input.conversationId,
        supersedesId: targets[0]!.id,
      })
      if (saved.duplicate) continue
      for (const target of targets.slice(1)) updateLocalMemory(input.space.id, target!.id, { status: 'superseded' })
      merges += 1
    }
    saveConsolidationState({ spaceId: input.space.id, autoCreatedSince: 0, lastRunAt: input.now, updatedAt: input.now })
    return { merges }
  } finally {
    running.delete(input.space.id)
  }
}
