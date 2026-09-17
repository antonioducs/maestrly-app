import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

/** How close to the end (in px) still counts as "reading the latest". */
export const STICK_THRESHOLD_PX = 48

/**
 * Keeps a scrolling list pinned to its end while the person is already there, and leaves it
 * alone the moment they scroll up to read something. `key` changes whenever content that may
 * grow the list changed (new message, new delta); the first layout scrolls to the end.
 */
export function useStickToBottom<T extends HTMLElement>(key: unknown, initialTop?: number): { ref: RefObject<T | null>; onScroll: () => void; stuck: RefObject<boolean> } {
  const ref = useRef<T>(null)
  const stuck = useRef(true)
  const mounted = useRef(false)
  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!mounted.current) {
      mounted.current = true
      // A saved position (coming back to a conversation) wins over the end on the first paint.
      if (initialTop != null && initialTop > 0) {
        el.scrollTop = initialTop
        onScroll()
        return
      }
    }
    if (stuck.current) el.scrollTop = el.scrollHeight
  }, [key, initialTop, onScroll])
  return { ref, onScroll, stuck }
}
