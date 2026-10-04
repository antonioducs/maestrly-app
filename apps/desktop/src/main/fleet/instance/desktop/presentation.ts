/**
 * Decides when a bot's tool call should bring one of its desktop windows to the front: which app a tool call
 * touches, and a gate that keeps rapid calls and human takeovers from making windows flicker.
 */

export type PresentationRequest = { app: 'browser' } | { app: 'terminal'; terminalId: string | null }

/** Browser tools that act on the page or tabs; reads (snapshot, screenshot, logs, evaluate, ...) are not listed. */
const BROWSER_TOOLS: ReadonlySet<string> = new Set([
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_click',
  'browser_double_click',
  'browser_right_click',
  'browser_type',
  'browser_press_key',
  'browser_drag',
  'browser_scroll',
  'browser_mouse_move',
  'browser_new_tab',
  'browser_switch_tab',
])

/** `mcp__<server>__<tool>` → `<tool>`; names without the prefix are returned unchanged. */
function bareToolName(toolName: string): string {
  return /^mcp__.+?__(.+)$/.exec(toolName)?.[1] ?? toolName
}

function terminalIdOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const id = (input as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : null
}

/** What a bot's tool call brings to the front of its desktop, if anything. */
export function presentationForTool(toolName: string, input: unknown): PresentationRequest | null {
  const tool = bareToolName(toolName)
  if (BROWSER_TOOLS.has(tool)) return { app: 'browser' }
  if (tool === 'terminal_send' || tool === 'terminal_run') return { app: 'terminal', terminalId: terminalIdOf(input) }
  if (tool === 'terminal_create') return { app: 'terminal', terminalId: null }
  return null
}

/** Tools whose window exists only after they finish: present on completion instead of on call. */
export function presentsOnCompletion(toolName: string): boolean {
  return bareToolName(toolName) === 'terminal_create'
}

export interface HoldState {
  state: 'none' | 'holding' | 'held'
  reason: 'takeover' | 'paused' | null
}

const DEFAULT_INTERVAL_MS = 250

/** Rate limits presentation per app and suppresses it while a human has taken over the desktop. */
export class PresentationGate {
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly lastPresented = new Map<PresentationRequest['app'], number>()

  constructor(options: { now?: () => number; intervalMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  /**
   * Whether to present now: never while a takeover hold is active; at most once per interval per app (every
   * terminal counts as the same app). `force` (dock and link requests) bypasses the interval, never a takeover.
   */
  allow(request: PresentationRequest, hold: HoldState, options: { force?: boolean } = {}): boolean {
    if (hold.state !== 'none' && hold.reason === 'takeover') return false
    const now = this.now()
    const last = this.lastPresented.get(request.app)
    if (!options.force && last !== undefined && now >= last && now - last < this.intervalMs) return false
    this.lastPresented.set(request.app, now)
    return true
  }
}
