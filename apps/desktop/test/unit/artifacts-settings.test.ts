import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getArtifactSettings, setArtifactSettings } from '../../src/main/artifacts/settings'
import { setAppSetting } from '../../src/main/store'
import { DEFAULT_ARTIFACT_SETTINGS } from '../../src/shared/artifacts'
import { closeDb, freshDb } from '../helpers/db'

beforeEach(freshDb)
afterEach(closeDb)

describe('artifact settings', () => {
  it('defaults to hosting on port 4010 with 2 GB', () => {
    expect(getArtifactSettings()).toEqual(DEFAULT_ARTIFACT_SETTINGS)
    expect(DEFAULT_ARTIFACT_SETTINGS).toEqual({ hostEnabled: true, port: 4010, quotaGb: 2 })
  })

  it('persists valid settings', () => {
    expect(setArtifactSettings({ hostEnabled: false, port: 5000, quotaGb: 3 })).toEqual({
      hostEnabled: false,
      port: 5000,
      quotaGb: 3,
    })
    expect(getArtifactSettings()).toEqual({ hostEnabled: false, port: 5000, quotaGb: 3 })
  })

  it.each([
    { hostEnabled: true, port: 80, quotaGb: 2 },
    { hostEnabled: true, port: 70000, quotaGb: 2 },
    { hostEnabled: true, port: 4010.5, quotaGb: 2 },
    { hostEnabled: true, port: 4010, quotaGb: 0 },
    { hostEnabled: 'yes', port: 4010, quotaGb: 2 },
  ])('rejects %j without saving', (input) => {
    expect(() => setArtifactSettings(input)).toThrow()
    expect(getArtifactSettings()).toEqual(DEFAULT_ARTIFACT_SETTINGS)
  })

  it('falls back to defaults for corrupt stored values', () => {
    setAppSetting('artifacts.port', 'nope')
    setAppSetting('artifacts.quotaGb', '-4')
    expect(getArtifactSettings()).toEqual(DEFAULT_ARTIFACT_SETTINGS)
  })
})
