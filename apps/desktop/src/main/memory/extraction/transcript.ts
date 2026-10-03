import { toolOutputText, type MessagePart } from '../../../shared/chat'
import type { StoredChatMessage } from '../../chat/chat-store'
import { MEMORY_PART_PREFIX } from '../turn-memory'

export interface ExtractionBlock {
  seq: number
  messageId: string
  text: string
}
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

function label(message: StoredChatMessage, bot: boolean, text: string): string {
  if (message.role === 'assistant') return 'Assistant'
  if (!bot) return 'User'
  if (text.startsWith('Scheduled routine "')) return 'Routine input'
  if (text.startsWith('Message from bot "')) return 'Message from another bot'
  return 'Owner'
}

function partLine(part: MessagePart): string | null {
  switch (part.type) {
    case 'text':
      return part.checkpoint === 'openai-native' ? null : part.text
    case 'tool': {
      const output =
        part.state.status === 'completed'
          ? cut(toolOutputText(part.state.output).replace(/\s+/g, ' '), 300)
          : part.state.status === 'error'
            ? cut(part.state.error, 300)
            : ''
      return `[tool ${part.toolName} ${cut(JSON.stringify(part.input ?? {}), 200)} → ${part.state.status}${output ? `: ${output}` : ''}]`
    }
    case 'file':
      return part.name.startsWith(MEMORY_PART_PREFIX)
        ? null
        : part.kind === 'image'
          ? '[image]'
          : `[attached ${part.name}]`
    case 'skill-invocation':
      return `/${part.name}${part.args ? ` ${part.args}` : ''}`
    default:
      return null // reasoning, compaction summaries, imported context, mentions
  }
}

export function renderExtractionTranscript(
  messages: ReadonlyArray<{ seq: number; message: StoredChatMessage }>,
  opts: { bot: boolean; personal?: boolean }
): ExtractionBlock[] {
  const blocks: ExtractionBlock[] = []
  for (const { seq, message } of messages) {
    if (message.internal && message.role === 'user') continue
    if (opts.personal && message.role !== 'user') continue
    const parts = opts.personal ? message.parts.filter((part) => part.type === 'text') : message.parts
    const lines = parts.map(partLine).filter((line): line is string => Boolean(line?.trim()))
    if (!lines.length) continue
    const body = lines.join('\n')
    blocks.push({
      seq,
      messageId: message.id,
      text: opts.personal
        ? JSON.stringify({ role: 'user', messageId: message.id, text: body })
        : `${label(message, opts.bot, body)}: ${body}`,
    })
  }
  return blocks
}

export function chunkExtractionBlocks(
  blocks: readonly ExtractionBlock[],
  maxChars: number,
  maxChunks: number
): ExtractionBlock[][] {
  const chunks: ExtractionBlock[][] = []
  let current: ExtractionBlock[] = []
  let size = 0
  for (const block of blocks) {
    const text =
      block.text.length > maxChars
        ? {
            ...block,
            text: `${block.text.slice(0, Math.floor((maxChars - 1) / 3))}…${block.text.slice(-(maxChars - 1 - Math.floor((maxChars - 1) / 3)))}`,
          }
        : block
    if (current.length && size + text.text.length > maxChars) {
      chunks.push(current)
      if (chunks.length >= maxChunks) return chunks
      current = []
      size = 0
    }
    current.push(text)
    size += text.text.length + 2
  }
  if (current.length && chunks.length < maxChunks) chunks.push(current)
  return chunks
}
