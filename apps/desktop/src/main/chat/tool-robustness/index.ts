/**
 * Tool-call robustness: repairs malformed calls, guards against loops and adapts schemas per provider. Documented in
 * docs/harness-profiles.md ("Tool-call robustness").
 */
import type { Tool, ToolSet } from 'ai'
import { chatDiag } from '../diag-log'
import { isLenientInputSchema, lenientInputSchema } from './lenient-input'
import { DEFAULT_TOOL_LOOP_GUARD_CONFIG, guardToolSet, ToolLoopGuard } from './loop-guard'
import { hasToolHistoryChanges, sanitizeToolHistory, type ToolHistoryMessage } from './tool-history'

export { coerceToolInput, parseToolArguments } from './arg-repair'
export { createToolCallRepair, type ToolCallRepairEvent } from './repair-tool-call'
export { lenientInputSchema, ToolInputValidationError } from './lenient-input'
export {
  guardToolSet,
  MAX_INVALID_TOOL_STEPS,
  ToolLoopGuard,
  ToolLoopGuardRefusal,
  trailingInvalidToolSteps,
  type ToolLoopStop,
} from './loop-guard'
export { createRepetitionWatch, type RepetitionVerdict, type RepetitionWatch } from './repetition-watch'
export { sanitizeToolHistory } from './tool-history'

/** A loop guard for one run (a turn or a subagent) that reports to the diagnostics log. */
export function createToolLoopGuard(diag: Record<string, unknown> = {}): ToolLoopGuard {
  return new ToolLoopGuard(DEFAULT_TOOL_LOOP_GUARD_CONFIG, (event) =>
    chatDiag({ kind: 'tool-loop-guard', ...diag, ...event })
  )
}

/**
 * Repairs the tool-call history of AI SDK messages before `streamText`, which refuses a call without a result
 * before any middleware runs. A valid history is returned as the same array.
 */
export function sanitizeHistoryMessages<M extends ToolHistoryMessage>(
  messages: readonly M[],
  diag: Record<string, unknown> = {}
): M[] {
  const sanitized = sanitizeToolHistory(messages)
  if (hasToolHistoryChanges(sanitized.stats)) {
    chatDiag({ kind: 'tool-history-sanitized', stage: 'messages', ...diag, ...sanitized.stats })
  }
  return sanitized.prompt
}

/** Copies a tool with some fields replaced, keeping the symbol markers other wrappers set on it. */
export function withToolOverrides<T extends object>(source: T, overrides: Partial<T>): T {
  const next = { ...source, ...overrides }
  for (const symbol of Object.getOwnPropertySymbols(source)) {
    if (Object.hasOwn(next, symbol)) continue
    const descriptor = Object.getOwnPropertyDescriptor(source, symbol)
    if (descriptor) Object.defineProperty(next, symbol, descriptor)
  }
  return next
}

function reportCoercion(toolName: string): void {
  chatDiag({ kind: 'tool-call-repaired', outcome: 'repaired', kinds: ['coercion'], toolName })
}

/**
 * Applies the host-side robustness layer to every executable function tool: lenient input validation and, when a
 * guard is given, the loop guard as the outermost wrapper. Provider tools and tools without a schema pass through.
 * Idempotent: a tool already hardened keeps its wrapper.
 */
export function hardenToolSetForModel(tools: ToolSet, options: { loopGuard?: ToolLoopGuard } = {}): ToolSet {
  const hardened = withLenientInputs(tools)
  return options.loopGuard ? guardToolSet(hardened, options.loopGuard) : hardened
}

function withLenientInputs(tools: ToolSet): ToolSet {
  const hardened: ToolSet = {}
  for (const [name, entry] of Object.entries(tools)) {
    const tool = entry as Tool
    if (
      !tool ||
      (tool as { type?: unknown }).type === 'provider' ||
      typeof tool.execute !== 'function' ||
      tool.inputSchema == null ||
      isLenientInputSchema(tool.inputSchema)
    ) {
      hardened[name] = entry
      continue
    }
    hardened[name] = withToolOverrides(tool, {
      inputSchema: lenientInputSchema(tool.inputSchema, { toolName: name, onCoerced: reportCoercion }),
    }) as typeof entry
  }
  return hardened
}
