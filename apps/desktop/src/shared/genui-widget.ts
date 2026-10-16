// Inline HTML in chat answers (```inline-html blocks). The renderer frames each block from this scheme; the main
// process serves the frame's page (genui-widget-frame.ts). The frame has its own opaque origin and policy, so the
// model's HTML never runs in the app's page.

import { GENUI_WIDGET_MAX_CHARS } from '@maestrly/bot-fleet-protocol'
import type { MessagePart } from './chat'

export const GENUI_WIDGET_SCHEME = 'maestrly-widget'
export const GENUI_WIDGET_FRAME_URL = `${GENUI_WIDGET_SCHEME}://frame/`

/** Language of the fence whose content renders as inline HTML. */
export const GENUI_WIDGET_FENCE = 'inline-html'

// Limits, theme keys and the messages a frame may send are shared with the mobile app's web view.
export {
  GENUI_WIDGET_ISSUE_KINDS,
  GENUI_WIDGET_MAX_CHARS,
  GENUI_WIDGET_MAX_HEIGHT,
  GENUI_WIDGET_MAX_SEND_CHARS,
  GENUI_WIDGET_THEME_KEYS,
  parseGenUiWidgetMessage,
  safeWebUrl,
  type GenUiWidgetIssueKind,
  type GenUiWidgetMessage,
  type GenUiWidgetTheme,
} from '@maestrly/bot-fleet-protocol'

export function isGenUiWidgetUrl(url: string): boolean {
  return url.startsWith(`${GENUI_WIDGET_SCHEME}:`)
}

/** FNV-1a of a block: tells blocks apart, and names a preview, without storing them. */
export function genUiWidgetHash(html: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < html.length; i++) {
    hash ^= html.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/**
 * The app tool that renders a block offscreen and returns a screenshot to the model. The model then shows a preview
 * with an empty block that names it, ```inline-html preview=<id>, instead of writing the HTML again.
 */
export const GENUI_PREVIEW_TOOL = 'preview_interface'

export const isGenUiPreviewTool = (toolName: string): boolean =>
  toolName === GENUI_PREVIEW_TOOL || toolName.endsWith(`__${GENUI_PREVIEW_TOOL}`)

/** The HTML of every preview a message rendered, by preview id. */
export function genUiPreviewsOf(parts: readonly MessagePart[]): Map<string, string> {
  const previews = new Map<string, string>()
  for (const part of parts) {
    if (part.type !== 'tool' || part.state.status !== 'completed' || !isGenUiPreviewTool(part.toolName)) continue
    const html = (part.input as { html?: unknown } | null)?.html
    if (typeof html === 'string' && html.length <= GENUI_WIDGET_MAX_CHARS) previews.set(genUiWidgetHash(html), html)
  }
  return previews
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const PREVIEW_INFO = new RegExp(`^\\s*${GENUI_WIDGET_FENCE}\\s+preview=([0-9a-z]+)\\s*$`)

/**
 * Replaces each closed ```inline-html preview=<id> block naming a preview of `previews` with that preview's HTML.
 * Fences inside other code blocks stay as written, and so does a reference to an unknown preview, or one whose
 * closing fence has not arrived yet.
 */
export function expandGenUiPreviews(text: string, previews: ReadonlyMap<string, string>): string {
  if (previews.size === 0 || !text.includes('preview=')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let open: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE_LINE.exec(lines[i])
    if (open) {
      out.push(lines[i])
      if (fence && fence[1][0] === open[0] && fence[1].length >= open.length && !fence[2].trim()) open = null
      continue
    }
    if (!fence) {
      out.push(lines[i])
      continue
    }
    const html = previews.get(PREVIEW_INFO.exec(fence[2])?.[1] ?? '')
    let end = i + 1
    while (end < lines.length && !lines[end].trim()) end++
    const close = end < lines.length ? FENCE_LINE.exec(lines[end]) : null
    if (
      html !== undefined &&
      close &&
      close[1][0] === fence[1][0] &&
      close[1].length >= fence[1].length &&
      !close[2].trim()
    ) {
      // Longer than any run of backticks in the HTML, so no line of it can close the block.
      const longest = Math.max(2, ...(html.match(/`+/g) ?? []).map((run) => run.length))
      const marker = '`'.repeat(longest + 1)
      out.push(`${marker}${GENUI_WIDGET_FENCE}`, html, marker)
      i = end
      continue
    }
    open = fence[1]
    out.push(lines[i])
  }
  return out.join('\n')
}
