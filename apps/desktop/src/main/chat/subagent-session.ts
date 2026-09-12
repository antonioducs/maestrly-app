import type { Tool, ToolSet } from 'ai'
import type {
  MessagePart,
  SubagentResumeStatus,
  SubagentRuntimeHandle,
  SubagentSessionChangedEvent,
  SubagentSessionOrigin,
  SubagentSessionStatus,
  SubagentSessionSummary,
  SubagentSessionUsage,
  SubagentWaitResult,
  ToolOutput,
} from '../../shared/chat'
import type { MaestroDelegationSnapshotV1 } from '../../shared/maestro'
import type { SubagentExecutionSnapshotV1 } from '../../shared/subagent-profiles'
import { applySubagentTextUpdate, type SubagentTextUpdate } from './subagent-text-stream'
import { clipPersistedToolOutput } from './message'
import {
  modelOutputToChatToolOutput,
  sanitizeStructuredContentForPersistence,
  sanitizeToolOutputForPersistence,
} from './tool-output'
import {
  createSubagentSession,
  getSubagentSession,
  getSubagentTranscriptChanges,
  subagentSessionId,
  updateSubagentSession,
  upsertSubagentTranscriptPart,
} from './subagent-session-store'
import { deepRedact, redactTokens } from '../pii-scrub'

type SessionListener = (event: SubagentSessionChangedEvent) => void

const listeners = new Set<SessionListener>()
const waiters = new Map<string, Set<() => void>>()

function publish(summary: SubagentSessionSummary): void {
  const event: SubagentSessionChangedEvent = {
    conversationId: summary.conversationId,
    sessionId: summary.id,
    revision: summary.revision,
  }
  for (const listener of listeners) listener(event)
  const pending = waiters.get(summary.id)
  if (!pending) return
  waiters.delete(summary.id)
  for (const wake of pending) wake()
}

export function onSubagentSessionChanged(listener: SessionListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Same-process recovery for a persisted live session that no longer has an owning execution.
 * This is not a timeout: callers must first prove that the Maestro registry no longer owns the worker.
 */
export function interruptOrphanedSubagentSession(
  sessionId: string,
  now = Date.now()
): SubagentSessionSummary | null {
  const current = getSubagentSession(sessionId)
  if (!current || !['preparing', 'running'].includes(current.status)) return current
  const summary = updateSubagentSession(sessionId, {
    status: 'interrupted',
    phase: 'orphaned',
    currentTool: null,
    error: 'The delegation no longer has a live owning execution.',
    finishedAt: now,
  })
  if (summary) publish(summary)
  return summary
}

function clippedOutput(output: unknown): ToolOutput {
  const safe = sanitizeToolOutputForPersistence(modelOutputToChatToolOutput(output))
  if (typeof safe === 'string') return clipPersistedToolOutput(redactTokens(safe))
  return {
    ...safe,
    text: clipPersistedToolOutput(redactTokens(safe.text)),
    ...(safe.structuredContent !== undefined
      ? { structuredContent: deepRedact(safe.structuredContent, redactTokens) as typeof safe.structuredContent }
      : {}),
  }
}

function safeInput(input: unknown): unknown {
  const redactSensitiveKeys = (value: unknown): unknown => {
    if (typeof value === 'string') return redactTokens(value)
    if (Array.isArray(value)) return value.map(redactSensitiveKeys)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i.test(key)
          ? '[redacted]'
          : redactSensitiveKeys(entry),
      ])
    )
  }
  return sanitizeStructuredContentForPersistence(redactSensitiveKeys(input)) ?? '(input omitted)'
}

function normalizedToolName(name: string): string {
  const namespaced = /^subagent:[^:]+:(.+)$/.exec(name)
  return namespaced?.[1] ?? name
}

function stringField(input: unknown, names: readonly string[]): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  for (const name of names) {
    if (typeof value[name] === 'string' && value[name]) return value[name]
  }
  return undefined
}

function toolSummary(
  name: string,
  input: unknown
): {
  toolNames: string[]
  files?: string[]
  commands?: string[]
  tests?: string[]
} {
  const result: ReturnType<typeof toolSummary> = { toolNames: [name] }
  const file = stringField(input, ['path', 'file', 'filePath', 'filename'])
  if (file) result.files = [file]
  const command = name === 'bash' ? stringField(input, ['command', 'cmd']) : undefined
  if (command) {
    result.commands = [command]
    if (/\b(test|vitest|jest|pytest|playwright|typecheck|lint|build)\b/i.test(command)) result.tests = [command]
  }
  return result
}

export interface SubagentSessionRecorder {
  readonly id: string
  readonly available: boolean
  summary(): SubagentSessionSummary | null
  phase(value: string, currentTool?: string | null): void
  text(update: SubagentTextUpdate): void
  instrumentTools(tools: ToolSet): ToolSet
  /** This turn's native provider thread/session; persisted as soon as its remote ID exists. */
  runtimeHandle(handle: SubagentRuntimeHandle): void
  /** Outcome of continuity requested via `resume_session_id`. */
  resumeOutcome(status: SubagentResumeStatus, reason?: string): void
  complete(input: {
    status: Exclude<SubagentSessionStatus, 'preparing' | 'running'>
    usage?: SubagentSessionUsage
    runtimeEstimatedCostUsd?: number
    error?: string
  }): void
}

class PersistentSubagentSessionRecorder implements SubagentSessionRecorder {
  readonly available = true
  readonly id: string
  private textValue = ''
  private position = 0
  private toolFallback = 0
  private textPartIndex = 0
  private textPartId: string | null = null
  private textPosition: number | null = null
  private textFlushTimer: ReturnType<typeof setTimeout> | null = null
  private completed = false

  constructor(input: {
    conversationId: string
    parentMessageId: string
    toolCallId: string
    origin: SubagentSessionOrigin
    agentName: string
    task: string
    profile?: SubagentExecutionSnapshotV1
    maestro?: MaestroDelegationSnapshotV1
    startedAt?: number
    resumedFrom?: string
  }) {
    const session = createSubagentSession(input)
    this.id = session.id
    publish(session)
  }

  summary(): SubagentSessionSummary | null {
    return getSubagentSession(this.id)
  }

  runtimeHandle(handle: SubagentRuntimeHandle): void {
    const summary = updateSubagentSession(this.id, { runtimeHandle: handle })
    if (summary) publish(summary)
  }

  resumeOutcome(status: SubagentResumeStatus, reason?: string): void {
    const summary = updateSubagentSession(this.id, { resume: { status, ...(reason ? { reason } : {}) } })
    if (summary) publish(summary)
  }

  phase(value: string, currentTool?: string | null): void {
    const summary = updateSubagentSession(this.id, {
      status: 'running',
      phase: value,
      ...(currentTool !== undefined ? { currentTool } : {}),
    })
    if (summary) publish(summary)
  }

  text(update: SubagentTextUpdate): void {
    this.textValue = applySubagentTextUpdate(this.textValue, update)
    if (this.textPosition == null) {
      this.textPosition = this.position++
      this.textPartId = `${this.id}:assistant:text:${++this.textPartIndex}`
    }
    if (this.completed) {
      if (this.textFlushTimer) clearTimeout(this.textFlushTimer)
      this.textFlushTimer = null
      this.flushText()
      return
    }
    if (this.textFlushTimer) return
    this.textFlushTimer = setTimeout(() => {
      this.textFlushTimer = null
      this.flushText()
    }, 80)
    this.textFlushTimer.unref?.()
  }

  private flushText(): void {
    if (this.textPosition == null) return
    const partId = this.textPartId
    if (!partId) return
    const summary = upsertSubagentTranscriptPart({
      sessionId: this.id,
      partId,
      position: this.textPosition,
      part: { type: 'text', id: partId, text: this.textValue },
    })
    if (summary) publish(summary)
  }

  private startTool(name: string, toolCallId: string, input: unknown): void {
    if (this.textFlushTimer) {
      clearTimeout(this.textFlushTimer)
      this.textFlushTimer = null
      this.flushText()
    }
    this.textValue = ''
    this.textPosition = null
    this.textPartId = null
    const part: MessagePart = {
      type: 'tool',
      id: toolCallId,
      toolCallId,
      toolName: name,
      input: safeInput(input),
      state: { status: 'running' },
    }
    const summary = upsertSubagentTranscriptPart({
      sessionId: this.id,
      partId: toolCallId,
      position: this.position++,
      part,
    })
    const updated = updateSubagentSession(this.id, {
      status: 'running',
      phase: 'tool-running',
      currentTool: name,
      ...toolSummary(name, input),
    })
    if (updated ?? summary) publish((updated ?? summary)!)
  }

  private finishTool(name: string, toolCallId: string, input: unknown, state: MessagePart & { type: 'tool' }): void {
    const summary = upsertSubagentTranscriptPart({
      sessionId: this.id,
      partId: toolCallId,
      part: state,
    })
    const updated = updateSubagentSession(this.id, {
      status: 'running',
      phase: state.state.status === 'error' ? 'tool-failed' : 'model-running',
      currentTool: null,
      ...toolSummary(name, input),
    })
    if (updated ?? summary) publish((updated ?? summary)!)
  }

  instrumentTools(tools: ToolSet): ToolSet {
    return Object.fromEntries(
      Object.entries(tools).map(([rawName, raw]) => {
        const candidate = raw as Tool & { execute?: (...args: any[]) => unknown }
        if (typeof candidate.execute !== 'function') return [rawName, raw]
        const name = normalizedToolName(rawName)
        const execute = candidate.execute
        return [
          rawName,
          {
            ...candidate,
            execute: async (input: unknown, options: { toolCallId?: string } = {}) => {
              const toolCallId =
                typeof options.toolCallId === 'string' && options.toolCallId
                  ? options.toolCallId
                  : `${this.id}:tool:${++this.toolFallback}`
              this.startTool(name, toolCallId, input)
              try {
                const output = await execute(input, options)
                this.finishTool(name, toolCallId, input, {
                  type: 'tool',
                  id: toolCallId,
                  toolCallId,
                  toolName: name,
                  input: safeInput(input),
                  state: { status: 'completed', output: clippedOutput(output) },
                })
                return output
              } catch (error) {
                this.finishTool(name, toolCallId, input, {
                  type: 'tool',
                  id: toolCallId,
                  toolCallId,
                  toolName: name,
                  input: safeInput(input),
                  state: { status: 'error', error: error instanceof Error ? error.message : String(error) },
                })
                throw error
              }
            },
          },
        ]
      })
    ) as ToolSet
  }

  complete(input: {
    status: Exclude<SubagentSessionStatus, 'preparing' | 'running'>
    usage?: SubagentSessionUsage
    runtimeEstimatedCostUsd?: number
    error?: string
  }): void {
    if (this.completed) return
    this.completed = true
    if (this.textFlushTimer) {
      clearTimeout(this.textFlushTimer)
      this.textFlushTimer = null
      this.flushText()
    }
    const now = Date.now()
    const summary = updateSubagentSession(this.id, {
      status: input.status,
      phase: input.status,
      currentTool: null,
      usage: input.usage,
      runtimeEstimatedCostUsd: input.runtimeEstimatedCostUsd,
      error: input.error ?? null,
      finishedAt: now,
    })
    if (summary) publish(summary)
  }
}

class NoopSubagentSessionRecorder implements SubagentSessionRecorder {
  readonly available = false
  readonly id: string
  constructor(input: { conversationId: string; parentMessageId: string; toolCallId: string }) {
    this.id = subagentSessionId(input)
  }
  summary(): SubagentSessionSummary | null {
    return null
  }
  phase(): void {}
  text(): void {}
  instrumentTools(tools: ToolSet): ToolSet {
    return tools
  }
  runtimeHandle(): void {}
  resumeOutcome(): void {}
  complete(): void {}
}

export function createSubagentSessionRecorder(input: {
  conversationId: string
  parentMessageId: string
  toolCallId: string
  origin: SubagentSessionOrigin
  agentName: string
  task: string
  profile?: SubagentExecutionSnapshotV1
  maestro?: MaestroDelegationSnapshotV1
  startedAt?: number
  resumedFrom?: string
}): SubagentSessionRecorder {
  try {
    return new PersistentSubagentSessionRecorder(input)
  } catch {
    // Isolated runner unit tests intentionally execute without a bootstrapped SQLite store.
    return new NoopSubagentSessionRecorder(input)
  }
}

export async function waitForSubagentSession(
  sessionId: string,
  cursor: number,
  waitMs: number,
  signal?: AbortSignal
): Promise<SubagentWaitResult | null> {
  const initial = getSubagentSession(sessionId)
  if (!initial) return null
  const changes = getSubagentTranscriptChanges(sessionId, cursor)
  if (initial.revision > cursor || changes.length || !['preparing', 'running'].includes(initial.status)) {
    const nextCursor = changes.length >= 100 ? changes[changes.length - 1].cursor : initial.revision
    return { session: initial, cursor: nextCursor, changes, timedOut: false }
  }
  const boundedWait = Math.max(0, Math.min(30_000, Math.floor(waitMs)))
  if (!boundedWait) return { session: initial, cursor, changes: [], timedOut: true }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  await new Promise<void>((resolve) => {
    const pending = waiters.get(sessionId) ?? new Set<() => void>()
    const wake = () => {
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      pending.delete(wake)
      if (pending.size === 0) waiters.delete(sessionId)
      resolve()
    }
    pending.add(wake)
    waiters.set(sessionId, pending)
    onAbort = wake
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(wake, boundedWait)
    timer.unref?.()
  })
  const session = getSubagentSession(sessionId)
  if (!session) return null
  const nextChanges = getSubagentTranscriptChanges(sessionId, cursor)
  const nextCursor = nextChanges.length >= 100 ? nextChanges[nextChanges.length - 1].cursor : session.revision
  return {
    session,
    cursor: nextCursor,
    changes: nextChanges,
    timedOut: session.revision <= cursor && nextChanges.length === 0,
  }
}
