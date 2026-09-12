import { useRef, useState, type DragEvent, type PointerEvent } from 'react'

export interface ReorderOpts {
  noDragSelector?: string
}

export function useReorder(onCommit: (from: number, to: number) => void, opts?: ReorderOpts) {
  const fromRef = useRef<number | null>(null)
  const suppressRef = useRef(false)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const props = (index: number) => ({
    draggable: true,
    onPointerDown: opts?.noDragSelector
      ? (e: PointerEvent) => {
          const t = e.target as HTMLElement | null
          suppressRef.current = !!t?.closest?.(opts.noDragSelector!)
        }
      : undefined,
    onDragStart: (e: DragEvent) => {
      if (suppressRef.current) {
        suppressRef.current = false
        e.preventDefault()
        return
      }
      fromRef.current = index
      e.dataTransfer.effectAllowed = 'move'
      try {
        e.dataTransfer.setData('text/plain', String(index)) // Some browsers require drag data to start.
      } catch {
        /* no-op */
      }
    },
    onDragOver: (e: DragEvent) => {
      if (fromRef.current === null) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setOverIndex((p) => (p === index ? p : index))
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      const from = fromRef.current
      fromRef.current = null
      setOverIndex(null)
      if (from !== null && from !== index) onCommit(from, index)
    },
    onDragEnd: () => {
      fromRef.current = null
      setOverIndex(null)
    },
  })
  return { props, overIndex }
}
