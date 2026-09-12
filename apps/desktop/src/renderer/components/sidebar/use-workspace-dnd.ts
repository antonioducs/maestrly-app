import { useMemo, useState } from 'react'
import { PointerSensor, useSensor, useSensors, type DragStartEvent, type DragEndEvent } from '@dnd-kit/core'
import type { WorkspaceGroup, WorkspaceWithConversations } from '../../../preload'

export function useWorkspaceDnd({
  workspaces,
  groups,
  onReorderWorkspaces,
  onReorderGroups,
  onMoveWorkspaceToGroup,
}: {
  workspaces: WorkspaceWithConversations[]
  groups: WorkspaceGroup[]
  onReorderWorkspaces: (ids: string[]) => void
  onReorderGroups: (ids: string[]) => void
  onMoveWorkspaceToGroup: (wsId: string, groupId: string | null, flatIds: string[]) => void
}) {
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const draggingWs = activeDragId?.startsWith('ws-') ?? false

  const { loose, byGroup } = useMemo(() => {
    const loose: WorkspaceWithConversations[] = []
    const byGroup = new Map<string, WorkspaceWithConversations[]>()
    for (const g of groups) byGroup.set(g.id, [])
    for (const ws of workspaces) {
      if (ws.groupId && byGroup.has(ws.groupId)) byGroup.get(ws.groupId)!.push(ws)
      else loose.push(ws)
    }
    return { loose, byGroup }
  }, [workspaces, groups])

  const groupOfWs = (wsId: string): string | null => {
    for (const g of groups) if ((byGroup.get(g.id) ?? []).some((w) => w.id === wsId)) return g.id
    return null
  }

  const resolveGroupId = (overId: string): string | null => {
    if (overId.startsWith('groupdrop-')) return overId.slice('groupdrop-'.length)
    if (overId.startsWith('group-')) return overId.slice('group-'.length)
    if (overId.startsWith('ws-')) return groupOfWs(overId.slice('ws-'.length))
    return null
  }

  const buildFlatIds = (moveWs: string, toGroup: string | null, beforeWs: string | null): string[] => {
    const looseIds = loose.map((w) => w.id)
    const byG = new Map<string, string[]>()
    for (const g of groups)
      byG.set(
        g.id,
        (byGroup.get(g.id) ?? []).map((w) => w.id)
      )
    const listForGroup = (groupId: string | null): string[] =>
      groupId !== null && byG.has(groupId) ? byG.get(groupId)! : looseIds
    const fromGroup = groupOfWs(moveWs)

    if (beforeWs && fromGroup === toGroup && groupOfWs(beforeWs) === toGroup) {
      const target = listForGroup(toGroup)
      const from = target.indexOf(moveWs)
      const to = target.indexOf(beforeWs)
      if (from >= 0 && to >= 0 && from !== to) {
        const [moved] = target.splice(from, 1)
        target.splice(to, 0, moved)
        return [...looseIds, ...groups.flatMap((g) => byG.get(g.id) ?? [])]
      }
    }

    const removeFrom = (arr: string[]) => {
      const i = arr.indexOf(moveWs)
      if (i >= 0) arr.splice(i, 1)
    }
    removeFrom(looseIds)
    for (const arr of byG.values()) removeFrom(arr)
    const target = listForGroup(toGroup)
    const at = beforeWs ? target.indexOf(beforeWs) : -1
    if (at >= 0) target.splice(at, 0, moveWs)
    else target.push(moveWs)
    return [...looseIds, ...groups.flatMap((g) => byG.get(g.id) ?? [])]
  }

  const onDragStart = (e: DragStartEvent) => setActiveDragId(String(e.active.id))
  const onDragCancel = () => setActiveDragId(null)
  const onDragEnd = (e: DragEndEvent) => {
    setActiveDragId(null)
    const { active, over } = e
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId === overId) return

    if (activeId.startsWith('ws-')) {
      const wsId = activeId.slice('ws-'.length)
      let targetGroup: string | null
      let beforeWs: string | null = null
      if (overId.startsWith('ws-')) {
        const overWs = overId.slice('ws-'.length)
        targetGroup = groupOfWs(overWs)
        beforeWs = overWs
      } else if (overId.startsWith('groupdrop-')) {
        targetGroup = overId.slice('groupdrop-'.length)
      } else if (overId.startsWith('group-')) {
        targetGroup = overId.slice('group-'.length)
      } else if (overId === 'rootdrop') {
        targetGroup = null // soltos
      } else {
        return
      }
      const flatIds = buildFlatIds(wsId, targetGroup, beforeWs)
      if (targetGroup === null && groupOfWs(wsId) === null) {
        onReorderWorkspaces(flatIds)
      } else {
        onMoveWorkspaceToGroup(wsId, targetGroup, flatIds)
      }
      return
    }

    // reordenar GRUPOS entre si
    if (activeId.startsWith('group-')) {
      const gid = activeId.slice('group-'.length)
      const targetG = resolveGroupId(overId)
      if (!targetG || targetG === gid) return
      const ids = groups.map((g) => g.id)
      const from = ids.indexOf(gid)
      const to = ids.indexOf(targetG)
      if (from < 0 || to < 0) return
      const next = [...ids]
      next.splice(from, 1)
      next.splice(to, 0, gid)
      onReorderGroups(next)
    }
  }

  return { sensors, draggingWs, loose, byGroup, buildFlatIds, onDragStart, onDragCancel, onDragEnd }
}
