/**
 * How a permission request shows what it would run. The person decides on this text, so it must be the exact
 * command: titles summarize a multi-line subject instead of cutting it at its first line.
 */

/** Lines in a command, ignoring the line break that ends the last one. */
export function previewLineCount(text: string): number {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').length
}

const TITLE_SUBJECT_MAX = 160

/**
 * `Run command: ls` for one line, `Run command (3 lines)` for several. A long line is shortened with an ellipsis:
 * the title is a summary, the full text is shown with the request.
 */
export function permissionSubjectTitle(label: string, subject: string): string {
  const lines = previewLineCount(subject)
  if (lines > 1) return `${label} (${lines} lines)`
  const line = subject.trim()
  return `${label}: ${line.length > TITLE_SUBJECT_MAX ? `${line.slice(0, TITLE_SUBJECT_MAX - 1)}…` : line}`
}

/** Resources not already visible in the preview (a command's own segments are), so nothing is shown twice. */
export function permissionExtraResources(request: { preview?: string; resources: string[] }): string[] {
  const preview = request.preview
  if (!preview) return request.resources
  return request.resources.filter((resource) => !preview.includes(resource))
}
