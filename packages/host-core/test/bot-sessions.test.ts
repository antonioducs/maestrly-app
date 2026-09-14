import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { migrateToV2, migrateToV3 } from '../src/bots/migrations.js'

function database() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE vms(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE operations(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE events(seq INTEGER PRIMARY KEY,body TEXT); PRAGMA user_version=1;')
  migrateToV2(db)
  return db
}
function bot(db: DatabaseSync, id: string, status = 'ready') {
  db.prepare('INSERT INTO bots VALUES(?,?,?,?)').run(id, 'vm', status, JSON.stringify({ id, vmId: 'vm', status }))
  db.prepare('INSERT INTO bot_bindings VALUES(?,?,?)').run(id, 'vm', JSON.stringify({ botId: id, vmId: 'vm', profile: 'bot', runtimeVersion: 'old' }))
}
it('migrates schema 2 without rewriting any existing records and reserves a legacy identity', () => {
  const db = database()
  try {
    const hostId = randomUUID()
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('hostId', hostId)
    bot(db, 'a')
    const before = db.prepare('SELECT * FROM bots').all()
    migrateToV3(db)
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3)
    expect(db.prepare('SELECT * FROM bots').all()).toEqual(before)
    expect(db.prepare('SELECT value FROM metadata').get()?.value).toBe(hostId)
    const record = JSON.parse(db.prepare('SELECT body FROM bot_sessions').get()!.body as string)
    expect(record).toMatchObject({ botId: 'a', vmId: 'vm', transport: 'legacy', state: 'stopped' })
    expect(record.id).toMatch(/^[a-f0-9-]{36}$/)
    bot(db, 'b') // VM uniqueness removed; session and turn constraints remain separate.
    expect(() => db.prepare('INSERT INTO bot_sessions(id,bot_id,vm_id,body) VALUES(?,?,?,?)').run(randomUUID(), 'a', 'vm', '{}')).toThrow(/UNIQUE/)
    migrateToV3(db)
    expect(db.prepare('SELECT count(*) AS n FROM bot_sessions').get()?.n).toBe(1)
  } finally { db.close() }
})
it('marks conflicting legacy bindings instead of sharing one credential directory', () => {
  const db = database()
  try {
    bot(db, 'a', 'archived')
    bot(db, 'b')
    migrateToV3(db)
    const sessions = db.prepare('SELECT body FROM bot_sessions').all().map(r => JSON.parse(r.body as string))
    expect(sessions).toHaveLength(2)
    expect(sessions.every(s => s.issue === 'LEGACY_BINDING_CONFLICT' && s.state === 'needs_attention')).toBe(true)
  } finally { db.close() }
})
it('rolls back a failed migration before dropping the legacy exclusivity constraint', () => {
  const db = database()
  try {
    db.exec('CREATE TABLE bot_sessions(conflicting TEXT)')
    expect(() => migrateToV3(db)).toThrow()
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='bots_active_vm'").get()).toBeDefined()
  } finally { db.close() }
})
it('adds schema 4 accounts without rewriting schema 3 bot, VM or session records', async () => {
  const { migrateToV4 } = await import('../src/bots/migrations.js')
  const db = database()
  try {
    bot(db, 'a')
    migrateToV3(db)
    const tables = ['metadata', 'vms', 'operations', 'events', 'bots', 'bot_bindings', 'bot_sessions', 'bot_vm_sessions']
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())
    migrateToV4(db)
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(4)
    tables.forEach((table, index) => {
      const rows = db.prepare(`SELECT * FROM ${table}`).all()
      expect(rows.map(row => Object.fromEntries(Object.keys(before[index][0] ?? row).map(key => [key, row[key]])))).toEqual(before[index])
    })
    expect(db.prepare('SELECT * FROM shared_accounts').all()).toEqual([])
    migrateToV4(db)
    expect(db.prepare('SELECT * FROM bot_sessions').all()).toEqual(before[6])
  } finally { db.close() }
})
