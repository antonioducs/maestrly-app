import { tFor } from '../../i18n'
import { z } from 'zod'
import { toolOutputText, type MessagePart } from '../../../shared/chat'
import { listChatMessagesAround, searchConversationHistory } from '../../chat/chat-store'
import type { McpToolContext } from './context'
import { ok } from './context'

const HISTORY_READ = { maxChars: 12_000, toolOutputChars: 600, compactionChars: 2_000 } as const
const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

function renderPart(part: MessagePart, t: McpToolContext['t']): string | null {
  if (part.type === 'text') return part.checkpoint === 'openai-native' || !part.text ? null : part.text
  if (part.type === 'tool') {
    const state = part.state
    const detail =
      state.status === 'completed'
        ? `: ${cut(toolOutputText(state.output).trim(), HISTORY_READ.toolOutputChars)}`
        : state.status === 'error'
          ? `: ${cut(state.error, HISTORY_READ.toolOutputChars)}`
          : ''
    return `[tool ${part.toolName} · ${state.status}${detail}]`
  }
  if (part.type === 'compaction')
    return part.text
      ? t('returns.history.compactionSummary', { text: cut(part.text, HISTORY_READ.compactionChars) })
      : t('returns.history.compaction')
  if (part.type === 'file') return part.name.startsWith('maestrly-memory-') ? null : `[${part.kind} ${part.name}]`
  if (part.type === 'skill-invocation') return `/${part.name}${part.args ? ` ${part.args}` : ''}`
  if (part.type === 'generated-image') return t('returns.history.generatedImage', { name: part.name })
  return null
}

export function renderHistoryWindow(
  conversationId: string,
  seq: number,
  before: number,
  after: number,
  t: McpToolContext['t'] = tFor('en', 'mcp')
): string {
  const blocks = listChatMessagesAround(conversationId, seq, before, after).map(({ seq: at, message }) => {
    const body = message.parts
      .map((part) => renderPart(part, t))
      .filter((line): line is string => Boolean(line))
      .join('\n')
    return { seq: at, text: `#${at} · ${new Date(message.createdAt).toISOString()} · ${message.role}\n${body}` }
  })
  if (!blocks.length) return t('returns.history.empty')
  const full = blocks.map((block) => block.text).join('\n\n')
  if (full.length <= HISTORY_READ.maxChars) return full

  const note = t('returns.history.truncated')
  const budget = HISTORY_READ.maxChars - note.length - 2
  const selected: typeof blocks = []
  let used = 0
  // Reserve the requested message before spending the remaining budget on its closest neighbours.
  for (const block of blocks.sort((a, b) => Math.abs(a.seq - seq) - Math.abs(b.seq - seq) || a.seq - b.seq)) {
    const remaining = budget - used - (selected.length ? 2 : 0)
    if (block.text.length > remaining && block.seq !== seq) continue
    const text = cut(block.text, remaining)
    used += text.length + (selected.length ? 2 : 0)
    selected.push({ ...block, text })
  }
  return [...selected.sort((a, b) => a.seq - b.seq).map((block) => block.text), note].join('\n\n')
}

export function registerHistoryTools(ctx: McpToolContext): void {
  const { server, convId, t } = ctx
  server.registerTool(
    'history_search',
    {
      title: t('tools.history_search.title'),
      description: t('tools.history_search.description'),
      inputSchema: {
        query: z.string().trim().min(2).max(500),
        limit: z.number().int().min(1).max(30).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) =>
      ok(
        JSON.stringify(
          {
            results: searchConversationHistory(convId, query, limit ?? 8).map((hit) => ({
              seq: hit.seq,
              role: hit.role,
              at: new Date(hit.createdAt).toISOString(),
              snippet: hit.snippet,
            })),
          },
          null,
          2
        )
      )
  )
  server.registerTool(
    'history_read',
    {
      title: t('tools.history_read.title'),
      description: t('tools.history_read.description'),
      inputSchema: {
        seq: z.number().int().min(0),
        before: z.number().int().min(0).max(10).optional(),
        after: z.number().int().min(0).max(10).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ seq, before, after }) => ok(renderHistoryWindow(convId, seq, before ?? 3, after ?? 3, t))
  )
}
