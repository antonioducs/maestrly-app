import type { ToolName } from '@cursor/sdk'

export interface CursorToolPolicyResolution {
  tools: ToolName[]
  disallowedTools?: ToolName[]
  customToolsEnabled: boolean
}

/**
 * Only host callbacks are offered. Native shell, file edits and delegation must
 * remain unavailable: the SDK has no host-driven approval broker for them.
 * Reapply this allowlist on every create/resume; SDK options are not persisted.
 */
export function cursorCustomToolsOnlyPolicy(): CursorToolPolicyResolution {
  return { tools: ['mcp'], customToolsEnabled: true }
}
