// KeyboardEvent → X keysym. Physical `code` identifies the key for release; `key`
// gives the produced character (layouts, dead keys and accents resolve before this).
const NAMED: Record<string, number> = {
  Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
  Home: 0xff50, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  PageUp: 0xff55, PageDown: 0xff56, End: 0xff57, Insert: 0xff63, ContextMenu: 0xff67,
  CapsLock: 0xffe5, NumLock: 0xff7f, ScrollLock: 0xff14, Pause: 0xff13, PrintScreen: 0xff61,
  AltGraph: 0xfe03, ' ': 0x20,
}
const BY_CODE: Record<string, number> = {
  ShiftLeft: 0xffe1, ShiftRight: 0xffe2, ControlLeft: 0xffe3, ControlRight: 0xffe4,
  AltLeft: 0xffe9, AltRight: 0xffea, MetaLeft: 0xffeb, MetaRight: 0xffec, OSLeft: 0xffeb, OSRight: 0xffec,
  NumpadEnter: 0xff8d,
}
export const MODIFIER_CODES = new Set(Object.keys(BY_CODE).filter((code) => code !== 'NumpadEnter'))
export function keysymOf(event: Pick<KeyboardEvent, 'key' | 'code'>): number | undefined {
  if (BY_CODE[event.code] !== undefined) return BY_CODE[event.code]
  if (NAMED[event.key] !== undefined) return NAMED[event.key]
  const function_ = /^F([1-9]|1[0-9]|2[0-4])$/.exec(event.key)
  if (function_) return 0xffbe + Number(function_[1]) - 1
  const characters = [...event.key]
  if (characters.length !== 1) return undefined // Dead, Unidentified, Process…
  const codePoint = characters[0].codePointAt(0)!
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return undefined
  return codePoint <= 0xff ? codePoint : 0x01000000 + codePoint
}
