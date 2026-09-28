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

/** Moves the paired gateway to another address, such as a new local end of the SSH tunnel to a VPS. */
export function saveFleetUrl(url: string): void {
  setAppSetting('fleet.url', url)
}

export function clearFleetCredentials(): void {
  if (!secureRemove(TOKEN_KEY)) throw new Error('Failed to clear fleet token')
  memoryToken = null
  // The last two were kept by versions that summarized what happened while the Mac was off.
  for (const key of ['fleet.url', 'fleet.deviceId', 'fleet.deviceName', 'fleet.lastActivitySeq', 'fleet.lastSeenAt'])
    setAppSetting(key, '')
}
