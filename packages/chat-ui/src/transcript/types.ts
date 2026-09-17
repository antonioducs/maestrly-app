/** One tool invocation as the card shows it, independent of which engine produced it. */
export type ToolViewState = 'pending' | 'awaiting-permission' | 'running' | 'done' | 'error' | 'denied'

export interface ToolImageRef {
  /** Opaque reference the host application resolves through `resolveImage`. */
  ref: string
  id: string
  name?: string
}

export interface ToolPartView {
  id: string
  toolName: string
  summary?: string
  input?: unknown
  /** Already-formatted output text; the card only clips it for display. */
  output?: string
  exitCode?: number
  changes?: { path: string; kind: string }[]
  state: ToolViewState
  images?: ToolImageRef[]
}

/** Longest tool output the card renders before showing an ellipsis; the Host clips earlier. */
export const TOOL_OUTPUT_DISPLAY_MAX = 8 * 1024

export function formatResponseDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes === 0) return `${seconds}s`
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours === 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
}

export function responseDurationMs(startedAt: number, endedAt = Date.now()): number {
  return Math.max(0, Math.round(endedAt - startedAt))
}
