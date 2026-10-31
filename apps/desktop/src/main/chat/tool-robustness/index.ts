/**
 * Tool-call robustness: repairs malformed calls, guards against loops and adapts schemas per provider. Documented in
 * docs/harness-profiles.md ("Tool-call robustness").
 */
import type { Tool, ToolSet } from 'ai'
import { chatDiag } from '../diag-log'
import { isLenientInputSchema, lenientInputSchema } from './lenient-input'

export { coerceToolInput, parseToolArguments } from './arg-repair'
export { createToolCallRepair, type ToolCallRepairEvent } from './repair-tool-call'
export { lenientInputSchema, ToolInputValidationError } from './lenient-input'

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
 * Applies the host-side robustness layer to every executable function tool: lenient input validation. Provider tools
 * and tools without a schema pass through. Idempotent: a tool already hardened keeps its wrapper.
 */
export function hardenToolSetForModel(tools: ToolSet): ToolSet {
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
