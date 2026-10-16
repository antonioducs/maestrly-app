import {
  fleetMetaFeatures,
  isAllowedPhoneServerUrl,
  normalizePairingCode,
  type FleetDeviceClient,
} from '@maestrly/bot-fleet-protocol'
import { createGatewayClient, GatewayError, type FetchLike } from '../gateway/client'
import type { PairedServer } from './registry'

export type PairingFailure = 'address' | 'code' | 'unreachable' | 'incompatible' | 'expired' | 'rate-limited' | 'failed'
export type PairingInput = {
  address: string
  code: string
  deviceName: string
  allowLoopback: boolean
  /** What this device is, for the server's list of devices. */
  client?: FleetDeviceClient
}

export class PairingError extends Error {
  constructor(
    readonly reason: PairingFailure,
    message: string
  ) {
    super(message)
    this.name = 'PairingError'
  }
}

function toPairingError(error: unknown): PairingError {
  if (error instanceof PairingError) return error
  if (!(error instanceof GatewayError)) return new PairingError('failed', String(error))
  const reason: PairingFailure =
    error.code === 'NETWORK' || error.code === 'TIMEOUT'
      ? 'unreachable'
      : error.code === 'PROTOCOL_INCOMPATIBLE' || error.code === 'BAD_RESPONSE'
        ? 'incompatible'
        : error.code === 'UNAUTHORIZED'
          ? 'expired'
          : error.code === 'RATE_LIMITED'
            ? 'rate-limited'
            : 'failed'
  return new PairingError(reason, error.message)
}

/** A tailnet address names the machine before `.<tailnet>.ts.net`; any other host, its first label. */
export function serverName(origin: string): string {
  const host = new URL(origin).hostname
  // An IP address is a name only whole.
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return host
  return host.replace(/\.[^.]+\.ts\.net$/, '').split('.')[0] || host
}

export async function pairWithServer(
  input: PairingInput,
  fetch: FetchLike
): Promise<{ server: PairedServer; token: string }> {
  const address = isAllowedPhoneServerUrl(input.address.trim(), { allowLoopback: input.allowLoopback })
  if (!address.ok) throw new PairingError('address', address.reason)
  const code = normalizePairingCode(input.code)
  if (!code) throw new PairingError('code', 'Invalid pairing code')
  const anonymous = createGatewayClient({ origin: address.origin, token: null, fetch })
  try {
    const meta = await anonymous.call('meta')
    const paired = await anonymous.call('pair', {
      body: { code, deviceName: input.deviceName, ...(input.client ? { client: input.client } : {}) },
    })
    return {
      token: paired.token,
      server: {
        id: paired.deviceId,
        origin: address.origin,
        name: serverName(address.origin),
        deviceName: input.deviceName,
        features: fleetMetaFeatures(meta),
        pairedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    throw toPairingError(error)
  }
}
