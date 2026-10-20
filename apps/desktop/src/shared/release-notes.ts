/**
 * Release notes as readable text. PURE module (no Electron/DOM) so the renderer and its tests share it.
 *
 * electron-updater's GitHub provider hands over a release's body as HTML (`<h2>`, `<ul>`, `<a class=… href=…>`).
 * The notes are remote content shown in a text block, so they are reduced to text here: never rendered as HTML.
 */

// Attributes after the tag name; a quoted value may hold `>`.
const ATTRIBUTES = String.raw`(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?`
const TAG_SOURCE = `</?[A-Za-z][A-Za-z0-9-]*${ATTRIBUTES}/?>`
const TAG = new RegExp(TAG_SOURCE, 'g')
const HAS_TAG = new RegExp(TAG_SOURCE)
const BLOCK_TAG = new RegExp(
  String.raw`(</?(?:ul|ol|li|p|h[1-6]|br|hr|div|tr|blockquote|pre)${ATTRIBUTES}/?>)\s+`,
  'gi'
)
const LIST_ITEM_START = new RegExp(`<li${ATTRIBUTES}>`, 'gi')
const LINE_BREAK = new RegExp(
  String.raw`<br${ATTRIBUTES}/?>|<hr${ATTRIBUTES}/?>|</(?:li|p|h[1-6]|div|tr|blockquote|pre|ul|ol)\s*>`,
  'gi'
)
const HAS_ENTITY = /&(?:#\d|#[xX][0-9a-fA-F]|[A-Za-z])/
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  hellip: '…',
}

function codePointText(code: number): string | null {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null
  return String.fromCodePoint(code)
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, decimal?: string, hex?: string, name?: string) => {
    if (decimal) return codePointText(Number.parseInt(decimal, 10)) ?? whole
    if (hex) return codePointText(Number.parseInt(hex, 16)) ?? whole
    return NAMED_ENTITIES[name ?? ''] ?? whole
  })
}

/**
 * Converts a release body to plain text: `<br>`, `</p>`, `</h1>`…`</h6>` and `</li>` end a line, `<li>` starts a
 * "• " item, every other tag is dropped with its attributes, entities are decoded and runs of spaces and blank
 * lines collapse. Text without markup or entities comes back exactly as it was.
 */
export function releaseNotesToText(notes: string): string {
  if (!HAS_TAG.test(notes) && !HAS_ENTITY.test(notes)) return notes
  const markup = notes
    .replace(/\r\n?/g, '\n')
    // Whitespace after a block tag is source formatting, not content: it must not add blank lines.
    .replace(BLOCK_TAG, '$1')
    .replace(LIST_ITEM_START, '• ')
    .replace(LINE_BREAK, '\n')
    .replace(TAG, '')
  const lines = decodeEntities(markup)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
  const collapsed: string[] = []
  for (const line of lines) {
    if (line === '' && collapsed.at(-1) === '') continue
    collapsed.push(line)
  }
  return collapsed.join('\n').trim()
}
