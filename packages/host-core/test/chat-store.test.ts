import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { HostStore } from '../src/persistence/store.js'
import { HOST_DB_VERSION, migrateToV2, migrateToV3, migrateToV4, migrateToV5 } from '../src/bots/migrations.js'
import { migrateToV6 } from '../src/teams/migrations.js'
import { migrateToV7 } from '../src/persistence/phase5-migration.js'
import { migrateToV8 } from '../src/persistence/chat-migration.js'
import { directory } from './bot-helpers.js'

const skipWindows = process.platform === 'win32'
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const stamp = '2026-01-01T00:00:00.000Z'
const BASE = `CREATE TABLE IF NOT EXISTS vms(id TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, vm_id TEXT NOT NULL REFERENCES vms(id), key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
  PRAGMA user_version=1;`

/** A schema-7 Host with one finished turn that recorded usage and three events that belong to it. */
async function phase5Host(upTo = 7) {
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
  if (upTo >= 7) migrateToV7(db)
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('hostId', '531d469d-1e84-434c-9831-bf16127464e5')
  db.prepare('INSERT INTO vms(id,body) VALUES(?,?)').run(
    'vm-1',
    JSON.stringify({ id: 'vm-1', name: 'lab', imageId: 'image', runtimeId: 'qemu', cpus: 4, memoryMiB: 2560, diskGiB: 4, revision: 3, state: 'running', desiredState: 'running', health: 'ready', startupPolicy: 'manual', diskRetained: true, identity: '0280eeef-75f0-4070-b10b-709ac2b2d9ba', createdAt: stamp, updatedAt: stamp })
  )
  db.prepare('INSERT INTO bots(id,vm_id,status,body) VALUES(?,?,?,?)').run('bot-a', 'vm-1', 'ready', JSON.stringify({ id: 'bot-a', name: 'bot-a', status: 'ready' }))
  db.prepare('INSERT INTO bot_conversations(id,bot_id,body) VALUES(?,?,?)').run('conv-a', 'bot-a', JSON.stringify({ id: 'conv-a', botId: 'bot-a' }))
  const turn = { id: 'turn-1', botId: 'bot-a', conversationId: 'conv-a', status: 'succeeded', startedAt: stamp, finishedAt: '2026-01-01T00:00:10.000Z', updatedAt: '2026-01-01T00:00:10.000Z', model: { model: 'gpt-5', source: 'recommended' }, usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 40 } }
  db.prepare('INSERT INTO bot_turns(id,bot_id,conversation_id,status,body) VALUES(?,?,?,?,?)').run(turn.id, 'bot-a', 'conv-a', 'succeeded', JSON.stringify(turn))
  // A running turn without usage must not enter the ledger.
  db.prepare('INSERT INTO bot_turns(id,bot_id,conversation_id,status,body) VALUES(?,?,?,?,?)').run('turn-2', 'bot-a', 'conv-a', 'running', JSON.stringify({ id: 'turn-2', botId: 'bot-a', status: 'running' }))
  for (const [seq, kind] of [[1, 'turn.status'], [2, 'assistant.delta'], [3, 'turn.status']] as const)
    db.prepare('INSERT INTO bot_events(seq,bot_id,runtime_event_id,body) VALUES(?,?,?,?)').run(seq, 'bot-a', `rt-${seq}`, JSON.stringify({ seq, botId: 'bot-a', turnId: 'turn-1', kind, summary: kind, createdAt: stamp }))
  db.prepare('INSERT INTO bot_events(seq,bot_id,runtime_event_id,body) VALUES(?,?,?,?)').run(4, 'bot-a', 'rt-4', JSON.stringify({ seq: 4, botId: 'bot-a', kind: 'runtime.changed', summary: 'x', createdAt: stamp }))
  db.close()
  return dir
}
function historyDigest(db: DatabaseSync) {
  const hash = createHash('sha256')
  for (const table of ['vms', 'metadata', 'bots', 'bot_conversations', 'bot_turns'])
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) hash.update(`${table}:${JSON.stringify(row)}`)
  return hash.digest('hex')
}

describe.skipIf(skipWindows)('schema 7 → 8', () => {
  it('adds the chat tables, backfills the ledger and event turn ids, and leaves history untouched', async () => {
    const dir = await phase5Host()
    const before = new DatabaseSync(join(dir, 'host.sqlite'))
    const digest = historyDigest(before)
    before.close()
    const store = new HostStore(dir)
    try {
      const db = (store as unknown as { db: DatabaseSync }).db
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(8)
      expect(HOST_DB_VERSION).toBe(8)
      expect(historyDigest(db)).toBe(digest)
      const ledger = db.prepare('SELECT * FROM bot_turn_usage').all() as Record<string, unknown>[]
      expect(ledger).toHaveLength(1)
      expect(ledger[0]).toMatchObject({ turn_id: 'turn-1', bot_id: 'bot-a', provider: 'codex', model: 'gpt-5', input: 120, cached_input: 40, output: 30, reasoning_output: 0, finished_at: '2026-01-01T00:00:10.000Z' })
      const events = db.prepare('SELECT seq, turn_id FROM bot_events ORDER BY seq').all() as { seq: number; turn_id: string | null }[]
      expect(events.map((event) => event.turn_id)).toEqual(['turn-1', 'turn-1', 'turn-1', null])
      for (const table of ['bot_prompts', 'bot_extensions', 'bot_skills']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0)
    } finally {
      store.close()
    }
    // The pre-migration copy is the evidence that nothing was risked.
    const backups = await readdir(join(dir, 'database-backups'))
    expect(backups.some((name) => name.startsWith('host-v7-'))).toBe(true)
  })
  it('is idempotent and refuses any schema but 7', async () => {
    const dir = await phase5Host()
    const first = new HostStore(dir)
    first.close()
    const again = new HostStore(dir)
    try {
      const db = (again as unknown as { db: DatabaseSync }).db
      expect(db.prepare('SELECT COUNT(*) AS n FROM bot_turn_usage').get()!.n).toBe(1)
      migrateToV8(db)
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(8)
    } finally {
      again.close()
    }
    const old = await phase5Host(6)
    const db = new DatabaseSync(join(old, 'host.sqlite'))
    try {
      expect(() => migrateToV8(db)).toThrow(/schema version 7/)
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(6)
    } finally {
      db.close()
    }
  })
})
