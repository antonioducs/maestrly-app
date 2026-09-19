import type { ReactNode } from 'react'
import type { StandaloneConversation } from '../../../shared/conversation'
import { useReorder } from '@/lib/use-reorder'
import type { DragHandle } from './WorkspaceConvList'

export function StandaloneChatList({
  conversations,
  onReorder,
  enabled,
  renderConv,
}: {
  conversations: StandaloneConversation[]
  onReorder: (ids: string[]) => void
  enabled: boolean
  renderConv: (conversation: StandaloneConversation, dnd: DragHandle | undefined, isOver: boolean) => ReactNode
}) {
  const reorder = useReorder(
    (from, to) => {
      const next = [...conversations]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      onReorder(next.map((conversation) => conversation.id))
    },
    { noDragSelector: '[data-no-drag]' }
  )
  return (
    <ul>
      {conversations.map((conversation, index) =>
        renderConv(conversation, enabled ? reorder.props(index) : undefined, enabled && reorder.overIndex === index)
      )}
    </ul>
  )
}
