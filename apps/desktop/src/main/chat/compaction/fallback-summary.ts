import type { ChatMessage, MessagePart } from '../../../shared/chat'
import { activeChatContext, clipMiddle, isPortableCompactionMarker } from '../message'
import { COMPACTION_SUMMARY_SECTIONS } from './summary-prompt'

export const FALLBACK_SUMMARY_MAX_CHARS = 12_000
const MAX_REQUESTS = 3
const MAX_REQUEST_CHARS = 1_500
const MAX_FILES = 25
const MAX_ERRORS = 8
const FILE_KEYS = ['path', 'file_path', 'filePath', 'file', 'filename', 'paths', 'files']

export const FALLBACK_SUMMARY_NOTICE =
  'Automatic summarization failed, so the older messages were condensed without a model and left the model context. ' +
  'They remain in the conversation history: use history_search and history_read to read them.'

function previousSummary(history: readonly ChatMessage[]): string {
  let text = ''
  for (const message of history)
    for (const part of message.parts) if (isPortableCompactionMarker(part)) text = part.text
  return text.trim()
}

function textOf(message: ChatMessage): string {
  return message.parts
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text' && !part.checkpoint)
    .map((part) => part.text)
    .join('')
    .trim()
}

function filesIn(input: unknown, into: Set<string>): void {
  if (!input || typeof input !== 'object') return
  for (const key of FILE_KEYS) {
    const value = (input as Record<string, unknown>)[key]
    for (const item of Array.isArray(value) ? value : [value])
      if (typeof item === 'string' && item.trim() && item.length <= 300) into.add(item.trim())
  }
}

function bullets(items: readonly string[], empty = '(none)'): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty
}

/**
 * Model-free digest of what a failed compaction should have summarized, in the structured summary's sections, so
 * the conversation can continue and the next successful compaction can update it like any summary.
 */
export function fallbackCompactionSummary(history: readonly ChatMessage[]): string {
  const active = activeChatContext([...history]).messages
  const requests = active
    .filter((message) => message.role === 'user')
    .map(textOf)
    .filter(Boolean)
    .slice(-MAX_REQUESTS)
    .map((text) => `"${clipMiddle(text, MAX_REQUEST_CHARS, ' … ')}"`)
  const tools = new Map<string, number>()
  const files = new Set<string>()
  const errors: string[] = []
  for (const message of active) {
    if (message.error?.trim()) errors.push(message.error.trim().split('\n')[0].slice(0, 200))
    for (const part of message.parts) {
      if (part.type !== 'tool') continue
      const name = part.toolName.replace(/^mcp__maestrly__/, '')
      tools.set(name, (tools.get(name) ?? 0) + 1)
      filesIn(part.input, files)
      if (part.state.status === 'error') errors.push(`${name}: ${part.state.error.trim().split('\n')[0].slice(0, 200)}`)
    }
  }
  const sections: Record<(typeof COMPACTION_SUMMARY_SECTIONS)[number], string> = {
    Objective: '(not summarized: see the pending requests and the previous summary)',
    'Requirements and constraints': '(not summarized)',
    Decisions: '(not summarized)',
    'Work state': bullets([
      `${active.length} older messages were condensed without a summary.`,
      ...(tools.size > 0
        ? [`Tools used: ${[...tools].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ')}`]
        : []),
    ]),
    'Pending user requests': bullets(requests),
    'Next steps': 'Re-read the latest requests above and continue; read the original messages if details are missing.',
    'Relevant files': bullets([...files].slice(0, MAX_FILES).map((file) => `\`${file}\``)),
    'Exact identifiers': '(not extracted: read the original messages with history_read)',
    'Errors and fixes': bullets(errors.slice(-MAX_ERRORS)),
  }
  const body = [
    FALLBACK_SUMMARY_NOTICE,
    ...COMPACTION_SUMMARY_SECTIONS.map((section) => `## ${section}\n${sections[section]}`),
  ].join('\n\n')
  const previous = previousSummary(history)
  if (!previous) return clipMiddle(body, FALLBACK_SUMMARY_MAX_CHARS, '\n…\n')
  const label = '\n\nPrevious summary, carried over unchanged:\n'
  const room = Math.max(1_000, FALLBACK_SUMMARY_MAX_CHARS - body.length - label.length)
  // Nested headings would read as this summary's own sections.
  const nested = previous.replace(/^(#{1,6})\s/gm, '###$1 ')
  return clipMiddle(
    `${body}${label}${clipMiddle(nested, room, '\n… previous summary shortened …\n')}`,
    FALLBACK_SUMMARY_MAX_CHARS,
    '\n…\n'
  )
}
