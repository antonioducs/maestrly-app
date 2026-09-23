import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { formatPairingCode, normalizePairingCode } from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'
import type { Store, Device } from './store.js'

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
export function token(): string {
  return randomBytes(32).toString('base64url')
}
export class Auth {
  private attempts = new Map<string, number[]>()
  constructor(readonly store: Store) {}
  createPairing(): { code: string; expiresAt: string } {
    let raw = ''
    for (const byte of randomBytes(8)) raw += alphabet[byte & 31]
    const expiresAt = new Date(Date.now() + 600_000).toISOString()
    this.store.addPairing(sha256(raw), expiresAt)
    return { code: formatPairingCode(raw), expiresAt }
  }
  pair(code: string, deviceName: string, remote: string): { deviceId: string; token: string } {
    const now = Date.now(),
      recent = (this.attempts.get(remote) ?? []).filter((at) => now - at < 60_000)
    if (recent.length >= 5) throw new GatewayError('RATE_LIMITED', 'Too many pairing attempts')
    recent.push(now)
    this.attempts.set(remote, recent)
    const normalized = normalizePairingCode(code)
    if (!normalized) throw new GatewayError('INVALID_REQUEST', 'Invalid pairing code format')
    const hash = sha256(normalized)
    const deviceToken = token(),
      deviceId = randomUUID()
    const device: Device = {
      id: deviceId,
      name: deviceName,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    }
    try {
      this.store.consumePairing(hash, device, sha256(deviceToken))
    } catch (error) {
      this.store.recordPairingAttempt(hash)
      throw error
    }
    return { deviceId, token: deviceToken }
  }
  device(bearer: string | undefined): Device {
    if (!bearer?.startsWith('Bearer ')) throw new GatewayError('UNAUTHORIZED', 'Device token required')
    const hash = sha256(bearer.slice(7))
    const found = this.store.deviceByHash(hash)
    if (!found) throw new GatewayError('UNAUTHORIZED', 'Invalid device token')
    if (!found.lastSeenAt || Date.now() - Date.parse(found.lastSeenAt) > 60_000) this.store.touchDevice(found.id)
    return found
  }
  internalBot(bearer: string | undefined): string {
    if (!bearer?.startsWith('Bearer ')) throw new GatewayError('UNAUTHORIZED', 'Bot token required')
    const hash = sha256(bearer.slice(7))
    const id = this.store.botByGatewayHash(hash)
    if (!id) throw new GatewayError('UNAUTHORIZED', 'Invalid bot token')
    return id
  }
}
