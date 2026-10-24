/** The keys a phone sends a bot's screen beside text, as X keysyms. */
export const SCREEN_KEYS = {
  Return: 0xff0d,
  Tab: 0xff09,
  Escape: 0xff1b,
  BackSpace: 0xff08,
} as const
export type ScreenKey = keyof typeof SCREEN_KEYS

/** X11's keysyms for Unicode characters past Latin-1: the code point plus this base. */
const UNICODE_KEYSYM_BASE = 0x0100_0000

/**
 * The keysym that types one character on a bot's screen, or null for a control character it cannot type. Latin-1
 * characters are their own keysyms; others take X11's Unicode keysyms, which the screen binds to a free key. A keysym
 * carries its case: the screen holds Shift around it as needed.
 */
export function keysymOf(codePoint: number): number | null {
  if (codePoint === 0x0a || codePoint === 0x0d) return SCREEN_KEYS.Return
  if (codePoint === 0x09) return SCREEN_KEYS.Tab
  if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)) return codePoint
  if (codePoint < 0x100 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null
  return UNICODE_KEYSYM_BASE + codePoint
}

/** The keysyms that type `text`, one per character it can type; a CR LF pair is one Return. */
export function textKeysyms(text: string): number[] {
  const keysyms: number[] = []
  for (const character of text.replace(/\r\n/g, '\n')) {
    const keysym = keysymOf(character.codePointAt(0) ?? 0)
    if (keysym !== null) keysyms.push(keysym)
  }
  return keysyms
}
