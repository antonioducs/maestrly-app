import { type HostId, isRemoteHostId, parseHostKey } from '../shared/host-key'
import { isFloatTab, type FloatTab } from '../shared/tool-tabs'
import { getConversation } from './store'

/** The tools of a remote host's conversation this computer shows: panels that reach the host for their content. */
const REMOTE_HOST_TABS: ReadonlySet<FloatTab> = new Set(['terminal', 'files', 'plan', 'review', 'notes'])

/** Which remote hosts serve their editor to this computer (RemoteHostInfo.editor); set once hosts are known. */
let remoteEditorHosts: (hostId: HostId) => boolean = () => false
export function setRemoteEditorHosts(offers: (hostId: HostId) => boolean): void {
  remoteEditorHosts = offers
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
  // This computer holds no native browser or companion for a conversation that runs on another host; its editor is the
  // host's, shown here when the host serves it (drawer/remote-vscode).
  if (isRemoteConversation(convId))
    return REMOTE_HOST_TABS.has(tab) || (tab === 'vscode' && remoteEditorHosts(parseHostKey(convId).hostId))
  // A conversation of this computer has its files at hand: the Files tab moves files to and from a host.
  if (tab === 'files') return false
  return !(tab === 'review' && getConversation(convId)?.scope === 'standalone')
}
