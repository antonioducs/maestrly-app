import type { WebContents } from 'electron'
import { eventKey, type KeyEventLike } from '../shared/shortcuts'
import { getConversation } from './store'
import { closeShellTerminal, createShellTerminal, getTerminalState } from './terminal-manager'

export type TerminalShortcutAction = 'create' | 'close'

/** Command on macOS, Control elsewhere, with no extra modifiers. */
export function terminalShortcutAction(input: KeyEventLike, platform: string): TerminalShortcutAction | null {
  const primary = platform === 'darwin' ? !!input.meta && !input.control : !!input.control && !input.meta
  if (!primary || input.alt || input.shift) return null

  const key = eventKey(input)
  if (key === 't') return 'create'
  if (key === 'w') return 'close'
  return null
}

/**
 * Capture terminal shortcuts only on its WebContentsView. The same listener follows reparenting among
 * drawer, popup, and floating hosts without global registration.
 */
export function attachTerminalHotkeyCapture(wc: WebContents, convId: string): void {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return
    const action = terminalShortcutAction(input, process.platform)
    if (!action) return

    // Prevent Command/Control+W from closing BrowserWindow even when no terminal tabs remain.
    event.preventDefault()
    if (action === 'create') {
      const conv = getConversation(convId)
      if (conv) createShellTerminal(convId, conv.cwd)
      return
    }

    const { activeId } = getTerminalState(convId)
    if (activeId) closeShellTerminal(convId, activeId)
  })
}
