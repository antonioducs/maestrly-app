import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INSTALLED_KEY,
  type InstalledPluginRecord,
  MARKETPLACES_KEY,
  SECRETS_PREFIX,
  listInstalled,
  listMarketplaces,
  marketplaceId,
  pluginServerId,
  readPluginSecrets,
  removeMarketplaceRecord,
  removePluginSecrets,
  writeInstalled,
  writePluginSecrets,
} from '../../src/main/plugins/store'
import * as store from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'

const secrets = vi.hoisted(() => ({ values: new Map<string, string>(), available: true }))
vi.mock('../../src/main/secure-store', () => ({
  isSecureStorageAvailable: () => secrets.available,
  secureGet: (key: string) => (secrets.available ? (secrets.values.get(key) ?? null) : null),
  secureSet: (key: string, value: string) => {
    if (!secrets.available) return false
    secrets.values.set(key, value)
    return true
  },
  secureRemove: (key: string) => secrets.values.delete(key),
}))

beforeEach(() => {
  freshDb()
  secrets.values.clear()
  secrets.available = true
})
afterEach(() => closeDb())

const record = (key: string): InstalledPluginRecord => ({
  key,
  name: key.split('@')[0],
  marketplaceId: 'mkt_1',
  source: { kind: 'marketplace', path: 'plugins/demo' },
  format: 'codex',
  version: '1.0.0',
  commit: 'a'.repeat(40),
  treeOid: 'b'.repeat(40),
  digest: 'c'.repeat(64),
  dirName: 'cccccccccccc',
  enabled: true,
  scope: { kind: 'global' },
  consent: { stdio: {}, executables: false, fingerprint: 'f', acceptedAt: 1 },
  servers: {},
  available: null,
  status: 'ready',
  previous: null,
  installedAt: 1,
  updatedAt: 1,
})

describe('plugin store', () => {
  it('seeds the two presets once without fetching them', () => {
    const list = listMarketplaces()
    expect(list.map((m) => [m.url, m.preset, m.commit])).toEqual([
      ['https://github.com/openai/plugins.git', 'openai-plugins', null],
      ['https://github.com/openai/community-plugins.git', 'openai-community-plugins', null],
    ])
    removeMarketplaceRecord(list[0].id)
    expect(listMarketplaces().map((m) => m.preset)).toEqual(['openai-community-plugins'])
    expect(JSON.parse(store.getAppSetting(MARKETPLACES_KEY)!)).toHaveLength(1)
  })

  it('derives stable ids', () => {
    expect(pluginServerId('demo@m', 'local')).toBe(pluginServerId('demo@m', 'local'))
    expect(pluginServerId('demo@m', 'local')).toMatch(/^plg_[0-9a-f]{20}$/)
    expect(pluginServerId('demo@m', 'local')).not.toBe(pluginServerId('demo@m', 'other'))
    expect(marketplaceId('https://x', null, [])).toMatch(/^mkt_[0-9a-f]{16}$/)
    expect(marketplaceId('https://x', 'v1', [])).not.toBe(marketplaceId('https://x', null, []))
  })

  it('never stores input values in the installed records', () => {
    writeInstalled((all) => {
      all['demo@m'] = record('demo@m')
    })
    writePluginSecrets('demo@m', { 'env:local:API_TOKEN': 'synthetic-value' })
    expect(store.getAppSetting(INSTALLED_KEY)).not.toContain('synthetic-value')
    expect(readPluginSecrets('demo@m')).toEqual({ 'env:local:API_TOKEN': 'synthetic-value' })
    removePluginSecrets('demo@m')
    expect(readPluginSecrets('demo@m')).toEqual({})
  })

  it('refuses to store inputs without secure storage', () => {
    secrets.available = false
    expect(() => writePluginSecrets('demo@m', { a: 'b' })).toThrow('secure-storage-unavailable')
  })

  it('reports unreadable inputs as null', () => {
    store.setAppSetting(SECRETS_PREFIX + 'demo@m', 'enc:v1:corrupt')
    expect(readPluginSecrets('demo@m')).toBeNull()
    expect(readPluginSecrets('other@m')).toEqual({})
  })

  it('writes installed records atomically', () => {
    writeInstalled((all) => {
      all['a@m'] = record('a@m')
    })
    expect(() =>
      writeInstalled((all) => {
        all['b@m'] = record('b@m')
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(Object.keys(listInstalled())).toEqual(['a@m'])
  })
})
