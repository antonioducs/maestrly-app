import type { SubagentRunMeta, SubagentSessionSummary, SubagentWaitResult } from '../../shared/chat'
import type { MaestroDelegationSnapshotV1 } from '../../shared/maestro'
import type { SubagentExecutionSnapshotV1 } from '../../shared/subagent-profiles'
import {
  createSubagentSessionRecorder,
  interruptOrphanedSubagentSession,
  type SubagentSessionRecorder,
  waitForSubagentSession,
} from './subagent-session'
import { getSubagentSession, listSubagentSessions } from './subagent-session-store'
import type { MaestroLiveRunPort } from './maestro-live'

export interface MaestroAsyncDelegationResult {
  output: string
  error?: string
  sub?: SubagentRunMeta
}

interface ActiveDelegation {
  sessionId: string
  conversationId: string
  parentMessageId: string
  agentName: string
  controller: AbortController
  recorder: SubagentSessionRecorder
  done: Promise<MaestroAsyncDelegationResult>
}

const active = new Map<string, ActiveDelegation>()
const observed = new Set<string>()
const reportedStalls = new Map<string, number>()

export const MAESTRO_SUPERVISION_CHECK_INTERVAL_MS = 20_000
export const MAESTRO_SUPERVISION_STALL_MS = 3 * 60_000
export const MAESTRO_SUPERVISION_CHECKPOINT_MS = 5 * 60_000

export type MaestroDelegationWaitReason = 'terminal' | 'stalled' | 'orphaned' | 'checkpoint'

export interface MaestroDelegationWaitResult extends SubagentWaitResult {
  reason: MaestroDelegationWaitReason
  alive: boolean
  idleMs: number
}

export interface MaestroDelegationWaitOptions {
  checkIntervalMs?: number
  stallMs?: number
  checkpointMs?: number
}

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

function duration(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback))
}

async function supervisionSnapshot(
  sessionId: string,
  cursor: number,
  reason: MaestroDelegationWaitReason,
  idleMs: number
): Promise<MaestroDelegationWaitResult | null> {
  const result = await waitForSubagentSession(sessionId, cursor, 0)
  if (!result) return null
  return {
    ...result,
    reason,
    alive: ['preparing', 'running'].includes(result.session.status) && active.has(sessionId),
    idleMs,
  }
}

/**
 * Absorbs routine worker events inside the host. The parent model is resumed only for an actionable
 * supervision reason, so transcript streaming can remain live without creating one model turn per event.
 */
export async function waitForMaestroDelegation(
  sessionId: string,
  cursor: number,
  signal: AbortSignal,
  options: MaestroDelegationWaitOptions = {}
): Promise<MaestroDelegationWaitResult | null> {
  const checkIntervalMs = duration(options.checkIntervalMs, MAESTRO_SUPERVISION_CHECK_INTERVAL_MS)
  const stallMs = duration(options.stallMs, MAESTRO_SUPERVISION_STALL_MS)
  const checkpointMs = duration(options.checkpointMs, MAESTRO_SUPERVISION_CHECKPOINT_MS)
  const startedAt = Date.now()
  const initialCursor = Math.max(0, Math.floor(cursor))
  let observedCursor = initialCursor

  while (true) {
    signal.throwIfAborted()
    let session = getSubagentSession(sessionId)
    if (!session) return null

    const now = Date.now()
    const idleMs = Math.max(0, now - session.lastActivityAt)
    if (terminal.has(session.status)) {
      reportedStalls.delete(sessionId)
      return supervisionSnapshot(sessionId, initialCursor, 'terminal', idleMs)
    }

    if (!active.has(sessionId)) {
      session = interruptOrphanedSubagentSession(sessionId, now) ?? session
      reportedStalls.delete(sessionId)
      return supervisionSnapshot(sessionId, initialCursor, 'orphaned', idleMs)
    }

    const reportedActivityAt = reportedStalls.get(sessionId)
    if (reportedActivityAt !== undefined && reportedActivityAt !== session.lastActivityAt) {
      reportedStalls.delete(sessionId)
    }
    const stallAlreadyReported = reportedStalls.get(sessionId) === session.lastActivityAt
    if (idleMs >= stallMs && !stallAlreadyReported) {
      reportedStalls.set(sessionId, session.lastActivityAt)
      return supervisionSnapshot(sessionId, initialCursor, 'stalled', idleMs)
    }

    const elapsedMs = Math.max(0, now - startedAt)
    if (elapsedMs >= checkpointMs) {
      return supervisionSnapshot(sessionId, initialCursor, 'checkpoint', idleMs)
    }

    const untilCheckpoint = checkpointMs - elapsedMs
    const untilStall = stallAlreadyReported ? checkIntervalMs : Math.max(1, stallMs - idleMs)
    const waitMs = Math.max(1, Math.min(checkIntervalMs, untilCheckpoint, untilStall))
    const update = await waitForSubagentSession(sessionId, observedCursor, waitMs, signal)
    if (!update) return null
    observedCursor = Math.max(observedCursor, update.cursor, update.session.revision)
  }
}

function handleOutput(session: SubagentSessionSummary): string {
  return JSON.stringify({
    sessionId: session.id,
    agent: session.agentName,
    status: session.status,
    cursor: session.revision,
    ...(session.resumedFrom ? { resumedFrom: session.resumedFrom } : {}),
    next: 'Call wait_delegation once with this sessionId and cursor; the host coalesces routine progress.',
  })
}

export function startMaestroDelegation(input: {
  conversationId: string
  parentMessageId: string
  toolCallId: string
  agentName: string
  task: string
  profile: SubagentExecutionSnapshotV1
  maestro: MaestroDelegationSnapshotV1
  parentSignal: AbortSignal
  maestroLive?: MaestroLiveRunPort
  /** Lineage pointer; defaults to the host-validated `maestro.resumedFrom`. */
  resumedFrom?: string
  execute: (signal: AbortSignal, recorder: SubagentSessionRecorder) => Promise<MaestroAsyncDelegationResult>
}): MaestroAsyncDelegationResult {
  const resumedFrom = input.resumedFrom ?? input.maestro.resumedFrom
  const recorder = createSubagentSessionRecorder({
    conversationId: input.conversationId,
    parentMessageId: input.parentMessageId,
    toolCallId: input.toolCallId,
    origin: 'delegate',
    agentName: input.agentName,
    task: input.task,
    profile: input.profile,
    maestro: input.maestro,
    ...(resumedFrom ? { resumedFrom } : {}),
  })
  const existing = active.get(recorder.id)
  if (existing) {
    const session = recorder.summary() ?? getSubagentSession(recorder.id)
    return {
      output: session ? handleOutput(session) : JSON.stringify({ sessionId: recorder.id, status: 'running' }),
      sub: {
        profile: input.profile,
        maestro: input.maestro,
        sessionId: recorder.id,
        startedAt: session?.startedAt,
        phase: session?.phase,
        lastActivityAt: session?.lastActivityAt,
      },
    }
  }
  const persisted = recorder.summary()
  if (persisted && !['preparing', 'running'].includes(persisted.status)) {
    return {
      output: handleOutput(persisted),
      sub: {
        profile: input.profile,
        maestro: input.maestro,
        sessionId: recorder.id,
        startedAt: persisted.startedAt,
        phase: persisted.phase,
        lastActivityAt: persisted.lastActivityAt,
        durationMs: persisted.durationMs,
        usage: persisted.usage,
        runtimeEstimatedCostUsd: persisted.runtimeEstimatedCostUsd,
      },
    }
  }

  const controller = new AbortController()
  const signal = AbortSignal.any([input.parentSignal, controller.signal])
  const onParentAbort = () => controller.abort(input.parentSignal.reason ?? new Error('Parent turn aborted.'))
  input.parentSignal.addEventListener('abort', onParentAbort, { once: true })
  recorder.phase('queued')

  const done = Promise.resolve()
    .then(() => {
      signal.throwIfAborted()
      return input.execute(signal, recorder)
    })
    .then((result) => {
      const rawOutput = result.error
        ? result.output.trim() && result.output.trim() !== result.error.trim()
          ? `${result.error}\n\n${result.output}`
          : result.error
        : result.output
      const output = input.maestroLive?.embedPending(input.toolCallId, rawOutput).output ?? rawOutput
      if (output !== result.output) recorder.text({ kind: 'replace', text: output })
      return result.error ? { ...result, output, error: output } : { ...result, output }
    })
    .catch((error) => {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message = input.maestroLive?.embedPending(input.toolCallId, rawMessage).output ?? rawMessage
      if (message !== rawMessage) recorder.text({ kind: 'replace', text: message })
      recorder.complete({ status: signal.aborted ? 'cancelled' : 'failed', error: message })
      return { output: '', error: message }
    })
    .finally(() => {
      const session = recorder.summary()
      if (session && ['preparing', 'running'].includes(session.status)) {
        recorder.complete({
          status: 'interrupted',
          error: 'Delegation execution ended without reporting a terminal status.',
        })
      }
      input.parentSignal.removeEventListener('abort', onParentAbort)
      active.delete(recorder.id)
      reportedStalls.delete(recorder.id)
    })
  void done.catch(() => undefined)
  active.set(recorder.id, {
    sessionId: recorder.id,
    conversationId: input.conversationId,
    parentMessageId: input.parentMessageId,
    agentName: input.agentName,
    controller,
    recorder,
    done,
  })

  const session = recorder.summary()!
  return {
    output: handleOutput(session),
    sub: {
      profile: input.profile,
      maestro: input.maestro,
      sessionId: recorder.id,
      startedAt: session.startedAt,
      phase: session.phase,
      lastActivityAt: session.lastActivityAt,
    },
  }
}

export function cancelMaestroDelegation(input: {
  conversationId: string
  parentMessageId: string
  sessionId: string
}): { ok: boolean; status: string } {
  const entry = active.get(input.sessionId)
  if (!entry || entry.conversationId !== input.conversationId || entry.parentMessageId !== input.parentMessageId) {
    const session = getSubagentSession(input.sessionId)
    return { ok: false, status: session?.status ?? 'not-found' }
  }
  entry.controller.abort(new Error('Delegation cancelled by the parent agent.'))
  entry.recorder.complete({ status: 'cancelled', error: 'Delegation cancelled by the parent agent.' })
  return { ok: true, status: 'cancelled' }
}

export function listTurnDelegations(conversationId: string, parentMessageId: string): SubagentSessionSummary[] {
  return listSubagentSessions(conversationId, { parentMessageId, origin: 'delegate', limit: 100 })
}

export function markDelegationObserved(sessionId: string): void {
  observed.add(sessionId)
}

export function unobservedTurnDelegations(conversationId: string, parentMessageId: string): SubagentSessionSummary[] {
  return listTurnDelegations(conversationId, parentMessageId).filter((session) => !observed.has(session.id))
}

export function activeTurnDelegations(conversationId: string, parentMessageId: string): SubagentSessionSummary[] {
  return listTurnDelegations(conversationId, parentMessageId).filter(
    (session) => session.status === 'preparing' || session.status === 'running'
  )
}

/** Host guard: wait windows are bounded, worker lifetime is not. Stop/abort remains the only global cap. */
export async function waitForTurnDelegationsTerminal(
  conversationId: string,
  parentMessageId: string,
  signal: AbortSignal
): Promise<SubagentSessionSummary[]> {
  while (true) {
    signal.throwIfAborted()
    const sessions = listTurnDelegations(conversationId, parentMessageId)
    const pending = sessions.filter((session) => session.status === 'preparing' || session.status === 'running')
    if (!pending.length) return sessions
    await Promise.all(pending.map((session) => waitForSubagentSession(session.id, session.revision, 30_000, signal)))
  }
}

export function cancelTurnDelegations(conversationId: string, parentMessageId: string): void {
  for (const entry of active.values()) {
    if (entry.conversationId !== conversationId || entry.parentMessageId !== parentMessageId) continue
    entry.controller.abort(new Error('Parent turn stopped.'))
    entry.recorder.complete({ status: 'cancelled', error: 'Parent turn stopped.' })
  }
}

export function activeMaestroDelegationCount(): number {
  return active.size
}
