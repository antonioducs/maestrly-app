import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { MessagePart, SubagentSessionSummary, SubagentTranscriptChange } from '../../shared/chat'
import {
  cancelMaestroDelegation,
  listTurnDelegations,
  MAESTRO_SUPERVISION_CHECKPOINT_MS,
  MAESTRO_SUPERVISION_STALL_MS,
  markDelegationObserved,
  waitForMaestroDelegation,
} from './maestro-delegation-registry'
import { getSubagentSession, getSubagentTranscriptChanges, listSubagentSessions } from './subagent-session-store'
import { toolOutputText } from '../../shared/chat'

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

/**
 * Everything returned here is re-read by the parent on every later model call for the rest of the turn.
 * Budgets are deliberately small: the parent coordinates, it does not need the worker's raw transcript.
 * `inspect_subagent` remains the escape hatch for detail, page by page.
 */
const REPORT_MAX_CHARS = 8_000
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

/** The worker's final message (host-embedded user updates included): the one thing the parent must read. */
function finalReport(sessionId: string): string {
  let report = ''
  let cursor = 0
  for (;;) {
    const page = getSubagentTranscriptChanges(sessionId, cursor, 200)
    if (!page.length) break
    for (const change of page) {
      if (change.role === 'assistant' && change.part.type === 'text' && change.part.text.trim()) report = change.part.text
    }
    cursor = page[page.length - 1].cursor
  }
  return clip(report, REPORT_MAX_CHARS)
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

function compactLiveSession(session: SubagentSessionSummary): unknown {
  return {
    sessionId: session.id,
    agent: session.agentName,
    status: session.status,
    phase: session.phase,
    currentTool: session.currentTool,
    cursor: session.revision,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    ...resumeFields(session),
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
  maestro: boolean
  signal: AbortSignal
}): ToolSet {
  const inspect = tool({
    description:
      'Read a paginated, sanitized transcript of a child subagent session. Use after task/delegate or to inspect a Maestro worker in detail.',
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
      if (!['preparing', 'running'].includes(fresh.status)) markDelegationObserved(fresh.id)
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
  if (!input.maestro) return { inspect_subagent: inspect }

  return {
    inspect_subagent: inspect,
    list_delegations: tool({
      description: 'List every Maestro delegation in this parent turn with compact live status.',
      inputSchema: z.object({}),
      execute: async () => ({
        delegations: listTurnDelegations(input.conversationId, input.parentMessageId).map((session) => ({
          ...(compactLiveSession(session) as Record<string, unknown>),
          ...(session.error ? { error: clip(session.error, 500) } : {}),
        })),
      }),
    }),
    wait_delegation: tool({
      description:
        'Block once while the host coalesces routine progress for one Maestro delegation. Returns only when the worker is terminal, orphaned, has no observable progress for about 3 minutes, or reaches a 5-minute supervision checkpoint. A terminal result carries the worker final `report`; call inspect_subagent only when you need the transcript behind it. Stalled is a warning, never proof of failure: do not cancel from silence alone. Reuse the returned cursor if another wait is needed.',
      inputSchema: z.object({
        session_id: z.string(),
        cursor: z.number().int().min(0).optional(),
      }),
      execute: async (args) => {
        const session = getSubagentSession(args.session_id)
        if (
          session?.origin !== 'delegate' ||
          session.conversationId !== input.conversationId ||
          session.parentMessageId !== input.parentMessageId
        ) {
          return { error: 'delegation-not-found' }
        }
        const requestedCursor = args.cursor ?? 0
        const result = await waitForMaestroDelegation(session.id, requestedCursor, input.signal)
        if (!result) return { error: 'delegation-not-found' }
        if (!['preparing', 'running'].includes(result.session.status)) markDelegationObserved(result.session.id)
        const settled = result.reason === 'terminal' || result.reason === 'orphaned'
        // Terminal: the parent gets the final report, not the transcript. Every byte returned here is re-read on
        // each later model call, and the raw transcript was the single largest source of parent context growth.
        // Non-terminal: a status line is enough; nothing here should invite the parent to narrate the wait.
        if (!settled) {
          return {
            reason: result.reason,
            session: compactLiveSession(result.session),
            cursor: requestedCursor,
            terminal: false,
            liveness: {
              alive: result.alive,
              idleMs: result.idleMs,
              stalled: result.reason === 'stalled',
              staleAfterMs: MAESTRO_SUPERVISION_STALL_MS,
              checkpointAfterMs: MAESTRO_SUPERVISION_CHECKPOINT_MS,
            },
          }
        }
        return {
          reason: result.reason,
          session: compactSession(result.session),
          cursor: result.session.revision,
          terminal: terminal.has(result.session.status),
          liveness: { alive: result.alive, idleMs: result.idleMs, stalled: false },
          report: finalReport(result.session.id),
          next: 'Use inspect_subagent with this session_id only if the report is insufficient.',
        }
      },
    }),
    cancel_delegation: tool({
      description: 'Cancel one active Maestro delegation owned by this parent turn.',
      inputSchema: z.object({ session_id: z.string() }),
      execute: async (args) =>
        cancelMaestroDelegation({
          conversationId: input.conversationId,
          parentMessageId: input.parentMessageId,
          sessionId: args.session_id,
        }),
    }),
  }
}
