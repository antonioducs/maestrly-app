import { createHash } from 'node:crypto'
import { toolOutputText, type MessagePart } from '../../../shared/chat'
import { normalizeForSearch } from '../../memory/relevance'
import { parseParts } from '../message'

/** Bounds of what one message contributes to the history index; the original stays in `chat_messages`. */
export const HISTORY_EXTRACT = {
  bodyChars: 64_000,
  trigramChars: 16_000,
  trigramReasoningChars: 2_000,
  toolInputChars: 500,
  toolOutputChars: 2_000,
  toolsChars: 8_000,
  cjkChars: 20_000,
} as const

/** Bumped whenever extraction changes what is indexed: the index file is then rebuilt. */
export const HISTORY_EXTRACTOR_VERSION = '1'

/** Results of the history and memory tools would echo earlier searches and duplicate what is indexed elsewhere. */
const QUIET_TOOL = /(?:^|__)(?:history|memory)_[a-z_]+$/

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

export interface HistoryDocument {
  /** Searchable at all: main-context, and not an internal prompt other than the approved plan. */
  eligible: boolean
  /** Visible text, as the person and the agent saw it. */
  bodyRaw: string
  /** Tool names, shortened inputs and outputs. */
  toolsRaw: string
  body: string
  tools: string
  cjk: string
  trigram: string
  /** The trigram text was shortened, so an exact search checks this message directly. */
  partial: boolean
  hasCompaction: boolean
}

const cut = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max))

/** Visible text of the parts; `reasoningChars` bounds each reasoning part. Hidden memory blocks are skipped. */
export function historyVisibleText(parts: readonly MessagePart[], reasoningChars = Number.POSITIVE_INFINITY): string {
  const out: string[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.checkpoint !== 'openai-native' && part.text) out.push(part.text)
    } else if (part.type === 'reasoning') out.push(cut(part.text, reasoningChars))
    else if (part.type === 'compaction' || part.type === 'context') out.push(part.text)
    else if (part.type === 'file') {
      if (!part.name.startsWith('maestrly-memory-')) out.push(part.name)
    } else if (part.type === 'generated-image') out.push([part.name, part.revisedPrompt ?? ''].join(' ').trim())
    else if (part.type === 'skill-invocation') out.push(`/${part.name}${part.args ? ` ${part.args}` : ''}`)
  }
  return out.join('\n')
}

function inputText(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input)
  } catch {
    return ''
  }
}

export function historyToolText(parts: readonly MessagePart[]): string {
  const out: string[] = []
  let used = 0
  for (const part of parts) {
    if (part.type !== 'tool') continue
    const state = part.state
    const detail = QUIET_TOOL.test(part.toolName)
      ? ''
      : state.status === 'completed' || state.status === 'running'
        ? toolOutputText(state.output)
        : state.status === 'error'
          ? state.error
          : state.status === 'denied'
            ? (state.reason ?? '')
            : ''
    const line = [
      `[tool ${part.toolName}]`,
      cut(inputText(part.input), HISTORY_EXTRACT.toolInputChars),
      cut(detail.trim(), HISTORY_EXTRACT.toolOutputChars),
    ]
      .filter(Boolean)
      .join(' ')
    const room = HISTORY_EXTRACT.toolsChars - used
    if (room <= 0) break
    out.push(cut(line, room))
    used += Math.min(line.length, room) + 1
  }
  return out.join('\n')
}

/** CJK runs as overlapping bigrams (single characters stay whole), so two-character words are found. */
export function cjkGrams(text: string): string {
  const grams: string[] = []
  let used = 0
  for (const [run] of text.matchAll(CJK_RUN)) {
    const chars = [...run]
    const runGrams = chars.length === 1 ? chars : chars.slice(0, -1).map((char, index) => char + chars[index + 1])
    for (const gram of runGrams) {
      used += gram.length + 1
      if (used > HISTORY_EXTRACT.cjkChars) return grams.join(' ')
      grams.push(gram)
    }
  }
  return grams.join(' ')
}

export function hasCjk(text: string): boolean {
  CJK_RUN.lastIndex = 0
  const found = CJK_RUN.test(text)
  CJK_RUN.lastIndex = 0
  return found
}

/**
 * Same rule as the main-context SQL predicate and the history tools: invalid metadata is legacy main context, isolated
 * executions are out, and internal prompts are out except the approved plan, which the agent may need to reread.
 */
export function historyEligible(metaJson: string | null, rawText: string): boolean {
  if (!metaJson) return true
  let meta: unknown
  try {
    meta = JSON.parse(metaJson)
  } catch {
    return true
  }
  if (!meta || typeof meta !== 'object') return true
  const { executionScope, internal } = meta as { executionScope?: unknown; internal?: unknown }
  const kind =
    executionScope && typeof executionScope === 'object' ? (executionScope as { kind?: unknown }).kind : undefined
  if (kind !== undefined && kind !== null && kind !== 'conversation') return false
  return !internal || rawText.includes('<approved_plan>')
}

export function extractHistoryDocument(partsJson: string | null, metaJson: string | null): HistoryDocument {
  const parts = parseParts(partsJson ?? '[]')
  const fullBody = historyVisibleText(parts)
  const bodyRaw = cut(fullBody, HISTORY_EXTRACT.bodyChars)
  const toolsRaw = historyToolText(parts)
  const trigramSource = historyVisibleText(parts, HISTORY_EXTRACT.trigramReasoningChars)
  const body = normalizeForSearch(bodyRaw)
  const trigram = normalizeForSearch(cut(trigramSource, HISTORY_EXTRACT.trigramChars))
  return {
    eligible: historyEligible(metaJson, fullBody),
    bodyRaw,
    toolsRaw,
    body,
    tools: normalizeForSearch(toolsRaw),
    cjk: cjkGrams(body),
    trigram,
    partial: trigramSource.length > HISTORY_EXTRACT.trigramChars || trigramSource.length !== fullBody.length,
    hasCompaction: parts.some((part) => part.type === 'compaction'),
  }
}

export function historyDocumentHash(document: HistoryDocument): string {
  if (!document.eligible) return 'ineligible'
  return createHash('sha1')
    .update(document.body)
    .update('\u0000')
    .update(document.tools)
    .update('\u0000')
    .update(document.trigram)
    .update(document.partial ? '\u0001' : '\u0000')
    .digest('hex')
}

/** A conversation as one token of the word index, so a common term never reads other conversations' matches. */
export function conversationToken(conversationId: string): string {
  return `c${createHash('sha1').update(conversationId).digest('hex').slice(0, 24)}`
}
