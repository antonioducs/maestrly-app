import { useMemo, type HTMLAttributes, type ReactNode } from 'react'
import type { Conversation } from '../../../preload'
import type { MaestroSwarmTask } from '../../../shared/maestro-swarm'
import { useMaestroSwarmPhases } from '@/lib/use-maestro-swarm'
import { useReorder } from '@/lib/use-reorder'
import type { ConvTopNode, DispatchConversationGroupInfo, SharedConversationGroupInfo } from './conv-top-nodes'

export type DragHandle = HTMLAttributes<HTMLElement> & { draggable?: boolean }

export function WorkspaceConvList({
  workspaceId,
  nodes,
  dndEnabled,
  findConversation,
  onReorder,
  renderConv,
  renderGroup,
  renderDispatch,
}: {
  workspaceId: string
  nodes: ConvTopNode[]
  dndEnabled: boolean
  findConversation?: (id: string) => Conversation | undefined
  onReorder: (workspaceId: string, ids: string[]) => void
  renderConv: (conv: Conversation, dnd: DragHandle | undefined, isOver: boolean) => ReactNode
  renderGroup: (
    info: SharedConversationGroupInfo,
    members: Conversation[],
    dnd: DragHandle | undefined,
    isOver: boolean
  ) => ReactNode
  renderDispatch: (
    info: DispatchConversationGroupInfo,
    members: Conversation[],
    dnd: DragHandle | undefined,
    isOver: boolean,
    swarmTasks: ReadonlyMap<string, MaestroSwarmTask>
  ) => ReactNode
}) {
  const maestroDispatchRootIds = useMemo(() => {
    const ids: string[] = []
    for (const node of nodes) {
      if (node.kind !== 'dispatch') continue
      const rootConv = findConversation?.(node.info.rootId) ?? node.members.find((m) => m.id === node.info.rootId)
      if (rootConv?.experience === 'maestro') ids.push(node.info.rootId)
    }
    return ids
  }, [nodes, findConversation])

  const swarmTasks = useMaestroSwarmPhases(maestroDispatchRootIds)

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
        if (n.kind === 'conv') return renderConv(n.conv, dnd, isOver)
        if (n.kind === 'dispatch') return renderDispatch(n.info, n.members, dnd, isOver, swarmTasks)
        return renderGroup(n.info, n.members, dnd, isOver)
      })}
    </>
  )
}
