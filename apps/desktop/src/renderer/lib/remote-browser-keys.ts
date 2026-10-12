import {
  BROWSER_MODIFIERS,
  type BrowserEditCommand,
  type BrowserKeyCommand,
  type BrowserStreamInput,
} from '../../shared/browser-stream'

/**
 * How a key pressed over the remote browser reaches the host's page, which runs on Linux. Characters never travel as
 * keys: the hidden text field under the surface composes them (dead keys, IME, emoji picker) and its `input` sends
 * the text. Keys still reach the page as key events so its shortcuts work, and the window's own shortcuts keep
 * working: only a fixed list of Command/Control combinations is taken from the app.
 */

export type KeyOs = 'mac' | 'win' | 'linux'
export type KeyInput = Extract<BrowserStreamInput, { type: 'key' }>

/** What a key down over the surface does. */
export type KeyRoute =
  /** A key event for the page. `typed`: the key also types into the hidden field, which must receive it. */
  | { route: 'page'; input: KeyInput; typed: boolean }
  | { route: 'edit'; command: BrowserEditCommand }
  | { route: 'copy'; cut: boolean }
  /** Paste is left to the native paste event, whose clipboard data is the window's clipboard. */
  | { route: 'paste' }
  | { route: 'browser'; action: 'focus-address' | 'reload' | 'back' | 'forward' }
  /** A dead key or a composition in progress: the hidden field composes it. */
  | { route: 'compose' }
  /** Not for the page: the app (and its shortcuts) handles it. */
  | { route: 'app' }

export interface KeyEventLike {
  key: string
  code: string
  keyCode: number
  location: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  repeat: boolean
  isComposing: boolean
}

/** Windows virtual key codes, which DevTools expects, for the keys this module rewrites. */
const VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
}

/** Keys that do something in the page by themselves: the hidden field must not act on them too. */
const NAMED_KEYS = new Set([
  'Backspace',
  'Tab',
  'Enter',
  'Escape',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'ContextMenu',
  ...Array.from({ length: 12 }, (_, n) => `F${n + 1}`),
])
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'])

/** Command/Control shortcuts that belong to the page: formatting in editors and inserting a link. */
const PAGE_SHORTCUT_LETTERS = new Set(['b', 'i', 'u', 'k'])

const isPrintable = (key: string): boolean => [...key].length === 1

/** The page's modifiers. Meta never reaches it: the window's Command becomes Control only in the rewrites below. */
function modifierBits(event: KeyEventLike, options: { alt?: boolean } = {}): number {
  let bits = 0
  if (options.alt ?? event.altKey) bits |= BROWSER_MODIFIERS.alt
  if (event.ctrlKey) bits |= BROWSER_MODIFIERS.control
  if (event.shiftKey) bits |= BROWSER_MODIFIERS.shift
  return bits
}

function keyInput(
  event: KeyEventLike,
  action: 'down' | 'up',
  overrides: Partial<Pick<KeyInput, 'key' | 'code' | 'keyCode' | 'modifiers' | 'location'>> & {
    commands?: BrowserKeyCommand[]
  } = {}
): KeyInput {
  const key = overrides.key ?? event.key
  const input: KeyInput = {
    type: 'key',
    action,
    key,
    code: (overrides.code ?? event.code).slice(0, 32),
    keyCode: overrides.keyCode ?? (VK[key] || (event.keyCode >= 0 && event.keyCode <= 255 ? event.keyCode : 0)),
    modifiers: overrides.modifiers ?? modifierBits(event),
    location: overrides.location ?? (event.location >= 0 && event.location <= 3 ? event.location : 0),
    autoRepeat: event.repeat,
  }
  const plain = !(input.modifiers & (BROWSER_MODIFIERS.control | BROWSER_MODIFIERS.alt))
  if (action === 'down' && plain && key === 'Enter') input.text = '\r'
  if (action === 'down' && plain && key === ' ') input.text = ' '
  if (overrides.commands?.length) input.commands = overrides.commands
  return input
}

/** A key with the same meaning on the host: `key` rewritten (Command+← is Home on Linux). */
function rewritten(event: KeyEventLike, key: string, modifiers: number, commands?: BrowserKeyCommand[]): KeyRoute {
  return {
    route: 'page',
    typed: false,
    input: keyInput(event, 'down', { key, code: key, keyCode: VK[key], modifiers, commands }),
  }
}

/** The route of a key down over the surface. */
export function routeKeyDown(event: KeyEventLike, os: KeyOs): KeyRoute {
  if (event.isComposing || event.key === 'Process' || event.keyCode === 229 || event.key === 'Dead')
    return { route: 'compose' }
  if (!event.key || event.key === 'Unidentified' || event.key.length > 32) return { route: 'app' }
  const mac = os === 'mac'
  const accel = mac ? event.metaKey : event.ctrlKey
  const letter = isPrintable(event.key) ? event.key.toLowerCase() : ''
  const shift = event.shiftKey ? BROWSER_MODIFIERS.shift : 0

  if (MODIFIER_KEYS.has(event.key)) {
    // The window's Command is the host's Control only within the shortcuts below; alone it means nothing there.
    if (mac && event.key === 'Meta') return { route: 'app' }
    return { route: 'page', typed: false, input: keyInput(event, 'down') }
  }

  if (accel && !event.altKey) {
    if (mac) {
      if (event.key === 'ArrowLeft') return rewritten(event, 'Home', shift)
      if (event.key === 'ArrowRight') return rewritten(event, 'End', shift)
      if (event.key === 'ArrowUp') return rewritten(event, 'Home', BROWSER_MODIFIERS.control | shift)
      if (event.key === 'ArrowDown') return rewritten(event, 'End', BROWSER_MODIFIERS.control | shift)
      if (event.key === 'Backspace') return rewritten(event, 'Backspace', 0, ['deleteToBeginningOfLine'])
      if (event.key === '[') return { route: 'browser', action: 'back' }
      if (event.key === ']') return { route: 'browser', action: 'forward' }
    }
    if (letter === 'c' && !event.shiftKey) return { route: 'copy', cut: false }
    if (letter === 'x' && !event.shiftKey) return { route: 'copy', cut: true }
    if (letter === 'v') return { route: 'paste' }
    if (letter === 'a' && !event.shiftKey) return { route: 'edit', command: 'selectAll' }
    if (letter === 'z') return { route: 'edit', command: event.shiftKey ? 'redo' : 'undo' }
    if (letter === 'y' && !mac && !event.shiftKey) return { route: 'edit', command: 'redo' }
    if (letter === 'l' && !event.shiftKey) return { route: 'browser', action: 'focus-address' }
    if (letter === 'r' && !event.shiftKey) return { route: 'browser', action: 'reload' }
    if (PAGE_SHORTCUT_LETTERS.has(letter)) {
      return {
        route: 'page',
        typed: false,
        input: keyInput(event, 'down', { modifiers: BROWSER_MODIFIERS.control | shift }),
      }
    }
    return { route: 'app' }
  }
  // Command with Option, or Control with Alt elsewhere: the window's shortcuts.
  if (accel) return { route: 'app' }

  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    if (mac) {
      // Option moves and deletes by word on a Mac; Control does on Linux.
      if (
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'Backspace' ||
        event.key === 'Delete'
      )
        return rewritten(event, event.key, BROWSER_MODIFIERS.control | shift)
      // Option with a character key types a character (or starts a dead key): it is no Alt shortcut on the host.
      if (isPrintable(event.key))
        return {
          route: 'page',
          typed: true,
          input: keyInput(event, 'down', { modifiers: modifierBits(event, { alt: false }) }),
        }
    } else {
      if (event.key === 'ArrowLeft') return { route: 'browser', action: 'back' }
      if (event.key === 'ArrowRight') return { route: 'browser', action: 'forward' }
    }
  }
  if (!mac && event.key === 'F5') return { route: 'browser', action: 'reload' }

  // Space types through its key, so that it also scrolls the page and presses its buttons.
  if (NAMED_KEYS.has(event.key) || (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey))
    return { route: 'page', typed: false, input: keyInput(event, 'down') }
  if (isPrintable(event.key)) {
    // A Control combination types nothing; anything else types its character through the hidden field.
    const typed = !event.ctrlKey && !event.metaKey
    return { route: 'page', typed, input: keyInput(event, 'down') }
  }
  return { route: 'app' }
}

/** The key up matching a key down that went to the page: the same key, as the page saw it go down. */
export function keyUpInput(down: KeyInput): KeyInput {
  return {
    type: 'key',
    action: 'up',
    key: down.key,
    code: down.code,
    keyCode: down.keyCode,
    modifiers: down.modifiers,
    location: down.location,
    autoRepeat: false,
  }
}
