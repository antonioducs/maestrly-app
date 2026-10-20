import os from 'node:os'
import { app } from 'electron'
import { readFleetServerRecords } from '../fleet/client/settings'
import type { HostFilesRoutes } from '../fleet/instance/host-files-http'
import type { EditorRoutes } from '../fleet/instance/server'
import { holdAwake } from '../power-manager'
import type { IpcHandlerTable } from '../remote-host/ipc-handler-table'
import type { RemoteHostInfo, RemoteOs } from '../../shared/remote-bridge'
import { PeerHosting } from './hosting'
import { loadOrCreateIdentity, type PeerIdentity } from './identity'
import { PeerHosts } from './peer-hosts'
import { appPeerStorage } from './storage'
import { PeerStore } from './store'

const MAX_ADDRESSES = 8

let store: PeerStore | null = null
let identity: PeerIdentity | null = null
let hosting: PeerHosting | null = null
let hosts: PeerHosts | null = null

/** The owner's other computers this profile paired with. */
export function peerStore(): PeerStore {
  store ??= new PeerStore(appPeerStorage)
  return store
}

/** The paired computers as hosts of this computer's windows. */
export function peerHosts(): PeerHosts {
  hosts ??= new PeerHosts({ store: peerStore() })
  return hosts
}

/** This profile's identity among the owner's computers, created on first use; null without a keyring. */
export function peerIdentity(): PeerIdentity | null {
  identity ??= loadOrCreateIdentity(appPeerStorage, {
    // The name this computer has on the first server it paired with, as the owner chose it there.
    defaultName: () => readFleetServerRecords()[0]?.deviceName || os.hostname(),
  })
  return identity
}

export const localPeerOs = (): RemoteOs =>
  process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'

/** Where the owner's other computers may reach this one: its name, then the addresses of its network interfaces. */
export function localPeerAddresses(): string[] {
  const addresses = [os.hostname()]
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.internal) continue
      if (item.family === 'IPv6' && item.address.toLowerCase().startsWith('fe80')) continue
      addresses.push(item.address)
    }
  }
  return [...new Set(addresses.filter(Boolean))].slice(0, MAX_ADDRESSES)
}

/** Shares this desktop with the owner's other computers while the owner keeps hosting on. */
export function startPeerHosting(deps: {
  table: IpcHandlerTable
  hostFiles: HostFilesRoutes & { sweep(): Promise<unknown> }
  editor: EditorRoutes & { closeAll(): void }
  hostInfo(): RemoteHostInfo
}): PeerHosting {
  const log = (level: 'info' | 'warn' | 'error', message: string): void =>
    console.error(JSON.stringify({ component: 'peer-host', level, message }))
  const started: PeerHosting = new PeerHosting({
    storage: appPeerStorage,
    identity: peerIdentity,
    store: peerStore(),
    appVersion: app.getVersion(),
    os: localPeerOs(),
    hub: { table: deps.table, appVersion: app.getVersion(), hostInfo: deps.hostInfo, log },
    hostFiles: deps.hostFiles,
    editor: deps.editor,
    holdAwake,
    localAddresses: localPeerAddresses,
    // Until Settings shows them, pairings and connections are only logged; the code itself never is.
    onPrompt: (prompt) => log('info', `Pairing with ${prompt.name}: ${prompt.outcome}`),
    onChange: () =>
      log('info', `Hosting ${started.enabled() ? 'on' : 'off'}, ${started.connected().length} computer(s) connected`),
  })
  hosting = started
  return started
}

/** The sharing of this desktop, once the main process started it. */
export const peerHosting = (): PeerHosting | null => hosting
