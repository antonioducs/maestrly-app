import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { z } from 'zod'
import { type FleetServerId, isFleetServerId } from '../../../shared/fleet-servers'
import { getAppSetting, setAppSetting } from '../../store'
import { isSecureStorageAvailable, secureGet, secureRemove, secureSet } from '../../secure-store'

/** The key of the one server's token in earlier versions; each server's is `fleet.deviceToken.<id>`. */
const TOKEN_KEY = 'fleet.deviceToken'
/** Where a server's device token is kept: the OS keyring, or memory for this session only. */
export type TokenPersistence = 'secure' | 'memory'

const SERVERS_KEY = 'fleet.servers'
/**
 * Each server's installation id (`/v1/meta`'s `serverId`), by this computer's id for it. Kept apart from the records,
 * which earlier versions read strictly: an unknown field there would drop the record on a downgrade.
 */
const GATEWAY_IDS_KEY = 'fleet.gatewayIds'
const gatewayIdSchema = z.string().uuid()
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
  /** The installation id the server announced, by which this computer refuses pairing it twice; absent from older. */
  gatewayId?: string
}

function readGatewayIds(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(getAppSetting(GATEWAY_IDS_KEY) || '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(
      Object.entries(raw).filter(
        (entry): entry is [string, string] => isFleetServerId(entry[0]) && gatewayIdSchema.safeParse(entry[1]).success
      )
    )
  } catch {
    return {}
  }
}

function writeGatewayId(id: FleetServerId, gatewayId: string | undefined): void {
  const ids = readGatewayIds()
  if (ids[id] === gatewayId) return
  if (gatewayId) ids[id] = gatewayId
  else delete ids[id]
  setAppSetting(GATEWAY_IDS_KEY, JSON.stringify(ids))
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
  const gatewayIds = readGatewayIds()
  const records: FleetServerRecord[] = []
  for (const entry of raw) {
    const parsed = recordSchema.safeParse(entry)
    if (!parsed.success || records.some((record) => record.id === parsed.data.id)) continue
    const record = parsed.data as FleetServerRecord
    const gatewayId = gatewayIds[record.id]
    records.push(gatewayId ? { ...record, gatewayId } : record)
  }
  return records
}

/** Replaces the record of the same server in place, or adds it last. */
export function writeFleetServerRecord(record: FleetServerRecord): void {
  const { gatewayId, ...stored } = record
  const records = readFleetServerRecords().map(({ gatewayId: _, ...item }) => item)
  const at = records.findIndex((item) => item.id === record.id)
  if (at < 0) records.push(stored)
  else records[at] = stored
  setAppSetting(SERVERS_KEY, JSON.stringify(records))
  writeGatewayId(record.id, gatewayId)
}

/** Forgets a server: its record and its token. */
export function deleteFleetServerRecord(id: FleetServerId): void {
  if (!secureRemove(tokenKey(id))) throw new Error('Failed to clear fleet token')
  memoryTokens.delete(id)
  setAppSetting(
    SERVERS_KEY,
    JSON.stringify(
      readFleetServerRecords()
        .filter((record) => record.id !== id)
        .map(({ gatewayId: _, ...record }) => record)
    )
  )
  writeGatewayId(id, undefined)
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
