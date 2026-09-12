import type { ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'

export function Sortable({
  id,
  disabled,
  children,
}: {
  id: string
  disabled?: boolean
  children: (s: ReturnType<typeof useSortable>) => ReactNode
}) {
  const sortable = useSortable({ id, disabled })
  return <>{children(sortable)}</>
}
