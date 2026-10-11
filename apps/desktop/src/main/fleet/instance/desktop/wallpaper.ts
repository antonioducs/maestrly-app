/**
 * The wallpaper of a bot's apps display: the soft gradient and doodles of the approved prototype, in the bot's tint,
 * with a rounded square holding the bot's initial and its name below. The dock (tint2) sits over the bottom of it.
 * Plain text in, plain text out: the display manager renders it with `rsvg-convert` and `hsetroot`.
 */

/** The color of a bot without a valid tint, and of its square. */
export const DEFAULT_WALLPAPER_TINT = '#6b6b78'

const WIDTH = 1280
const HEIGHT = 800
/** The room the dock needs at the bottom; the bot's square and name are centered above it. */
const DOCK_ROOM = 90
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
// XML 1.0 holds neither most control characters, the two non-characters at the end of the BMP, nor lone surrogates.
const NOT_XML =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

function channels(color: string): [number, number, number] {
  if (!HEX_COLOR.test(color)) throw new TypeError(`Not a #rrggbb color: ${JSON.stringify(color)}`)
  return [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16)) as [number, number, number]
}

/** The color `t` of the way from `a` to `b` (both `#rrggbb`), as `#rrggbb`. A share outside 0 to 1 is held to it. */
export function mixHex(a: string, b: string, t: number): string {
  const from = channels(a)
  const to = channels(b)
  const share = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  return `#${from
    .map((value, index) =>
      Math.round(value + (to[index] - value) * share)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

const escapeXml = (text: string): string => text.replace(/[&<>"']/g, (character) => XML_ESCAPES[character])

/** The text as one clean line: no characters XML cannot hold, runs of whitespace as one space, no edge spaces. */
function cleanName(name: string): string {
  return name.replace(NOT_XML, '').replace(/\s+/g, ' ').trim()
}

/** The first user-perceived character, in capitals (`ß` becomes `S`, an emoji sequence stays whole). */
function initialOf(name: string): string {
  if (!name) return '?'
  const [first] = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name.toUpperCase())
  return first?.segment ?? '?'
}

/** The name fits the screen at any length the fleet allows (40 letters): the longer, the smaller, down to 18. */
const nameSize = (name: string): number =>
  Math.min(30, Math.max(18, Math.floor(1000 / Math.max(1, Array.from(name).length))))

// The doodles of the prototype's wallpaper, one 190 pixel tile.
const DOODLES = `<circle cx="30" cy="36" r="7"/><path d="M124 22v14M117 29h14"/><path d="M66 96c6-8 16-8 22 0"/><path d="M156 118l4 9 9 4-9 4-4 9-4-9-9-4 9-4z"/><rect x="30" y="138" width="14" height="14" rx="4"/><path d="M104 160c5 0 8-3 8-8"/>`

/**
 * The wallpaper as an SVG of 1280 by 800 pixels. `tint` is a `#rrggbb` color; anything else, or none, uses
 * {@link DEFAULT_WALLPAPER_TINT}. The name is escaped for XML.
 */
export function wallpaperSvg(bot: { name: string; tint?: string | null }): string {
  const tint = bot.tint && HEX_COLOR.test(bot.tint) ? bot.tint.toLowerCase() : DEFAULT_WALLPAPER_TINT
  const name = cleanName(bot.name)
  const initial = initialOf(name)
  // The prototype's layers: a diagonal gradient from a pale corner to a deeper one, a highlight near the top left
  // and a glow in the bottom right corner. The first stop is the color of the top left corner.
  const light = mixHex('#e2e3ee', tint, 0.2)
  const deep = mixHex('#9ea3bd', tint, 0.42)
  const highlight = mixHex('#f6f5fb', tint, 0.14)
  const glow = mixHex('#5c6080', tint, 0.58)
  const squareSize = 120
  const squareX = (WIDTH - squareSize) / 2
  const squareY = Math.round((HEIGHT - DOCK_ROOM - squareSize - 52) / 2)
  const centerX = WIDTH / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<defs>
<linearGradient id="sky" gradientUnits="userSpaceOnUse" x1="411.3" y1="-166.1" x2="868.7" y2="966.1">
<stop offset="0" stop-color="${light}"/>
<stop offset="1" stop-color="${deep}"/>
</linearGradient>
<radialGradient id="highlight" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(333 144) scale(704 520)">
<stop offset="0" stop-color="${highlight}"/>
<stop offset="0.72" stop-color="${highlight}" stop-opacity="0"/>
</radialGradient>
<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(1126 800) scale(768 600)">
<stop offset="0" stop-color="${glow}"/>
<stop offset="0.7" stop-color="${glow}" stop-opacity="0"/>
</radialGradient>
<pattern id="doodles" width="190" height="190" patternUnits="userSpaceOnUse">
<g fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${DOODLES}</g>
</pattern>
<filter id="shadow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="20"/></filter>
</defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)"/>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#highlight)"/>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#doodles)" opacity="0.55"/>
<rect x="${squareX}" y="${squareY + 18}" width="${squareSize}" height="${squareSize}" rx="34" fill="#1e143c" opacity="0.28" filter="url(#shadow)"/>
<rect x="${squareX}" y="${squareY}" width="${squareSize}" height="${squareSize}" rx="34" fill="${tint}"/>
<text x="${centerX}" y="${squareY + 80}" text-anchor="middle" font-family="'DejaVu Sans', 'Noto Sans', sans-serif" font-size="60" font-weight="700" fill="#ffffff">${escapeXml(initial)}</text>
<text x="${centerX}" y="${squareY + squareSize + 52}" text-anchor="middle" font-family="'DejaVu Sans', 'Noto Sans', sans-serif" font-size="${nameSize(name)}" font-weight="500" fill="#1c1a26" fill-opacity="0.86">${escapeXml(name)}</text>
</svg>
`
}
