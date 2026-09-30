import type { HostId } from './host-key'
import type { RemoteOs } from './remote-bridge'

/**
 * How this computer reaches a host. `offline` is a host whose server does not run it now (stopped, starting, or the
 * server itself unreachable); `incompatible` is a host that runs another version of the app than this computer.
 */
export type HostConnectionState = 'connecting' | 'online' | 'reconnecting' | 'incompatible' | 'offline'

/** The environment of a server that runs a remote host: what the owner starts, restarts or updates. */
export interface HostEnvironmentView {
  id: string
  /** The environment's lifecycle on the server (`running`, `stopped`, `starting`, …). */
  lifecycle: string
  updateAvailable: boolean
}

/** A host as a window of this computer sees it. */
export interface HostView {
  id: HostId
  remote: boolean
  /** The server's name for a remote host; empty for this computer, which the window names itself. */
  label: string
  state: HostConnectionState
  /** Increases each time a remote host answers again: what the window shows of it is loaded again. */
  epoch: number
  os: RemoteOs
  homeDir: string
  /** Whether opening files, folders and dialogs on the host's own desktop is of any use to the person. */
  desktopEffects: boolean
  editor: boolean
  browser: boolean
  environment: HostEnvironmentView | null
  /** The app version of a host that refused this computer's, when it said so. */
  hostVersion: string | null
}
