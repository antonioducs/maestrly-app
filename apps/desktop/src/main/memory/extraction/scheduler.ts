import { randomUUID } from 'node:crypto'
import type { OneShotSelection } from '../../chat/one-shot-text'
import { runOneShotText } from '../../chat/one-shot-text'
import { listChatMessagesRange, maxChatSeq, recordChatUsageAttempt } from '../../chat/chat-store'
import { getCompactionSummarizer } from '../../chat/compaction-summarizer'
import { getConversation } from '../../store'
import { getExtractionState, saveExtractionState } from '../../store/memory-extraction-state'
import { listLocalMemories } from '../local-memory-service'
import { readMemorySettings } from '../settings'
import { memorySpaceForConversation } from '../spaces'
import { applyExtraction } from './apply'
import { maybeConsolidate } from './consolidation'
import { getOwnerMemoryWriter } from './owner-writer'
import { EXTRACTION_LIMITS, extractionSystemPrompt, extractionUserPrompt, parseExtractionOutput } from './prompt'
import { chunkExtractionBlocks, renderExtractionTranscript, type ExtractionBlock } from './transcript'

export type ExtractionOutcome = 'done' | 'busy' | 'idle' | 'too-little' | 'backoff' | 'failed' | 'cancelled'
export interface ExtractionDeps {
  oneShot: typeof runOneShotText
  now: () => number
  selection?: OneShotSelection | null
}
const defaultDeps: ExtractionDeps = { oneShot: runOneShotText, now: Date.now }

/** Bots summarize with the owner's compaction model; the desktop uses the opt-in memory setting. */
export function resolveExtractionSelection(conversationId: string): OneShotSelection | null {
  const bot = getCompactionSummarizer(conversationId)
  if (bot) return bot()
  const settings = readMemorySettings().extraction
  return settings.enabled && settings.selection ? settings.selection : null
}

const pending = new Map<string, { timer: NodeJS.Timeout; firstAt: number; upToSeq: number }>()
/** The running extraction of each conversation; `settled` resolves when it has returned. */
const running = new Map<string, { controller: AbortController; settled: Promise<void> }>()

export function scheduleMemoryExtraction(
  conversationId: string,
  upToSeq: number | undefined = undefined,
  deps: Partial<ExtractionDeps> & { run?: (id: string, upToSeq: number) => Promise<unknown> } = {}
): void {
  try {
    if (
      !memorySpaceForConversation(conversationId) ||
      !(deps.selection === undefined ? resolveExtractionSelection(conversationId) : deps.selection)
    )
      return
    const now = (deps.now ?? Date.now)()
    const current = pending.get(conversationId)
    if (current) clearTimeout(current.timer)
    const firstAt = current?.firstAt ?? now
    const target = Math.max(current?.upToSeq ?? 0, upToSeq ?? maxChatSeq(conversationId))
    const delay = Math.max(0, Math.min(EXTRACTION_LIMITS.debounceMs, firstAt + EXTRACTION_LIMITS.maxWaitMs - now))
    const timer = setTimeout(() => {
      pending.delete(conversationId)
      void Promise.resolve()
        .then(() => (deps.run ?? ((id, seq) => runMemoryExtraction(id, seq, deps)))(conversationId, target))
        .catch(() => console.warn('[memory-extraction] Scheduled run failed'))
    }, delay)
    timer.unref?.()
    pending.set(conversationId, { timer, firstAt, upToSeq: target })
  } catch {
    console.warn('[memory-extraction] Scheduling failed')
  }
}

export function disposeMemoryExtraction(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}

/**
 * Stops a conversation's memory extraction: a scheduled run is dropped and a running one is aborted. What its provider
 * returns anyway is discarded, so nothing more is written to the conversation's memory space, its owner memory or its
 * extraction state. Resolves once the run has returned, or after `timeoutMs`; the conversation can extract again at
 * once. A fleet bot cancels its extraction when it is uninstalled.
 */
export async function cancelMemoryExtraction(conversationId: string, timeoutMs = 3_000): Promise<void> {
  const scheduled = pending.get(conversationId)
  if (scheduled) {
    clearTimeout(scheduled.timer)
    pending.delete(conversationId)
  }
  const run = running.get(conversationId)
  if (!run) return
  running.delete(conversationId)
  run.controller.abort(new DOMException('Memory extraction cancelled', 'AbortError'))
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    run.settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
}

export async function runMemoryExtraction(
  conversationId: string,
  upToSeq: number | undefined = undefined,
  overrides: Partial<ExtractionDeps> = {}
): Promise<ExtractionOutcome> {
  if (running.has(conversationId)) return 'busy'
  const controller = new AbortController()
  let settle!: () => void
  const run = {
    controller,
    settled: new Promise<void>((resolve) => {
      settle = resolve
    }),
  }
  running.set(conversationId, run)
  // Checked after every wait: once cancelled, the run writes nothing more.
  const signal = controller.signal
  const deps = { ...defaultDeps, ...overrides }
  try {
    const now = deps.now()
    const space = memorySpaceForConversation(conversationId)
    const selection = deps.selection === undefined ? resolveExtractionSelection(conversationId) : deps.selection
    const conversation = getConversation(conversationId)
    if (!space || !selection || !conversation) return 'idle'
    const existing = getExtractionState(conversationId)
    const state = existing ?? {
      conversationId,
      spaceId: space.id,
      lastSeq: -1,
      status: 'idle' as const,
      error: null,
      attempts: 0,
      lastRunAt: null,
      updatedAt: now,
    }
    if (
      state.attempts >= EXTRACTION_LIMITS.maxAttempts &&
      state.lastRunAt !== null &&
      now - state.lastRunAt < EXTRACTION_LIMITS.failureBackoffMs
    )
      return 'backoff'
    const targetSeq = upToSeq ?? maxChatSeq(conversationId)
    if (!existing) {
      let before = targetSeq
      let chars = 0
      let oldest = -1
      lookback: while (before >= 0) {
        const page = listChatMessagesRange(conversationId, -1, before, {
          limit: EXTRACTION_LIMITS.pageSize,
          newestFirst: true,
        })
        if (!page.length) break
        for (const row of page) {
          const block = renderExtractionTranscript([row], { bot: space.kind === 'bot' })[0]
          if (!block) continue
          if (chars && chars + block.text.length > EXTRACTION_LIMITS.initialLookbackChars) break lookback
          oldest = row.seq
          chars += block.text.length
          if (chars >= EXTRACTION_LIMITS.initialLookbackChars) break lookback
        }
        before = page[page.length - 1].seq - 1
      }
      state.lastSeq = oldest < 0 ? -1 : oldest - 1
      saveExtractionState(state)
    }
    const blocks: ExtractionBlock[] = []
    let cursor = state.lastSeq
    let chars = 0
    read: while (cursor < targetSeq) {
      const page = listChatMessagesRange(conversationId, cursor, targetSeq, { limit: EXTRACTION_LIMITS.pageSize })
      if (!page.length) break
      for (const row of page) {
        cursor = row.seq
        const block = renderExtractionTranscript([row], { bot: space.kind === 'bot' })[0]
        if (!block) continue
        blocks.push(block)
        chars += block.text.length
        if (chars >= EXTRACTION_LIMITS.chunkChars * EXTRACTION_LIMITS.maxChunks) break read
      }
    }
    if (blocks.reduce((sum, block) => sum + block.text.length, 0) < EXTRACTION_LIMITS.minChars) return 'too-little'
    const owner = space.kind === 'bot' ? getOwnerMemoryWriter(conversationId) : undefined
    let lastSeq = state.lastSeq
    let attempts = state.attempts
    try {
      for (const chunk of chunkExtractionBlocks(blocks, EXTRACTION_LIMITS.chunkChars, EXTRACTION_LIMITS.maxChunks)) {
        const catalog = listLocalMemories(space.id, { status: 'active', limit: 300 })
          .map(
            (memory) =>
              `${memory.id} · ${memory.type} · ${memory.title} — ${memory.content.replace(/\s+/g, ' ').slice(0, 160)}`
          )
          .join('\n')
          .slice(0, EXTRACTION_LIMITS.catalogChars)
        const chunkOwner = chunk.some((block) => block.text.startsWith('Owner:')) ? owner : undefined
        const ownerEntries = chunkOwner
          ? (await chunkOwner.list().catch(() => [])).map((entry) => `${entry.id} — ${entry.content}`).join('\n')
          : null
        if (signal.aborted) return 'cancelled'
        const last = chunk[chunk.length - 1]
        let output = null
        for (let retry = 0; retry < 2; retry++) {
          const result = await deps.oneShot({
            selection,
            system: extractionSystemPrompt(space.kind),
            prompt: extractionUserPrompt({
              memories: catalog,
              owner: ownerEntries,
              transcript: chunk.map((block) => block.text).join('\n\n'),
            }),
            signal: AbortSignal.any([AbortSignal.timeout(600_000), signal]),
            conversationId,
            cwd: conversation.cwd,
            agent: 'memory-extraction',
          })
          // The call is billed even when its answer comes after a cancellation; the answer itself is discarded.
          recordChatUsageAttempt({
            id: `memory-extraction:${randomUUID()}`,
            conversationId,
            model: { providerId: selection.providerId, modelId: selection.modelId },
            usage: result.usage,
          })
          if (signal.aborted) return 'cancelled'
          output = parseExtractionOutput(result.text)
          if (output !== null) break
        }
        if (output === null) console.warn('[memory-extraction] Unreadable output; skipping chunk')
        else
          await applyExtraction({
            space,
            output,
            conversationId,
            originMessageId: last.messageId,
            ...(chunkOwner ? { owner: chunkOwner } : {}),
            signal,
          })
        if (signal.aborted) return 'cancelled'
        attempts = 0
        lastSeq = last.seq
        saveExtractionState({
          ...state,
          spaceId: space.id,
          lastSeq,
          status: 'idle',
          error: null,
          attempts: 0,
          lastRunAt: now,
          updatedAt: deps.now(),
        })
      }
    } catch (error) {
      if (signal.aborted) return 'cancelled'
      saveExtractionState({
        ...state,
        spaceId: space.id,
        lastSeq,
        status: 'failed',
        error: error instanceof Error ? error.message.slice(0, 500) : 'extraction failed',
        attempts: attempts + 1,
        lastRunAt: now,
        updatedAt: deps.now(),
      })
      console.warn('[memory-extraction] Extraction failed')
      return 'failed'
    }
    await maybeConsolidate({
      space,
      selection,
      conversationId,
      cwd: conversation.cwd,
      oneShot: deps.oneShot,
      now,
      signal,
    }).catch(() => console.warn('[memory-extraction] Consolidation failed'))
    return signal.aborted ? 'cancelled' : 'done'
  } catch {
    if (signal.aborted) return 'cancelled'
    console.warn('[memory-extraction] Run failed')
    return 'failed'
  } finally {
    if (running.get(conversationId) === run) running.delete(conversationId)
    settle()
  }
}
