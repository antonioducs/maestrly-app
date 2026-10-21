import { ipcRenderer } from 'electron'
import type { PeerConnectFinish, PeerConnectStart, PeerOverview } from '../shared/peer'

export type {
  PeerComputerView,
  PeerConnectError,
  PeerConnectFinish,
  PeerConnectStart,
  PeerOverview,
  PeerPairingPromptView,
} from '../shared/peer'

/** This computer among the owner's computers: never routed to another host. */
export const peerApi = {
  peerOverview: (): Promise<PeerOverview> => ipcRenderer.invoke('peer:overview'),
  onPeerChanged: (cb: (overview: PeerOverview) => void): (() => void) => {
    const listener = (_event: unknown, overview: PeerOverview) => cb(overview)
    ipcRenderer.on('peer:changed', listener)
    return () => ipcRenderer.removeListener('peer:changed', listener)
  },
  peerSetHosting: (on: boolean): Promise<PeerOverview> => ipcRenderer.invoke('peer:set-hosting', on),
  peerRename: (name: string): Promise<PeerOverview> => ipcRenderer.invoke('peer:rename', name),
  peerRemove: (deviceId: string): Promise<PeerOverview> => ipcRenderer.invoke('peer:remove', deviceId),
  /** Ends what a paired computer has open on this one; it stays paired. */
  peerDisconnect: (deviceId: string): Promise<void> => ipcRenderer.invoke('peer:disconnect', deviceId),
  /** Asks the computer at an address to pair: it shows a code to type here. */
  peerConnectStart: (address: string): Promise<PeerConnectStart> => ipcRenderer.invoke('peer:connect-start', address),
  peerConnectCode: (pairingId: string, code: string): Promise<PeerConnectFinish> =>
    ipcRenderer.invoke('peer:connect-code', pairingId, code),
  peerConnectCancel: (pairingId: string): Promise<void> => ipcRenderer.invoke('peer:connect-cancel', pairingId),
  /** Declines the pairing another computer asked for. */
  peerPromptCancel: (pairingId: string): Promise<void> => ipcRenderer.invoke('peer:prompt-cancel', pairingId),
  /** Closes the dialog that says how a pairing another computer asked for ended. */
  peerPromptDismiss: (pairingId: string): Promise<void> => ipcRenderer.invoke('peer:prompt-dismiss', pairingId),
}
