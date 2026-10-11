/**
 * Pure translation of X11 key events (keysym + modifier state) into Chrome DevTools Protocol
 * `Input.dispatchKeyEvent` parameters. Key, code and virtual key values follow the standard DOM / Windows tables
 * that Puppeteer's US keyboard layout uses, so pages see the same events a physical US keyboard would produce.
 */

const CDP_ALT = 1
const CDP_CONTROL = 2
const CDP_META = 4
const CDP_SHIFT = 8

/** X11 modifier mask bits that matter to a browser; Lock (Caps), Mod2 (Num Lock) and button bits are ignored. */
const X11_SHIFT = 0x01
const X11_CONTROL = 0x04
const X11_MOD1 = 0x08
const X11_MOD4 = 0x40

const UNICODE_KEYSYM_BASE = 0x1000000
const MAX_CODE_POINT = 0x10ffff
const LOCATION_LEFT = 1
const LOCATION_RIGHT = 2
const LOCATION_NUMPAD = 3

/** CDP modifier bitmask: Alt=1, Control=2, Meta=4, Shift=8. */
export function cdpModifiers(x11State: number): number {
  let modifiers = 0
  if (x11State & X11_MOD1) modifiers |= CDP_ALT
  if (x11State & X11_CONTROL) modifiers |= CDP_CONTROL
  if (x11State & X11_MOD4) modifiers |= CDP_META
  if (x11State & X11_SHIFT) modifiers |= CDP_SHIFT
  return modifiers
}

export interface PresentedKeyEvent {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp'
  key: string
  code: string
  windowsVirtualKeyCode: number
  nativeVirtualKeyCode: number
  modifiers: number
  text?: string
  unmodifiedText?: string
  /** 1 left / 2 right for modifiers, 3 numpad. */
  location?: number
  autoRepeat?: boolean
}

export type EditCommand = 'selectAll' | 'copy' | 'cut' | 'paste' | 'undo' | 'redo'

interface KeyDefinition {
  key: string
  code: string
  vk: number
  location?: number
  /** Text a named key types when no Control/Alt/Meta is held (Enter only); printable keys type their own `key`. */
  text?: string
  /** Modifier bits the keysym itself implies (ISO_Left_Tab is Shift+Tab). */
  implied?: number
}

const NAMED_KEYS = new Map<number, KeyDefinition>([
  [0xff08, { key: 'Backspace', code: 'Backspace', vk: 8 }],
  [0xff09, { key: 'Tab', code: 'Tab', vk: 9 }],
  [0xfe20, { key: 'Tab', code: 'Tab', vk: 9, implied: CDP_SHIFT }],
  [0xff0d, { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }],
  [0xff8d, { key: 'Enter', code: 'NumpadEnter', vk: 13, text: '\r', location: LOCATION_NUMPAD }],
  [0xff1b, { key: 'Escape', code: 'Escape', vk: 27 }],
  [0xffff, { key: 'Delete', code: 'Delete', vk: 46 }],
  [0xff50, { key: 'Home', code: 'Home', vk: 36 }],
  [0xff57, { key: 'End', code: 'End', vk: 35 }],
  [0xff55, { key: 'PageUp', code: 'PageUp', vk: 33 }],
  [0xff56, { key: 'PageDown', code: 'PageDown', vk: 34 }],
  [0xff51, { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }],
  [0xff52, { key: 'ArrowUp', code: 'ArrowUp', vk: 38 }],
  [0xff53, { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }],
  [0xff54, { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }],
  [0xff63, { key: 'Insert', code: 'Insert', vk: 45 }],
  [0xffe1, { key: 'Shift', code: 'ShiftLeft', vk: 16, location: LOCATION_LEFT }],
  [0xffe2, { key: 'Shift', code: 'ShiftRight', vk: 16, location: LOCATION_RIGHT }],
  [0xffe3, { key: 'Control', code: 'ControlLeft', vk: 17, location: LOCATION_LEFT }],
  [0xffe4, { key: 'Control', code: 'ControlRight', vk: 17, location: LOCATION_RIGHT }],
  [0xffe5, { key: 'CapsLock', code: 'CapsLock', vk: 20 }],
  [0xffe7, { key: 'Meta', code: 'MetaLeft', vk: 91, location: LOCATION_LEFT }],
  [0xffe8, { key: 'Meta', code: 'MetaRight', vk: 92, location: LOCATION_RIGHT }],
  [0xffe9, { key: 'Alt', code: 'AltLeft', vk: 18, location: LOCATION_LEFT }],
  [0xffea, { key: 'Alt', code: 'AltRight', vk: 18, location: LOCATION_RIGHT }],
  [0xffeb, { key: 'Meta', code: 'MetaLeft', vk: 91, location: LOCATION_LEFT }],
  [0xffec, { key: 'Meta', code: 'MetaRight', vk: 92, location: LOCATION_RIGHT }],
])

// F1..F12 are consecutive in both the keysym table (0xffbe..) and the Windows virtual keys (0x70..).
for (let n = 1; n <= 12; n++) NAMED_KEYS.set(0xffbd + n, { key: `F${n}`, code: `F${n}`, vk: 111 + n })

/** Keypad operators; KP_0..KP_9 (0xffb0..0xffb9) are generated below. */
const KEYPAD_OPERATORS = new Map<number, KeyDefinition>([
  [0xffaa, { key: '*', code: 'NumpadMultiply', vk: 106 }],
  [0xffab, { key: '+', code: 'NumpadAdd', vk: 107 }],
  [0xffad, { key: '-', code: 'NumpadSubtract', vk: 109 }],
  [0xffae, { key: '.', code: 'NumpadDecimal', vk: 110 }],
  [0xffaf, { key: '/', code: 'NumpadDivide', vk: 111 }],
])

function keypadDefinition(keysym: number): KeyDefinition | null {
  const operator = KEYPAD_OPERATORS.get(keysym)
  const definition =
    operator ??
    (keysym >= 0xffb0 && keysym <= 0xffb9
      ? { key: String(keysym - 0xffb0), code: `Numpad${keysym - 0xffb0}`, vk: 96 + keysym - 0xffb0 }
      : null)
  return definition ? { ...definition, location: LOCATION_NUMPAD } : null
}

/** US layout key (DOM code and Windows virtual key) for each ASCII punctuation character, shifted ones included. */
const US_PUNCTUATION = new Map<string, { code: string; vk: number }>()
function mapPunctuation(characters: string, code: string, vk: number): void {
  for (const character of characters) US_PUNCTUATION.set(character, { code, vk })
}
mapPunctuation(' ', 'Space', 32)
mapPunctuation('-_', 'Minus', 189)
mapPunctuation('=+', 'Equal', 187)
mapPunctuation('[{', 'BracketLeft', 219)
mapPunctuation(']}', 'BracketRight', 221)
mapPunctuation('\\|', 'Backslash', 220)
mapPunctuation(';:', 'Semicolon', 186)
mapPunctuation(`'"`, 'Quote', 222)
mapPunctuation('`~', 'Backquote', 192)
mapPunctuation(',<', 'Comma', 188)
mapPunctuation('.>', 'Period', 190)
mapPunctuation('/?', 'Slash', 191)
/** Shifted digit row on a US keyboard, in Digit1..Digit9, Digit0 order. */
const SHIFTED_DIGITS = '!@#$%^&*()'

/** The Unicode code point a keysym types, or null when it types nothing printable. */
function codePointOf(keysym: number): number | null {
  if (!Number.isInteger(keysym)) return null
  if ((keysym >= 0x20 && keysym <= 0x7e) || (keysym >= 0xa0 && keysym <= 0xff)) return keysym
  if (keysym > UNICODE_KEYSYM_BASE) {
    const codePoint = keysym - UNICODE_KEYSYM_BASE
    const isControl = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)
    const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff
    if (!isControl && !isSurrogate && codePoint <= MAX_CODE_POINT) return codePoint
  }
  return null
}

function printableDefinition(codePoint: number): KeyDefinition {
  const key = String.fromCodePoint(codePoint)
  if (codePoint >= 0x61 && codePoint <= 0x7a) return { key, code: `Key${key.toUpperCase()}`, vk: codePoint - 0x20 }
  if (codePoint >= 0x41 && codePoint <= 0x5a) return { key, code: `Key${key}`, vk: codePoint }
  if (codePoint >= 0x30 && codePoint <= 0x39) return { key, code: `Digit${key}`, vk: codePoint }
  const shiftedDigit = SHIFTED_DIGITS.indexOf(key)
  if (shiftedDigit >= 0) {
    const digit = (shiftedDigit + 1) % 10
    return { key, code: `Digit${digit}`, vk: 0x30 + digit }
  }
  const punctuation = US_PUNCTUATION.get(key)
  if (punctuation) return { key, code: punctuation.code, vk: punctuation.vk }
  return { key, code: '', vk: 0 }
}

function definitionFor(keysym: number): { definition: KeyDefinition; printable: boolean } | null {
  const named = NAMED_KEYS.get(keysym)
  if (named) return { definition: named, printable: false }
  const keypad = keypadDefinition(keysym)
  if (keypad) return { definition: keypad, printable: true }
  const codePoint = codePointOf(keysym)
  return codePoint === null ? null : { definition: printableDefinition(codePoint), printable: true }
}

/** The CDP event for an X key press/release, or null for keysyms with no browser meaning. */
export function presentedKeyEvent(pressed: boolean, keysym: number, x11State: number): PresentedKeyEvent | null {
  const found = definitionFor(keysym)
  if (!found) return null
  const { definition, printable } = found
  const modifiers = cdpModifiers(x11State) | (definition.implied ?? 0)
  const event: PresentedKeyEvent = {
    type: 'keyUp',
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.vk,
    nativeVirtualKeyCode: definition.vk,
    modifiers,
  }
  if (definition.location !== undefined) event.location = definition.location
  if (!pressed) return event

  // Control, Alt and Meta turn a key into a shortcut: the page sees the key, but nothing is typed.
  const text = printable ? definition.key : definition.text
  const types = text !== undefined && (modifiers & (CDP_ALT | CDP_CONTROL | CDP_META)) === 0
  if (types) {
    event.type = 'keyDown'
    event.text = text
    event.unmodifiedText = text
  } else {
    event.type = 'rawKeyDown'
  }
  return event
}

/** The edit command a key press asks for, if any (only on press). */
export function editCommand(keysym: number, x11State: number): EditCommand | null {
  const modifiers = cdpModifiers(x11State)
  if (modifiers & (CDP_ALT | CDP_META)) return null
  const control = (modifiers & CDP_CONTROL) !== 0
  const shift = (modifiers & CDP_SHIFT) !== 0
  if (keysym === 0xff63) return shift && !control ? 'paste' : null
  if (!control) return null
  // The keysym already carries the case, so Shift+C arrives as 'C'; match both.
  const lower = keysym >= 0x41 && keysym <= 0x5a ? keysym + 0x20 : keysym
  switch (lower) {
    case 0x61: // a
      return shift ? null : 'selectAll'
    case 0x63: // c
      return 'copy'
    case 0x78: // x
      return shift ? null : 'cut'
    case 0x76: // v
      return 'paste'
    case 0x7a: // z
      return shift ? 'redo' : 'undo'
    case 0x79: // y
      return shift ? null : 'redo'
    default:
      return null
  }
}
