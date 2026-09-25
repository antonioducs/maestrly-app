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
import { chunkExtractionBlocks, renderExtractionTranscript } from './transcript'

export type ExtractionOutcome = 'done' | 'busy' | 'idle' | 'too-little' | 'backoff' | 'failed'
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
const running = new Set<string>()

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

export async function runMemoryExtraction(
  conversationId: string,
  upToSeq: number | undefined = undefined,
  overrides: Partial<ExtractionDeps> = {}
): Promise<ExtractionOutcome> {
  if (running.has(conversationId)) return 'busy'
  running.add(conversationId)
  const deps = { ...defaultDeps, ...overrides }
  try {
    const now = deps.now()
    const space = memorySpaceForConversation(conversationId)
    const selection = deps.selection === undefined ? resolveExtractionSelection(conversationId) : deps.selection
    const conversation = getConversation(conversationId)
    if (!space || !selection || !conversation) return 'idle'
    const state = getExtractionState(conversationId) ?? {
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
    const blocks = renderExtractionTranscript(
      listChatMessagesRange(conversationId, state.lastSeq, upToSeq ?? maxChatSeq(conversationId)),
      { bot: space.kind === 'bot' }
    )
    if (blocks.reduce((sum, block) => sum + block.text.length, 0) < EXTRACTION_LIMITS.minChars) return 'too-little'
    const owner = space.kind === 'bot' ? getOwnerMemoryWriter(conversationId) : undefined
    let lastSeq = state.lastSeq
    try {
      for (const chunk of chunkExtractionBlocks(blocks, EXTRACTION_LIMITS.chunkChars, EXTRACTION_LIMITS.maxChunks)) {
        const catalog = listLocalMemories(space.id, { status: 'active', limit: 300 })
          .map(
            (memory) =>
              `${memory.id} · ${memory.type} · ${memory.title} — ${memory.content.replace(/\s+/g, ' ').slice(0, 160)}`
          )
          .join('\n')
          .slice(0, EXTRACTION_LIMITS.catalogChars)
        const ownerEntries = owner
          ? (await owner.list().catch(() => [])).map((entry) => `${entry.id} — ${entry.content}`).join('\n')
          : null
        const last = chunk[chunk.length - 1]
        const result = await deps.oneShot({
          selection,
          system: extractionSystemPrompt(space.kind),
          prompt: extractionUserPrompt({
            memories: catalog,
            owner: ownerEntries,
            transcript: chunk.map((block) => block.text).join('\n\n'),
          }),
          signal: AbortSignal.timeout(600_000),
          conversationId,
          cwd: conversation.cwd,
          agent: 'memory-extraction',
        })
        recordChatUsageAttempt({
          id: `memory-extraction:${conversationId}:${lastSeq}-${last.seq}:${state.attempts}`,
          conversationId,
          model: { providerId: selection.providerId, modelId: selection.modelId },
          usage: result.usage,
        })
        await applyExtraction({
          space,
          output: parseExtractionOutput(result.text),
          conversationId,
          originMessageId: last.messageId,
          ...(owner ? { owner } : {}),
        })
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
      saveExtractionState({
        ...state,
        spaceId: space.id,
        lastSeq,
        status: 'failed',
        error: error instanceof Error ? error.message.slice(0, 500) : 'extraction failed',
        attempts: state.attempts + 1,
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
    }).catch(() => console.warn('[memory-extraction] Consolidation failed'))
    return 'done'
  } catch {
    console.warn('[memory-extraction] Run failed')
    return 'failed'
  } finally {
    running.delete(conversationId)
  }
}
