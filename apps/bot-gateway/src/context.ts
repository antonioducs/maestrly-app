import type { Auth } from './auth.js'
import type { GatewayConfig } from './config.js'
import type { EventHub } from './events.js'
import type { HostMonitor } from './host.js'
import type { Lifecycle } from './lifecycle.js'
import type { Store } from './store.js'
export type GatewayContext = {
  auth: Auth
  config: GatewayConfig
  events: EventHub
  host: HostMonitor
  lifecycle: Lifecycle
  store: Store
}
