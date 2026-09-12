import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'

export function Droppable({
  id,
  children,
}: {
  id: string
  children: (d: ReturnType<typeof useDroppable>) => ReactNode
}) {
  const droppable = useDroppable({ id })
  return <>{children(droppable)}</>
}
