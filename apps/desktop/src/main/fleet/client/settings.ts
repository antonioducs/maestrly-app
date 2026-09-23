import { getAppSetting, setAppSetting } from '../../store'
import { isSecureStorageAvailable, secureGet, secureRemove, secureSet } from '../../secure-store'

const TOKEN_KEY = 'fleet.deviceToken'
let memoryToken: string | null = null

export type TokenPersistence = 'secure' | 'memory'

export function readFleetSettings(): {
  url: string | null
  deviceId: string | null
  deviceName: string | null
  lastActivitySeq: number | null
  lastSeenAt: number | null
  token: string | null
  tokenPersistence: TokenPersistence
} {
  const rawSeq = getAppSetting('fleet.lastActivitySeq')
  const seq = rawSeq === null || rawSeq === '' ? null : Number(rawSeq)
  const rawSeenAt = getAppSetting('fleet.lastSeenAt')
  const seenAt = rawSeenAt === null || rawSeenAt === '' ? null : Number(rawSeenAt)
  const secureToken = secureGet(TOKEN_KEY)
  return {
    url: getAppSetting('fleet.url') || null,
    deviceId: getAppSetting('fleet.deviceId') || null,
    deviceName: getAppSetting('fleet.deviceName') || null,
    lastActivitySeq: seq !== null && Number.isSafeInteger(seq) && seq >= 0 ? seq : null,
    lastSeenAt: seenAt !== null && Number.isSafeInteger(seenAt) && seenAt >= 0 ? seenAt : null,
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
  setAppSetting('fleet.lastActivitySeq', '')
  setAppSetting('fleet.lastSeenAt', '')
  return memoryToken ? 'memory' : 'secure'
}

export function saveLastActivitySeq(seq: number): void {
  setAppSetting('fleet.lastActivitySeq', String(seq))
}

export function saveLastSeenAt(at: number): void {
  setAppSetting('fleet.lastSeenAt', String(at))
}

export function clearFleetCredentials(): void {
  if (!secureRemove(TOKEN_KEY)) throw new Error('Failed to clear fleet token')
  memoryToken = null
  for (const key of ['fleet.url', 'fleet.deviceId', 'fleet.deviceName', 'fleet.lastActivitySeq', 'fleet.lastSeenAt'])
    setAppSetting(key, '')
}
