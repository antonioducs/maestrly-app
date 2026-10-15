import { type HostId, isRemoteHostId, parseHostKey } from '../shared/host-key'
import { isFloatTab, type FloatTab } from '../shared/tool-tabs'
import { getConversation } from './store'

/** The tools of a remote host's conversation this computer shows: panels that reach the host for their content. */
const REMOTE_HOST_TABS: ReadonlySet<FloatTab> = new Set(['terminal', 'files', 'plan', 'review', 'notes'])

/** The tools a remote host serves only when it says so: its browser (streamed here) and its editor. */
export type RemoteHostTool = 'browser' | 'vscode'

/** Which remote hosts serve which of those tools (RemoteHostInfo.browser, .editor); set once hosts are known. */
let remoteToolHosts: (hostId: HostId, tool: RemoteHostTool) => boolean = () => false
export function setRemoteToolHosts(offers: (hostId: HostId, tool: RemoteHostTool) => boolean): void {
  remoteToolHosts = offers
}

/** Whether the drawer's id of a conversation names one of a remote host (see shared/host-key). */
export const isRemoteConversation = (convId: string): boolean => isRemoteHostId(parseHostKey(convId).hostId)

/**
 * The query of a panel's page. The drawer knows a conversation of a remote host by its host key; the page is told the
 * host and the host's own id, and reaches that host for everything it shows.
 */
export function panelSearch(tab: string, convId: string): string {
  const { hostId, id } = parseHostKey(convId)
  const host = isRemoteHostId(hostId) ? `&host=${encodeURIComponent(hostId)}` : ''
  return `?panel=${tab}&conv=${encodeURIComponent(id)}${host}`
}

/** Main-process admission for renderer requests and restored native views. */
export function conversationTabAllowed(convId: string, tab: FloatTab): boolean {
  if (!isFloatTab(tab)) return false
  // A remote conversation's computer is drawn by the window from its video stream: it never has a native view.
  if (tab === 'computer') return false
  // This computer holds no companion for a conversation that runs on another host. Its browser is the host's, streamed
  // here (drawer/panels), and its editor is the host's too (drawer/remote-vscode): each is shown once the host serves it.
  if (isRemoteConversation(convId))
    return (
      REMOTE_HOST_TABS.has(tab) ||
      ((tab === 'browser' || tab === 'vscode') && remoteToolHosts(parseHostKey(convId).hostId, tab))
    )
  // A conversation of this computer has its files at hand: the Files tab moves files to and from a host.
  if (tab === 'files') return false
  return !(tab === 'review' && getConversation(convId)?.scope === 'standalone')
}
