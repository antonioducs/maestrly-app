import {
  FLEET_PROTOCOL_VERSION,
  fleetMetaFeatures,
  isAllowedFleetUrl,
  normalizePairingCode,
} from '@maestrly/bot-fleet-protocol'
import { FleetApiClient, FleetClientError } from './api'

/**
 * A pairing the gateway granted: where it is, this computer's device and token there, what it offers, and the id of
 * its installation (null from gateways before it).
 */
export type PairedGateway = {
  origin: string
  deviceId: string
  deviceName: string
  token: string
  features: string[]
  gatewayId: string | null
}

/** The platform this computer pairs as, so the server's list of devices can tell computers apart. */
function devicePlatform(): 'macos' | 'windows' | 'linux' {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
}

/**
 * Pairs this computer with a gateway by its code; nothing is stored here. `accept` sees the installation's id before
 * the code is spent, and throws to refuse it.
 */
export async function pairWithGateway(input: {
  url: string
  code: string
  deviceName: string
  accept?: (gatewayId: string | null) => void
}): Promise<PairedGateway> {
  const allowed = isAllowedFleetUrl(input.url)
  if (!allowed.ok) throw new FleetClientError('INVALID_REQUEST', 400, allowed.reason)
  const code = normalizePairingCode(input.code)
  if (!code) throw new FleetClientError('INVALID_REQUEST', 400, 'Invalid pairing code')
  const unauthenticated = new FleetApiClient(allowed.origin)
  const meta = await unauthenticated.call('meta')
  if (meta.protocol !== FLEET_PROTOCOL_VERSION)
    throw new FleetClientError('PROTOCOL_INCOMPATIBLE', 426, 'Incompatible fleet protocol')
  const gatewayId = meta.serverId ?? null
  input.accept?.(gatewayId)
  const paired = await unauthenticated.call('pair', {
    body: { code, deviceName: input.deviceName, client: { kind: 'computer', platform: devicePlatform() } },
  })
  return {
    origin: allowed.origin,
    deviceId: paired.deviceId,
    deviceName: input.deviceName,
    token: paired.token,
    features: fleetMetaFeatures(meta),
    gatewayId,
  }
}
