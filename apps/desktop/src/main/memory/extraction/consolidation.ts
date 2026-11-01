import { extractionAllowed, extractionCommitGuard, matchesSnapshot, withSpaceApply } from './guards'
import { extractionSystemPrompt } from './prompt'
import { transaction } from '../../store/db'
import { randomUUID } from 'node:crypto'
import { recordChatUsageAttempt } from '../../chat/chat-store'
import { z } from 'zod'
import { MEMORY_TYPES } from '../../../shared/memory'
import type { OneShotSelection, runOneShotText } from '../../chat/one-shot-text'
import {
  CONSOLIDATION_PRODUCTS_KEY_PREFIX,
  getConsolidationState,
  saveConsolidationState,
} from '../../store/memory-extraction-state'
import { getAppSetting, setAppSetting } from '../../store/app-settings'
import type { LocalMemory } from '../../../shared/memory'
import { memoryContentProblem, normalizeMemoryText } from '../content-safety'
import { createLocalMemory, getLocalMemory, listLocalMemories, updateLocalMemory } from '../local-memory-service'
import type { MemorySpace } from '../spaces'

export const CONSOLIDATION_LIMITS = {
  minNew: 15,
  intervalMs: 86_400_000,
  maxInput: 150,
  inputChars: 48_000,
  maxMerges: 10,
  contentMax: 3_000,
  /** A merge must keep at least this share of its longest original: consolidation dedupes, it never condenses. */
  minKeptRatio: 0.8,
  maxTags: 64,
} as const
const merge = z.object({
  ids: z.array(z.string().min(1)).min(2).max(10),
  type: z.enum(MEMORY_TYPES),
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(CONSOLIDATION_LIMITS.contentMax),
})
/**
 * Only automatic entries are merged: what the person or the agent saved stays as they wrote it. Procedures are never
 * merged either, since their steps, commands and code are what makes them useful.
 */
const CONSOLIDATED_TYPES = MEMORY_TYPES.filter((type) => type !== 'procedure')

/**
 * The entries the last consolidation of a space created, which are not new evidence for its next run (deleted with the
 * space, see `deleteLocalMemorySpace`).
 */
const productsKey = (spaceId: string) => `${CONSOLIDATION_PRODUCTS_KEY_PREFIX}${spaceId}`
function lastProducts(spaceId: string): Set<string> {
  try {
    const value: unknown = JSON.parse(getAppSetting(productsKey(spaceId)) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** What the merged entry inherits from its originals, so a merge never demotes, untags or re-scopes them. */
function inherited(targets: readonly LocalMemory[]): Pick<LocalMemory, 'importance' | 'tags' | 'scope'> {
  const scopes = new Set(targets.map((target) => target.scope))
  return {
    importance: Math.max(...targets.map((target) => target.importance)),
    tags: [...new Set(targets.flatMap((target) => target.tags))].slice(0, CONSOLIDATION_LIMITS.maxTags),
    scope: scopes.size === 1 ? targets[0].scope : '',
  }
}

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
  authorized?: () => boolean
}): Promise<{ merges: number }> {
  if (
    running.has(input.space.id) ||
    input.signal?.aborted ||
    !extractionAllowed(input.space) ||
    input.authorized?.() === false
  )
    return { merges: 0 }
  const commitAllowed = extractionCommitGuard(input.space)
  const allowed = () => commitAllowed() && input.authorized?.() !== false
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
      source: 'auto',
      type: CONSOLIDATED_TYPES,
      limit: CONSOLIDATION_LIMITS.maxInput,
    })
    // New evidence is what extraction saved since the last run; that run's own merges are not, so a merged entry is
    // merged again only together with something new instead of being condensed once more every day.
    const products = lastProducts(input.space.id)
    const since = state.lastRunAt
    const isNew = (memory: LocalMemory) => !products.has(memory.id) && (since === null || memory.createdAt > since)
    const system =
      (input.space.kind === 'personal'
        ? `${extractionSystemPrompt('personal')}\nConsolidate only existing personal facts; use the merge schema below instead of extraction operations.\n`
        : '') +
      'You merge duplicate or overlapping memories of an AI agent. The input has one JSON object per line: {"id","type","title","content","new"}. Merge only memories that describe the same thing; never merge different topics. Every merge must include at least one memory with "new":true. Keep every unique fact, step, command, path and value in the merged content, keep its line breaks and lists, and do not shorten it: merging removes repetition, never detail. ' +
      `Content up to ${CONSOLIDATION_LIMITS.contentMax} characters. Return ONLY {"merges":[{"ids":["<id>","<id>"],"type":"decision|constraint|preference|lesson|reference","title":"…","content":"…"}]} with at most 10 merges, or {"merges":[]}.`
    const memories: typeof candidates = []
    const lines: string[] = []
    let chars = 0
    for (const memory of candidates) {
      // JSON keeps each entry on one line with unambiguous boundaries while preserving its line breaks.
      const line = JSON.stringify({
        id: memory.id,
        type: memory.type,
        title: memory.title,
        content: memory.content,
        new: isNew(memory),
      })
      const size = line.length + (lines.length ? 1 : 0)
      if (chars + size > CONSOLIDATION_LIMITS.inputChars) break
      memories.push(memory)
      lines.push(line)
      chars += size
    }
    if (!memories.some(isNew)) {
      if (!input.signal?.aborted && allowed())
        saveConsolidationState({ ...state, autoCreatedSince: 0, lastRunAt: input.now, updatedAt: input.now })
      return { merges: 0 }
    }
    const snapshots = new Map(memories.map((memory) => [memory.id, memory]))
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
    if (input.signal?.aborted || !allowed()) return { merges: 0 }
    return await withSpaceApply(input.space.id, () => {
      if (input.signal?.aborted || !allowed()) return { merges: 0 }
      let merges = 0
      const text = result.text.replace(/```(?:json)?/gi, '')
      let raw: unknown = null
      try {
        raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
      } catch {
        raw = null
      }
      const list = Array.isArray((raw as { merges?: unknown })?.merges) ? (raw as { merges: unknown[] }).merges : []
      const created: string[] = []
      for (const item of list.slice(0, CONSOLIDATION_LIMITS.maxMerges)) {
        if (input.signal?.aborted || !allowed()) return { merges }
        const parsed = merge.safeParse(item)
        if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) continue
        if (parsed.data.type === 'procedure') continue
        if (parsed.data.ids.some((id) => !snapshots.has(id))) continue
        const found = parsed.data.ids.map((id) => getLocalMemory(input.space.id, id))
        if (
          found.some(
            (target) =>
              target?.status !== 'active' ||
              target.pinned ||
              target.source !== 'auto' ||
              target.type === 'procedure' ||
              !matchesSnapshot(target, snapshots.get(target.id))
          )
        )
          continue
        const targets = found as LocalMemory[]
        if (!targets.some(isNew)) continue
        const title = normalizeMemoryText(parsed.data.title)
        const content = normalizeMemoryText(parsed.data.content)
        if (memoryContentProblem(`${title}\n${content}`)) continue
        const longest = Math.max(...targets.map((target) => normalizeMemoryText(target.content).length))
        if (content.length < longest * CONSOLIDATION_LIMITS.minKeptRatio) continue
        let applied = false
        transaction(() => {
          const saved = createLocalMemory({
            workspaceId: input.space.id,
            title,
            content,
            type: parsed.data.type,
            ...inherited(targets),
            source: 'auto',
            originConversationId: targets[0].originConversationId ?? input.conversationId,
            ...(targets[0].originMessageId ? { originMessageId: targets[0].originMessageId } : {}),
            supersedesId: targets[0].id,
          })
          if (saved.duplicate) return
          for (const target of targets.slice(1)) updateLocalMemory(input.space.id, target.id, { status: 'superseded' })
          created.push(saved.memory.id)
          applied = true
        })
        if (applied) merges += 1
      }
      if (input.signal?.aborted || !allowed()) return { merges }
      setAppSetting(productsKey(input.space.id), JSON.stringify(created))
      saveConsolidationState({
        spaceId: input.space.id,
        autoCreatedSince: 0,
        lastRunAt: input.now,
        updatedAt: input.now,
      })
      return { merges }
    })
  } finally {
    input.signal?.removeEventListener('abort', release)
    release()
  }
}
