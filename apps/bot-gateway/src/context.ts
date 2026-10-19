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
import type { PeerThreads } from './peer-threads.js'
import type { Peers } from './peers.js'
import type { Routines } from './routines.js'
import type { ScreenProxy } from './screen.js'
import type { BridgeProxy } from './bridge.js'
import type { HostFilesProxy } from './host-files.js'
import type { HostEditorProxy } from './host-editor.js'
import type { PushNotifier } from './push.js'
import type { DictationService } from './dictation.js'
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
  peerThreads?: PeerThreads
  routines?: Routines
  screen?: ScreenProxy
  bridge?: BridgeProxy
  hostFiles?: HostFilesProxy
  hostEditor?: HostEditorProxy
  desktops?: DesktopBridge
  push?: PushNotifier
  dictation?: DictationService
  revokeDevice?: (deviceId: string) => Promise<void>
}
