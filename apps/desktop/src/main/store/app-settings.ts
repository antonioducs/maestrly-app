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
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value ? '1' : '0')
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
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}
