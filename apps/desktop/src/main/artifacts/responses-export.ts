/** The responses of an artifact as a file the owner saves: CSV for spreadsheets, JSON as they were sent. */
import type { ArtifactResponseView } from '../../shared/artifacts'

const MAX_STEM_CHARS = 60
/** Spreadsheets read the byte order mark as UTF-8, so accented names stay intact. */
const BOM = '\uFEFF'
const FIXED_COLUMNS = ['name', 'kind', 'verified', 'version', 'sent_at', 'updated_at']
/** What makes a spreadsheet run a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/

/** A file name from an artifact's title: lowercase letters and digits separated by dashes. */
export function fileStem(title: string): string {
  const stem = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_STEM_CHARS)
    .replace(/-+$/, '')
  return stem || 'artifact'
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function cell(value: unknown): string {
  const text = cellText(value)
  const safe = FORMULA_START.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

/**
 * One row per response, with fixed columns first and then every top-level field of the data, in the order first seen.
 * Visitors write the data, so a cell a spreadsheet would run as a formula is prefixed with an apostrophe.
 */
export function responsesToCsv(responses: readonly ArtifactResponseView[]): string {
  // A Map keeps the order fields were first seen and takes any name as a plain key.
  const fields = new Map<string, true>()
  for (const response of responses) for (const key of Object.keys(response.data)) fields.set(key, true)
  const keys = [...fields.keys()]
  const rows = [[...FIXED_COLUMNS, ...keys].map(cell).join(',')]
  for (const response of responses) {
    const data = new Map(Object.entries(response.data))
    rows.push(
      [
        response.author.name,
        response.author.kind,
        response.author.verified,
        response.version,
        new Date(response.createdAt).toISOString(),
        new Date(response.updatedAt).toISOString(),
        ...keys.map((key) => data.get(key)),
      ]
        .map(cell)
        .join(',')
    )
  }
  return `${BOM}${rows.join('\r\n')}\r\n`
}

export function responsesToJson(
  artifact: { id: string; title: string },
  responses: readonly ArtifactResponseView[],
  now: number
): string {
  return JSON.stringify({ artifact, exportedAt: new Date(now).toISOString(), responses }, null, 2)
}
