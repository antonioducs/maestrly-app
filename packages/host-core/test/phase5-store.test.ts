import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { HostStore } from '../src/persistence/store.js'
import { HOST_DB_VERSION, migrateToV2, migrateToV3, migrateToV4, migrateToV5 } from '../src/bots/migrations.js'
import { migrateToV6 } from '../src/teams/migrations.js'
import { migrateToV7 } from '../src/persistence/phase5-migration.js'
import { directory } from './bot-helpers.js'

const skipWindows = process.platform === 'win32'
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const stamp = '2026-01-01T00:00:00.000Z'

/** The exact base schema HostStore writes for a fresh database, before any bot migration. */
const BASE = `CREATE TABLE IF NOT EXISTS vms(id TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, vm_id TEXT NOT NULL REFERENCES vms(id), key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
  PRAGMA user_version=1;`

/**
 * A real schema-6 database with history a person would not want to lose: a VM, two bots with
 * their conversations, one turn, a team and a team run. Building it from the shipped
 * migrations (not from a hand-written dump) is what makes the preservation check meaningful.
 */
async function legacyHost() {
  const dir = await directory()
  dirs.push(dir)
  const db = new DatabaseSync(join(dir, 'host.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
  db.exec(BASE)
  migrateToV2(db)
  migrateToV3(db)
  migrateToV4(db)
  migrateToV5(db)
  migrateToV6(db)
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('hostId', '531d469d-1e84-434c-9831-bf16127464e5')
  db.prepare('INSERT INTO vms(id,body) VALUES(?,?)').run(
    'vm-1',
    JSON.stringify({
      id: 'vm-1',
      name: 'lab',
      imageId: 'image',
      runtimeId: 'qemu',
      cpus: 4,
      memoryMiB: 2560,
      diskGiB: 4,
      revision: 3,
      state: 'running',
      desiredState: 'running',
      health: 'ready',
      startupPolicy: 'manual',
      diskRetained: true,
      identity: '0280eeef-75f0-4070-b10b-709ac2b2d9ba',
      createdAt: stamp,
      updatedAt: stamp,
    })
  )
  for (const id of ['bot-a', 'bot-b']) {
    db.prepare('INSERT INTO bots(id,vm_id,status,body) VALUES(?,?,?,?)').run(id, 'vm-1', 'ready', JSON.stringify({ id, name: id, status: 'ready' }))
    db.prepare('INSERT INTO bot_conversations(id,bot_id,body) VALUES(?,?,?)').run(`conv-${id}`, id, JSON.stringify({ id: `conv-${id}`, botId: id }))
  }
  db.prepare('INSERT INTO bot_turns(id,bot_id,conversation_id,status,body) VALUES(?,?,?,?,?)').run('turn-1', 'bot-a', 'conv-bot-a', 'succeeded', JSON.stringify({ id: 'turn-1', botId: 'bot-a' }))
  db.prepare('INSERT INTO teams(id,host_id,status,coordinator_bot_id,conversation_id,body) VALUES(?,?,?,?,?,?)').run('team-1', '531d469d-1e84-434c-9831-bf16127464e5', 'active', 'bot-a', 'team-conv', JSON.stringify({ id: 'team-1' }))
  db.prepare('INSERT INTO team_conversations(id,team_id,body) VALUES(?,?,?)').run('team-conv', 'team-1', JSON.stringify({ id: 'team-conv' }))
  db.prepare('INSERT INTO team_runs(id,team_id,conversation_id,message_id,status,body) VALUES(?,?,?,?,?,?)').run('run-1', 'team-1', 'team-conv', 'msg-1', 'succeeded', JSON.stringify({ id: 'run-1' }))
  db.close()
  return dir
}
/** Content digest of every row a person already had, so a migration cannot quietly rewrite one. */
function historyDigest(db: DatabaseSync) {
  const hash = createHash('sha256')
  for (const table of ['vms', 'operations', 'metadata', 'bots', 'bot_conversations', 'bot_turns', 'teams', 'team_conversations', 'team_runs'])
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) hash.update(`${table}:${JSON.stringify(row)}`)
  return hash.digest('hex')
}
const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((row) => row.name)

describe.skipIf(skipWindows)('schema 6 → 7 migration', () => {
  it('adds the routine and voice tables without rewriting a single existing row', async () => {
    const dir = await legacyHost()
    const before = new DatabaseSync(join(dir, 'host.sqlite'))
    const digest = historyDigest(before)
    const legacyTables = tables(before)
    before.close()

    const store = new HostStore(dir)
    try {
      // The store always migrates to the current version; this suite only requires that 7 was reached.
      expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(HOST_DB_VERSION)
      expect(HOST_DB_VERSION).toBeGreaterThanOrEqual(7)
      expect(historyDigest(store.db)).toBe(digest)
      // The identity a person's bots are bound to is the same one, not a regenerated UUID.
      expect(store.hostId).toBe('531d469d-1e84-434c-9831-bf16127464e5')
      for (const table of legacyTables) expect(tables(store.db)).toContain(table)
      for (const table of [
        'routines',
        'routine_occurrences',
        'routine_executions',
        'routine_proposals',
        'routine_operations',
        'routine_usage',
        'routine_events',
        'voice_clips',
        'voice_uploads',
        'voice_jobs',
        'voice_message_links',
        'voice_operations',
      ])
        expect(tables(store.db), table).toContain(table)
    } finally {
      store.close()
    }
  })

  it('keeps a consistent backup of the previous schema before upgrading in place', async () => {
    const dir = await legacyHost()
    const store = new HostStore(dir)
    store.close()
    const backups = new DatabaseSync(join(dir, 'host.sqlite'))
    backups.close()
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(join(dir, 'database-backups'))
    expect(files.some((name) => name.startsWith('host-v6-'))).toBe(true)
  })

  it('rolls the whole upgrade back when any statement fails, leaving schema 6 intact', async () => {
    const dir = await legacyHost()
    const db = new DatabaseSync(join(dir, 'host.sqlite'))
    // Something already occupies one of the new names: the migration must abort as a unit.
    db.exec('CREATE TABLE voice_jobs(id TEXT PRIMARY KEY)')
    const digest = historyDigest(db)
    expect(() => migrateToV7(db)).toThrow()
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(6)
    expect(tables(db)).not.toContain('routines')
    expect(historyDigest(db)).toBe(digest)
    db.close()
  })

  it('refuses to run against a schema it was not written for', async () => {
    const dir = await directory()
    dirs.push(dir)
    const db = new DatabaseSync(join(dir, 'host.sqlite'))
    db.exec(BASE)
    expect(() => migrateToV7(db)).toThrow(/version 6/)
    db.close()
  })

  it('is idempotent: restarting twice never recreates a table or loses a routine row', async () => {
    const dir = await legacyHost()
    const first = new HostStore(dir)
    first.db
      .prepare('INSERT INTO routines(id,host_id,target_kind,target_id,status,fingerprint,watermark_utc,body) VALUES(?,?,?,?,?,?,?,?)')
      .run('r-1', first.hostId, 'bot', 'bot-a', 'active', 'a'.repeat(64), stamp, JSON.stringify({ id: 'r-1' }))
    first.close()
    for (let restart = 0; restart < 2; restart++) {
      const store = new HostStore(dir)
      expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(HOST_DB_VERSION)
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM routines').get()).toEqual({ n: 1 })
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM routine_occurrences').get()).toEqual({ n: 0 })
      store.close()
    }
  })
})

describe.skipIf(skipWindows)('durable guarantees of the new tables', () => {
  async function openStore() {
    const dir = await legacyHost()
    const store = new HostStore(dir)
    store.db
      .prepare('INSERT INTO routines(id,host_id,target_kind,target_id,status,fingerprint,watermark_utc,body) VALUES(?,?,?,?,?,?,?,?)')
      .run('r-1', store.hostId, 'bot', 'bot-a', 'active', 'a'.repeat(64), stamp, JSON.stringify({ id: 'r-1' }))
    return store
  }
  const insertOccurrence = (store: HostStore, id: string, at: string, status = 'pending', manualKey: string | null = null) =>
    store.db
      .prepare('INSERT INTO routine_occurrences(id,routine_id,origin,scheduled_for_utc,status,manual_key,body) VALUES(?,?,?,?,?,?,?)')
      .run(id, 'r-1', manualKey ? 'manual' : 'schedule', at, status, manualKey, JSON.stringify({ id }))

  it('fires one nominal instant exactly once, even under concurrent materialisation', async () => {
    const store = await openStore()
    try {
      insertOccurrence(store, 'o-1', '2026-03-02T12:00:00.000Z', 'succeeded')
      expect(() => insertOccurrence(store, 'o-2', '2026-03-02T12:00:00.000Z', 'succeeded')).toThrow(/UNIQUE/)
      // A different instant of the same routine is a different occurrence.
      insertOccurrence(store, 'o-3', '2026-03-03T12:00:00.000Z', 'succeeded')
    } finally {
      store.close()
    }
  })

  it('never lets a routine overlap itself while an occurrence still holds its slot', async () => {
    const store = await openStore()
    try {
      insertOccurrence(store, 'o-1', '2026-03-02T12:00:00.000Z', 'running')
      expect(() => insertOccurrence(store, 'o-2', '2026-03-03T12:00:00.000Z', 'pending')).toThrow(/UNIQUE/)
      store.db.prepare("UPDATE routine_occurrences SET status='succeeded' WHERE id='o-1'").run()
      insertOccurrence(store, 'o-2', '2026-03-03T12:00:00.000Z', 'pending')
    } finally {
      store.close()
    }
  })

  it('gives "run now" a stable key so a repeated click returns the same occurrence', async () => {
    const store = await openStore()
    try {
      insertOccurrence(store, 'm-1', '2026-03-02T12:00:00.000Z', 'succeeded', 'manual:key-1')
      expect(() => insertOccurrence(store, 'm-2', '2026-03-02T12:30:00.000Z', 'succeeded', 'manual:key-1')).toThrow(/UNIQUE/)
    } finally {
      store.close()
    }
  })

  it('binds an execution to exactly one engine: a bot turn or a team run, never both or neither', async () => {
    const store = await openStore()
    try {
      insertOccurrence(store, 'o-1', '2026-03-02T12:00:00.000Z', 'running')
      const insert = (id: string, turnId: string | null, runId: string | null, continuationOf: string | null = null) =>
        store.db
          .prepare('INSERT INTO routine_executions(id,occurrence_id,routine_id,turn_id,team_run_id,continuation_of,body) VALUES(?,?,?,?,?,?,?)')
          .run(id, 'o-1', 'r-1', turnId, runId, continuationOf, JSON.stringify({ id }))
      insert('x-1', 'turn-1', null)
      expect(() => insert('x-2', 'turn-1', 'run-1')).toThrow()
      expect(() => insert('x-3', null, null)).toThrow()
      // The same turn cannot be claimed by two occurrences.
      expect(() => insert('x-4', 'turn-1', null)).toThrow(/UNIQUE/)
      // A continuation after a takeover is another execution of the SAME occurrence.
      store.db.prepare('INSERT INTO bot_turns(id,bot_id,conversation_id,status,body) VALUES(?,?,?,?,?)').run('turn-2', 'bot-a', 'conv-bot-a', 'running', '{}')
      insert('x-5', 'turn-2', null, 'turn-1')
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM routine_executions WHERE occurrence_id=?').get('o-1')).toEqual({ n: 2 })
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM routine_occurrences WHERE routine_id=?').get('r-1')).toEqual({ n: 1 })
    } finally {
      store.close()
    }
  })

  it('links one recording to one message and keeps the bytes outside the database', async () => {
    const store = await openStore()
    try {
      const clip = (id: string) =>
        store.db
          .prepare('INSERT INTO voice_clips(id,target_kind,target_id,state,bytes,digest,expires_at,body) VALUES(?,?,?,?,?,?,?,?)')
          .run(id, 'bot', 'bot-a', 'stored', 32_044, 'b'.repeat(64), stamp, JSON.stringify({ id }))
      clip('clip-1')
      clip('clip-2')
      const link = (messageId: string, clipId: string) =>
        store.db
          .prepare('INSERT INTO voice_message_links(message_id,clip_id,target_kind,target_id,body) VALUES(?,?,?,?,?)')
          .run(messageId, clipId, 'bot', 'bot-a', JSON.stringify({ messageId, clipId }))
      link('msg-1', 'clip-1')
      expect(() => link('msg-2', 'clip-1')).toThrow(/UNIQUE/)
      expect(() => link('msg-1', 'clip-2')).toThrow(/UNIQUE|PRIMARY/)
      // No column anywhere holds audio: only size and digest describe the recording.
      const columns = store.db.prepare('PRAGMA table_info(voice_clips)').all() as { name: string }[]
      expect(columns.map((column) => column.name)).not.toContain('data')
      expect(columns.map((column) => column.name)).toContain('digest')
    } finally {
      store.close()
    }
  })

  it('keeps routine and voice idempotency keys unique and separate from the other domains', async () => {
    const store = await openStore()
    try {
      const routineOperation = (id: string, key: string) =>
        store.db
          .prepare('INSERT INTO routine_operations(id,key,fingerprint,routine_id,occurrence_id,request,body) VALUES(?,?,?,?,?,?,?)')
          .run(id, key, 'f', 'r-1', null, '{}', JSON.stringify({ id }))
      routineOperation('op-1', 'key-1')
      expect(() => routineOperation('op-2', 'key-1')).toThrow(/UNIQUE/)
      // The same key in the team namespace is a different, independent operation.
      store.db.prepare('INSERT INTO team_operations(id,key,fingerprint,team_id,run_id,request,body) VALUES(?,?,?,?,?,?,?)').run('t-op', 'key-1', 'f', 'team-1', null, '{}', '{}')
    } finally {
      store.close()
    }
  })

  it('accepts only the known target kinds and occurrence origins', async () => {
    const store = await openStore()
    try {
      expect(() =>
        store.db
          .prepare('INSERT INTO routines(id,host_id,target_kind,target_id,status,fingerprint,watermark_utc,body) VALUES(?,?,?,?,?,?,?,?)')
          .run(randomUUID(), store.hostId, 'host', 'x', 'active', 'a'.repeat(64), stamp, '{}')
      ).toThrow(/CHECK/)
      expect(() =>
        store.db
          .prepare('INSERT INTO routine_occurrences(id,routine_id,origin,scheduled_for_utc,status,manual_key,body) VALUES(?,?,?,?,?,?,?)')
          .run('bad', 'r-1', 'cron', stamp, 'pending', null, '{}')
      ).toThrow(/CHECK/)
    } finally {
      store.close()
    }
  })
})
