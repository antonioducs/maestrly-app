/**
 * Makes the tool-call history of a request acceptable to strict providers. Every assistant tool call needs exactly
 * one result in the tool messages that follow it, ids must be unique and non-empty, and names and inputs must have
 * the shape providers accept. Persisted history can break these rules: a crash between a call and its result, a
 * server that reuses `call_0` on every step, a model that invented `functions.read:0`, or arguments stored as text.
 *
 * A valid prompt is returned as the same reference, so prompt caching and existing requests are untouched.
 * Pairing is by occurrence within each assistant frame, as in OpenClaw's transcript repair; the missing-result text
 * follows OpenCode and OpenClaw. No code is copied.
 */
import { createHash } from 'node:crypto'
import { parseToolArguments } from './arg-repair'
import { isRecord } from './json-schema-utils'

/**
 * The shape shared by AI SDK `ModelMessage`s and provider prompts (`LanguageModelV4Prompt`), the two places this
 * runs: before `streamText`, which refuses a call without a result, and in the model middleware for every step.
 */
export interface ToolHistoryMessage {
  role: string
  content: unknown
}

interface HistoryPart {
  type: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  providerExecuted?: boolean
  [key: string]: unknown
}

interface ToolMessage {
  role: 'tool'
  content: HistoryPart[]
  [key: string]: unknown
}

export const MISSING_TOOL_RESULT_TEXT =
  'This tool call was interrupted before a result was recorded; its outcome is unknown. Verify the current state ' +
  'before repeating anything that has side effects.'

export interface ToolHistoryStats {
  orphanCalls: number
  orphanResults: number
  renamedIds: number
  renamedNames: number
  repairedInputs: number
}

export interface SanitizedToolHistory<M extends ToolHistoryMessage> {
  prompt: M[]
  stats: ToolHistoryStats
}

export interface ToolHistoryOptions {
  /** Anthropic accepts only `^[a-zA-Z0-9_-]+$` tool-use ids. */
  strictIds?: boolean
}

const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/
const STRICT_ID = /[^A-Za-z0-9_-]/g
/** Mistral's id shape: nine alphanumeric characters. A renamed id keeps it. */
const NINE_ALNUM = /^[A-Za-z0-9]{9}$/
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function sanitizeToolName(name: string): string {
  if (VALID_NAME.test(name)) return name
  const cleaned = name
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return cleaned || 'invalid_tool'
}

function nineAlnum(seed: string): string {
  const digest = createHash('sha256').update(seed).digest()
  let out = ''
  for (let index = 0; index < 9; index++) out += ALNUM[digest[index] % ALNUM.length]
  return out
}

/** A deterministic id the prompt does not use yet, shaped like the original. */
export function uniqueToolCallId(original: string, taken: ReadonlySet<string>, strict: boolean): string {
  if (NINE_ALNUM.test(original)) {
    for (let attempt = 1; ; attempt++) {
      const candidate = nineAlnum(`${original}:${attempt}`)
      if (!taken.has(candidate)) return candidate
    }
  }
  const base = (strict ? original.replace(STRICT_ID, '_') : original).slice(0, 56) || 'call'
  for (let attempt = 2; ; attempt++) {
    const candidate = `${base}_${attempt}`
    if (!taken.has(candidate)) return candidate
  }
}

function normalizedInput(input: unknown): unknown {
  if (isRecord(input)) return input
  if (typeof input === 'string') {
    const parsed = parseToolArguments(input)
    return parsed.ok && isRecord(parsed.value) ? parsed.value : {}
  }
  return {}
}

interface Occurrence {
  id: string
  name: string
}

function emptyStats(): ToolHistoryStats {
  return { orphanCalls: 0, orphanResults: 0, renamedIds: 0, renamedNames: 0, repairedInputs: 0 }
}

export function hasToolHistoryChanges(stats: ToolHistoryStats): boolean {
  return Object.values(stats).some((count) => count > 0)
}

function partsOf(message: ToolHistoryMessage): HistoryPart[] | null {
  return Array.isArray(message.content) ? (message.content as HistoryPart[]) : null
}

export function sanitizeToolHistory<M extends ToolHistoryMessage>(
  prompt: readonly M[],
  options: ToolHistoryOptions = {}
): SanitizedToolHistory<M> {
  const strict = options.strictIds === true
  const stats = emptyStats()
  const out: ToolHistoryMessage[] = []
  const taken = new Set<string>()
  let changed = false

  // Provider-executed calls pair inside the assistant message; their ids are reserved but never touched.
  for (const message of prompt) {
    if (message.role !== 'assistant') continue
    for (const part of partsOf(message) ?? []) {
      if (part.type === 'tool-call' && part.providerExecuted && typeof part.toolCallId === 'string') {
        taken.add(part.toolCallId)
      }
    }
  }

  let index = 0
  while (index < prompt.length) {
    const message = prompt[index]
    const messageParts = partsOf(message)
    if (message.role === 'tool' && messageParts) {
      // Results outside any assistant frame answer nothing.
      const kept = messageParts.filter((part) => part.type !== 'tool-result')
      stats.orphanResults += messageParts.length - kept.length
      if (kept.length !== messageParts.length) changed = true
      if (kept.length) out.push(kept.length === messageParts.length ? message : { ...message, content: kept })
      index++
      continue
    }
    if (message.role !== 'assistant' || !messageParts) {
      out.push(message)
      index++
      continue
    }

    const pending = new Map<string, Occurrence[]>()
    const order: Occurrence[] = []
    let assistantChanged = false
    const content = messageParts.map((part): HistoryPart => {
      if (part.type !== 'tool-call' || part.providerExecuted) return part
      const originalId = typeof part.toolCallId === 'string' ? part.toolCallId : ''
      const originalName = typeof part.toolName === 'string' ? part.toolName : ''
      const name = sanitizeToolName(originalName)
      if (name !== part.toolName) stats.renamedNames++
      const input = normalizedInput(part.input)
      if (input !== part.input) stats.repairedInputs++
      let id = strict ? originalId.replace(STRICT_ID, '_') : originalId
      if (!id || taken.has(id)) id = uniqueToolCallId(originalId, taken, strict)
      if (id !== part.toolCallId) stats.renamedIds++
      taken.add(id)
      const occurrence = { id, name }
      const queue = pending.get(originalId) ?? []
      queue.push(occurrence)
      pending.set(originalId, queue)
      order.push(occurrence)
      if (id === part.toolCallId && name === part.toolName && input === part.input) return part
      assistantChanged = true
      return { ...part, toolCallId: id, toolName: name, input }
    })
    out.push(assistantChanged ? { ...message, content } : message)
    if (assistantChanged) changed = true

    const answered = new Set<Occurrence>()
    const toolMessages: ToolMessage[] = []
    let next = index + 1
    while (next < prompt.length && prompt[next].role === 'tool') {
      const toolMessage = prompt[next] as unknown as ToolMessage
      let toolChanged = false
      const parts: HistoryPart[] = []
      for (const part of partsOf(toolMessage) ?? []) {
        if (part.type !== 'tool-result') {
          parts.push(part)
          continue
        }
        const occurrence = pending.get(typeof part.toolCallId === 'string' ? part.toolCallId : '')?.shift()
        if (!occurrence) {
          // No call left to answer: an orphan, or a second result for the same call.
          stats.orphanResults++
          toolChanged = true
          continue
        }
        answered.add(occurrence)
        if (occurrence.id === part.toolCallId && occurrence.name === part.toolName) parts.push(part)
        else {
          parts.push({ ...part, toolCallId: occurrence.id, toolName: occurrence.name })
          toolChanged = true
        }
      }
      if (toolChanged) changed = true
      toolMessages.push(toolChanged ? { ...toolMessage, content: parts } : toolMessage)
      next++
    }

    const missing = order.filter((occurrence) => !answered.has(occurrence))
    if (missing.length) {
      stats.orphanCalls += missing.length
      changed = true
      const synthetic: HistoryPart[] = missing.map((occurrence) => ({
        type: 'tool-result',
        toolCallId: occurrence.id,
        toolName: occurrence.name,
        output: { type: 'error-text', value: MISSING_TOOL_RESULT_TEXT },
      }))
      const last = toolMessages.at(-1)
      if (last) toolMessages[toolMessages.length - 1] = { ...last, content: [...last.content, ...synthetic] }
      else toolMessages.push({ role: 'tool', content: synthetic })
    }
    for (const toolMessage of toolMessages) {
      if (toolMessage.content.length) out.push(toolMessage)
      else changed = true
    }
    index = next
  }

  return { prompt: (changed ? out : prompt) as M[], stats }
}
