import { app, BrowserWindow } from 'electron'

/**
 * Keyboard focus on a display that several owners share. In a bot environment one Electron process draws the
 * environment screen (Maestrly's settings) and every bot's browser, with its popups, on one X display, and whoever
 * controls one area of it types into whichever window has that display's focus. So while a control lasts, the windows
 * of every other owner neither take the focus nor receive native input:
 *
 * - `setFocusable(false)` makes `focus()`, `webContents.focus()` and `show()` leave the focus where it is;
 * - `setEnabled(false)` drops the native keyboard and mouse events that still reach such a window, for example when the
 *   window manager gives it the focus after the focused window closed. Programmatic input (CDP and `sendInputEvent`),
 *   which bots use, does not go through there and keeps working;
 * - a hidden window of another owner is shown with `showInactive()`, which tells the window manager not to focus it.
 *
 * A window that opens during a control belongs to nobody until its owner is set, so it starts restricted. When the
 * control ends every window gets its previous state back; outside a control nothing is restricted.
 */

/** Who a window belongs to: the environment screen, or one conversation (its browser and the popups of its pages). */
export type ScreenFocusOwner = { kind: 'environment' } | { kind: 'conversation'; conversationId: string }

interface Restriction {
  focusable: boolean
  enabled: boolean
}

const owners = new WeakMap<BrowserWindow, string>()
const restricted = new Map<BrowserWindow, Restriction>()
/** Windows whose closing already forgets their restriction; each needs that listener once, however many controls. */
const watched = new WeakSet<BrowserWindow>()
/** The control in progress; its key is null when the controlled screen has no windows at all. */
let held: { key: string | null; focus: () => void } | null = null
let watchingNewWindows = false

const keyOf = (owner: ScreenFocusOwner): string =>
  owner.kind === 'environment' ? 'environment' : `conversation:${owner.conversationId}`

function log(message: string): void {
  console.error(JSON.stringify({ component: 'screen-focus', level: 'error', message }))
}
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Sets the owner of a window. During a control the window is restricted or released right away. */
export function setScreenFocusOwner(win: BrowserWindow, owner: ScreenFocusOwner): void {
  owners.set(win, keyOf(owner))
  if (held) apply(win)
}

/** Whether a window may take the focus now: always, except while someone controls another owner's screen. */
export function mayTakeScreenFocus(win: BrowserWindow): boolean {
  return !held || (held.key !== null && owners.get(win) === held.key)
}

/** Shows a window and focuses it, or, during another owner's control, only shows it without taking the focus. */
export function showWindow(win: BrowserWindow): void {
  if (!mayTakeScreenFocus(win)) {
    if (!win.isVisible()) win.showInactive()
    return
  }
  win.show()
  win.focus()
}

/**
 * Keeps the display's focus on the windows of one owner (none with `null`) until the returned function is called:
 * the windows of every other owner are restricted, then `focus` gives the keyboard to the owner's window without
 * waiting for a click. A later hold replaces this one; releasing a replaced hold does nothing.
 */
export function holdScreenFocus(owner: ScreenFocusOwner | null, focus: () => void): () => void {
  const hold = { key: owner ? keyOf(owner) : null, focus }
  held = hold
  if (!watchingNewWindows) {
    watchingNewWindows = true
    // Emitted while the window is constructed, before anyone can show or focus it.
    app.on('browser-window-created', (_event, win) => {
      if (held) apply(win)
    })
  }
  for (const win of BrowserWindow.getAllWindows()) apply(win)
  focusHeld(hold)
  let released = false
  return () => {
    if (released) return
    released = true
    if (held !== hold) return
    held = null
    for (const win of [...restricted.keys()]) release(win)
  }
}

/**
 * Gives the keyboard back to the controlled screen after one of its windows closed, such as a sign-in popup: the
 * window manager hands the display's focus to the next window, but not the keyboard to the page inside it.
 */
export function refocusScreen(owner: ScreenFocusOwner): void {
  if (held && held.key === keyOf(owner)) focusHeld(held)
}

function focusHeld(hold: { focus: () => void }): void {
  try {
    hold.focus()
  } catch (error) {
    log(`Could not focus the controlled screen: ${describe(error)}`)
  }
}

function apply(win: BrowserWindow): void {
  if (mayTakeScreenFocus(win)) release(win)
  else restrict(win)
}

function restrict(win: BrowserWindow): void {
  if (restricted.has(win) || win.isDestroyed()) return
  try {
    restricted.set(win, { focusable: win.isFocusable(), enabled: win.isEnabled() })
    win.setFocusable(false)
    win.setEnabled(false)
    if (!watched.has(win)) {
      watched.add(win)
      win.once('closed', () => restricted.delete(win))
    }
  } catch (error) {
    log(`Could not keep a window from taking the focus: ${describe(error)}`)
  }
}

function release(win: BrowserWindow): void {
  const previous = restricted.get(win)
  if (!previous) return
  restricted.delete(win)
  if (win.isDestroyed()) return
  try {
    win.setFocusable(previous.focusable)
    win.setEnabled(previous.enabled)
  } catch (error) {
    log(`Could not give a window its focus back: ${describe(error)}`)
  }
}
