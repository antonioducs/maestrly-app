import type { WebContents } from 'electron'
import {
  matchShortcut,
  matchDetachShortcut,
  defaultShortcuts,
  defaultClosePopup,
  closePopupMatches,
  bindingMatchesEvent,
  defaultDrawerShortcut,
  osFromPlatform,
  type EffectiveShortcuts,
  type ShortcutBinding,
} from '../shared/shortcuts'
import type { FloatTab } from '../shared/tool-tabs'

/**
 * Central main-process keyboard capture for tool popups (#328). App-local shortcuts require
 * before-input-event on mainWindow and every drawer WebContentsView so focused native content is
 * covered. A single dispatch path avoids racing renderer keydown handlers. Inject popup handlers,
 * visible-conversation state, and suppression through index.ts; settings supply effective shortcuts.
 */

export interface HotkeyHandler {
  /**
   * Currently visible conversation, not merely active state. null on project panels/Settings/onboarding disables
   * popup shortcuts; sourced from drawer:visible-conversation.
   */
  visibleConvId(): string | null
  /** Modal/overlay suppression gives Escape to the modal and prevents opening popups beneath it. */
  isSuppressed(): boolean
  /** Return true if accepted; false lets the focused content receive the key combination. */
  openPopup(convId: string, tab: FloatTab): boolean
  /**
   * Shift variant detaches the tool to a floating window or focuses an existing one, subject to
   * visible-conversation and modal guards.
   */
  openFloating(convId: string, tab: FloatTab): boolean
  /**
   * Close the focused floating window or top popup. Return whether something closed so otherwise the key
   * can reach the modal/editor.
   */
  closeTop(convId: string | null): boolean
  /** Toggle the docked drawer for the visible conversation. */
  toggleDrawer(convId: string): boolean
}

let handler: HotkeyHandler | null = null
let shortcuts: EffectiveShortcuts = defaultShortcuts(osFromPlatform(process.platform))
let closeShortcut: ShortcutBinding = defaultClosePopup(osFromPlatform(process.platform))
let drawerShortcut: ShortcutBinding = defaultDrawerShortcut(osFromPlatform(process.platform))

/** Inject handlers from index.ts, following setFloatFocuser. */
export function setHotkeyHandler(h: HotkeyHandler): void {
  handler = h
}

/** Apply effective OS defaults plus stored overrides at boot and after Settings saves. */
export function setActiveShortcuts(eff: EffectiveShortcuts): void {
  shortcuts = eff
}

/** Update the Escape-plus-modifiers close binding at boot and after Settings saves. */
export function setActiveCloseShortcut(b: ShortcutBinding): void {
  closeShortcut = b
}

export function setActiveDrawerShortcut(b: ShortcutBinding): void {
  drawerShortcut = b
}

/** Register shortcut/Escape capture on mainWindow or a drawer WebContentsView. */
export function attachHotkeyCapture(wc: WebContents): void {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || !handler) return
    const convId = handler.visibleConvId()

    // Close the focused floating window or top popup only without modal suppression. Prevent default only
    // when closeTop succeeds. Check both key and code because layouts may report Escape differently. macOS
    // consumes Command+Escape, so the default uses Control+Escape.
    if (input.key === 'Escape' || input.code === 'Escape') {
      if (closePopupMatches(closeShortcut, input) && !handler.isSuppressed()) {
        if (handler.closeTop(convId)) event.preventDefault()
      }
      return
    }

    // Tool shortcuts open centered popups only with a visible conversation and no modal.
    const ev = {
      key: input.key,
      code: input.code,
      meta: input.meta,
      control: input.control,
      alt: input.alt,
      shift: input.shift,
    }
    if (convId && !handler.isSuppressed() && bindingMatchesEvent(drawerShortcut, ev)) {
      if (handler.toggleDrawer(convId)) event.preventDefault()
      return
    }
    const tab = matchShortcut(ev, shortcuts)
    if (tab && convId && !handler.isSuppressed()) {
      if (handler.openPopup(convId, tab)) event.preventDefault()
      return
    }
    // Shift variant detaches the tool to a floating window with the same guards.
    const detachTab = matchDetachShortcut(ev, shortcuts)
    if (detachTab && convId && !handler.isSuppressed()) {
      if (handler.openFloating(convId, detachTab)) event.preventDefault()
    }
  })
}
