/**
 * `repairToolCall` for the AI SDK loops (BYOK and subagents). The SDK calls it only for a call whose name is unknown
 * or whose input failed to parse or validate. It repairs the name deterministically and the JSON text; a repair it
 * cannot make throws a message written for the model, which the SDK returns to it as the tool's error. Schema
 * coercion is not done here: the lenient input schema already tried it before the SDK gave up.
 */
import { InvalidToolInputError, NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from 'ai'
import { isRecord } from './json-schema-utils'
import { parseToolArguments } from './arg-repair'
import { resolveToolName, unknownToolMessage } from './tool-name-repair'

export type ToolCallRepairKind = 'name' | 'json'

export interface ToolCallRepairEvent {
  /** What was repaired; `failed` means the call could not be repaired and returned an error to the model. */
  outcome: 'repaired' | 'failed'
  kinds: ToolCallRepairKind[]
  toolName: string
  rule?: string
  reason?: string
}

/** Raised when a call cannot be repaired; its message is what the model reads. */
export class ToolCallUnrepairableError extends Error {
  constructor(
    message: string,
    readonly reason: 'unknown-tool' | 'ambiguous-tool' | 'truncated' | 'multiple' | 'invalid'
  ) {
    super(message)
    this.name = 'ToolCallUnrepairableError'
  }
}

export function createToolCallRepair(options: { onEvent?: (event: ToolCallRepairEvent) => void } = {}) {
  const repair: ToolCallRepairFunction<ToolSet> = async ({ toolCall, tools, error }) => {
    const kinds: ToolCallRepairKind[] = []
    let toolName = toolCall.toolName
    let rule: string | undefined
    const fail = (message: string, reason: ToolCallUnrepairableError['reason']): never => {
      options.onEvent?.({ outcome: 'failed', kinds, toolName, reason })
      throw new ToolCallUnrepairableError(message, reason)
    }

    if (NoSuchToolError.isInstance(error)) {
      const available = Object.keys(tools)
      const resolution = resolveToolName(toolCall.toolName, available)
      if (resolution.kind !== 'repaired') {
        fail(
          unknownToolMessage(toolCall.toolName, resolution, available),
          resolution.kind === 'ambiguous' ? 'ambiguous-tool' : 'unknown-tool'
        )
      } else {
        toolName = resolution.name
        rule = resolution.rule
        kinds.push('name')
      }
    } else if (!InvalidToolInputError.isInstance(error)) {
      return null
    }

    let input = toolCall.input
    let parsed: unknown
    try {
      parsed = input.trim() === '' ? {} : JSON.parse(input)
    } catch {
      const result = parseToolArguments(input)
      if (!result.ok) return fail(result.message, result.reason)
      parsed = result.value
      input = JSON.stringify(parsed)
      kinds.push('json')
    }
    // A whole argument object encoded as a JSON string: `"{\"path\":\"a\"}"`.
    if (typeof parsed === 'string') {
      const inner = parseToolArguments(parsed)
      if (inner.ok && isRecord(inner.value)) {
        input = JSON.stringify(inner.value)
        if (!kinds.includes('json')) kinds.push('json')
      }
    }

    // Nothing to repair: the input parsed and the schema rejected it; the SDK reports the validation error.
    if (kinds.length === 0) return null
    options.onEvent?.({ outcome: 'repaired', kinds, toolName, ...(rule ? { rule } : {}) })
    return { ...toolCall, toolName, input }
  }
  return repair
}
