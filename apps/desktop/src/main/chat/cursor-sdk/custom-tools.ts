import type { SDKCustomTool, SDKCustomToolResult, SDKJsonValue } from '@cursor/sdk'

export interface CursorCustomToolDefinition {
  name: string
  description: string
  inputSchema?: Record<string, SDKJsonValue>
  execute: (
    args: Record<string, SDKJsonValue>,
    toolCallId?: string
  ) => Promise<SDKCustomToolResult> | SDKCustomToolResult
}

/** Builds the Record expected by Agent.create({ local: { customTools } }). */
export function buildCursorCustomTools(
  definitions: readonly CursorCustomToolDefinition[]
): Record<string, SDKCustomTool> {
  const out: Record<string, SDKCustomTool> = {}
  for (const def of definitions) {
    out[def.name] = {
      description: def.description,
      ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),
      execute: (args, context) => def.execute(args, context.toolCallId),
    }
  }
  return out
}

/**
 * Wraps a custom tool execute() with a Maestrly permission gate.
 * Product path for interactive approval of OUR tools only
 * (Cursor built-ins still cannot be gated this way).
 */
export function withCursorCustomToolPermissionGate(
  definition: CursorCustomToolDefinition,
  gate: (input: {
    name: string
    args: Record<string, SDKJsonValue>
    toolCallId?: string
  }) => Promise<'allow' | 'deny'> | 'allow' | 'deny'
): CursorCustomToolDefinition {
  return {
    ...definition,
    execute: async (args, toolCallId) => {
      const decision = await gate({ name: definition.name, args, toolCallId })
      if (decision === 'deny') {
        return {
          content: [{ type: 'text', text: `Permission denied for custom tool "${definition.name}".` }],
          isError: true,
        }
      }
      return definition.execute(args, toolCallId)
    },
  }
}
