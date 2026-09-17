import { useCallback, useEffect, useState } from 'react'
import type { ExtensionMethod, ExtensionsState } from '@maestrly/host-protocol'

const empty = (botId: string): ExtensionsState => ({ botId, revision: 0, mcpServers: [], skills: [] })
const CHANGED = 'bot-extensions-changed'

/**
 * The extensions of one bot, as the Host reports them. Every change names the revision it was
 * based on; a conflict reloads and reports, it never retries with a guessed revision.
 */
export function useExtensions(botId: string, connected: boolean, supported: boolean) {
  const [state, setState] = useState<ExtensionsState>(() => empty(botId))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const reload = useCallback(async () => {
    if (!connected || !supported) return
    setState(await window.bot.extension({ method: 'extension.inspect', params: { botId } }))
  }, [botId, connected, supported])
  useEffect(() => {
    void reload().catch((failure) => setError(String(failure)))
    // The chat chip and the details tab are two views of the same bot: a change in one reloads the other.
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === botId) void reload().catch(() => undefined)
    }
    window.addEventListener(CHANGED, changed)
    return () => window.removeEventListener(CHANGED, changed)
  }, [reload, botId])
  const change = useCallback(
    async (method: Exclude<ExtensionMethod, 'extension.inspect'>, params: Record<string, unknown>) => {
      setBusy(true)
      setError('')
      try {
        setState(await window.bot.extension({ method, params: { botId, expectedRevision: state.revision, ...params } }))
        window.dispatchEvent(new CustomEvent(CHANGED, { detail: botId }))
        return true
      } catch (failure) {
        setError(String(failure))
        if (/REVISION_CONFLICT/.test(String(failure))) await reload().catch(() => undefined)
        return false
      } finally {
        setBusy(false)
      }
    },
    [botId, state.revision, reload]
  )
  return { state, error, busy, reload, change }
}
