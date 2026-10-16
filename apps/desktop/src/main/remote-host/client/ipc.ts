import os from 'node:os'
import { app, type WebContents, webContents } from 'electron'
import { FLEET_INSTANCE_BRIDGE_PATH, FLEET_PROTOCOL_HEADER, FLEET_PROTOCOL_VERSION } from '@maestrly/bot-fleet-protocol'
import { WebSocket as NodeWebSocket } from 'ws'
import { type HostId, isValidHostId, parseHostKey } from '../../../shared/host-key'
import { REMOTE_BRIDGE_LIMITS, type RemoteOriginRole, type RemoteOs } from '../../../shared/remote-bridge'
import { fleetClientService } from '../../fleet/client/service'
import { fleetServerId, readFleetSettings } from '../../fleet/client/settings'
import type { IpcRegistrar } from '../../ipc-registrar'
import { getLocale } from '../../store'
import { isE2E } from '../../test-mode'
import { broadcast, getPanelTargetMetadata } from '../../window-ipc'
import { isHeadlessInstance } from '../server/config'
import type { BridgeClientSocket } from './host-connection'
import { type DirectHost, HostRegistry, parseDirectHost } from './host-registry'

const localOs = (): RemoteOs => (process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux')

function openDirectSocket(host: DirectHost): BridgeClientSocket {
  const url = new URL(host.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return new NodeWebSocket(url.origin + FLEET_INSTANCE_BRIDGE_PATH, {
    headers: { [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION), Authorization: `Bearer ${host.token}` },
    maxPayload: REMOTE_BRIDGE_LIMITS.maxFrameBytes,
  }) as unknown as BridgeClientSocket
}

/**
 * Which renderer of this computer a sender is for a host: a drawer panel of one conversation, or the main window.
 * A panel of a remote conversation is registered here under its host key; the host knows the conversation by its id.
 */
export function originRole(sender: WebContents): RemoteOriginRole {
  const panel = getPanelTargetMetadata(sender)
  return panel?.convId && panel.panel
    ? { role: 'panel', convId: parseHostKey(panel.convId).id, panel: panel.panel }
    : { role: 'main' }
}

let registry: HostRegistry | null = null
const hostsListeners = new Set<() => void>()
const eventListeners = new Set<(hostId: HostId, channel: string, args: unknown[]) => void>()

/**
 * Calls `listener` with every push a host sends this computer, before it reaches the renderer it is for: how this
 * computer's main process follows what it asked a host to do. Returns its removal.
 */
export function onHostEvent(listener: (hostId: HostId, channel: string, args: unknown[]) => void): () => void {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

/** Calls `listener` whenever the hosts or their states change; returns its removal. */
export function onHostsChanged(listener: () => void): () => void {
  hostsListeners.add(listener)
  return () => hostsListeners.delete(listener)
}

/** The hosts of this computer's windows; null before IPC is registered. */
export const hostRegistry = (): HostRegistry | null => registry

/**
 * Registers what a window uses to reach hosts: the list of hosts, and the relay of a remote host's API. A headless
 * instance (a bot, or a host itself) has no remote hosts: its list is this computer alone.
 */
export function registerHostsIpc(reg: IpcRegistrar): void {
  const headless = isHeadlessInstance()
  const direct = headless ? null : parseDirectHost(process.env.MAESTRLY_DEV_DIRECT_HOST, !app.isPackaged || isE2E())
  const hosts = new HostRegistry({
    fleet: {
      getConnection: () => fleetClientService.getConnection(),
      getSnapshot: () => (headless ? { environments: [] } : fleetClientService.getSnapshot()),
      onChange: (listener) => fleetClientService.onChange(listener),
      bridgeTicket: (eid) => fleetClientService.call('environmentBridgeTicket', { params: { eid }, body: {} }),
    },
    serverId: fleetServerId,
    appVersion: app.getVersion(),
    local: { os: localOs(), homeDir: os.homedir() },
    client: () => ({
      deviceName: (readFleetSettings().deviceName ?? os.hostname()).slice(0, 128),
      os: localOs(),
      locale: getLocale(),
    }),
    openSocket: (url) => new WebSocket(url),
    direct: direct && { host: direct, openSocket: openDirectSocket },
    onChanged: (list) => {
      broadcast('hosts:changed', list)
      for (const listener of hostsListeners) listener()
    },
    onEvent: (hostId, origin, channel, args) => {
      for (const listener of eventListeners) {
        try {
          listener(hostId, channel, args)
        } catch (error) {
          console.error('[hosts] a host event listener failed:', error)
        }
      }
      const target = webContents.fromId(origin)
      if (target && !target.isDestroyed()) target.send('host:event', hostId, channel, args)
    },
  })
  registry = hosts
  hosts.start()
  app.once('before-quit', () => hosts.stop())

  const tracked = new WeakSet<WebContents>()
  /** The connection a sender's call goes through; the sender becomes an origin of the host on its first call. */
  const use = (sender: WebContents, hostId: unknown, channel: unknown, args: unknown) => {
    if (typeof hostId !== 'string' || !isValidHostId(hostId)) throw new Error('Unknown host')
    if (typeof channel !== 'string' || !channel || channel.length > 200 || !Array.isArray(args))
      throw new Error('Invalid host call')
    const connection = hosts.use(hostId, sender.id, () => originRole(sender))
    if (!tracked.has(sender)) {
      tracked.add(sender)
      const origin = sender.id
      sender.once('destroyed', () => hosts.closeOrigin(origin))
    }
    return connection
  }

  reg.handle('hosts:list', () => hosts.list())
  reg.mhandle('hosts:retry', (_event, hostId: unknown) => {
    if (typeof hostId === 'string') hosts.retry(hostId)
  })
  reg.mhandle('host:invoke', (event, hostId: unknown, channel: unknown, args: unknown) =>
    use(event.sender, hostId, channel, args).invoke(event.sender.id, channel as string, args as unknown[])
  )
  reg.mon('host:send', (event, hostId: unknown, channel: unknown, args: unknown) => {
    try {
      use(event.sender, hostId, channel, args).send(event.sender.id, channel as string, args as unknown[])
    } catch {
      /* A send has no answer: one for a host that went away is dropped, like a push to a closed window. */
    }
  })
}
