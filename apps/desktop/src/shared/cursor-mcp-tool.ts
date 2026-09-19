/** Normalize the SDK's synthetic MCP envelope for shared events and persisted history. */

export interface UnwrappedCursorToolCall {
  toolName: string
  input: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** SDK envelope shared by host and third-party MCP tools. */
export function isCursorMcpToolEnvelope(input: unknown): input is {
  providerIdentifier: string
  toolName: string
  args?: unknown
} {
  if (!isRecord(input)) return false
  if (typeof input.providerIdentifier !== 'string' || !input.providerIdentifier) return false
  if (typeof input.toolName !== 'string' || !input.toolName.trim()) return false
  return true
}

/** Promote the nested tool name and arguments; already normalized calls are unchanged. */
export function unwrapCursorMcpToolCall(toolName: string, input: unknown): UnwrappedCursorToolCall {
  if (toolName !== 'mcp' || !isCursorMcpToolEnvelope(input)) return { toolName, input }
  return { toolName: input.toolName.trim(), input: input.args }
}

/** Normalize a tool part without mutating the original. */
export function unwrapCursorMcpToolPart<T extends { toolName: string; input?: unknown }>(part: T): T {
  const unwrapped = unwrapCursorMcpToolCall(part.toolName, part.input)
  if (unwrapped.toolName === part.toolName && unwrapped.input === part.input) return part
  return { ...part, toolName: unwrapped.toolName, input: unwrapped.input }
}
