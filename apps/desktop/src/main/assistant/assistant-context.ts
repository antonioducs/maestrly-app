import type { AssistantOverview } from '../../shared/assistant-overview'
import type { HostId } from '../../shared/host-key'
import type { HostInvoker } from '../remote-host/host-invoker'

/** How the assistant's tools reach remote workspaces hosts: wired by the window process at startup. */
export interface AssistantHostAccess {
  invoker: HostInvoker
  /** The remote hosts this computer knows. */
  hosts(): Array<{ id: HostId; label: string; state: string }>
}

let hostAccess: AssistantHostAccess | null = null

export function setAssistantHostAccess(access: AssistantHostAccess | null): void {
  hostAccess = access
}

export function assistantHostAccess(): AssistantHostAccess | null {
  return hostAccess
}

/** A paired bot server's name: the host name it reports, else its address. */
function serverName(connection: { hostname: string | null; url: string | null }, fallback: string): string {
  if (connection.hostname) return connection.hostname
  if (connection.url) {
    try {
      return new URL(connection.url).host
    } catch {
      return connection.url
    }
  }
  return fallback
}

/** The overview across this computer, its remote hosts and its bot servers, without `exclude`. */
export async function collectAssistantOverview(exclude: string | null): Promise<AssistantOverview> {
  const [{ createOverviewService }, store, workspaces, chat, plans, { fleetServers }] = await Promise.all([
    import('./overview-service'),
    import('../store'),
    import('../workspace-service'),
    import('../chat/service'),
    import('../plan-broker'),
    import('../fleet/client/servers'),
  ])
  const access = hostAccess
  const service = createOverviewService({
    localWorkspaces: () => workspaces.listWorkspacesWithConversations(false),
    localStandalone: () => store.listStandaloneConversations(false),
    isRunning: (id) => chat.isChatConversationRunning(id),
    pending: (id) => chat.chatPendingInteractions(id),
    hasPendingPlan: (id) => plans.getPending(id) !== null,
    hosts: () => access?.hosts() ?? [],
    invokeHost: (hostId, channel, args, opts) =>
      access ? access.invoker.invoke(hostId, channel, args, opts) : Promise.reject(new Error('No remote hosts here.')),
    fleetClients: () =>
      fleetServers.clients().map((client) => {
        const connection = client.getConnection()
        return {
          serverId: client.serverId,
          serverName: serverName(connection, client.serverId),
          connected: connection.state === 'connected',
          snapshot: () => client.getSnapshot(),
        }
      }),
    now: () => Date.now(),
  })
  return service.collect(exclude)
}
