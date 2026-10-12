import type { Conversation, WorkspaceGroup, WorkspaceWithConversations } from '../../../preload'
import { type HostId, hostKey, isRemoteHostId, LOCAL_HOST_ID, parseHostKey } from '../../../shared/host-key'
import { hostApi } from './host-context'

/**
 * The window shows conversations of several hosts in one sidebar, one list of mounted chats and one drawer. What it
 * keeps about them is keyed by host key, so inside the window a remote conversation, workspace or group carries its
 * host key as its id ("shell" form); a host's own API takes the host's ids ("host" form). This computer's ids are the
 * same in both forms.
 */

type Identified = { id: string }

const keyOf = (hostId: HostId, id: string): string => hostKey(hostId, id)
const idOf = (key: string): string => parseHostKey(key).id

/** The host a conversation, workspace or group of the window belongs to. */
export const hostOfKey = (key: string): HostId => parseHostKey(key).hostId

export const isRemoteKey = (key: string): boolean => isRemoteHostId(hostOfKey(key))

/** The API and the host's own id for something the window knows by its key. */
export function hostTarget(key: string): { hostId: HostId; id: string; api: ReturnType<typeof hostApi> } {
  const { hostId, id } = parseHostKey(key)
  return { hostId, id, api: hostApi(hostId) }
}

function mapConversation<T extends Conversation>(conversation: T, map: (id: string) => string): T {
  return {
    ...conversation,
    id: map(conversation.id),
    workspaceId: conversation.workspaceId === null ? null : map(conversation.workspaceId),
    ...(conversation.repos
      ? { repos: conversation.repos.map((repo) => ({ ...repo, workspaceId: map(repo.workspaceId) })) }
      : {}),
  }
}

export function shellConversation<T extends Conversation>(hostId: HostId, conversation: T): T {
  return hostId === LOCAL_HOST_ID ? conversation : mapConversation(conversation, (id) => keyOf(hostId, id))
}

export function hostConversation<T extends Conversation>(conversation: T): T {
  return isRemoteKey(conversation.id) ? mapConversation(conversation, idOf) : conversation
}

export function shellWorkspace(hostId: HostId, workspace: WorkspaceWithConversations): WorkspaceWithConversations {
  if (hostId === LOCAL_HOST_ID) return workspace
  return {
    ...workspace,
    id: keyOf(hostId, workspace.id),
    groupId: workspace.groupId === null ? null : keyOf(hostId, workspace.groupId),
    conversations: workspace.conversations.map((conversation) => shellConversation(hostId, conversation)),
  }
}

export function hostWorkspace(workspace: WorkspaceWithConversations): WorkspaceWithConversations {
  if (!isRemoteKey(workspace.id)) return workspace
  return {
    ...workspace,
    id: idOf(workspace.id),
    groupId: workspace.groupId === null ? null : idOf(workspace.groupId),
    conversations: workspace.conversations.map(hostConversation),
  }
}

export const shellGroup = (hostId: HostId, group: WorkspaceGroup): WorkspaceGroup =>
  hostId === LOCAL_HOST_ID ? group : { ...group, id: keyOf(hostId, group.id) }

export const shellItem = <T extends Identified>(hostId: HostId, item: T): T =>
  hostId === LOCAL_HOST_ID ? item : { ...item, id: keyOf(hostId, item.id) }

/** A record by host id, keyed for the window. */
export function shellRecord<T>(hostId: HostId, record: Record<string, T>): Record<string, T> {
  if (hostId === LOCAL_HOST_ID) return record
  const out: Record<string, T> = {}
  for (const [id, value] of Object.entries(record)) out[keyOf(hostId, id)] = value
  return out
}

export const shellIds = (hostId: HostId, ids: Iterable<string>): Set<string> =>
  new Set([...ids].map((id) => keyOf(hostId, id)))

export const rawIds = (keys: string[]): string[] => keys.map(idOf)
export const rawId = idOf

type Update<T> = T | ((previous: T) => T)

/**
 * A setter of one of the window's records by key, as a host's own code sees it: its entries by the host's ids, and
 * nothing of other hosts. What it returns replaces that host's entries only.
 */
export function hostRecordSetter<T>(
  host: HostId,
  set: (update: (previous: Record<string, T>) => Record<string, T>) => void
): (update: Update<Record<string, T>>) => void {
  return (update) =>
    set((previous) => {
      const mine: Record<string, T> = {}
      const others: Record<string, T> = {}
      for (const [key, value] of Object.entries(previous)) {
        const parsed = parseHostKey(key)
        if (parsed.hostId === host) mine[parsed.id] = value
        else others[key] = value
      }
      const next = typeof update === 'function' ? update(mine) : update
      return next === mine ? previous : { ...others, ...shellRecord(host, next) }
    })
}

/**
 * The window's active conversation as a host's own code sees it: the conversation in host form while it belongs to
 * that host, and none otherwise. Clearing it or leaving it as it is never touches another host's conversation.
 */
export function hostActiveSetter(
  host: HostId,
  set: (update: (previous: Conversation | null) => Conversation | null) => void
): (update: Update<Conversation | null>) => void {
  return (update) =>
    set((previous) => {
      const mine = previous && hostOfKey(previous.id) === host ? hostConversation(previous) : null
      const next = typeof update === 'function' ? update(mine) : update
      if (next === mine) return previous
      return next ? shellConversation(host, next) : mine ? null : previous
    })
}
