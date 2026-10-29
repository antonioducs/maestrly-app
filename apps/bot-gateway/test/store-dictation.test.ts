import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store.js'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // Closed by the test.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gateway-dictation-'))
  dirs.push(dir)
  return dir
}
function open(dir: string): Store {
  const store = new Store(dir)
  stores.push(store)
  return store
}
const version = (db: DatabaseSync) =>
  (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value

describe('server dictation key', () => {
  it('starts with no key on schema 20', () => {
    const store = open(tempDir())
    expect(store.dictationSettings()).toBeNull()
    expect(version(store.db)).toBe('23')
  })

  it('keeps one key, replaced by the next one', () => {
    const store = open(tempDir())
    store.saveDictationSettings('openai', 'sk-a', 'Mac')
    expect(store.dictationSettings()).toMatchObject({ provider: 'openai', key: 'sk-a', updatedBy: 'Mac' })
    store.saveDictationSettings('groq', 'gk-b', 'iPhone')
    expect(store.dictationSettings()).toMatchObject({ provider: 'groq', key: 'gk-b', updatedBy: 'iPhone' })
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM dictation_settings').get()).toEqual({ n: 1 })
    expect(store.dictationSettings()?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('removes the key', () => {
    const store = open(tempDir())
    store.saveDictationSettings('openai', 'sk-a', 'Mac')
    expect(store.clearDictationSettings()).toBe(true)
    expect(store.dictationSettings()).toBeNull()
    expect(store.clearDictationSettings()).toBe(false)
  })

  it('migrates a schema 19 database in place', () => {
    const dir = tempDir()
    open(dir).close()
    const raw = new DatabaseSync(path.join(dir, 'gateway.sqlite'))
    raw.exec('DROP TABLE dictation_settings')
    raw.prepare("UPDATE meta SET value='19' WHERE key='schema_version'").run()
    raw.close()
    const store = open(dir)
    expect(version(store.db)).toBe('23')
    expect(store.dictationSettings()).toBeNull()
    store.saveDictationSettings('groq', 'gk-1', 'Mac')
    expect(store.dictationSettings()?.provider).toBe('groq')
  })

  it('ignores a row whose provider it does not know', () => {
    const store = open(tempDir())
    store.db
      .prepare(
        "INSERT INTO dictation_settings(id,provider,api_key,updated_at,updated_by) VALUES(1,'azure','k','2026-10-18T00:00:00.000Z','Mac')"
      )
      .run()
    expect(store.dictationSettings()).toBeNull()
  })
})
