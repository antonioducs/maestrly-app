import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { z } from 'zod'
import { type FleetServerId, isFleetServerId } from '../../../shared/fleet-servers'
import { getAppSetting, setAppSetting } from '../../store'
import { isSecureStorageAvailable, secureGet, secureRemove, secureSet } from '../../secure-store'

const TOKEN_KEY = 'fleet.deviceToken'
let memoryToken: string | null = null

export type TokenPersistence = 'secure' | 'memory'

export function readFleetSettings(): {
  url: string | null
  deviceId: string | null
  deviceName: string | null
  token: string | null
  tokenPersistence: TokenPersistence
} {
  const secureToken = secureGet(TOKEN_KEY)
  return {
    url: getAppSetting('fleet.url') || null,
    deviceId: getAppSetting('fleet.deviceId') || null,
    deviceName: getAppSetting('fleet.deviceName') || null,
    token: memoryToken ?? secureToken,
    tokenPersistence: memoryToken || !isSecureStorageAvailable() ? 'memory' : 'secure',
  }
}

export function saveFleetCredentials(
  url: string,
  deviceId: string,
  deviceName: string,
  token: string
): TokenPersistence {
  if (secureSet(TOKEN_KEY, token)) {
    memoryToken = null
  } else {
    // A failed replacement must not leave an older persisted token usable later.
    if (!secureRemove(TOKEN_KEY)) throw new Error('Failed to replace fleet token')
    memoryToken = token
  }
  setAppSetting('fleet.url', url)
  setAppSetting('fleet.deviceId', deviceId)
  setAppSetting('fleet.deviceName', deviceName)
  return memoryToken ? 'memory' : 'secure'
}

/**
 * This computer's own id for the paired server: what tells its workspaces host from this computer's profile and,
 * later, from the hosts of other servers. It is assigned on first use and lasts as long as the pairing.
 */
export function fleetServerId(): string {
  const stored = getAppSetting('fleet.serverId')
  if (stored) return stored
  const id = randomUUID()
  setAppSetting('fleet.serverId', id)
  return id
}

/** Moves the paired gateway to another address, such as a new local end of the SSH tunnel to a VPS. */
export function saveFleetUrl(url: string): void {
  setAppSetting('fleet.url', url)
}

export function clearFleetCredentials(): void {
  if (!secureRemove(TOKEN_KEY)) throw new Error('Failed to clear fleet token')
  memoryToken = null
  // The last two were kept by versions that summarized what happened while the Mac was off.
  for (const key of [
    'fleet.url',
    'fleet.deviceId',
    'fleet.deviceName',
    'fleet.serverId',
    'fleet.lastActivitySeq',
    'fleet.lastSeenAt',
  ])
    setAppSetting(key, '')
}

const SERVERS_KEY = 'fleet.servers'
const LEGACY_KEYS = [
  'fleet.url',
  'fleet.deviceId',
  'fleet.deviceName',
  'fleet.serverId',
  'fleet.lastActivitySeq',
  'fleet.lastSeenAt',
]
const tokenKey = (id: FleetServerId) => `${TOKEN_KEY}.${id}`
const memoryTokens = new Map<FleetServerId, string>()
const recordSchema = z
  .object({
    id: z.string().refine(isFleetServerId),
    url: z.string().min(1).max(2048),
    deviceId: z.string().min(1).max(128),
    deviceName: z.string().min(1).max(160),
    pairedAt: z.string().min(1).max(64),
  })
  .strict()

/** A server this computer is paired with: where it is, and which device this computer is to it. */
export type FleetServerRecord = {
  id: FleetServerId
  url: string
  deviceId: string
  deviceName: string
  pairedAt: string
}

export const newFleetServerId = (): FleetServerId => randomUUID() as FleetServerId

/** Moves the one server of an earlier version into the list of servers, once. */
export function migrateLegacyFleetSettings(now = () => new Date().toISOString()): void {
  if (getAppSetting(SERVERS_KEY)) return
  const url = getAppSetting('fleet.url')
  const deviceId = getAppSetting('fleet.deviceId')
  let keepLegacyToken = false
  if (url && deviceId) {
    const stored = getAppSetting('fleet.serverId')
    // The paired server keeps its id, so the hosts and everything stored under them keep theirs.
    const id = isFleetServerId(stored) ? stored : newFleetServerId()
    const token = secureGet(TOKEN_KEY)
    if (token) keepLegacyToken = saveFleetServerToken(id, token) === 'memory'
    const deviceName = getAppSetting('fleet.deviceName') || os.hostname()
    setAppSetting(SERVERS_KEY, JSON.stringify([{ id, url, deviceId, deviceName, pairedAt: now() }]))
  } else setAppSetting(SERVERS_KEY, '[]')
  if (!keepLegacyToken) secureRemove(TOKEN_KEY)
  for (const key of LEGACY_KEYS) setAppSetting(key, '')
}

/** The paired servers in pairing order; an entry that does not read back is left out. */
export function readFleetServerRecords(): FleetServerRecord[] {
  let raw: unknown
  try {
    raw = JSON.parse(getAppSetting(SERVERS_KEY) || '[]')
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const records: FleetServerRecord[] = []
  for (const entry of raw) {
    const parsed = recordSchema.safeParse(entry)
    if (parsed.success && !records.some((record) => record.id === parsed.data.id))
      records.push(parsed.data as FleetServerRecord)
  }
  return records
}

/** Replaces the record of the same server in place, or adds it last. */
export function writeFleetServerRecord(record: FleetServerRecord): void {
  const records = readFleetServerRecords()
  const at = records.findIndex((item) => item.id === record.id)
  if (at < 0) records.push(record)
  else records[at] = record
  setAppSetting(SERVERS_KEY, JSON.stringify(records))
}

/** Forgets a server: its record and its token. */
export function deleteFleetServerRecord(id: FleetServerId): void {
  if (!secureRemove(tokenKey(id))) throw new Error('Failed to clear fleet token')
  memoryTokens.delete(id)
  setAppSetting(SERVERS_KEY, JSON.stringify(readFleetServerRecords().filter((record) => record.id !== id)))
}

export function readFleetServerToken(id: FleetServerId): { token: string | null; persistence: TokenPersistence } {
  const memory = memoryTokens.get(id) ?? null
  return {
    token: memory ?? secureGet(tokenKey(id)),
    persistence: memory || !isSecureStorageAvailable() ? 'memory' : 'secure',
  }
}

export function saveFleetServerToken(id: FleetServerId, token: string): TokenPersistence {
  if (secureSet(tokenKey(id), token)) {
    memoryTokens.delete(id)
    return 'secure'
  }
  // A failed replacement must not leave an older persisted token usable later.
  if (!secureRemove(tokenKey(id))) throw new Error('Failed to replace fleet token')
  memoryTokens.set(id, token)
  return 'memory'
}
