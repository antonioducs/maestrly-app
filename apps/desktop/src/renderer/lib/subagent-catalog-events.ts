const SUBAGENT_PROFILES_CHANGED = 'maestrly:subagent-profiles-changed'

export function notifySubagentProfilesChanged(): void {
  window.dispatchEvent(new Event(SUBAGENT_PROFILES_CHANGED))
}

export function subscribeSubagentProfilesChanged(listener: () => void): () => void {
  window.addEventListener(SUBAGENT_PROFILES_CHANGED, listener)
  return () => window.removeEventListener(SUBAGENT_PROFILES_CHANGED, listener)
}
