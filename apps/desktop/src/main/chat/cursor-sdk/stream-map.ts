/**
 * Pure Cursor SDK → ChatStreamEvent mapper.
 * Owns only transient folding state; persistence/lifecycle stay outside.
 *
 * Defense: if the SDK ends a run without tool_call completed/error (reconnect,
 * truncated stream, cancel race), open tools are reconciled on terminal status
 * so the UI never keeps a spinner forever.
 */
import type { SDKMessage } from '@cursor/sdk'
import type { ChatStreamEvent, ChatUsage, ToolOutput, ToolState } from '../../../shared/chat'
import { unwrapCursorMcpToolCall } from '../../../shared/cursor-mcp-tool'
import { clipPersistedToolOutput } from '../message'
import { modelOutputToChatToolOutput } from '../tool-output'
import { redactCursorCredentials } from './errors'

export type CursorRunTerminalStatus = 'FINISHED' | 'ERROR' | 'CANCELLED' | 'EXPIRED'

export interface CursorTerminalResolution {
  /** Terminal reconciled from stream and wait; null means neither reported a terminal. */
  status: CursorRunTerminalStatus | null
  /** Contradicting terminal reports, such as stream FINISHED followed by wait failure. */
  conflict: boolean
}

function normalizeTerminalStatus(raw: string | null | undefined): CursorRunTerminalStatus | null {
  if (!raw) return null
  const value = String(raw).toUpperCase()
  if (value === 'FINISHED' || value === 'ERROR' || value === 'CANCELLED' || value === 'EXPIRED') {
    return value as CursorRunTerminalStatus
  }
  return null
}

/** Reconcile both terminal reports. Any observed failure overrides a successful report. */
export function resolveCursorTerminalEvidence(
  streamStatus: string | null | undefined,
  waitStatus: string | null | undefined
): CursorTerminalResolution {
  const stream = normalizeTerminalStatus(streamStatus)
  const wait = normalizeTerminalStatus(waitStatus)
  if (stream === 'ERROR' || stream === 'CANCELLED' || stream === 'EXPIRED') {
    return { status: stream, conflict: wait === 'FINISHED' }
  }
  if (wait === 'ERROR' || wait === 'CANCELLED' || wait === 'EXPIRED') {
    return { status: wait, conflict: stream === 'FINISHED' }
  }
  if (stream === 'FINISHED') {
    return { status: 'FINISHED', conflict: false }
  }
  if (wait === 'FINISHED') {
    return { status: 'FINISHED', conflict: false }
  }
  return { status: null, conflict: false }
}

export interface CursorStreamMapper {
  push(message: SDKMessage): ChatStreamEvent[]
  /**
   * Close any tools still open after the stream ends, using wait()/status
   * as the terminal signal. Safe to call multiple times.
   */
  reconcileOpenTools(status: CursorRunTerminalStatus, detail?: string): ChatStreamEvent[]
  state(): CursorStreamMapperState
}

export interface CursorStreamMapperState {
  agentId: string | null
  runId: string | null
  /** request_id reported by SDK request messages, for diagnostics. */
  requestId: string | null
  modelId: string | null
  tools: readonly string[]
  lastUsage: ChatUsage | null
  finished: boolean
  finishStatus: string | null
  /** Textual terminal detail, such as a runtime error. */
  finishMessage: string | null
  /** Tool call ids still in running/pending (not completed/error/denied). */
  openToolCallIds: readonly string[]
}

interface OpenTool {
  name: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeJson(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function toolOutputText(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (isRecord(result)) {
    if (typeof result.text === 'string') return result.text
    if (typeof result.output === 'string') return result.output
    if (typeof result.content === 'string') return result.content
    if (Array.isArray(result.content)) {
      return result.content
        .map((entry) => (isRecord(entry) && typeof entry.text === 'string' ? entry.text : ''))
        .filter(Boolean)
        .join('\n')
    }
  }
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function mapUsage(usage: unknown): ChatUsage | null {
  if (!isRecord(usage)) return null
  const input =
    typeof usage.inputTokens === 'number'
      ? usage.inputTokens
      : typeof usage.input === 'number'
        ? usage.input
        : undefined
  const output =
    typeof usage.outputTokens === 'number'
      ? usage.outputTokens
      : typeof usage.output === 'number'
        ? usage.output
        : undefined
  if (input == null || output == null || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0)
    return null
  const cachedInput = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : undefined
  const cacheCreate = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : undefined
  return {
    usageVersion: 2,
    input: input ?? 0,
    output: output ?? 0,
    ...(cachedInput != null ? { cachedInput } : {}),
    ...(cacheCreate != null ? { cacheCreate } : {}),
  }
}

function terminalToolState(status: CursorRunTerminalStatus, detail?: string): ToolState {
  const sanitized = detail?.trim() ? clipPersistedToolOutput(redactCursorCredentials(detail.trim())) : undefined
  if (status === 'CANCELLED') {
    return {
      status: 'error',
      error: sanitized || 'Run cancelled before tool completed.',
    }
  }
  if (status === 'ERROR' || status === 'EXPIRED') {
    return {
      status: 'error',
      error: sanitized || `Run ${status.toLowerCase()} before tool completed.`,
    }
  }
  // FINISHED without tool terminal — do NOT fabricate success output.
  return {
    status: 'error',
    error: sanitized || 'Tool did not complete before run finished (incomplete stream / reconnect).',
  }
}

/**
 * Maps Cursor `run.stream()` SDKMessage values into Maestrly ChatStreamEvents.
 */
export function createCursorStreamMapper(
  messageId: string,
  canonicalOutputFor?: (toolCallId: string) => ToolOutput | undefined
): CursorStreamMapper {
  const startedReasoningParts = new Set<string>()
  /** Tools that already emitted input-start (dedupe). */
  const startedTools = new Set<string>()
  /** Tools still open until completed/error/reconcile. */
  const openTools = new Map<string, OpenTool>()
  let textPartSeq = 0
  let activeTextPartId: string | null = null
  let reasoningPartSeq = 0
  let agentId: string | null = null
  let runId: string | null = null
  let requestId: string | null = null
  let modelId: string | null = null
  let tools: string[] = []
  let lastUsage: ChatUsage | null = null
  let finished = false
  let finishStatus: string | null = null
  let finishMessage: string | null = null

  const ensureTextPart = (events: ChatStreamEvent[]): string => {
    if (!activeTextPartId) {
      activeTextPartId = `cursor_text_${textPartSeq}`
      textPartSeq += 1
      events.push({ kind: 'text-start', messageId, partId: activeTextPartId })
    }
    return activeTextPartId
  }

  // Contiguous assistant fragments share a text part until a tool or reasoning event.
  const closeTextPart = (): void => {
    activeTextPartId = null
  }

  const ensureReasoningPart = (events: ChatStreamEvent[]): string => {
    const partId = `cursor_reasoning_${reasoningPartSeq}`
    if (!startedReasoningParts.has(partId)) {
      startedReasoningParts.add(partId)
      events.push({ kind: 'reasoning-start', messageId, partId })
    }
    return partId
  }

  const openTool = (toolCallId: string, toolName: string, input: unknown, events: ChatStreamEvent[]): void => {
    const unwrapped = unwrapCursorMcpToolCall(toolName, input)
    const resolvedName = unwrapped.toolName
    const resolvedInput = unwrapped.input
    if (!startedTools.has(toolCallId)) {
      startedTools.add(toolCallId)
      events.push({ kind: 'tool-input-start', messageId, toolCallId, toolName: resolvedName })
      events.push({
        kind: 'tool-call',
        messageId,
        toolCallId,
        toolName: resolvedName,
        input: safeJson(resolvedInput) ?? {},
      })
      openTools.set(toolCallId, { name: resolvedName })
      return
    }
    // A later envelope can promote an earlier generic MCP call to its actual tool name.
    const previous = openTools.get(toolCallId)
    if (previous && previous.name !== resolvedName) {
      events.push({
        kind: 'tool-call',
        messageId,
        toolCallId,
        toolName: resolvedName,
        input: safeJson(resolvedInput) ?? {},
      })
      openTools.set(toolCallId, { name: resolvedName })
    }
  }

  const closeTool = (toolCallId: string, state: ToolState, events: ChatStreamEvent[]): void => {
    if (!openTools.has(toolCallId) && startedTools.has(toolCallId)) {
      // Already closed — skip duplicate terminal.
      return
    }
    openTools.delete(toolCallId)
    events.push({ kind: 'tool-state', messageId, toolCallId, state })
  }

  const reconcileOpenTools = (status: CursorRunTerminalStatus, detail?: string): ChatStreamEvent[] => {
    if (openTools.size === 0) return []
    const events: ChatStreamEvent[] = []
    const state = terminalToolState(status, detail)
    for (const toolCallId of [...openTools.keys()]) {
      closeTool(toolCallId, state, events)
    }
    return events
  }

  const push = (message: SDKMessage): ChatStreamEvent[] => {
    const events: ChatStreamEvent[] = []
    if ('agent_id' in message && typeof message.agent_id === 'string') {
      agentId = message.agent_id
    }
    if ('run_id' in message && typeof message.run_id === 'string') {
      runId = message.run_id
    }
    if ('request_id' in message && typeof message.request_id === 'string') {
      requestId = message.request_id
    }

    switch (message.type) {
      case 'system': {
        if (message.model && typeof message.model.id === 'string') {
          modelId = message.model.id
        }
        if (Array.isArray(message.tools)) {
          tools = message.tools.filter((t): t is string => typeof t === 'string')
        }
        return events
      }
      case 'user':
        return events
      case 'assistant': {
        const content = message.message?.content
        if (!Array.isArray(content)) return events
        for (const block of content) {
          if (!isRecord(block)) continue
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            const partId = ensureTextPart(events)
            events.push({ kind: 'text-delta', messageId, partId, delta: block.text })
          } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            closeTextPart()
            openTool(block.id, block.name, block.input, events)
            events.push({
              kind: 'tool-state',
              messageId,
              toolCallId: block.id,
              state: { status: 'running' },
            })
          }
        }
        return events
      }
      case 'tool_call': {
        closeTextPart()
        const toolCallId = message.call_id
        const toolName = message.name
        openTool(toolCallId, toolName, message.args, events)
        if (message.status === 'running') {
          events.push({
            kind: 'tool-state',
            messageId,
            toolCallId,
            state: { status: 'running' },
          })
        } else if (message.status === 'completed') {
          // Redact before clipping so a credential fragment cannot survive truncation.
          // Use the same 50k limit as the other native runtimes.
          const normalized = canonicalOutputFor?.(toolCallId) ?? modelOutputToChatToolOutput(message.result)
          const output =
            typeof normalized === 'string'
              ? clipPersistedToolOutput(redactCursorCredentials(normalized))
              : {
                  ...normalized,
                  text: clipPersistedToolOutput(redactCursorCredentials(normalized.text)),
                }
          closeTool(toolCallId, { status: 'completed', output }, events)
        } else if (message.status === 'error') {
          const output = clipPersistedToolOutput(
            redactCursorCredentials(toolOutputText(message.result) || 'Tool failed')
          )
          closeTool(toolCallId, { status: 'error', error: output }, events)
        }
        return events
      }
      case 'thinking': {
        closeTextPart()
        if (typeof message.text === 'string' && message.text) {
          const partId = ensureReasoningPart(events)
          events.push({ kind: 'reasoning-delta', messageId, partId, delta: message.text })
          if (typeof message.thinking_duration_ms === 'number') {
            reasoningPartSeq += 1
            startedReasoningParts.delete(`cursor_reasoning_${reasoningPartSeq}`)
          }
        }
        return events
      }
      case 'usage': {
        const usage = mapUsage(message.usage)
        if (usage) lastUsage = usage
        return events
      }
      case 'status': {
        finishStatus = message.status
        if (
          message.status === 'FINISHED' ||
          message.status === 'ERROR' ||
          message.status === 'CANCELLED' ||
          message.status === 'EXPIRED'
        ) {
          finished = true
          finishMessage = message.message?.trim() || null
          // The runner alone emits the final turn event after reconciling stream and wait.
          events.push(...reconcileOpenTools(message.status, finishMessage ?? undefined))
        }
        return events
      }
      case 'task':
      case 'request':
      default:
        return events
    }
  }

  return {
    push,
    reconcileOpenTools,
    state: () => ({
      agentId,
      runId,
      requestId,
      modelId,
      tools: [...tools],
      lastUsage,
      finished,
      finishStatus,
      finishMessage,
      openToolCallIds: [...openTools.keys()],
    }),
  }
}
