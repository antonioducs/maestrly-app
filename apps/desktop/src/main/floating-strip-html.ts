import type { FloatTab } from '../shared/tool-tabs'

export interface FloatingStripHtmlInput {
  chromeHeight: number
  color: string
  convId: string
  conversationName?: string
  pinTitle: string
  pinned: boolean
  projectName?: string
  tab: FloatTab
  tabTitle: string
  title: string
  unpinTitle: string
}

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * HTML without inline JavaScript: production CSP uses script-src 'self', so preload wires the pin
 * button.
 */
export function floatingStripHtml(input: FloatingStripHtmlInput): string {
  const {
    chromeHeight,
    color,
    convId,
    conversationName,
    pinTitle,
    pinned,
    projectName,
    tab,
    tabTitle,
    title,
    unpinTitle,
  } = input
  const proj = projectName ? `<span class="dim">${escHtml(projectName)}</span><span class="dim sep">›</span>` : ''
  const name = conversationName ? `<span class="conv">${escHtml(conversationName)}</span>` : ''
  const currentTitle = pinned ? unpinTitle : pinTitle
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>
  html,body{margin:0;height:100%;overflow:hidden;background:#0A0A0B}
  .strip{box-sizing:border-box;height:${chromeHeight}px;display:flex;align-items:center;gap:8px;padding:0 10px;
    border-bottom:2px solid ${color};font:12px -apple-system,system-ui,'Segoe UI',sans-serif;color:#a1a1aa;
    -webkit-user-select:none;user-select:none;cursor:default}
  .dot{flex:none;width:8px;height:8px;border-radius:50%;background:${color}}
  .id{display:flex;align-items:center;gap:6px;min-width:0;flex:1;white-space:nowrap}
  .id span{overflow:hidden;text-overflow:ellipsis}
  .dim{color:#71717a}
  .sep{flex:none}
  .conv{color:#e4e4e7;font-weight:600}
  #pin{flex:none;display:flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;
    border-radius:6px;background:transparent;color:#71717a;cursor:pointer;padding:0}
  #pin:hover{background:#1f1f23;color:#e4e4e7}
  #pin.on{color:${color}}
  #pin.on svg{fill:currentColor}
  </style></head><body>
  <div class="strip">
    <span class="dot"></span>
    <span class="id">${proj}${name}<span class="dim">${escHtml(tabTitle)}</span></span>
    <button id="pin" class="${pinned ? 'on' : ''}" type="button" title="${escHtml(currentTitle)}"
      data-maestrly-floating-pin data-conv-id="${escHtml(convId)}" data-tab="${escHtml(tab)}"
      data-pinned="${pinned}" data-pin-title="${escHtml(pinTitle)}" data-unpin-title="${escHtml(unpinTitle)}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>
    </button>
  </div></body></html>`
}
