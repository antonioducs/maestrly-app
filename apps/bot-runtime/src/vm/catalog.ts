import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, lstatSync, chmodSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { sessionIdSchema, sessionProfileSchema, vmSessionInfoSchema, type VmSessionInfo } from '@maestrly/host-protocol'

export const sessionRecordSchema = vmSessionInfoSchema.extend({
  legacy: z.boolean(),
  username: z.string().regex(/^(maestrlybot|mb[a-f0-9]{24})$/),
  uid: z.number().int().positive().optional(),
  gid: z.number().int().positive().optional(),
  provisioned: z.boolean(),
  leaseTurnId: z.string().max(128).optional(),
  leaseExpiresAt: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
})
export type SessionRecord = z.infer<typeof sessionRecordSchema>
export function publicSession(record: SessionRecord): VmSessionInfo {
  const { id, botId, profile, state, generation, desiredState } = record
  return { id, botId, profile, state, generation, desiredState }
}
/** Root-private VM catalogue. No auth payloads, tool arguments or model output enter it. */
export class VmCatalog {
  private db: DatabaseSync
  private lock: DatabaseSync
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || realpathSync(directory) !== directory)
      throw new Error('VM catalogue must be a private owned canonical directory')
    for (const name of ['owner.sqlite', 'sessions.sqlite']) {
      try {
        const s = lstatSync(join(directory, name))
        if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.()) throw new Error('Unsafe catalogue database')
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    this.lock = new DatabaseSync(join(directory, 'owner.sqlite'))
    try { this.lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE') } catch (error) { this.lock.close(); throw error }
    this.db = new DatabaseSync(join(directory, 'sessions.sqlite'))
    const version = this.db.prepare('PRAGMA user_version').get()!.user_version as number
    if (version > 1) { this.db.close(); this.lock.close(); throw new Error('Unsupported VM catalogue version') }
    chmodSync(join(directory, 'owner.sqlite'), 0o600)
    chmodSync(join(directory, 'sessions.sqlite'), 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,bot_id TEXT UNIQUE NOT NULL,username TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
    this.db.exec('PRAGMA user_version=1')
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  list(): SessionRecord[] { return this.db.prepare('SELECT body FROM sessions ORDER BY rowid').all().map(r => sessionRecordSchema.parse(JSON.parse(r.body as string))) }
  get(id: string) { sessionIdSchema.parse(id); const row = this.db.prepare('SELECT body FROM sessions WHERE id=?').get(id); return row ? sessionRecordSchema.parse(JSON.parse(row.body as string)) : undefined }
  save(record: SessionRecord) {
    sessionRecordSchema.parse(record)
    sessionProfileSchema.parse(record.profile)
    const old = this.get(record.id)
    if (old && (old.username !== record.username || old.botId !== record.botId || old.legacy !== record.legacy)) throw new Error('Session identity is immutable')
    this.db.prepare('INSERT INTO sessions(id,bot_id,username,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(record.id, record.botId, record.username, JSON.stringify(record))
  }
  operation(key: string) {
    return this.db.prepare('SELECT fingerprint,status,result FROM operations WHERE key=?').get(key) as { fingerprint: string; status: string; result: string | null } | undefined
  }
  begin(key: string, fingerprint: string) { this.db.prepare("INSERT INTO operations(key,fingerprint,status) VALUES(?,?,'pending')").run(key, fingerprint) }
  finish(key: string, value: unknown) { this.db.prepare("UPDATE operations SET status='succeeded',result=? WHERE key=?").run(JSON.stringify(value), key) }
  metadata(key: string) { return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value as string | undefined }
  setMetadata(key: string, value: string) { this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  close() { this.db.close(); this.lock.close() }
}
