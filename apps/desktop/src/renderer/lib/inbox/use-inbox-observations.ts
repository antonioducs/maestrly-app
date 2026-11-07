import { useMemo, useRef } from 'react'
import type { TFunction } from 'i18next'
import type { Conversation, WorkspaceWithConversations } from '../../../preload'
import type { FleetSnapshot } from '../../../preload/api-fleet'
import { type FleetServerId, type FleetServerView, fleetKey } from '../../../shared/fleet-servers'
import { type HostId, LOCAL_HOST_ID } from '../../../shared/host-key'
import type { HostView } from '../../../shared/hosts'
import type { FleetBotAttentionEvent } from '../../../shared/notifications'
import { hostName } from '@/components/sidebar/HostSection'
import type { ConversationStatus } from '../../../shared/conversation'
import type { RemoteHostShell } from '../hosts/remote-host-runtime'
import type { InboxObservation, InboxPlace } from './inbox-model'
import {
  botObservations,
  conversationObservations,
  type InboxBotServerInput,
  type InboxConversationInput,
} from './inbox-sources'
import { useLiveStatusTimes } from './use-inbox'

/** The same array while its items are the same: what the sources list changes far less often than their statuses. */
function useSameItems<T>(items: readonly T[]): readonly T[] {
  const kept = useRef(items)
  const previous = kept.current
  if (previous.length !== items.length || items.some((item, index) => item !== previous[index])) kept.current = items
  return kept.current
}

/** Where an environment of a server is, for the place filter: a host and the bots of one environment are one place. */
const environmentPlaceKey = (serverId: FleetServerId, environmentId: string): string =>
  `env:${fleetKey(serverId, environmentId)}`

export function hostPlace(host: HostView | undefined, hostId: HostId, t: TFunction<'ui'>): InboxPlace {
  if (!host?.remote) return { key: `host:${LOCAL_HOST_ID}`, label: t('sidebar.hostThisComputer') }
  const key =
    host.environment && host.serverId ? environmentPlaceKey(host.serverId, host.environment.id) : `host:${hostId}`
  return { key, label: hostName(host, t) }
}

export interface InboxObservationSources {
  workspaces: readonly WorkspaceWithConversations[]
  standaloneConversations: readonly Conversation[]
  remote: Readonly<Record<HostId, RemoteHostShell>>
  hosts: readonly HostView[]
  statuses: Readonly<Record<string, ConversationStatus>>
  attention: ReadonlySet<string>
  pendingPlanIds: ReadonlySet<string>
  fleetServers: readonly FleetServerView[]
  /** Each paired server's bots, environments and requests, in the order of `fleetServers`. */
  fleetSnapshots: readonly FleetSnapshot[]
  botMarks: ReadonlySet<string>
  botEvents: ReadonlyMap<string, FleetBotAttentionEvent>
  t: TFunction<'ui'>
}

/** What every host and server tells the notifications center now. */
export function useInboxObservations(sources: InboxObservationSources): InboxObservation[] {
  const { remote, hosts, t } = sources
  const shells = Object.values(remote)
  const lists = useSameItems([
    sources.workspaces,
    sources.standaloneConversations,
    ...shells.flatMap((shell) => [shell.workspaces, shell.standaloneConversations]),
  ])
  const hostIds = useSameItems(shells.map((shell) => shell.hostId))
  const conversations = useMemo(() => {
    const byId = new Map(hosts.map((host) => [host.id, host]))
    const inputs: InboxConversationInput[] = []
    const add = (
      hostId: HostId,
      workspaces: readonly WorkspaceWithConversations[],
      chats: readonly Conversation[]
    ): void => {
      const place = hostPlace(byId.get(hostId), hostId, t)
      for (const workspace of workspaces)
        for (const conversation of workspace.conversations)
          inputs.push({ conversation, project: workspace.name, place })
      for (const conversation of chats) inputs.push({ conversation, place })
    }
    const [localWorkspaces, localChats, ...remoteLists] = lists as [
      readonly WorkspaceWithConversations[],
      readonly Conversation[],
      ...(readonly WorkspaceWithConversations[] | readonly Conversation[])[],
    ]
    add(LOCAL_HOST_ID, localWorkspaces, localChats)
    hostIds.forEach((hostId, index) =>
      add(
        hostId,
        remoteLists[index * 2] as readonly WorkspaceWithConversations[],
        remoteLists[index * 2 + 1] as readonly Conversation[]
      )
    )
    return inputs
  }, [lists, hostIds, hosts, t])

  const liveAt = useLiveStatusTimes(sources.statuses)
  const conversationItems = useMemo(
    () =>
      conversationObservations(conversations, {
        statuses: sources.statuses,
        attention: sources.attention,
        pendingPlanIds: sources.pendingPlanIds,
        liveAt,
      }),
    [conversations, sources.statuses, sources.attention, sources.pendingPlanIds, liveAt]
  )

  const snapshots = useSameItems(sources.fleetSnapshots)
  const servers = useSameItems(sources.fleetServers)
  const botServers = useMemo(
    () =>
      servers.flatMap((server, index): InboxBotServerInput[] => {
        const snapshot = snapshots[index]
        if (!snapshot) return []
        const environments = new Map(snapshot.environments.map((environment) => [environment.id, environment.name]))
        const serverPlace: InboxPlace = {
          key: `server:${server.id}`,
          label: server.connection.hostname || t('inbox.botsServer'),
        }
        return [
          {
            serverId: server.id,
            bots: snapshot.bots,
            inbox: snapshot.inbox,
            place: (environmentId) => {
              const name = environmentId ? environments.get(environmentId) : undefined
              return environmentId && name
                ? { key: environmentPlaceKey(server.id, environmentId), label: name }
                : serverPlace
            },
          },
        ]
      }),
    [servers, snapshots, t]
  )
  const botItems = useMemo(
    () => botObservations(botServers, sources.botMarks, sources.botEvents),
    [botServers, sources.botMarks, sources.botEvents]
  )

  return useMemo(() => [...conversationItems, ...botItems], [conversationItems, botItems])
}
