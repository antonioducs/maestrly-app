import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  secure: new Map<string, string>(),
  secureAvailable: true,
  failSecureSet: new Set<string>(),
}))
vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => state.settings.get(key) ?? null,
  setAppSetting: (key: string, value: string) => {
    state.settings.set(key, value)
  },
}))
vi.mock('../../src/main/secure-store', () => ({
  isSecureStorageAvailable: () => state.secureAvailable,
  secureGet: (key: string) => (state.secureAvailable ? (state.secure.get(key) ?? null) : null),
  secureSet: (key: string, value: string) => {
    if (!state.secureAvailable || state.failSecureSet.has(key)) return false
    state.secure.set(key, value)
    return true
  },
  secureRemove: (key: string) => {
    state.secure.delete(key)
    return true
  },
}))

import {
  deleteFleetServerRecord,
  migrateLegacyFleetSettings,
  newFleetServerId,
  readFleetServerRecords,
  readFleetServerToken,
  saveFleetServerToken,
  writeFleetServerRecord,
} from '../../src/main/fleet/client/settings'
import { type FleetServerId, isFleetServerId } from '../../src/shared/fleet-servers'

const S = '5f0c2a9e-7b1d-4c3e-9a8f-0d1e2f3a4b5c' as FleetServerId
const now = () => '2026-10-19T00:00:00.000Z'
const LEGACY = [
  'fleet.url',
  'fleet.deviceId',
  'fleet.deviceName',
  'fleet.serverId',
  'fleet.lastActivitySeq',
  'fleet.lastSeenAt',
]
const record = (id: FleetServerId, url = 'http://127.0.0.1:7443') => ({
  id,
  url,
  deviceId: 'device-' + id.slice(0, 4),
  deviceName: 'Mac',
  pairedAt: now(),
})
function pairLegacy(serverId: string | null = S) {
  state.settings.set('fleet.url', 'http://127.0.0.1:7443')
  state.settings.set('fleet.deviceId', 'device-1')
  state.settings.set('fleet.deviceName', 'Mac')
  if (serverId) state.settings.set('fleet.serverId', serverId)
  state.secure.set('fleet.deviceToken', 'T')
}

beforeEach(() => {
  state.settings.clear()
  state.secure.clear()
  state.secureAvailable = true
  state.failSecureSet.clear()
})

describe('fleet server records', () => {
  it('moves the paired server of an earlier version into a record that keeps its id', () => {
    pairLegacy()
    migrateLegacyFleetSettings(now)
    expect(readFleetServerRecords()).toEqual([
      { id: S, url: 'http://127.0.0.1:7443', deviceId: 'device-1', deviceName: 'Mac', pairedAt: now() },
    ])
    expect(readFleetServerToken(S)).toEqual({ token: 'T', persistence: 'secure' })
    expect(state.secure.has('fleet.deviceToken')).toBe(false)
    for (const key of LEGACY) expect(state.settings.get(key) ?? '').toBe('')
  })

  it('gives the server a new id when the earlier version never named it', () => {
    pairLegacy(null)
    migrateLegacyFleetSettings(now)
    const [only] = readFleetServerRecords()
    expect(isFleetServerId(only.id)).toBe(true)
    expect(readFleetServerToken(only.id).token).toBe('T')
  })

  it('migrates once', () => {
    pairLegacy()
    migrateLegacyFleetSettings(now)
    state.settings.set('fleet.url', 'http://127.0.0.1:9999')
    state.settings.set('fleet.deviceId', 'device-2')
    migrateLegacyFleetSettings(now)
    expect(readFleetServerRecords().map((item) => item.url)).toEqual(['http://127.0.0.1:7443'])
  })

  it('starts an empty list when nothing was paired', () => {
    migrateLegacyFleetSettings(now)
    expect(state.settings.get('fleet.servers')).toBe('[]')
    expect(readFleetServerRecords()).toEqual([])
  })

  it('keeps the record without a keyring, where the token never outlived the session', () => {
    pairLegacy()
    state.secureAvailable = false
    migrateLegacyFleetSettings(now)
    expect(readFleetServerRecords().map((item) => item.id)).toEqual([S])
    expect(readFleetServerToken(S)).toEqual({ token: null, persistence: 'memory' })
  })

  it('keeps the legacy token when the new key cannot hold it', () => {
    pairLegacy()
    state.failSecureSet.add(`fleet.deviceToken.${S}`)
    migrateLegacyFleetSettings(now)
    expect(state.secure.get('fleet.deviceToken')).toBe('T')
    expect(readFleetServerToken(S)).toEqual({ token: 'T', persistence: 'memory' })
  })

  it('drops records that fail the schema and repeated ids', () => {
    const other = newFleetServerId()
    state.settings.set(
      'fleet.servers',
      JSON.stringify([record(S), { ...record(other), url: '' }, record(S, 'http://127.0.0.1:8000'), { id: 'A/B' }, 7])
    )
    expect(readFleetServerRecords()).toEqual([record(S)])
    state.settings.set('fleet.servers', '{not json')
    expect(readFleetServerRecords()).toEqual([])
  })

  it('replaces a record in place, appends a new one, and deletes one with its token', () => {
    const other = newFleetServerId()
    writeFleetServerRecord(record(S))
    writeFleetServerRecord(record(other))
    writeFleetServerRecord(record(S, 'http://127.0.0.1:7471'))
    expect(readFleetServerRecords().map((item) => [item.id, item.url])).toEqual([
      [S, 'http://127.0.0.1:7471'],
      [other, 'http://127.0.0.1:7443'],
    ])
    expect(saveFleetServerToken(S, 'secret')).toBe('secure')
    deleteFleetServerRecord(S)
    expect(readFleetServerRecords().map((item) => item.id)).toEqual([other])
    expect(state.secure.has(`fleet.deviceToken.${S}`)).toBe(false)
    expect(readFleetServerToken(S).token).toBeNull()
  })

  it('keeps the installation id apart from the records an earlier version reads strictly', () => {
    const GATEWAY = '11111111-2222-4333-8444-555555555555'
    writeFleetServerRecord({ ...record(S), gatewayId: GATEWAY })
    expect(readFleetServerRecords()).toEqual([{ ...record(S), gatewayId: GATEWAY }])
    // What 0.24 reads: the record as it knew it, without a field its strict schema would refuse.
    expect(JSON.parse(state.settings.get('fleet.servers') ?? '')).toEqual([record(S)])
    writeFleetServerRecord(record(S, 'http://127.0.0.1:7471'))
    expect(readFleetServerRecords()[0].gatewayId).toBeUndefined()
    writeFleetServerRecord({ ...record(S), gatewayId: GATEWAY })
    state.settings.set('fleet.gatewayIds', JSON.stringify({ [S]: GATEWAY, 'A/B': GATEWAY, other: 'not-a-uuid' }))
    expect(readFleetServerRecords()[0].gatewayId).toBe(GATEWAY)
    deleteFleetServerRecord(S)
    expect(JSON.parse(state.settings.get('fleet.gatewayIds') ?? '')).toEqual({})
  })

  it('keeps a token in memory without a keyring', () => {
    state.secureAvailable = false
    expect(saveFleetServerToken(S, 'secret')).toBe('memory')
    expect(readFleetServerToken(S)).toEqual({ token: 'secret', persistence: 'memory' })
    deleteFleetServerRecord(S)
    expect(readFleetServerToken(S).token).toBeNull()
  })
})
