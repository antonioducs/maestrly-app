/** How the app shows the responses people sent from an artifact page. No React, so it is tested directly. */
import type { ArtifactResponseView } from '../../../shared/artifacts'
// A relative import: unit tests compile this file without the renderer's path aliases.
import type { TFn } from '../settings/shared'

const MAX_PREVIEW_CHARS = 120

const oneLine = (value: unknown): string =>
  (typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))).replace(/\s+/g, ' ')

/** The first fields of a response, one line each, for the list; `more` counts the fields left out. */
export function responsePreview(
  data: Record<string, unknown>,
  limit = 3
): { fields: { key: string; value: string }[]; more: number } {
  const entries = Object.entries(data)
  const fields = entries.slice(0, limit).map(([key, value]) => {
    const text = oneLine(value)
    return { key, value: text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS - 1)}…` : text }
  })
  return { fields, more: Math.max(0, entries.length - limit) }
}

/** Who sent a response: you, a person by name, or a guest whose name nobody confirmed. */
export function responseAuthor(t: TFn, author: ArtifactResponseView['author']): string {
  if (author.kind === 'owner') return t('artifacts.comments.you')
  if (author.kind === 'guest') return t('artifacts.comments.unverified', { name: author.name })
  return author.name
}
