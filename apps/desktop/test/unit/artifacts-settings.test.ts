import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getArtifactSettings, setArtifactSettings } from '../../src/main/artifacts/settings'
import { setAppSetting } from '../../src/main/store'
import { DEFAULT_ARTIFACT_SETTINGS } from '../../src/shared/artifacts'
import { closeDb, freshDb } from '../helpers/db'

beforeEach(freshDb)
afterEach(closeDb)

describe('artifact settings', () => {
  it('defaults to hosting on port 4010 with 2 GB, no public address and links that last 30 days', () => {
    expect(getArtifactSettings()).toEqual(DEFAULT_ARTIFACT_SETTINGS)
    expect(DEFAULT_ARTIFACT_SETTINGS).toEqual({
      hostEnabled: true,
      port: 4010,
      quotaGb: 2,
      publicAddress: '',
      ownerName: '',
      linkExpiryDays: 30,
    })
  })

  it('persists valid settings', () => {
    const saved = {
      hostEnabled: false,
      port: 5000,
      quotaGb: 3,
      publicAddress: 'https://mac.tail1234.ts.net:8443',
      ownerName: 'Antonio',
      linkExpiryDays: null,
    }
    expect(setArtifactSettings(saved)).toEqual(saved)
    expect(getArtifactSettings()).toEqual(saved)
    expect(setArtifactSettings({ ...saved, linkExpiryDays: 365, publicAddress: '', ownerName: '' })).toEqual({
      ...saved,
      linkExpiryDays: 365,
      publicAddress: '',
      ownerName: '',
    })
    expect(getArtifactSettings()).toMatchObject({ linkExpiryDays: 365, publicAddress: '', ownerName: '' })
  })

  it('stores the public address as an origin', () => {
    const save = (publicAddress: string) =>
      setArtifactSettings({ ...DEFAULT_ARTIFACT_SETTINGS, publicAddress }).publicAddress
    expect(save('https://x.example/')).toBe('https://x.example')
    expect(save('  HTTPS://X.example:443  ')).toBe('https://x.example')
    expect(save('http://192.168.0.10:4010')).toBe('http://192.168.0.10:4010')
    expect(save(' ')).toBe('')
  })

  it('trims the owner name', () => {
    expect(setArtifactSettings({ ...DEFAULT_ARTIFACT_SETTINGS, ownerName: '  Antonio  ' }).ownerName).toBe('Antonio')
    expect(setArtifactSettings({ ...DEFAULT_ARTIFACT_SETTINGS, ownerName: 'x'.repeat(60) }).ownerName).toHaveLength(60)
  })

  it.each([
    { port: 80 },
    { port: 70000 },
    { port: 4010.5 },
    { quotaGb: 0 },
    { hostEnabled: 'yes' },
    { publicAddress: 'https://x.example/path' },
    { publicAddress: 'https://x.example/?q=1' },
    { publicAddress: 'https://x.example/#frag' },
    { publicAddress: 'https://user:secret@x.example' },
    { publicAddress: 'ftp://x' },
    { publicAddress: 'just some text' },
    { publicAddress: 42 },
    { ownerName: 'x'.repeat(61) },
    { ownerName: 'Two\nlines' },
    { linkExpiryDays: 0 },
    { linkExpiryDays: 366 },
    { linkExpiryDays: 1.5 },
    { linkExpiryDays: '30' },
  ])('rejects %j without saving', (change) => {
    expect(() => setArtifactSettings({ ...DEFAULT_ARTIFACT_SETTINGS, ...change })).toThrow()
    expect(getArtifactSettings()).toEqual(DEFAULT_ARTIFACT_SETTINGS)
  })

  it('rejects settings with missing fields', () => {
    expect(() => setArtifactSettings({ hostEnabled: true, port: 4010, quotaGb: 2 })).toThrow()
  })

  it('falls back to defaults for corrupt stored values', () => {
    setAppSetting('artifacts.port', 'nope')
    setAppSetting('artifacts.quotaGb', '-4')
    setAppSetting('artifacts.publicAddress', 'not a url')
    setAppSetting('artifacts.ownerName', 'x'.repeat(200))
    setAppSetting('artifacts.linkExpiryDays', '9000')
    expect(getArtifactSettings()).toEqual(DEFAULT_ARTIFACT_SETTINGS)
  })
})
