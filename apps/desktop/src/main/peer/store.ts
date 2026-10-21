import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RemoteOs } from '../../shared/remote-bridge'
import { certificateFingerprint, type PeerStorage } from './identity'
import { type PeerRecord, peerRecordSchema } from './schemas'

const RECORDS_KEY = 'peer.records'
const tokenKey = (deviceId: string): string => `peer.token.${deviceId}`
const MAX_ADDRESSES = 8
const TOUCH_INTERVAL_MS = 60_000

export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')
export const issueToken = (): string => randomBytes(32).toString('base64url')
const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))].slice(0, MAX_ADDRESSES)

export function newPeerRecord(input: {
  deviceId: string
  name: string
  os: RemoteOs
  certPem: string
  port: number
  addresses: string[]
  issuedToken: string
  hosting: boolean
  now: number
}): PeerRecord {
  return {
    deviceId: input.deviceId,
    name: input.name,
    os: input.os,
    certPem: input.certPem,
    fingerprint: certificateFingerprint(input.certPem),
    port: input.port,
    addresses: unique(input.addresses),
    tint: null,
    pairedAt: input.now,
    lastSeenAt: input.now,
    issuedTokenHash: tokenHash(input.issuedToken),
    hosting: input.hosting,
  }
}

/** The owner's other computers this one paired with. Their tokens live in the keyring; records hold no secret. */
export class PeerStore {
  private readonly listeners = new Set<() => void>()
  constructor(private readonly storage: PeerStorage) {}

  list(): PeerRecord[] {
    const text = this.storage.get(RECORDS_KEY)
    if (!text) return []
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return []
    }
    if (!Array.isArray(raw)) return []
    return raw.flatMap((entry) => {
      const parsed = peerRecordSchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
  }

  get(deviceId: string): PeerRecord | null {
    return this.list().find((record) => record.deviceId === deviceId) ?? null
  }

  /** Keeps a computer just paired; false when the keyring cannot keep its token, and nothing is stored then. */
  save(record: PeerRecord, tokenToUse: string): boolean {
    if (!this.storage.setSecret(tokenKey(record.deviceId), tokenToUse)) return false
    this.write([record, ...this.list().filter((item) => item.deviceId !== record.deviceId)])
    return true
  }

  /** The token this computer presents to reach a paired one. */
  tokenFor(deviceId: string): string | null {
    return this.storage.getSecret(tokenKey(deviceId))
  }

  /** The paired computer that presents a token this one issued, from an `Authorization` header. */
  authenticate(authorization: string | undefined): PeerRecord | null {
    if (!authorization?.startsWith('Bearer ')) return null
    const presented = Buffer.from(tokenHash(authorization.slice(7)), 'hex')
    let found: PeerRecord | null = null
    // Every record is compared, so the time taken does not tell which one matched.
    for (const record of this.list()) {
      if (timingSafeEqual(Buffer.from(record.issuedTokenHash, 'hex'), presented)) found = record
    }
    return found
  }

  /** Records where and when a paired computer was last seen: the address first, the time at most once a minute. */
  touch(deviceId: string, at: number, address?: string): void {
    const records = this.list()
    const record = records.find((item) => item.deviceId === deviceId)
    if (!record) return
    const addresses = address ? unique([address, ...record.addresses]) : record.addresses
    const stale = record.lastSeenAt === null || at - record.lastSeenAt >= TOUCH_INTERVAL_MS
    if (!stale && addresses.join() === record.addresses.join()) return
    this.write(
      records.map((item) => (item === record ? { ...item, addresses, lastSeenAt: stale ? at : item.lastSeenAt } : item))
    )
  }

  /** Notes that a paired computer shares itself: this computer reached its bridge. */
  markHosting(deviceId: string): void {
    const records = this.list()
    if (!records.some((item) => item.deviceId === deviceId && item.hosting === false)) return
    this.write(records.map((item) => (item.deviceId === deviceId ? { ...item, hosting: true } : item)))
  }

  /** Keeps the port a paired computer said it moved to. */
  setPort(deviceId: string, port: number): void {
    const records = this.list()
    if (!records.some((item) => item.deviceId === deviceId && item.port !== port)) return
    this.write(records.map((item) => (item.deviceId === deviceId ? { ...item, port } : item)))
  }

  /** Keeps the name a paired computer now gives itself. */
  rename(deviceId: string, name: string): void {
    const records = this.list()
    if (!records.some((item) => item.deviceId === deviceId && item.name !== name)) return
    this.write(records.map((item) => (item.deviceId === deviceId ? { ...item, name } : item)))
  }

  remove(deviceId: string): boolean {
    const records = this.list()
    if (!records.some((item) => item.deviceId === deviceId)) return false
    this.storage.removeSecret(tokenKey(deviceId))
    this.write(records.filter((item) => item.deviceId !== deviceId))
    return true
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private write(records: PeerRecord[]): void {
    this.storage.set(RECORDS_KEY, JSON.stringify(records))
    for (const listener of [...this.listeners]) listener()
  }
}
