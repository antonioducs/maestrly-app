import {
  GENUI_WIDGET_BASE_CSS,
  GENUI_WIDGET_META_CSP,
  GENUI_WIDGET_THEME_KEYS,
  interfaceBridgeScript,
  type GenUiThemeKey,
  type InterfaceTransport,
} from '@maestrly/bot-fleet-protocol'
import type { Palette } from '../../theme/tokens'

/** A theme value that cannot end its declaration or the style element, as the desktop frame accepts. */
const SAFE_VALUE = /^[^;{}<>\\]{1,200}$/

/** The app's colors and type as the block's `var(--ui-*)` variables. */
export function interfaceTheme(palette: Palette): Record<GenUiThemeKey, string> {
  return {
    text: palette.ink,
    muted: palette.muted,
    card: palette.surface,
    border: palette.line,
    accent: palette.brass,
    'accent-text': palette.raised,
    success: palette.moss,
    warning: palette.brass,
    danger: palette.brick,
    font: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    mono: 'ui-monospace,SFMono-Regular,Menlo,monospace',
    radius: '12px',
  }
}

/**
 * The page a phone writes an interactive answer into: the desktop frame's policy (in a meta element, without the
 * `sandbox` only a header can carry), styles and bridge, then the block. The web view that shows it gives it its own
 * process and an opaque origin; the policy keeps it off the network.
 */
export function interfaceDocument(
  html: string,
  theme: Partial<Record<GenUiThemeKey, string>>,
  transport: InterfaceTransport,
  colorScheme: 'light' | 'dark'
): string {
  let vars = ''
  for (const key of GENUI_WIDGET_THEME_KEYS) {
    const value = theme[key]
    if (typeof value === 'string' && SAFE_VALUE.test(value)) vars += `--ui-${key}:${value};`
  }
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${GENUI_WIDGET_META_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">',
    `<style>${GENUI_WIDGET_BASE_CSS}${vars ? `:root{${vars}}` : ''}:root{color-scheme:${colorScheme}}</style>`,
    // The bridge is code of ours: `</script` cannot appear in it, which the shared tests hold it to.
    `<script>${interfaceBridgeScript(transport)}</script>`,
    `</head><body>${html}</body></html>`,
  ].join('')
}
