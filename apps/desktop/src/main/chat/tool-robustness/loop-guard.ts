/**
 * Stops a model that keeps making the same tool call without progress. A call is identified by its tool and its
 * canonical arguments; "no progress" means the same call returned the same result (or failed the same way) again.
 * The guard first adds a note to the result, then refuses to run the call, then stops the turn: in the AI SDK loops
 * the runner ends the turn at the step boundary, and in the native runtimes every later tool call of the turn is
 * refused with the instruction to stop.
 *
 * Thresholds and wording are adapted from Hermes Agent (`tool_guardrails.py`) and OpenClaw (`tool-loop-detection.ts`);
 * no code is copied.
 */
import { createHash } from 'node:crypto'
import { modelOutputToChatToolOutput, toolOutputIsError } from '../tool-output'
import { isHostToolReadOnly, PARALLEL_SAFE_HOST_TOOL_NAMES } from '../tool-policy'
import type { ToolOutput } from '../../../shared/chat'
import { isRecord } from './json-schema-utils'

export interface ToolLoopGuardConfig {
  /** Identical call with an identical result: note on this occurrence, refuse on the next-but-one. */
  repeatWarnAt: number
  repeatBlockAt: number
  /** The same failure with identical arguments. */
  failureWarnAt: number
  failureBlockAt: number
  /** Refusals in one turn before the turn stops. */
  maxBlocks: number
  /** Polling tools are expected to repeat; they only stop after this many identical results. */
  pollerStopAt: number
}

export const DEFAULT_TOOL_LOOP_GUARD_CONFIG: Readonly<ToolLoopGuardConfig> = Object.freeze({
  repeatWarnAt: 3,
  repeatBlockAt: 5,
  failureWarnAt: 2,
  failureBlockAt: 3,
  maxBlocks: 3,
  pollerStopAt: 30,
})

/** Tools whose purpose is waiting for something to change; an unchanged result is their normal answer. */
export const POLLING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'wait_conversation',
  'read_conversation',
  'terminal_read',
  'terminal_snapshot',
  'bot_peers_wait',
  'browser_wait_for',
  'browser_console_logs',
  'browser_network_logs',
  'desktop_wait_events',
  'desktop_read_chat',
  'runner_status',
  'runner_logs',
  'debug_status',
])

export interface ToolLoopStop {
  toolName: string
  reason: 'repeated-calls' | 'repeated-failures' | 'blocked-retry' | 'too-many-blocks' | 'polling'
  /** Written for the model; the interface shows its own translated text. */
  message: string
}

export interface ToolLoopGuardEvent {
  action: 'warn' | 'block' | 'stop'
  toolName: string
  reason: string
  count: number
}

interface SignatureState {
  resultHash: string | null
  repeats: number
  failureHash: string | null
  failures: number
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  )
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'undefined')
    .digest('hex')
    .slice(0, 32)
}

function ordinal(count: number): string {
  const rest = count % 100
  if (rest >= 11 && rest <= 13) return `${count}th`
  return `${count}${count % 10 === 1 ? 'st' : count % 10 === 2 ? 'nd' : count % 10 === 3 ? 'rd' : 'th'}`
}

export class ToolLoopGuardRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolLoopGuardRefusal'
  }
}

export class ToolLoopGuard {
  private readonly signatures = new Map<string, SignatureState>()
  private readonly blocked = new Set<string>()
  private blocks = 0
  private stopReason: ToolLoopStop | null = null

  constructor(
    private readonly config: ToolLoopGuardConfig = DEFAULT_TOOL_LOOP_GUARD_CONFIG,
    private readonly onEvent?: (event: ToolLoopGuardEvent) => void
  ) {}

  /** Set once the turn must stop; every later call is refused. */
  get stopped(): ToolLoopStop | null {
    return this.stopReason
  }

  private signature(name: string, input: unknown): string {
    return `${name}\0${hash(input)}`
  }

  private state(signature: string): SignatureState {
    let state = this.signatures.get(signature)
    if (!state) {
      state = { resultHash: null, repeats: 0, failureHash: null, failures: 0 }
      this.signatures.set(signature, state)
    }
    return state
  }

  private stop(toolName: string, reason: ToolLoopStop['reason'], count: number): ToolLoopStop {
    this.stopReason ??= {
      toolName,
      reason,
      message:
        `Maestrly stopped this turn because \`${toolName}\` kept repeating without progress. Do not call more ` +
        'tools: tell the user what you found and what is blocking you.',
    }
    this.onEvent?.({ action: 'stop', toolName, reason, count })
    return this.stopReason
  }

  /** Decides before a call runs; a refusal is returned as the message the model reads. */
  check(name: string, input: unknown): { run: true } | { run: false; message: string } {
    if (this.stopReason) return { run: false, message: this.stopReason.message }
    if (POLLING_TOOL_NAMES.has(name)) return { run: true }
    const signature = this.signature(name, input)
    const state = this.signatures.get(signature)
    if (this.blocked.has(signature)) {
      return { run: false, message: this.stop(name, 'blocked-retry', (state?.repeats ?? 0) + 1).message }
    }
    if (!state) return { run: true }
    const failing = state.failures >= this.config.failureBlockAt - 1
    const repeating = state.repeats >= this.config.repeatBlockAt - 1
    if (!failing && !repeating) return { run: true }
    this.blocked.add(signature)
    this.blocks++
    const count = failing ? state.failures : state.repeats
    if (this.blocks >= this.config.maxBlocks) {
      return { run: false, message: this.stop(name, 'too-many-blocks', count).message }
    }
    this.onEvent?.({ action: 'block', toolName: name, reason: failing ? 'repeated-failures' : 'repeated-calls', count })
    return {
      run: false,
      message: failing
        ? `Maestrly did not run this call: \`${name}\` already failed ${count} times with these exact arguments. ` +
          'Change the arguments or your approach; calling it again unchanged stops the turn.'
        : `Maestrly did not run this call: \`${name}\` was already called ${count} times with these exact arguments ` +
          'and returned the same result each time. Use the result you have or change your approach; calling it ' +
          'again unchanged stops the turn.',
    }
  }

  /** Records what a call returned; returns a note to append to the result, if any. */
  record(
    name: string,
    input: unknown,
    outcome: { resultHash: string; isError: boolean; readOnly: boolean }
  ): string | null {
    const signature = this.signature(name, input)
    const state = this.state(signature)
    if (outcome.isError) {
      state.failures = state.failureHash === outcome.resultHash ? state.failures + 1 : 1
      state.failureHash = outcome.resultHash
      state.resultHash = null
      state.repeats = 0
    } else {
      state.repeats = state.resultHash === outcome.resultHash ? state.repeats + 1 : 1
      state.resultHash = outcome.resultHash
      state.failureHash = null
      state.failures = 0
      // A change to the world makes earlier identical results stale; the same mutation keeps counting.
      if (!outcome.readOnly) this.resetExcept(signature)
    }
    if (POLLING_TOOL_NAMES.has(name)) {
      if (!outcome.isError && state.repeats >= this.config.pollerStopAt) this.stop(name, 'polling', state.repeats)
      return null
    }
    if (outcome.isError && state.failures >= this.config.failureWarnAt) {
      this.onEvent?.({ action: 'warn', toolName: name, reason: 'repeated-failures', count: state.failures })
      return (
        `[Maestrly: \`${name}\` failed the same way ${state.failures} times with these exact arguments. Do not ` +
        'retry it unchanged: read the error and change your approach.]'
      )
    }
    if (!outcome.isError && state.repeats >= this.config.repeatWarnAt) {
      this.onEvent?.({ action: 'warn', toolName: name, reason: 'repeated-calls', count: state.repeats })
      return (
        `[Maestrly: this is the ${ordinal(state.repeats)} call to \`${name}\` with these exact arguments, and it ` +
        'returned the same result each time. Do not repeat it: use the result you already have, change the ' +
        'arguments, or take a different approach.]'
      )
    }
    return null
  }

  private resetExcept(signature: string): void {
    for (const key of this.signatures.keys()) if (key !== signature) this.signatures.delete(key)
    for (const key of [...this.blocked]) if (key !== signature) this.blocked.delete(key)
  }
}

const PERMISSION_ERROR_NAMES = new Set([
  'PermissionRejectedError',
  'PermissionCorrectedError',
  'PermissionDeniedError',
  'PermissionCancelledError',
])

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
}

function appendNote(output: unknown, note: string): ToolOutput {
  const normalized = modelOutputToChatToolOutput(output)
  if (typeof normalized === 'string') return `${normalized}\n\n${note}`
  return { ...normalized, text: `${normalized.text}\n\n${note}` }
}

export function isToolReadOnly(name: string, metadata: unknown): boolean {
  return isHostToolReadOnly(name, metadata) || PARALLEL_SAFE_HOST_TOOL_NAMES.has(name)
}

type Execute = (input: unknown, options: unknown) => unknown

/** Set on the options of a call the outermost guard already counted, so a guard nested inside passes it through. */
const COUNTED_BY_GUARD = Symbol('maestrly.toolLoopGuard.counted')
/** Marks the execute a guard produced, so wrapping again with the same guard is a no-op. */
const GUARDED = Symbol('maestrly.toolLoopGuard')

interface GuardedMarker {
  guard: ToolLoopGuard
  execute: Execute
}

function isAbort(error: unknown, options: unknown): boolean {
  const signal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal
  const name = (error as { name?: unknown } | null)?.name
  return signal?.aborted === true || name === 'AbortError'
}

/**
 * Wraps one tool's execute with the guard. Cancellations and permission decisions are not counted. Only the
 * outermost guard counts a call: a ToolSet a parent hands to a subagent is re-guarded by the subagent, and the
 * parent's guard inside passes the call through, so each run keeps its own counts.
 */
export function guardToolExecute(name: string, execute: Execute, guard: ToolLoopGuard, metadata: unknown): Execute {
  const readOnly = isToolReadOnly(name, metadata)
  const guarded: Execute = async (input, options) => {
    if (options && typeof options === 'object' && (options as { [COUNTED_BY_GUARD]?: true })[COUNTED_BY_GUARD]) {
      return execute(input, options)
    }
    const decision = guard.check(name, input)
    if (!decision.run) throw new ToolLoopGuardRefusal(decision.message)
    const innerOptions = options && typeof options === 'object' ? { ...options, [COUNTED_BY_GUARD]: true } : options
    let output: unknown
    try {
      output = await execute(input, innerOptions)
    } catch (error) {
      const errorName = (error as { name?: unknown } | null)?.name
      if (isAbort(error, options) || (typeof errorName === 'string' && PERMISSION_ERROR_NAMES.has(errorName))) {
        throw error
      }
      const note = guard.record(name, input, { resultHash: hash(errorText(error)), isError: true, readOnly })
      if (!note) throw error
      const annotated = new Error(`${errorText(error)}\n\n${note}`, { cause: error })
      if (typeof errorName === 'string') annotated.name = errorName
      throw annotated
    }
    const normalized = modelOutputToChatToolOutput(output)
    const note = guard.record(name, input, {
      resultHash: hash(normalized),
      isError: toolOutputIsError(normalized),
      readOnly,
    })
    return note ? appendNote(output, note) : output
  }
  return guarded
}

/** Puts every executable tool of a ToolSet under one guard. Idempotent for the same guard. */
export function guardToolSet<T extends Record<string, unknown>>(tools: T, guard: ToolLoopGuard): T {
  const out: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(tools)) {
    const tool = entry as { execute?: unknown; metadata?: unknown; type?: unknown; [GUARDED]?: GuardedMarker }
    const execute = tool?.execute
    if (typeof execute !== 'function' || tool.type === 'provider') {
      out[name] = entry
      continue
    }
    const marker = tool[GUARDED]
    if (marker?.guard === guard && marker.execute === execute) {
      out[name] = entry
      continue
    }
    const guarded = guardToolExecute(name, execute as Execute, guard, tool.metadata)
    const next = { ...(tool as object), execute: guarded }
    Object.defineProperty(next, GUARDED, { value: { guard, execute: guarded } satisfies GuardedMarker })
    out[name] = next
  }
  return out as T
}

interface StepToolCalls {
  toolCalls: ReadonlyArray<{ invalid?: boolean }>
}

/** Consecutive final steps whose tool calls were all invalid (unknown tool or unrepairable arguments). */
export function trailingInvalidToolSteps(steps: readonly StepToolCalls[]): number {
  let count = 0
  for (let index = steps.length - 1; index >= 0; index--) {
    const calls = steps[index].toolCalls
    if (!calls.length || calls.some((call) => call.invalid !== true)) break
    count++
  }
  return count
}

export const MAX_INVALID_TOOL_STEPS = 3
