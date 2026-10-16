import { useCallback, useEffect, useRef, useState } from 'react'

export interface PageOverlayFrame {
  id: number
  /** Frozen frame of the page as a data URL; null when the page was not on screen. */
  src: string | null
}

/**
 * Lets DOM (the address-bar suggestions) appear over the browser's native page, which paints above every DOM
 * z-index. While `wanted`, main captures the page and the chrome paints that frame under the page; `reveal` then
 * moves the page offscreen, so no empty frame flashes in between. Unwanted, unmounted, or switched to another
 * conversation, the page comes back.
 */
export function usePageOverlay(
  convId: string | null,
  wanted: boolean
): { frame: PageOverlayFrame | null; reveal: (id: number) => void } {
  const [frame, setFrame] = useState<PageOverlayFrame | null>(null)
  const seq = useRef(0)
  // Conversation whose page main currently keeps (or is preparing to keep) behind the suggestions.
  const engaged = useRef<string | null>(null)

  useEffect(() => {
    if (!convId) return
    const id = ++seq.current
    if (wanted) {
      engaged.current = convId
      window.api.drawerOmniboxOverlay(convId, 'prepare').then(
        (src) => {
          if (seq.current === id) setFrame({ id, src })
        },
        () => {
          if (seq.current === id) setFrame({ id, src: null })
        }
      )
      return
    }
    if (engaged.current !== convId) {
      setFrame(null)
      return
    }
    engaged.current = null
    // Keep the frozen frame until the page is back on top of it.
    void window.api
      .drawerOmniboxOverlay(convId, 'close')
      .catch(() => null)
      .finally(() => {
        if (seq.current === id) setFrame(null)
      })
  }, [convId, wanted])

  useEffect(
    () => () => {
      const owner = engaged.current
      engaged.current = null
      seq.current++
      if (owner) void window.api.drawerOmniboxOverlay(owner, 'close').catch(() => null)
    },
    [convId]
  )

  const reveal = useCallback(
    (id: number) => {
      if (!convId || seq.current !== id) return
      void window.api.drawerOmniboxOverlay(convId, 'open').catch(() => null)
    },
    [convId]
  )

  // Without a frame there is nothing to paint first.
  useEffect(() => {
    if (frame && !frame.src) reveal(frame.id)
  }, [frame, reveal])

  return { frame, reveal }
}
