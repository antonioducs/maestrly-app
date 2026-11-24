import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { MessagePart, SubagentSessionSummary, SubagentTranscriptChange } from '../../shared/chat'
import { getSubagentSession, getSubagentTranscriptChanges, listSubagentSessions } from './subagent-session-store'
import { toolOutputText } from '../../shared/chat'

/**
 * Everything returned here is re-read by the parent on every later model call for the rest of the turn.
 * Budgets are deliberately small: the parent coordinates, it does not need the worker's raw transcript.
 * `inspect_subagent` remains the escape hatch for detail, page by page.
 */
const INSPECT_TEXT_MAX_CHARS = 4_000
const INSPECT_TOOL_MAX_CHARS = 1_500
const INSPECT_PAGE_MAX_CHARS = 12_000
const INSPECT_DEFAULT_LIMIT = 20

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text
}

function compactPart(part: MessagePart): unknown {
  if (part.type === 'text') return { type: 'message', text: clip(part.text, INSPECT_TEXT_MAX_CHARS) }
  if (part.type !== 'tool') return { type: part.type }
  const state = part.state
  return {
    type: 'tool',
    name: part.toolName,
    input: part.input,
    status: state.status,
    ...(state.status === 'completed' || state.status === 'running'
      ? { output: clip(toolOutputText(state.output), INSPECT_TOOL_MAX_CHARS) }
      : {}),
    ...(state.status === 'error' ? { error: clip(state.error, INSPECT_TOOL_MAX_CHARS) } : {}),
  }
}

/** Stops at the page budget so one page never exceeds ~12k chars; the caller reports `hasMore` from the cursor. */
function compactChanges(changes: SubagentTranscriptChange[]): { items: unknown[]; consumed: number } {
  const items: unknown[] = []
  let budget = INSPECT_PAGE_MAX_CHARS
  for (const change of changes) {
    const item = { cursor: change.cursor, at: change.updatedAt, ...(compactPart(change.part) as Record<string, unknown>) }
    const size = JSON.stringify(item).length
    if (items.length && size > budget) break
    budget -= size
    items.push(item)
  }
  return { items, consumed: items.length }
}

function compactSession(session: SubagentSessionSummary): unknown {
  return {
    sessionId: session.id,
    agent: session.agentName,
    status: session.status,
    phase: session.phase,
    currentTool: session.currentTool,
    cursor: session.revision,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    durationMs: session.durationMs,
    usage: session.usage,
    runtimeEstimatedCostUsd: session.runtimeEstimatedCostUsd,
    tools: session.toolNames,
    files: capped(session.files),
    commands: capped(session.commands.map((command) => clip(command, 200))),
    tests: capped(session.tests.map((command) => clip(command, 200))),
    error: session.error ? clip(session.error, 2_000) : undefined,
    ...resumeFields(session),
  }
}

function capped(list: string[], max = 25): string[] {
  return list.length > max ? [...list.slice(0, max), `… +${list.length - max} more`] : list
}

/** Continuity outcome: the parent must see when a "resume" silently became a fresh worker and why. */
function resumeFields(session: SubagentSessionSummary): Record<string, unknown> {
  return {
    ...(session.resumedFrom ? { resumedFrom: session.resumedFrom } : {}),
    ...(session.resumeStatus ? { resumeStatus: session.resumeStatus } : {}),
    ...(session.resumeReason ? { resumeReason: session.resumeReason } : {}),
  }
}

function resolveSession(input: {
  conversationId: string
  parentMessageId: string
  sessionId?: string
  agent?: string
}): SubagentSessionSummary | null {
  if (input.sessionId) {
    const session = getSubagentSession(input.sessionId)
    return session?.conversationId === input.conversationId ? session : null
  }
  return (
    listSubagentSessions(input.conversationId, { parentMessageId: input.parentMessageId, limit: 100 }).find(
      (session) => !input.agent || session.agentName === input.agent
    ) ?? null
  )
}

export function buildSubagentSupervisionTools(input: {
  conversationId: string
  parentMessageId: string
}): ToolSet {
  const inspect = tool({
    description:
      'Read a paginated, sanitized transcript of a child subagent session. Use after task to inspect a child subagent in detail.',
    inputSchema: z.object({
      session_id: z.string().optional(),
      agent: z.string().optional(),
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args) => {
      const session = resolveSession({
        conversationId: input.conversationId,
        parentMessageId: input.parentMessageId,
        sessionId: args.session_id,
        agent: args.agent,
      })
      if (!session) return { error: 'subagent-session-not-found' }
      const limit = args.limit ?? INSPECT_DEFAULT_LIMIT
      const changes = getSubagentTranscriptChanges(session.id, args.cursor ?? 0, limit)
      const fresh = getSubagentSession(session.id) ?? session
      const page = compactChanges(changes)
      const truncatedByBudget = page.consumed < changes.length
      const cursor =
        truncatedByBudget || changes.length >= limit ? changes[page.consumed - 1]?.cursor ?? fresh.revision : fresh.revision
      return {
        session: compactSession(fresh),
        cursor,
        hasMore: cursor < fresh.revision,
        changes: page.items,
      }
    },
  })
  return { inspect_subagent: inspect }
}
