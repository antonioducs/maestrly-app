// Inline HTML in chat answers (```inline-html blocks). The renderer frames each block from this scheme; the main
// process serves the frame's page (genui-widget-frame.ts). The frame has its own opaque origin and policy, so the
// model's HTML never runs in the app's page.

export const GENUI_WIDGET_SCHEME = 'maestrly-widget'
export const GENUI_WIDGET_FRAME_URL = `${GENUI_WIDGET_SCHEME}://frame/`

/** Language of the fence whose content renders as inline HTML. */
export const GENUI_WIDGET_FENCE = 'inline-html'

/** Longest block the frame renders; a longer one shows its source only. */
export const GENUI_WIDGET_MAX_CHARS = 200_000
export const GENUI_WIDGET_MAX_HEIGHT = 2400
export const GENUI_WIDGET_MAX_SEND_CHARS = 4000

/** Theme variables the frame exposes to the block as `var(--ui-<key>)`. */
export const GENUI_WIDGET_THEME_KEYS = [
  'text',
  'muted',
  'card',
  'border',
  'accent',
  'accent-text',
  'success',
  'warning',
  'danger',
  'font',
  'mono',
  'radius',
] as const

export type GenUiWidgetTheme = Partial<Record<(typeof GENUI_WIDGET_THEME_KEYS)[number], string>>

/**
 * Problems the frame finds in a block: an image that did not load (replaced by a placeholder), content wider than
 * the answer, text cut off by its box, a layout sized by the frame's own height, a script error, or something the
 * frame's policy blocked.
 */
export const GENUI_WIDGET_ISSUE_KINDS = ['image', 'overflow', 'clipped', 'viewport', 'script', 'blocked'] as const
export type GenUiWidgetIssueKind = (typeof GENUI_WIDGET_ISSUE_KINDS)[number]

/** What the frame may ask its host; anything else is ignored. */
export type GenUiWidgetMessage =
  | { type: 'ready' }
  | { type: 'size'; height: number }
  | { type: 'send'; text: string }
  | { type: 'open'; url: string }
  | { type: 'issue'; kind: GenUiWidgetIssueKind; detail: string }

export function isGenUiWidgetUrl(url: string): boolean {
  return url.startsWith(`${GENUI_WIDGET_SCHEME}:`)
}

/** An http(s) URL without credentials, normalized; null for anything else. */
export function safeWebUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

/** A message from a frame, checked field by field: the frame runs model-written code. */
export function parseGenUiWidgetMessage(data: unknown): GenUiWidgetMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const message = data as Record<string, unknown>
  if (message.source !== 'maestrly-widget') return null
  switch (message.type) {
    case 'ready':
      return { type: 'ready' }
    case 'size': {
      const height = message.height
      if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return null
      return { type: 'size', height: Math.min(Math.ceil(height), GENUI_WIDGET_MAX_HEIGHT) }
    }
    case 'send': {
      if (typeof message.text !== 'string') return null
      const text = message.text.trim()
      return text && text.length <= GENUI_WIDGET_MAX_SEND_CHARS ? { type: 'send', text } : null
    }
    case 'open': {
      const url = typeof message.url === 'string' ? safeWebUrl(message.url) : null
      return url ? { type: 'open', url } : null
    }
    case 'issue': {
      const kind = GENUI_WIDGET_ISSUE_KINDS.find((known) => known === message.kind)
      if (!kind || typeof message.detail !== 'string') return null
      return { type: 'issue', kind, detail: message.detail.slice(0, 300) }
    }
    default:
      return null
  }
}
