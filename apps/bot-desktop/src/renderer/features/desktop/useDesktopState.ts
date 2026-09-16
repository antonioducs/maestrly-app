import { useEffect, useState } from 'react'
import type { DesktopState } from '@maestrly/host-protocol'

/** Control state for the conversation (pause banner, composer); no view is opened. */
export function useDesktopState(botId: string, connected: boolean, refreshKey: unknown) {
  const [state, setState] = useState<DesktopState>()
  useEffect(() => {
    if (!connected) return
    let alive = true
    const load = () =>
      window.bot.desktop.inspect(botId).then(
        (value) => alive && setState(value),
        () => alive && setState(undefined)
      )
    void load()
    const timer = setInterval(() => void load(), 4000)
    const unsubscribe = window.bot.desktop.onEvent((event) => {
      if (alive && event.botId === botId && event.state) setState(event.state)
    })
    return () => {
      alive = false
      clearInterval(timer)
      unsubscribe()
    }
  }, [botId, connected, refreshKey])
  return [state, setState] as const
}
