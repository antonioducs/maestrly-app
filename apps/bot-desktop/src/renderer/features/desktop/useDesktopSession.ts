import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopInput, DesktopState } from '@maestrly/host-protocol'
import type { DesktopPhase } from '../../../shared/types'

export type DesktopSocket = { handle: string; url: string; protocols: string[] }
export type DesktopSessionState = {
  socket?: DesktopSocket
  state?: DesktopState
  phase: DesktopPhase | 'idle' | 'error'
  controlling: boolean
  reason?: string
  error?: string
}
const codeOf = (error: unknown) => /\[([A-Z_]{1,64})\]/.exec(String(error))?.[1] ?? /\b([A-Z][A-Z_]{3,63})\b/.exec(String(error))?.[1]
/**
 * One viewer per open panel. It never survives a bot or Host change: switching bots
 * closes the view and clears the frame, so one bot's pixels never appear under another.
 */
export function useDesktopSession(botId: string, open: boolean) {
  const [value, setValue] = useState<DesktopSessionState>({ phase: 'idle', controlling: false })
  const handle = useRef<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!open) return
    let disposed = false
    setValue({ phase: 'connecting', controlling: false })
    const unsubscribe = window.bot.desktop.onEvent((event) => {
      if (disposed || event.handle !== handle.current) return
      if (event.phase === 'closed') {
        handle.current = undefined
        setValue((current) => ({ ...current, socket: undefined, phase: 'reconnecting', controlling: false, reason: event.reason }))
        // A lost view reconnects with fresh authorization; nothing old is replayed.
        if (event.reason !== 'CLOSED') setTimeout(() => !disposed && setAttempt((n) => n + 1), 1500)
        return
      }
      setValue((current) => ({ ...current, ...(event.state ? { state: event.state } : {}), phase: event.phase, controlling: event.controlling, reason: event.reason }))
    })
    void window.bot.desktop.open(botId).then(
      (opened) => {
        if (disposed) return void window.bot.desktop.close(opened.handle).catch(() => {})
        handle.current = opened.handle
        setValue({ socket: { handle: opened.handle, url: opened.url, protocols: opened.protocols }, state: opened.state, phase: 'connecting', controlling: false })
      },
      (error) => {
        if (!disposed) setValue({ phase: 'error', controlling: false, error: codeOf(error) ?? 'DESKTOP_UNAVAILABLE' })
      }
    )
    return () => {
      disposed = true
      unsubscribe()
      const current = handle.current
      handle.current = undefined
      if (current) void window.bot.desktop.close(current).catch(() => {})
    }
  }, [botId, open, attempt])
  const acquire = useCallback(async () => {
    const current = handle.current
    if (!current) return
    setValue((state) => ({ ...state, phase: 'acquiring', error: undefined }))
    try {
      const result = await window.bot.desktop.acquire(current)
      setValue((state) => ({ ...state, state: result.state, controlling: result.controlling, phase: result.phase }))
    } catch (error) {
      setValue((state) => ({ ...state, phase: state.socket ? 'viewing' : 'connecting', error: codeOf(error) ?? 'HANDOFF_UNCERTAIN' }))
    }
  }, [])
  const returnControl = useCallback(async (continueTask: boolean) => {
    setValue((state) => ({ ...state, controlling: false, phase: 'returning', error: undefined }))
    try {
      const result = await window.bot.desktop.returnControl({ botId, ...(handle.current ? { handle: handle.current } : {}), continueTask })
      setValue((state) => ({ ...state, state: result.state, phase: state.socket ? 'viewing' : 'connecting', ...(result.failureCode ? { error: result.failureCode } : {}) }))
      return result
    } catch (error) {
      setValue((state) => ({ ...state, phase: state.socket ? 'viewing' : 'connecting', error: codeOf(error) ?? 'HANDOFF_UNCERTAIN' }))
      return undefined
    }
  }, [botId])
  const input = useCallback((events: DesktopInput[]) => {
    const current = handle.current
    if (!current || !events.length) return
    void window.bot.desktop.input(current, events).catch((error) => {
      setValue((state) => ({ ...state, error: codeOf(error) }))
    })
  }, [])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { ...value, acquire, returnControl, input, retry }
}
