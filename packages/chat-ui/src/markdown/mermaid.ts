let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null
let mermaidSeq = 0

export function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', fontFamily: 'inherit' })
      return m.default
    })
  }
  return mermaidPromise
}

export async function renderMermaid(code: string): Promise<string> {
  const mermaid = await getMermaid()
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute; left:-9999px; top:-9999px; visibility:hidden; pointer-events:none;'
  document.body.appendChild(host)
  try {
    const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, code, host)
    return `<div class="mermaid-preview">${svg}</div>`
  } finally {
    host.remove()
  }
}

/** The failure text is injected so the message reads in the person's language, never in the library's. */
export function mermaidError(e: unknown, label = 'Invalid Mermaid'): string {
  const msg = String((e as Error)?.message ?? e).replace(/</g, '&lt;')
  return `<pre class="mermaid-error">⚠️ ${label.replace(/</g, '&lt;')}:\n${msg}</pre>`
}
