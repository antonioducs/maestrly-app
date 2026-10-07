import type { ArtifactHosting } from './artifact-hosting.js'
import type { DesktopBridge } from './desktop-bridge.js'
import type { FleetNetwork } from './network.js'
import type { OwnerMemory } from './owner-memory.js'
import type { Auth } from './auth.js'
import type { GatewayConfig } from './config.js'
import type { EventHub } from './events.js'
import type { HostMonitor } from './host.js'
import type { Lifecycle } from './lifecycle.js'
import type { Store } from './store.js'
import type { Peers } from './peers.js'
import type { Routines } from './routines.js'
import type { ScreenProxy } from './screen.js'
export type GatewayContext = {
  artifacts?: ArtifactHosting
  network?: FleetNetwork
  auth: Auth
  config: GatewayConfig
  events: EventHub
  host: HostMonitor
  lifecycle: Lifecycle
  store: Store
  ownerMemory?: OwnerMemory
  peers?: Peers
  routines?: Routines
  screen?: ScreenProxy
  desktops?: DesktopBridge
  revokeDevice?: (deviceId: string) => Promise<void>
}
