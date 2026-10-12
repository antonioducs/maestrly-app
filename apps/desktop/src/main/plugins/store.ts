import { createHash } from 'node:crypto'
import type {
  PluginFormat,
  PluginMarketplaceDto,
  PluginMarketplacePreset,
  PluginPolicyDto,
  PluginScope,
  PluginSourceErrorCode,
} from '../../shared/plugins'
import { isSecureStorageAvailable, secureGet, secureRemove, secureSet } from '../secure-store'
import { getAppSetting, setAppSetting, transaction } from '../store'

/**
 * Plugin records in `app_settings`. Identities and state are plain JSON; every value the user enters for a plugin
 * (tokens, keys, options) lives in one encrypted record per plugin, written only through secure storage.
 */

export const MARKETPLACES_KEY = 'plugins.marketplaces.v1'
export const INSTALLED_KEY = 'plugins.installed.v1'
export const PRESETS_SEEDED_KEY = 'plugins.presetsSeeded.v1'
export const SECRETS_PREFIX = 'plugins.secrets.'

export interface MarketplaceRecord {
  id: string
  url: string
  ref: string | null
  sparsePaths: string[]
  preset: PluginMarketplaceDto['preset']
  name: string | null
  displayName: string | null
  format: 'codex' | 'claude' | 'single-plugin' | null
  commit: string | null
  fetchedAt: number | null
  error: PluginSourceErrorCode | null
  pluginCount: number | null
  addedAt: number
}

export interface InstalledPluginRecord {
  key: string
  name: string
  marketplaceId: string
  source: { kind: 'marketplace'; path: string } | { kind: 'git'; url: string; ref: string | null; path: string | null }
  format: PluginFormat
  version: string | null
  commit: string
  treeOid: string
  digest: string
  dirName: string
  enabled: boolean
  scope: PluginScope
  /** stdio: serverKey → launch digest the user approved; fingerprint of everything shown at consent. */
  consent: { stdio: Record<string, string>; executables: boolean; fingerprint: string; acceptedAt: number }
  servers: Record<string, { id: string; enabled: boolean }>
  available: { commit: string; treeOid: string; checkedAt: number } | null
  status: 'ready' | 'installing' | 'updating' | 'removing'
  previous: { dirName: string; commit: string; treeOid: string; digest: string } | null
  installedAt: number
  updatedAt: number
  /** Namespaced skill names of the installed version, cleaned from skill settings on removal. */
  skillNames?: string[]
  /** How to reload the installed package (a Claude marketplace entry may act as its manifest). */
  loadOptions?: {
    claudeEntry?: { strict: boolean; fields: Record<string, unknown> }
    displayOverrides?: { displayName?: string; description?: string; category?: string }
    rootName?: string
  }
  displayName?: string
  policy?: PluginPolicyDto
}

export const PRESET_MARKETPLACES: readonly { preset: PluginMarketplacePreset; url: string }[] = [
  { preset: 'openai-plugins', url: 'https://github.com/openai/plugins.git' },
  { preset: 'openai-community-plugins', url: 'https://github.com/openai/community-plugins.git' },
]

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export function marketplaceId(url: string, ref: string | null, sparsePaths: readonly string[]): string {
  return `mkt_${sha256(JSON.stringify([url, ref, [...sparsePaths]])).slice(0, 16)}`
}

/** Stable across updates, so per-conversation MCP toggles and the tool catalog survive a new version. */
export function pluginServerId(key: string, serverKey: string): string {
  return `plg_${sha256(`${key}\0${serverKey}`).slice(0, 20)}`
}

export const isPluginServerId = (id: string): boolean => /^plg_[0-9a-f]{20}$/.test(id)

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function readMarketplaces(): MarketplaceRecord[] {
  const list = parseJson<unknown>(getAppSetting(MARKETPLACES_KEY), [])
  return Array.isArray(list)
    ? (list as MarketplaceRecord[]).filter(
        (item) => item && typeof item.id === 'string' && typeof item.url === 'string'
      )
    : []
}

/** Marketplace sources; the two presets are added once (never fetched until the user opens or refreshes them). */
export function listMarketplaces(): MarketplaceRecord[] {
  if (getAppSetting(PRESETS_SEEDED_KEY) !== '1') {
    transaction(() => {
      if (getAppSetting(PRESETS_SEEDED_KEY) === '1') return
      const list = readMarketplaces()
      const now = Date.now()
      for (const { preset, url } of PRESET_MARKETPLACES) {
        const id = marketplaceId(url, null, [])
        if (list.some((item) => item.id === id)) continue
        list.push({
          id,
          url,
          ref: null,
          sparsePaths: [],
          preset,
          name: null,
          displayName: null,
          format: null,
          commit: null,
          fetchedAt: null,
          error: null,
          pluginCount: null,
          addedAt: now,
        })
      }
      setAppSetting(MARKETPLACES_KEY, JSON.stringify(list))
      setAppSetting(PRESETS_SEEDED_KEY, '1')
    })
  }
  return readMarketplaces()
}

export function getMarketplace(id: string): MarketplaceRecord | undefined {
  return listMarketplaces().find((item) => item.id === id)
}

export function saveMarketplace(record: MarketplaceRecord): void {
  transaction(() => {
    const list = listMarketplaces()
    const index = list.findIndex((item) => item.id === record.id)
    if (index >= 0) list[index] = record
    else list.push(record)
    setAppSetting(MARKETPLACES_KEY, JSON.stringify(list))
  })
}

export function removeMarketplaceRecord(id: string): void {
  transaction(() => {
    setAppSetting(MARKETPLACES_KEY, JSON.stringify(listMarketplaces().filter((item) => item.id !== id)))
  })
}

export function listInstalled(): Record<string, InstalledPluginRecord> {
  const value = parseJson<unknown>(getAppSetting(INSTALLED_KEY), {})
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, InstalledPluginRecord> = {}
  for (const [key, record] of Object.entries(value as Record<string, InstalledPluginRecord>))
    if (record && typeof record === 'object' && record.key === key) out[key] = record
  return out
}

const listeners = new Set<() => void>()
/** Called after every committed change of the installed plugins (runtime caches subscribe). */
export function onInstalledChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Mutates the installed records inside one transaction; a throwing `mutate` changes nothing. */
export function writeInstalled(mutate: (all: Record<string, InstalledPluginRecord>) => void): void {
  transaction(() => {
    const all = listInstalled()
    mutate(all)
    setAppSetting(INSTALLED_KEY, JSON.stringify(all))
  })
  for (const listener of listeners) listener()
}

/** The plugin's input values; null when a stored record cannot be decrypted or parsed (its servers stay unavailable). */
export function readPluginSecrets(key: string): Record<string, string> | null {
  const decrypted = secureGet(SECRETS_PREFIX + key)
  if (decrypted === null) {
    const raw = getAppSetting(SECRETS_PREFIX + key)
    return raw === null || raw === '' ? {} : null
  }
  try {
    const value = JSON.parse(decrypted)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
  } catch {
    return null
  }
}

/** Replaces the plugin's input values; throws `secure-storage-unavailable` instead of storing them in clear. */
export function writePluginSecrets(key: string, values: Record<string, string>): void {
  if (!Object.keys(values).length) {
    removePluginSecrets(key)
    return
  }
  if (!isSecureStorageAvailable() || !secureSet(SECRETS_PREFIX + key, JSON.stringify(values)))
    throw new Error('secure-storage-unavailable')
}

export function removePluginSecrets(key: string): void {
  secureRemove(SECRETS_PREFIX + key)
}
