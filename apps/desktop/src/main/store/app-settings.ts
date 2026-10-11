import { randomUUID } from 'node:crypto'
import { getDb } from './db'

// ---- global app settings as key/value pairs ----

/** Read a global Boolean setting, falling back to dflt when absent. */
export function getAppFlag(key: string, dflt: boolean): boolean {
  const r = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: string } | undefined
  if (!r || r.value == null) return dflt
  return r.value === '1'
}

/** Upsert a global Boolean setting. */
export function setAppFlag(key: string, value: boolean): void {
  setAppSetting(key, value ? '1' : '0')
}

/**
 * Read a raw string setting, or null when absent. Unlike Boolean flags, callers choose parsing, such
 * as JSON for cached CLI status.
 */
export function getAppSetting(key: string): string | null {
  const r = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: string } | undefined
  return r?.value ?? null
}

/** Upsert a raw string setting. */
export function setAppSetting(key: string, value: string): void {
  const previous = getAppSetting(key)
  const db = getDb()
  db.exec('SAVEPOINT fleet_settings_write')
  try {
    db.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value)
    if (previous !== value) invalidateSettingsRevisions(key, previous, value)
    db.exec('RELEASE fleet_settings_write')
  } catch (error) {
    db.exec('ROLLBACK TO fleet_settings_write; RELEASE fleet_settings_write')
    throw error
  }
}

/** Revision writes bypass observation: revision values are random tokens, never hashes of secrets. */
export function writeSettingsRevision(resource: string): void {
  getDb()
    .prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run('fleet.settings.revision.' + resource, randomUUID())
}
function json(raw: string | null): unknown {
  try {
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}
function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function ids(raw: string | null): string[] {
  const value = json(raw)
  return Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item === 'string' ? [item] : typeof object(item).id === 'string' ? [String(object(item).id)] : []
      )
    : Object.keys(object(value))
}
/**
 * Observe local edits, imports and remote edits at their shared durable write boundary.
 * Resource keys: accounts (aggregate), models:<providerId>, skill:<name>, skill-groups,
 * mcp:<id> and mcp (aggregate), preferences, runtime:<id>.
 */
function invalidateSettingsRevisions(key: string, previous: string | null, value: string): void {
  if (key.startsWith('fleet.settings.')) return
  const resources = new Set<string>()
  if (
    ['chat.providers', 'chat.subscriptionAccounts', 'chat.subscriptionDefaultLabels', 'chat.chatgptWeb'].includes(key)
  ) {
    resources.add('accounts')
    for (const id of [...ids(previous), ...ids(value)]) resources.add('models:' + id)
  }
  if (key.startsWith('chat.apiKey.')) resources.add('accounts')
  if (key.startsWith('chat.mcpServer.')) {
    resources.add('mcp')
    resources.add('mcp:' + key.slice('chat.mcpServer.'.length))
  }
  if (key === 'chat.hiddenModels') {
    const before = object(json(previous)),
      after = object(json(value))
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (JSON.stringify(before[id]) !== JSON.stringify(after[id])) resources.add('models:' + id)
  }
  if (key === 'chat.mcpServers') {
    resources.add('mcp')
    const records = (raw: string | null) => {
      const list = json(raw)
      return new Map<string, string>(
        Array.isArray(list)
          ? list.flatMap((item) =>
              typeof object(item).id === 'string' ? [[String(object(item).id), JSON.stringify(item)]] : []
            )
          : []
      )
    }
    const before = records(previous),
      after = records(value)
    for (const id of new Set([...before.keys(), ...after.keys()]))
      if (before.get(id) !== after.get(id)) resources.add('mcp:' + id)
  }
  if (key === 'chat.skills.groups.v1') resources.add('skill-groups')
  if (key === 'chat.skills.disabled' || key === 'chat.skills.installed')
    for (const name of [...ids(previous), ...ids(value)]) resources.add('skill:' + name)
  if (key === 'chat.imageGen') resources.add('preferences')
  const runtimes: Record<string, string> = {
    'runtimeAssets.claudeCodeReleases': 'claude-code',
    'runtimeAssets.codexReleases': 'codex',
    'runtimeAssets.antigravityReleases': 'antigravity-acp',
  }
  if (Object.hasOwn(runtimes, key)) resources.add('runtime:' + runtimes[key])
  for (const resource of resources) writeSettingsRevision(resource)
}
