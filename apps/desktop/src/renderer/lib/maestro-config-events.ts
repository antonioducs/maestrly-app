/** Renderer-local invalidation for global or conversation Maestro configuration changes. */
const MAESTRO_CONFIG_CHANGED = 'maestrly:maestro-config-changed'

export function notifyMaestroConfigChanged(): void {
  window.dispatchEvent(new Event(MAESTRO_CONFIG_CHANGED))
}

export function subscribeMaestroConfigChanged(listener: () => void): () => void {
  window.addEventListener(MAESTRO_CONFIG_CHANGED, listener)
  return () => window.removeEventListener(MAESTRO_CONFIG_CHANGED, listener)
}
