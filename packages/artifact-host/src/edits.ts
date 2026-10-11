import { isTextPath } from './bundle-paths.js'
import { ArtifactHostError } from './errors.js'

export interface TextEdit {
  path: string
  oldText: string
  newText: string
}

// `ignoreBOM` keeps a byte order mark in the text, so an edit never drops it silently.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/**
 * Applies exact, single-occurrence text replacements in order and returns a new bundle. Any failing edit aborts the
 * whole change; `details.index` is the 1-based position of that edit.
 */
export function applyEdits(files: Map<string, Uint8Array>, edits: readonly TextEdit[]): Map<string, Uint8Array> {
  const next = new Map(files)
  edits.forEach((edit, position) => {
    const details = { index: position + 1, path: edit.path }
    const bytes = next.get(edit.path)
    if (!bytes)
      throw new ArtifactHostError(
        'edit_not_found',
        `Edit ${details.index}: ${edit.path} is not in the version`,
        details
      )
    if (!isTextPath(edit.path))
      throw new ArtifactHostError('edit_binary', `Edit ${details.index}: ${edit.path} is not a text file`, details)
    let text: string
    try {
      text = decoder.decode(bytes)
    } catch {
      throw new ArtifactHostError('edit_binary', `Edit ${details.index}: ${edit.path} is not valid UTF-8`, details)
    }
    const first = text.indexOf(edit.oldText)
    if (first < 0)
      throw new ArtifactHostError(
        'edit_not_found',
        `Edit ${details.index}: oldText was not found in ${edit.path}`,
        details
      )
    if (text.indexOf(edit.oldText, first + 1) >= 0)
      throw new ArtifactHostError(
        'edit_ambiguous',
        `Edit ${details.index}: oldText appears more than once in ${edit.path}`,
        details
      )
    next.set(edit.path, encoder.encode(text.slice(0, first) + edit.newText + text.slice(first + edit.oldText.length)))
  })
  return next
}
