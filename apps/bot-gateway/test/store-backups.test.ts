import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store.js'
import {
  at,
  backupRun,
  backupSettings,
  botRecord,
  environmentRecord,
  environmentSecrets,
  gatewaySecrets,
} from './backup-fixtures.js'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close()
    } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'store-backups-'))
  dirs.push(dir)
  return dir
}
function open(dir = temp()) {
  const store = new Store(dir)
  stores.push(store)
  return store
}
const version = (db: DatabaseSync) =>
  String((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: unknown }).value)
const tables = (db: DatabaseSync) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'backup_%' ORDER BY name").all() as {
      name: string
    }[]
  ).map((row) => row.name)

describe('backup records', () => {
  it('creates the backup tables on schema 24', () => {
    const store = open()
    expect(version(store.db)).toBe('24')
    expect(tables(store.db)).toEqual(['backup_environments', 'backup_runs', 'backup_settings'])
    expect(store.backupSettings()).toBeNull()
  })

  it('migrates a schema 23 database in place', () => {
    const dir = temp()
    open(dir).close()
    const raw = new DatabaseSync(path.join(dir, 'gateway.sqlite'))
    raw.exec('DROP TABLE backup_settings; DROP TABLE backup_environments; DROP TABLE backup_runs')
    raw.prepare("UPDATE meta SET value='23' WHERE key='schema_version'").run()
    raw.close()
    const store = open(dir)
    expect(version(store.db)).toBe('24')
    expect(tables(store.db)).toEqual(['backup_environments', 'backup_runs', 'backup_settings'])
  })

  it('keeps the settings with their secrets', () => {
    const store = open()
    const settings = backupSettings({ lastPruneAt: at(2), repositoryBytes: 4096 })
    store.saveBackupSettings(settings)
    expect(store.backupSettings()).toEqual(settings)
    expect(store.backupSettings()?.destination).toMatchObject({ secretAccessKey: 'secret-example-value' })
    store.saveBackupSettings({ ...settings, schedule: null, enabled: false })
    expect(store.backupSettings()).toMatchObject({ schedule: null, enabled: false })
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM backup_settings').get()).toEqual({ n: 1 })
  })

  it('forgets the schedules with the settings', () => {
    const store = open()
    store.insertEnvironment(environmentRecord('work'), environmentSecrets('work'))
    store.saveBackupSettings(backupSettings())
    store.setBackupNextRun('work', at(2, 3))
    expect(store.backupEnvironments()).toEqual([{ environmentId: 'work', nextRunAt: at(2, 3) }])
    store.setBackupNextRun('work', null)
    expect(store.backupEnvironments()).toEqual([{ environmentId: 'work', nextRunAt: null }])
    store.clearBackupSettings()
    expect(store.backupSettings()).toBeNull()
    expect(store.backupEnvironments()).toEqual([])
  })

  it('drops the schedule of a purged environment', () => {
    const store = open()
    store.insertEnvironment(environmentRecord('work'), environmentSecrets('work'))
    store.insertEnvironment(environmentRecord('home'), environmentSecrets('home'))
    store.setBackupNextRun('work', at(2, 3))
    store.setBackupNextRun('home', at(2, 3))
    store.removeBackupEnvironment('home')
    expect(store.backupEnvironments().map((row) => row.environmentId)).toEqual(['work'])
    store.purgeEnvironment('work')
    expect(store.backupEnvironments()).toEqual([])
  })

  it('keeps runs, newest first, and prunes finished ones', () => {
    const store = open()
    store.saveBackupRun(backupRun('one', { startedAt: at(1) }))
    store.saveBackupRun(backupRun('two', { startedAt: at(2) }))
    store.saveBackupRun(backupRun('three', { startedAt: at(3), state: 'running', phase: 'upload', finishedAt: null }))
    store.saveBackupRun(backupRun('four', { startedAt: at(4), state: 'queued', phase: 'queued', finishedAt: null }))
    store.saveBackupRun(backupRun('other', { startedAt: at(5), environmentId: 'home' }))
    store.saveBackupRun(
      backupRun('one', {
        startedAt: at(1),
        state: 'failed',
        error: { code: 'denied', message: 'Access denied' },
        volumeName: 'volume',
      })
    )
    expect(store.backupRun('one')).toMatchObject({
      state: 'failed',
      error: { code: 'denied', message: 'Access denied' },
      volumeName: 'volume',
    })
    expect(store.backupRuns({ limit: 2 }).map((run) => run.id)).toEqual(['other', 'four'])
    expect(store.backupRuns({ environmentId: 'work', limit: 10 }).map((run) => run.id)).toEqual([
      'four',
      'three',
      'two',
      'one',
    ])
    expect(store.unfinishedBackupRuns().map((run) => run.id)).toEqual(['three', 'four'])
    store.pruneBackupRuns('work', 1)
    expect(store.backupRuns({ environmentId: 'work', limit: 10 }).map((run) => run.id)).toEqual([
      'four',
      'three',
      'two',
    ])
    expect(store.backupRun('other')).not.toBeNull()
    expect(store.backupRun('missing')).toBeNull()
  })

  it('refuses a database from a newer gateway', () => {
    const dir = temp()
    open(dir).close()
    const raw = new DatabaseSync(path.join(dir, 'gateway.sqlite'))
    raw.prepare("UPDATE meta SET value='25' WHERE key='schema_version'").run()
    raw.close()
    expect(() => new Store(dir)).toThrow('Gateway database schema is newer than this binary')
  })

  it('reads a bot slot', () => {
    const store = open()
    store.insertEnvironment(environmentRecord('work'), environmentSecrets('work'))
    store.insertBot(botRecord('ana'), gatewaySecrets('ana'), { environmentId: 'work', slot: 3 })
    expect(store.botSlot('ana')).toBe(3)
    expect(store.botSlot('missing')).toBeNull()
  })
})
