import { tFor } from '../../i18n'
import { z } from 'zod'
import { toolOutputText, type MessagePart } from '../../../shared/chat'
import { listChatMessagesAround } from '../../chat/chat-store'
import { browseHistory, searchHistory, type HistorySearchHit } from '../../chat/history-index/search'
import { localEmbeddingReranker } from '../../chat/history-index/semantic'
import { canReadConversationHistory, workspaceHistoryAccess } from '../../chat/history-index/access'
import { planRef } from '../../chat/plans/context'
import { getConversationPlan, listConversationPlans } from '../../chat/plans/store'
import type { McpToolContext } from './context'
import { err, ok } from './context'

const HISTORY_READ = {
  maxChars: 12_000,
  toolOutputChars: 600,
  fullToolOutputChars: 8_000,
  compactionChars: 2_000,
} as const
const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

function renderPart(part: MessagePart, t: McpToolContext['t'], toolOutputChars: number): string | null {
  if (part.type === 'text') return part.checkpoint === 'openai-native' || !part.text ? null : part.text
  if (part.type === 'tool') {
    const state = part.state
    const detail =
      state.status === 'completed'
        ? `: ${cut(toolOutputText(state.output).trim(), toolOutputChars)}`
        : state.status === 'error'
          ? `: ${cut(state.error, toolOutputChars)}`
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
  t: McpToolContext['t'] = tFor('en', 'mcp'),
  options: { detail?: 'brief' | 'full' } = {}
): string {
  const toolOutputChars = options.detail === 'full' ? HISTORY_READ.fullToolOutputChars : HISTORY_READ.toolOutputChars
  const blocks = listChatMessagesAround(conversationId, seq, before, after).map(({ seq: at, message }) => {
    const body = message.parts
      .map((part) => renderPart(part, t, toolOutputChars))
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

const result = (hit: HistorySearchHit, names?: ReadonlyMap<string, string>) => ({
  seq: hit.seq,
  role: hit.role,
  at: new Date(hit.createdAt).toISOString(),
  snippet: hit.snippet,
  ...(hit.score !== undefined ? { score: hit.score } : {}),
  ...(hit.kind ? { kind: hit.kind } : {}),
  ...(names ? { conversationId: hit.conversationId, conversation: names.get(hit.conversationId) ?? '' } : {}),
})

const json = (value: unknown) => ok(JSON.stringify(value, null, 2))

export function registerHistoryTools(ctx: McpToolContext): void {
  const { server, convId, t, workerScope } = ctx
  server.registerTool(
    'history_search',
    {
      title: t('tools.history_search.title'),
      description: t('tools.history_search.description'),
      inputSchema: {
        query: z.string().trim().min(2).max(500).optional().describe(t('tools.history_search.params.query')),
        limit: z.number().int().min(1).max(30).optional().describe(t('tools.history_search.params.limit')),
        mode: z.enum(['relevance', 'exact']).optional().describe(t('tools.history_search.params.mode')),
        beforeSeq: z.number().int().min(0).optional().describe(t('tools.history_search.params.beforeSeq')),
        scope: z.enum(['conversation', 'workspace']).optional().describe(t('tools.history_search.params.scope')),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, mode, beforeSeq, scope }) => {
      const bounded = limit ?? 8
      if (scope === 'workspace') {
        const access = workspaceHistoryAccess(convId, workerScope)
        if (!access.ok) return err(t('returns.history.workspaceDenied'))
        const names = new Map(access.conversations.map((conversation) => [conversation.id, conversation.name]))
        if (!query) {
          // The workspace's conversations, most recently active first, each with the last thing the person asked.
          const results = access.conversations.slice(0, bounded).map((conversation) => {
            const [latest] = browseHistory(conversation.id, { limit: 1 })
            return {
              conversationId: conversation.id,
              conversation: conversation.name,
              at: new Date(conversation.lastActivityAt).toISOString(),
              ...(conversation.archived ? { archived: true } : {}),
              ...(latest ? { seq: latest.seq, role: latest.role, snippet: latest.snippet } : {}),
            }
          })
          return json({ results, mode: 'browse', scope: 'workspace' })
        }
        const found = await searchHistory({
          conversationIds: access.conversations.map((conversation) => conversation.id),
          query,
          mode,
          limit: bounded,
          rerank: localEmbeddingReranker(),
        })
        return json({
          results: found.hits.map((hit) => result(hit, names)),
          mode: found.mode,
          scope: 'workspace',
          ...(found.building ? { index: 'building' } : {}),
        })
      }
      if (!query)
        return json({
          results: browseHistory(convId, { beforeSeq, limit: bounded }).map((hit) => result(hit)),
          mode: 'browse',
        })
      const found = await searchHistory({
        conversationIds: [convId],
        query,
        mode,
        limit: bounded,
        beforeSeq,
        rerank: localEmbeddingReranker(),
      })
      return json({
        results: found.hits.map((hit) => result(hit)),
        mode: found.mode,
        ...(found.building ? { index: 'building' } : {}),
      })
    }
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
        detail: z.enum(['brief', 'full']).optional().describe(t('tools.history_read.params.detail')),
        conversationId: z.string().min(1).max(200).optional().describe(t('tools.history_read.params.conversationId')),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ seq, before, after, detail, conversationId }) => {
      const target = conversationId ?? convId
      if (!canReadConversationHistory(convId, target, workerScope)) return err(t('returns.history.conversationDenied'))
      return ok(renderHistoryWindow(target, seq, before ?? 3, after ?? 3, t, { detail }))
    }
  )
  server.registerTool(
    'plan_read',
    {
      title: t('tools.plan_read.title'),
      description: t('tools.plan_read.description'),
      inputSchema: {
        id: z.string().trim().min(1).max(100).optional().describe(t('tools.plan_read.params.id')),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const plan = getConversationPlan(convId, id)
      if (plan) {
        const title = plan.title ? ` · ${plan.title}` : ''
        return ok(`${planRef(plan.id)} · v${plan.version} · ${plan.status}${title}\n\n${plan.content}`)
      }
      const ids = listConversationPlans(convId).map((entry) => planRef(entry.id))
      return err(ids.length ? t('returns.plans.notFound', { ids: ids.join(', ') }) : t('returns.plans.none'))
    }
  )
}
