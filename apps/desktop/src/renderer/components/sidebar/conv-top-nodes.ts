import type { Conversation } from '../../../preload'

export interface SharedConversationGroupInfo {
  key: string
  cwd: string
  branch: string
  mode: 'worktree' | 'local'
}

export type ConvTopNode =
  | { kind: 'conv'; conv: Conversation }
  | { kind: 'group'; info: SharedConversationGroupInfo; members: Conversation[] }

function sharedGroupInfo(conv: Conversation): SharedConversationGroupInfo | null {
  if (conv.isMulti || (conv.mode !== 'worktree' && conv.mode !== 'local')) return null
  const key =
    conv.mode === 'worktree' ? JSON.stringify(['worktree', conv.cwd]) : JSON.stringify(['local', conv.cwd, conv.branch])
  return { key, cwd: conv.cwd, branch: conv.branch, mode: conv.mode }
}

export function buildConvTopNodes(convs: Conversation[]): ConvTopNode[] {
  const looseByGroup = new Map<string, { info: SharedConversationGroupInfo; members: Conversation[] }>()
  for (const conv of convs) {
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

  const seenGroups = new Set<string>()
  const nodes: ConvTopNode[] = []
  for (const conv of convs) {
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
