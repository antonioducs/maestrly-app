/**
 * The browser of a conversation that runs on a remote host, shown live in a window of another computer. The host
 * streams JPEG frames of the page its agent drives, and the window sends the person's input back; everything travels
 * over the host bridge. Frames, cursor and notices go to the one renderer that opened the stream.
 */

export const BROWSER_STREAM_LIMITS = {
  /** Frames sent and not yet acknowledged by the window; past them the host holds the page's next frame back. */
  maxFramesInFlight: 2,
  /** Text copied from or pasted into the page, in UTF-16 code units. */
  maxClipboardChars: 1024 * 1024,
  maxPasteHtmlChars: 2 * 1024 * 1024,
  /** One `text` input: what a key, a composition or a dictation inserts at once. */
  maxTextInputChars: 4096,
  maxSelectOptions: 1000,
  maxLabelChars: 500,
} as const

export type BrowserStreamEndReason = 'taken-over' | 'stopped' | 'unavailable'

export interface BrowserStreamStarted {
  streamId: string
}

/** What the window shows: the active tab, a sign-in window the page opened above it, or nothing when no tab is open. */
export interface BrowserStreamSource {
  convId: string
  streamId: string
  /** Increases on each change of source; frames and requests of an earlier one are dropped. */
  source: number
  kind: 'tab' | 'popup' | 'none'
  /** The address and title of a sign-in window; null for a tab. */
  popup: { url: string; title: string } | null
}

export interface BrowserStreamFrame {
  convId: string
  streamId: string
  source: number
  seq: number
  /** Size of the page's viewport the frame shows, in its window's pixels; input coordinates use the same space. */
  width: number
  height: number
  /** JPEG, base64. */
  data: string
}

export interface BrowserStreamEnded {
  convId: string
  streamId: string
  reason: BrowserStreamEndReason
}

/** CSS cursor names the window accepts; anything else shows the default cursor. */
export const BROWSER_STREAM_CURSORS = [
  'default',
  'none',
  'context-menu',
  'help',
  'pointer',
  'progress',
  'wait',
  'cell',
  'crosshair',
  'text',
  'vertical-text',
  'alias',
  'copy',
  'move',
  'no-drop',
  'not-allowed',
  'grab',
  'grabbing',
  'all-scroll',
  'col-resize',
  'row-resize',
  'n-resize',
  'e-resize',
  's-resize',
  'w-resize',
  'ne-resize',
  'nw-resize',
  'se-resize',
  'sw-resize',
  'ew-resize',
  'ns-resize',
  'nesw-resize',
  'nwse-resize',
  'zoom-in',
  'zoom-out',
] as const
export type BrowserStreamCursorName = (typeof BROWSER_STREAM_CURSORS)[number]
const CURSOR_NAMES: ReadonlySet<string> = new Set(BROWSER_STREAM_CURSORS)

/** The CSS cursor for a cursor type Electron reports (`cursor-changed`). */
export function browserStreamCursor(type: unknown): BrowserStreamCursorName {
  if (typeof type !== 'string') return 'default'
  if (type === 'nodrop' || type === 'drag-drop-none') return 'no-drop'
  if (type.includes('panning')) return 'all-scroll'
  if (type === 'drag-drop-move') return 'move'
  if (type === 'drag-drop-copy') return 'copy'
  if (type === 'drag-drop-link') return 'alias'
  return CURSOR_NAMES.has(type) ? (type as BrowserStreamCursorName) : 'default'
}

export interface BrowserStreamCursor {
  convId: string
  streamId: string
  cursor: BrowserStreamCursorName
}

export interface BrowserSelectOption {
  label: string
  disabled: boolean
  /** The label of the option's group, or null outside any group. */
  group: string | null
}

/** A `<select>` the person clicked in the page: the window lists its options, since the page cannot show its own. */
export interface BrowserSelectRequest {
  convId: string
  streamId: string
  source: number
  requestId: string
  options: BrowserSelectOption[]
  selectedIndex: number
  /** The element in the frame's coordinates, to anchor the list under it. */
  rect: { x: number; y: number; width: number; height: number }
}

export interface BrowserStreamNotice {
  convId: string
  streamId: string
  /** The page asked for a file, which the remote browser cannot upload yet. */
  notice: 'file-chooser'
}

/** CDP modifier bits: Alt 1, Control 2, Meta 4, Shift 8. */
export const BROWSER_MODIFIERS = { alt: 1, control: 2, meta: 4, shift: 8 } as const

/** Editing commands a key may carry, for shortcuts whose meaning differs between the window's system and the host's. */
export const BROWSER_KEY_COMMANDS = ['deleteToBeginningOfLine'] as const
export type BrowserKeyCommand = (typeof BROWSER_KEY_COMMANDS)[number]

export type BrowserEditCommand = 'selectAll' | 'undo' | 'redo'

export type BrowserStreamInput =
  | {
      type: 'mouse'
      action: 'move' | 'down' | 'up'
      /** In the frame's coordinates (see BrowserStreamFrame). */
      x: number
      y: number
      button: 'none' | 'left' | 'middle' | 'right'
      /** Buttons held: left 1, right 2, middle 4. */
      buttons: number
      clickCount: number
      modifiers: number
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | {
      type: 'key'
      action: 'down' | 'up'
      key: string
      code: string
      keyCode: number
      modifiers: number
      /** 1 left / 2 right for modifiers, 3 numpad. */
      location: number
      autoRepeat: boolean
      /**
       * Only Enter and Space type through their key (Space so that it also scrolls the page and presses buttons);
       * every other character arrives as `text`.
       */
      text?: '\r' | ' '
      commands?: BrowserKeyCommand[]
    }
  | { type: 'text'; text: string }
  | { type: 'edit'; command: BrowserEditCommand }
  | { type: 'focus'; focused: boolean }

const COORDINATE_LIMIT = 100_000
const DELTA_LIMIT = 100_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max
const shortString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T =>
  typeof value === 'string' && (options as readonly string[]).includes(value)

/** The input the window sent, checked field by field; null for anything malformed. */
export function parseBrowserStreamInput(value: unknown): BrowserStreamInput | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'mouse':
      if (
        !oneOf(value.action, ['move', 'down', 'up'] as const) ||
        !finite(value.x, COORDINATE_LIMIT) ||
        !finite(value.y, COORDINATE_LIMIT) ||
        !oneOf(value.button, ['none', 'left', 'middle', 'right'] as const) ||
        !integer(value.buttons, 0, 7) ||
        !integer(value.clickCount, 0, 3) ||
        !integer(value.modifiers, 0, 15)
      )
        return null
      return {
        type: 'mouse',
        action: value.action,
        x: value.x,
        y: value.y,
        button: value.button,
        buttons: value.buttons,
        clickCount: value.clickCount,
        modifiers: value.modifiers,
      }
    case 'wheel':
      if (
        !finite(value.x, COORDINATE_LIMIT) ||
        !finite(value.y, COORDINATE_LIMIT) ||
        !finite(value.deltaX, DELTA_LIMIT) ||
        !finite(value.deltaY, DELTA_LIMIT) ||
        !integer(value.modifiers, 0, 15)
      )
        return null
      return {
        type: 'wheel',
        x: value.x,
        y: value.y,
        deltaX: value.deltaX,
        deltaY: value.deltaY,
        modifiers: value.modifiers,
      }
    case 'key': {
      if (
        !oneOf(value.action, ['down', 'up'] as const) ||
        !shortString(value.key, 32) ||
        !value.key ||
        !shortString(value.code, 32) ||
        !integer(value.keyCode, 0, 255) ||
        !integer(value.modifiers, 0, 15) ||
        !integer(value.location, 0, 3) ||
        typeof value.autoRepeat !== 'boolean' ||
        (value.text !== undefined && value.text !== '\r' && value.text !== ' ')
      )
        return null
      let commands: BrowserKeyCommand[] | undefined
      if (value.commands !== undefined) {
        if (!Array.isArray(value.commands) || value.commands.length > BROWSER_KEY_COMMANDS.length) return null
        if (!value.commands.every((command) => oneOf(command, BROWSER_KEY_COMMANDS))) return null
        commands = value.commands as BrowserKeyCommand[]
      }
      return {
        type: 'key',
        action: value.action,
        key: value.key,
        code: value.code,
        keyCode: value.keyCode,
        modifiers: value.modifiers,
        location: value.location,
        autoRepeat: value.autoRepeat,
        ...(value.text === '\r' || value.text === ' ' ? { text: value.text } : {}),
        ...(commands?.length ? { commands } : {}),
      }
    }
    case 'text':
      if (!shortString(value.text, BROWSER_STREAM_LIMITS.maxTextInputChars) || !value.text) return null
      return { type: 'text', text: value.text }
    case 'edit':
      if (!oneOf(value.command, ['selectAll', 'undo', 'redo'] as const)) return null
      return { type: 'edit', command: value.command }
    case 'focus':
      if (typeof value.focused !== 'boolean') return null
      return { type: 'focus', focused: value.focused }
    default:
      return null
  }
}

/** A stream id the host gave out: what the window sends back must have its shape before anything is looked up. */
export const isBrowserStreamId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value)
