import type { HTMLAttributes, ReactNode } from 'react'
import type { Conversation } from '../../../preload'
import { useReorder } from '@/lib/use-reorder'
import type { ConvTopNode, SharedConversationGroupInfo } from './conv-top-nodes'

export type DragHandle = HTMLAttributes<HTMLElement> & { draggable?: boolean }

export function WorkspaceConvList({
  workspaceId,
  nodes,
  dndEnabled,
  onReorder,
  renderConv,
  renderGroup,
}: {
  workspaceId: string
  nodes: ConvTopNode[]
  dndEnabled: boolean
  onReorder: (workspaceId: string, ids: string[]) => void
  renderConv: (conv: Conversation, dnd: DragHandle | undefined, isOver: boolean) => ReactNode
  renderGroup: (
    info: SharedConversationGroupInfo,
    members: Conversation[],
    dnd: DragHandle | undefined,
    isOver: boolean
  ) => ReactNode
}) {
  const reorder = useReorder(
    (from, to) => {
      const next = [...nodes]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)

      const ids = next.flatMap((n) => (n.kind === 'conv' ? [n.conv.id] : n.members.map((m) => m.id)))
      onReorder(workspaceId, ids)
    },
    { noDragSelector: '[data-no-drag]' }
  )
  return (
    <>
      {nodes.map((n, i) => {
        const dnd = dndEnabled ? reorder.props(i) : undefined
        const isOver = dndEnabled && reorder.overIndex === i
        return n.kind === 'conv' ? renderConv(n.conv, dnd, isOver) : renderGroup(n.info, n.members, dnd, isOver)
      })}
    </>
  )
}
