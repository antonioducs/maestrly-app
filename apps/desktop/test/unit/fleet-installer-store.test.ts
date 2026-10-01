import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetInstallRecord } from '../../src/shared/fleet-installer'

const settings = vi.hoisted(() => new Map<string, string>())
vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => settings.get(key),
  setAppSetting: (key: string, value: string) => settings.set(key, value),
}))
vi.mock('../../src/main/secure-store', () => ({
  isSecureStorageAvailable: () => false,
  secureGet: () => null,
  secureRemove: () => {},
  secureSet: () => false,
}))
import { readInstallRecord, writeInstallRecord } from '../../src/main/fleet/installer/store'

beforeEach(() => settings.clear())
const legacy: FleetInstallRecord = {
  mode: 'local',
  version: '0.9.4',
  port: 7443,
  allowPrivateNetwork: false,
  remote: null,
  installedAt: '2026-09-27T12:00:00.000Z',
}

describe('installer record compatibility', () => {
  it('loads legacy records without artifact fields and round trips additive fields', () => {
    settings.set('fleet.installer', JSON.stringify(legacy))
    expect(readInstallRecord()).toEqual(legacy)
    const upgraded = { ...legacy, artifactsOnly: true, artifactsPort: 4011, remoteArtifactsPort: 4210 }
    writeInstallRecord(upgraded)
    expect(readInstallRecord()).toEqual(upgraded)
    writeInstallRecord({ ...legacy, artifactsPort: null })
    expect(readInstallRecord()?.artifactsPort).toBeNull()
  })

  it('rejects malformed additions without overwriting a valid record', () => {
    writeInstallRecord(legacy)
    expect(() => writeInstallRecord({ ...legacy, artifactsPort: 65536 })).toThrow()
    expect(readInstallRecord()).toEqual(legacy)
    settings.set('fleet.installer', JSON.stringify({ ...legacy, artifactsOnly: 'yes' }))
    expect(readInstallRecord()).toBeNull()
  })
})
