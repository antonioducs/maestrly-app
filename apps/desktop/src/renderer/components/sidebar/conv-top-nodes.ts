import type { Conversation } from '../../../preload'

export interface SharedConversationGroupInfo {
  key: string
  cwd: string
  branch: string
  mode: 'worktree' | 'local'
}

export interface DispatchConversationGroupInfo {
  key: string
  rootId: string
  rootName: string
}

export type ConvTopNode =
  | { kind: 'conv'; conv: Conversation }
  | { kind: 'group'; info: SharedConversationGroupInfo; members: Conversation[] }
  | { kind: 'dispatch'; info: DispatchConversationGroupInfo; members: Conversation[] }

function sharedGroupInfo(conv: Conversation): SharedConversationGroupInfo | null {
  if (conv.isMulti || (conv.mode !== 'worktree' && conv.mode !== 'local')) return null
  const key =
    conv.mode === 'worktree' ? JSON.stringify(['worktree', conv.cwd]) : JSON.stringify(['local', conv.cwd, conv.branch])
  return { key, cwd: conv.cwd, branch: conv.branch, mode: conv.mode }
}

export function buildConvTopNodes(convs: Conversation[]): ConvTopNode[] {
  const byId = new Map<string, Conversation>()
  for (const conv of convs) byId.set(conv.id, conv)

  // Group derived conversations by the root of their dispatch chain. A dispatch folder appears only when
  // at least one derived conversation is listed and takes precedence over shared-worktree grouping.
  const derivedByRoot = new Map<string, { rootName: string; derived: Conversation[] }>()
  for (const conv of convs) {
    const origin = conv.dispatchOrigin
    if (!origin || origin.rootConversationId === conv.id) continue
    const rootId = origin.rootConversationId
    const entry = derivedByRoot.get(rootId)
    if (entry) {
      entry.derived.push(conv)
    } else {
      const rootConv = byId.get(rootId)
      derivedByRoot.set(rootId, { rootName: rootConv?.name ?? origin.rootName, derived: [conv] })
    }
  }

  const dispatchGroups = new Map<string, { info: DispatchConversationGroupInfo; members: Conversation[] }>()
  const dispatchRootOfConv = new Map<string, string>()
  for (const [rootId, { rootName, derived }] of derivedByRoot) {
    const rootConv = byId.get(rootId)
    const sortedDerived = derived.slice().sort((a, b) => a.createdAt - b.createdAt)
    const members = rootConv ? [rootConv, ...sortedDerived] : sortedDerived
    dispatchGroups.set(rootId, {
      info: { key: `dispatch:${rootId}`, rootId, rootName },
      members,
    })
    for (const member of members) dispatchRootOfConv.set(member.id, rootId)
  }

  const looseByGroup = new Map<string, { info: SharedConversationGroupInfo; members: Conversation[] }>()
  for (const conv of convs) {
    if (dispatchRootOfConv.has(conv.id)) continue
    const info = sharedGroupInfo(conv)
    if (!info) continue
    const group = looseByGroup.get(info.key)
    if (group) group.members.push(conv)
    else looseByGroup.set(info.key, { info, members: [conv] })
  }
  const groupedKeys = new Set<string>()
  for (const [key, group] of looseByGroup) {
    if (group.members.length >= 2) groupedKeys.add(key)
  }

  const seenDispatch = new Set<string>()
  const seenGroups = new Set<string>()
  const nodes: ConvTopNode[] = []
  for (const conv of convs) {
    const dispatchRootId = dispatchRootOfConv.get(conv.id)
    if (dispatchRootId !== undefined) {
      if (seenDispatch.has(dispatchRootId)) continue
      seenDispatch.add(dispatchRootId)
      const group = dispatchGroups.get(dispatchRootId)!
      nodes.push({ kind: 'dispatch', info: group.info, members: group.members })
      continue
    }
    const groupInfo = sharedGroupInfo(conv)
    if (groupInfo && groupedKeys.has(groupInfo.key)) {
      if (seenGroups.has(groupInfo.key)) continue
      seenGroups.add(groupInfo.key)
      const group = looseByGroup.get(groupInfo.key)!
      const members = group.members.slice().sort((a, b) => a.createdAt - b.createdAt)
      nodes.push({ kind: 'group', info: group.info, members })
      continue
    }
    nodes.push({ kind: 'conv', conv })
  }
  return nodes
}
