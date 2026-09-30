import { ipcRenderer } from 'electron'
import { LOCAL_HOST_ID } from '../shared/host-key'
import type { HostView } from '../shared/hosts'
import { type HostApi, localHostApi, makeHostApi } from './host-api'
import type { IpcTransport } from './ipc-transport'

export type { HostConnectionState, HostEnvironmentView, HostView } from '../shared/hosts'

type Listener = (event: unknown, ...args: unknown[]) => void

/** What each remote host pushes to this renderer, by host and channel. */
const remoteListeners = new Map<string, Map<string, Set<Listener>>>()
let listening = false

function listen(): void {
  if (listening) return
  listening = true
  ipcRenderer.on('host:event', (event, hostId: string, channel: string, args: unknown[]) => {
    const listeners = remoteListeners.get(hostId)?.get(channel)
    if (listeners) for (const listener of [...listeners]) listener(event, ...args)
  })
}

/**
 * The transport of a remote host: this computer's main process relays calls over the host's bridge and hands back
 * what the host pushes to this renderer. Every host shares one `host:event` listener.
 */
function remoteTransport(hostId: string): IpcTransport {
  const channels = new Map<string, Set<Listener>>()
  remoteListeners.set(hostId, channels)
  return {
    invoke: (channel, ...args) => ipcRenderer.invoke('host:invoke', hostId, channel, args),
    send: (channel, ...args) => ipcRenderer.send('host:send', hostId, channel, args),
    on: (channel, listener) => {
      listen()
      let listeners = channels.get(channel)
      if (!listeners) {
        listeners = new Set()
        channels.set(channel, listeners)
      }
      listeners.add(listener)
    },
    removeListener: (channel, listener) => {
      const listeners = channels.get(channel)
      if (listeners?.delete(listener) && !listeners.size) channels.delete(channel)
    },
  }
}

const remoteApis = new Map<string, HostApi>()

export const hostsApi = {
  /** This computer and each remote host, with how each one is reached now. */
  hostsList: (): Promise<HostView[]> => ipcRenderer.invoke('hosts:list'),
  onHostsChanged: (cb: (hosts: HostView[]) => void): (() => void) => {
    const listener = (_event: unknown, hosts: HostView[]) => cb(hosts)
    ipcRenderer.on('hosts:changed', listener)
    return () => ipcRenderer.removeListener('hosts:changed', listener)
  },
  /** Dials a remote host again now instead of at its next attempt. */
  hostsRetry: (hostId: string): Promise<void> => ipcRenderer.invoke('hosts:retry', hostId),
  /** The host API of a host; this computer is `'local'`. */
  hostApi: (hostId: string): HostApi => {
    if (hostId === LOCAL_HOST_ID) return localHostApi
    let api = remoteApis.get(hostId)
    if (!api) {
      api = makeHostApi(remoteTransport(hostId))
      remoteApis.set(hostId, api)
    }
    return api
  },
}
