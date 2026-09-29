// Injected into every HTML file of an artifact, before the page's own scripts. A classic script with no imports:
// it only reports load state and errors to the viewer shell, which treats every message as untrusted.
;(() => {
  const post = (message: Record<string, unknown>) =>
    window.parent.postMessage({ source: 'maestrly-bridge', ...message }, '*')
  window.addEventListener('error', (event) => post({ type: 'error', message: String(event.message).slice(0, 300) }))
  window.addEventListener('unhandledrejection', (event) =>
    post({ type: 'error', message: String((event.reason as Error)?.message ?? event.reason).slice(0, 300) })
  )
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => post({ type: 'ready' }))
  else post({ type: 'ready' })
})()
