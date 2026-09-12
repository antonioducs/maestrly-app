import { useRef, useState } from 'react'

export function useReorder(onCommit: (from: number, to: number) => void) {
  const fromRef = useRef<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const props = (index: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      fromRef.current = index
      e.dataTransfer.effectAllowed = 'move'
      try {
        e.dataTransfer.setData('text/plain', String(index)) // Some browsers require drag data to start.
      } catch {
        /* no-op */
      }
    },
    onDragOver: (e: React.DragEvent) => {
      if (fromRef.current === null) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setOverIndex((p) => (p === index ? p : index))
    },
    onDrop: (e: React.DragEvent) => {
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
