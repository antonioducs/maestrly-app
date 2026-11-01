import { createHash } from 'node:crypto'
import { type ChatMessage, type MessagePart, toolOutputText } from '../../../shared/chat'
import { clipMiddle } from '../message'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

/** Older outputs shorter than this cost little and often carry the answer itself. */
export const PRUNE_MIN_OUTPUT_CHARS = 1_000
/** Repeated outputs at least this long are kept only in their newest occurrence. */
export const DEDUPE_MIN_OUTPUT_CHARS = 200
/** Head plus tail of an older output kept in the summarizer's input. */
export const SUMMARY_TOOL_OUTPUT_CHARS = 1_200
/** The latest user turns, whose tool results the model is still working from. */
export const PROTECTED_USER_TURNS = 3
const PROTECTED_TOOLS = new Set(['todo_write', 'review_plan', 'ask_question'])
const MAX_ARGS_CHARS = 120

const bareName = (name: string) => name.replace(/^mcp__maestrly__/, '')

function outputText(part: ToolPart): string | null {
  if (part.state.status === 'completed') return toolOutputText(part.state.output)
  if (part.state.status === 'error') return part.state.error
  return null
}

function outputIdentity(part: ToolPart): string | null {
  if (part.state.status !== 'completed') return null
  const output = part.state.output
  const text = toolOutputText(output)
  if (text.length < DEDUPE_MIN_OUTPUT_CHARS) return null
  return createHash('sha256')
    .update(typeof output === 'string' ? output : JSON.stringify(output))
    .digest('hex')
}

function argsPreview(input: unknown): string {
  let text: string
  try {
    text = JSON.stringify(input ?? {}) ?? ''
  } catch {
    text = String(input ?? '')
  }
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS - 1)}…` : text
}

/** One-line replacement for an output the model no longer receives; the original stays in the stored history. */
export function toolOutputStub(part: ToolPart, reason: 'removed' | 'duplicate' = 'removed'): string {
  const text = outputText(part) ?? ''
  const lines = text ? text.split('\n').length : 0
  const status =
    part.state.status === 'error' ? `error: ${text.trim().split('\n')[0].slice(0, 200)}` : part.state.status
  const note =
    reason === 'duplicate' ? 'same output as a later call' : 'output removed — rerun or use history_search/history_read'
  return `[tool ${bareName(part.toolName)} ${argsPreview(part.input)} → ${status}, ${lines} lines, ${text.length} chars; ${note}]`
}

/** Ids of the messages from the latest `turns` user messages on: their tool results are never pruned. */
export function protectedRecentMessageIds(messages: readonly ChatMessage[], turns = PROTECTED_USER_TURNS): Set<string> {
  let seen = 0
  let from = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user') continue
    seen += 1
    from = index
    if (seen >= turns) break
  }
  return new Set(seen >= turns ? messages.slice(from).map((message) => message.id) : messages.map(({ id }) => id))
}

export interface ToolPruneTarget {
  messageId: string
  partId: string
  /** What the model receives instead of the output. */
  stub: string
  savedChars: number
}

/**
 * Plans which older tool outputs the model stops receiving. `stub` replaces each one of at least 1k characters by a
 * one-line description; `clip` (for the summarizer's input) keeps its head and tail. In both modes an output repeated
 * later is reduced to a note. Recent turns, unfinished tools, plans, to-do lists and questions are never touched.
 */
export function planToolPruning(
  messages: readonly ChatMessage[],
  opts: { protectedIds: ReadonlySet<string>; mode: 'stub' | 'clip' }
): ToolPruneTarget[] {
  const targets: ToolPruneTarget[] = []
  const later = new Set<string>()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]
      if (part.type !== 'tool') continue
      const identity = outputIdentity(part)
      const prunable =
        !opts.protectedIds.has(message.id) && !PROTECTED_TOOLS.has(bareName(part.toolName)) && !part.contextStub
      const text = outputText(part)
      if (prunable && text != null) {
        const duplicate = identity != null && later.has(identity)
        const stub = duplicate
          ? toolOutputStub(part, 'duplicate')
          : text.length < PRUNE_MIN_OUTPUT_CHARS
            ? null
            : opts.mode === 'stub'
              ? toolOutputStub(part)
              : text.length > SUMMARY_TOOL_OUTPUT_CHARS
                ? clipMiddle(text, SUMMARY_TOOL_OUTPUT_CHARS, '\n… older output clipped for the summary …\n')
                : null
        if (stub != null && stub.length < text.length) {
          targets.push({ messageId: message.id, partId: part.id, stub, savedChars: text.length - stub.length })
        }
      }
      if (identity) later.add(identity)
    }
  }
  return targets.reverse()
}

/** `messages` with each target's stub set as the tool part's `contextStub`; untouched messages are kept as is. */
export function applyToolPruning<T extends ChatMessage>(
  messages: readonly T[],
  targets: readonly ToolPruneTarget[]
): T[] {
  if (targets.length === 0) return [...messages]
  const byMessage = new Map<string, Map<string, string>>()
  for (const target of targets) {
    const parts = byMessage.get(target.messageId) ?? new Map<string, string>()
    parts.set(target.partId, target.stub)
    byMessage.set(target.messageId, parts)
  }
  return messages.map((message) => {
    const stubs = byMessage.get(message.id)
    if (!stubs) return message
    return {
      ...message,
      parts: message.parts.map((part) =>
        part.type === 'tool' && stubs.has(part.id) ? { ...part, contextStub: stubs.get(part.id) } : part
      ),
    }
  })
}
