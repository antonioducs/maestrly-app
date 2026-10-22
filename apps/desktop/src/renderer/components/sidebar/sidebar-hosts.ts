import type { HostView } from '../../../shared/hosts'
import { type HostId, LOCAL_HOST_ID } from '../../../shared/host-key'

/** What a machine's conversations do now, for its entry in the host switcher. */
export interface HostActivity {
  /** Conversations that finished in the background and wait for the person. */
  attention: number
  working: number
}

/** Counts a machine's live conversations that wait for the person or run now; archived ones do not count. */
export function hostActivity(
  conversations: Iterable<{ id: string; status: string; archived: number }>,
  statuses: Readonly<Record<string, string>>,
  attention: ReadonlySet<string>
): HostActivity {
  let waiting = 0
  let working = 0
  for (const conversation of conversations) {
    if (conversation.archived === 1) continue
    if (attention.has(conversation.id)) waiting++
    if ((statuses[conversation.id] ?? conversation.status) === 'working') working++
  }
  return { attention: waiting, working }
}

/**
 * The machine whose chats and workspaces the sidebar lists: the one chosen last while it is still listed, else this
 * computer. A machine that is not listed yet (the window is still reaching it) keeps the choice for when it is.
 */
export function resolveSidebarHost(stored: string | null, hostIds: readonly HostId[]): HostId {
  return stored !== null && hostIds.includes(stored) ? stored : LOCAL_HOST_ID
}

/**
 * The machines as the switcher's menu lists them: with hosts of more than one bot server, this computer and the other
 * computers first, then each server's hosts under its name; otherwise one list, unnamed.
 */
export function hostGroups(hosts: HostView[]): Array<{ serverId: string | null; server: string; hosts: HostView[] }> {
  const servers = new Set(hosts.flatMap((host) => (host.serverId ? [host.serverId] : [])))
  if (servers.size < 2) return [{ serverId: null, server: '', hosts }]
  const groups = new Map<string | null, { serverId: string | null; server: string; hosts: HostView[] }>()
  groups.set(null, { serverId: null, server: '', hosts: [] })
  for (const host of hosts) {
    const key = host.serverId ?? null
    let group = groups.get(key)
    if (!group) {
      group = { serverId: key, server: host.server, hosts: [] }
      groups.set(key, group)
    }
    if (!group.server && host.server) group.server = host.server
    group.hosts.push(host)
  }
  return [...groups.values()].filter((group) => group.hosts.length > 0)
}
