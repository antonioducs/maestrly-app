import { setConversationTile } from '../conversation-screen'
import type { BrowserPlacement } from '../remote-host/server/computers'
import { refreshBrowserStream } from './browser-stream'
import { handOverStreamWindow } from './stream-window'

/** The floating window of a conversation's browser, as the floating manager handles it. */
export interface ConversationTileWindows {
  /** Opens the browser in its floating window, without the keyboard. */
  detach(convId: string): void
  /** Keeps that window shown whichever conversation the host's window shows. */
  setPinned(convId: string): void
  /** Closes the floating window and returns the browser to its drawer. */
  reattach(convId: string): void
  floatWindow(convId: string): { setAlwaysOnTop(flag: boolean): void } | null
  /** The browser's placement: `slot`, `stream`, `floating`, `popup`. */
  placement(convId: string): string
}

/**
 * Moves a workspaces conversation's browser where its computer or its Browser tab's video needs it (see
 * `BrowserPlacement`), and refreshes a stream that shows it, so the next frame comes from its new window.
 */
export function placeConversationBrowser(
  convId: string,
  placement: BrowserPlacement,
  windows: ConversationTileWindows
): void {
  const current = windows.placement(convId)
  if (placement.kind === 'computer') {
    setConversationTile(convId, null)
    if (current === 'stream') handOverStreamWindow(convId)
    windows.detach(convId)
    windows.setPinned(convId)
    // Programs the agent starts on the environment display must not cover the tile the computer's desktop mirrors.
    windows.floatWindow(convId)?.setAlwaysOnTop(true)
  } else if (placement.kind === 'tile') {
    setConversationTile(convId, placement.tile)
    if (current === 'floating') windows.reattach(convId)
  } else {
    setConversationTile(convId, null)
    if (current === 'floating') windows.reattach(convId)
    if (current === 'stream') handOverStreamWindow(convId)
  }
  refreshBrowserStream(convId)
}
