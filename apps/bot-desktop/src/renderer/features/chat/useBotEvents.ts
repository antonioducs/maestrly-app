import { useEffect, useRef, useState } from 'react'
import { mergeBotEvents, type BotEventState } from './events'
export function useBotEvents(
  botId: string,
  connected: boolean,
  refresh: () => Promise<void>,
  onError: (error: unknown) => void
) {
  const [state, setState] = useState<BotEventState>({ events: [], cursor: 0 })
  const callbacks = useRef({ refresh, onError })
  callbacks.current = { refresh, onError }
  useEffect(() => {
    if (!connected) return
    let disposed = false
    let current: BotEventState = { events: [], cursor: 0 }
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const page = await window.bot.bot({
          method: 'bot.events.list',
          params: { botId, after: current.cursor, limit: 100 },
        })
        if (disposed) return
        current = mergeBotEvents(current, page)
        setState(current)
        if (
          page.events.some((event) =>
            [
              'assistant.message',
              'turn.status',
              'file.produced',
              'approval.requested',
              'question.asked',
              'approval.resolved',
              'question.answered',
            ].includes(event.kind)
          )
        ) {
          await callbacks.current.refresh()
        }
        if (!disposed) timer = setTimeout(poll, page.hasMore ? 0 : 1500)
      } catch (error) {
        if (!disposed) {
          callbacks.current.onError(error)
          timer = setTimeout(poll, 1500)
        }
      }
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [botId, connected])
  return state.events
}
