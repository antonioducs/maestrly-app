import { useEffect, useRef, useState, type RefObject } from 'react'

/** Open/close state for a small anchored panel that closes on outside click or Escape. */
export function usePopover<T extends HTMLElement = HTMLDivElement>(): { open: boolean; setOpen: (next: boolean | ((o: boolean) => boolean)) => void; ref: RefObject<T | null> } {
  const [open, setOpen] = useState(false)
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-select-content]')) return
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, ref }
}

export const PANEL_CLASS = 'absolute bottom-full left-0 z-50 mb-1 overflow-hidden rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl'
