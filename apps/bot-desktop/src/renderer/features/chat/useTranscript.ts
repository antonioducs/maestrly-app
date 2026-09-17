import { useCallback, useEffect, useRef, useState } from 'react'
import { applyTranscriptEvent, foldTranscript, type BotEvent, type BotTurn, type TranscriptMessage } from '@maestrly/host-protocol'

export interface TranscriptState {
  messages: TranscriptMessage[]
  turns: BotTurn[]
  hasMore: boolean
  /** Highest event sequence already folded into `messages`. */
  cursor: number
}
export const emptyTranscript = (): TranscriptState => ({ messages: [], turns: [], hasMore: false, cursor: 0 })

/**
 * The transcript of one bot: a page from the Host plus every live event applied with the very
 * projection the Host used for the page. On a Host that predates transcripts it falls back to
 * the message list and folds locally from the events it can see, so nothing is silently blank.
 */
export function useTranscript(botId: string, connected: boolean, supported: boolean, events: BotEvent[]) {
  const [state, setState] = useState<TranscriptState>(emptyTranscript)
  const alive = useRef(true)
  const loading = useRef<Promise<void> | null>(null)

  const load = useCallback(
    async (earlier = false) => {
      const before = earlier && state.messages.length ? Math.min(...state.messages.map((m) => m.sequence)) : undefined
      let page: TranscriptState
      if (supported) {
        const result = await window.bot.bot({ method: 'bot.transcript.list', params: { botId, ...(before ? { before } : {}) } })
        page = { messages: result.messages, turns: result.turns, hasMore: result.hasMore, cursor: result.cursor }
      } else {
        const result = await window.bot.bot({ method: 'bot.messages.list', params: { botId, ...(before ? { before } : {}) } })
        const turnIds = new Set(result.turns.map((turn) => turn.id))
        const own = events.filter((event) => event.turnId && turnIds.has(event.turnId))
        page = { messages: foldTranscript({ messages: result.messages, turns: result.turns, events: own }), turns: result.turns, hasMore: result.hasMore, cursor: Math.max(0, ...own.map((e) => e.seq)) }
      }
      if (!alive.current) return
      setState((current) => {
        if (!earlier) return page
        const known = new Set(page.messages.map((m) => m.id))
        return { ...page, messages: [...page.messages, ...current.messages.filter((m) => !known.has(m.id))], cursor: Math.max(current.cursor, page.cursor) }
      })
    },
    [botId, supported, events, state.messages]
  )
  const reload = useCallback(() => {
    // One reload at a time: a burst of events must not race several pages into the state.
    if (!loading.current) loading.current = load().finally(() => (loading.current = null))
    return loading.current
  }, [load])

  useEffect(() => {
    alive.current = true
    setState(emptyTranscript())
    return () => {
      alive.current = false
    }
  }, [botId])
  useEffect(() => {
    if (connected) void reload().catch(() => {})
    // Only the bot and the connection decide when the page is fetched again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, connected, supported])

  // Live events after the cursor extend the page with the same fold the Host applies.
  useEffect(() => {
    if (!events.length) return
    // Decide what is new against the committed cursor, never against a render's snapshot: two
    // event pages can land before a re-render, and applying one of them twice would duplicate parts.
    setState((current) => {
      const fresh = events.filter((event) => event.seq > current.cursor && event.turnId)
      if (!fresh.length) return current
      let messages = current.messages
      for (const event of fresh) messages = applyTranscriptEvent(messages, event, current.turns.find((turn) => turn.id === event.turnId))
      return { ...current, messages, cursor: Math.max(current.cursor, ...fresh.map((e) => e.seq)) }
    })
  }, [events])

  return { ...state, reload, loadEarlier: () => load(true) }
}
