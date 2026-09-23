import { timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FleetActivityEntry, FleetActivityKind, FleetBot, FleetPeerMessage } from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'

type Row = Record<string, unknown>
export type Device = {
  id: string
  name: string
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}
export type BotSecrets = { controlToken: string; gatewayToken: string; gatewayTokenSha256: string }
export class Store {
  readonly db: DatabaseSync
  private depth = 0
  constructor(dataDir: string) {
    const file = path.join(dataDir, 'gateway.sqlite')
    this.db = new DatabaseSync(file)
    if (!existsSync(file)) throw new Error('Failed to create gateway database')
    chmodSync(file, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
    this.migrate()
  }
  close() {
    this.db.close()
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth--
    }
  }
  private migrate() {
    this.transaction(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      const version = Number(
        (this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as Row | undefined)?.value ?? 0
      )
      if (version > 1) throw new Error('Gateway database schema is newer than this binary')
      if (version === 0) {
        this.db.exec(`
          CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT);
          CREATE TABLE pairing_codes (code_sha256 TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT, attempts INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL, tint TEXT NOT NULL, ceiling TEXT NOT NULL, selection_json TEXT, talks_to_json TEXT NOT NULL, paused INTEGER NOT NULL, lifecycle TEXT NOT NULL, setup_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
          CREATE TABLE bot_secrets (bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, control_token TEXT NOT NULL, gateway_token TEXT NOT NULL, gateway_token_sha256 TEXT NOT NULL UNIQUE);
          CREATE TABLE routines (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), title TEXT NOT NULL, prompt TEXT NOT NULL, schedule_json TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at TEXT, last_run_at TEXT, last_outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, bot_id TEXT REFERENCES bots(id), kind TEXT NOT NULL, summary TEXT, data_json TEXT NOT NULL);
          CREATE TABLE peer_messages (id TEXT PRIMARY KEY, at TEXT NOT NULL, from_bot TEXT NOT NULL, to_bot TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL);
          CREATE TABLE pending_deliveries (message_id TEXT PRIMARY KEY REFERENCES peer_messages(id), to_bot TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, status INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,key));
          CREATE INDEX idx_activity_seq ON activity(seq);
          CREATE INDEX idx_idempotency_created ON idempotency(created_at);
        `)
        this.db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','1')").run()
      }
    })
  }
  addPairing(hash: string, expiresAt: string) {
    this.db.prepare('INSERT INTO pairing_codes(code_sha256,expires_at) VALUES(?,?)').run(hash, expiresAt)
  }
  consumePairing(hash: string, device: Device, tokenHash: string): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM pairing_codes WHERE code_sha256=?').get(hash) as Row | undefined
      if (!row) throw new GatewayError('UNAUTHORIZED', 'Invalid pairing code')
      if (Number(row.attempts) >= 5) throw new GatewayError('RATE_LIMITED', 'Pairing code attempt limit reached')
      if (row.used_at || String(row.expires_at) <= new Date().toISOString())
        throw new GatewayError('UNAUTHORIZED', 'Pairing code expired or used')
      this.db.prepare('UPDATE pairing_codes SET used_at=? WHERE code_sha256=?').run(new Date().toISOString(), hash)
      this.db
        .prepare(
          'INSERT INTO devices(id,name,token_sha256,created_at,last_seen_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)'
        )
        .run(device.id, device.name, tokenHash, device.createdAt)
    })
  }
  recordPairingAttempt(hash: string) {
    this.db.prepare('UPDATE pairing_codes SET attempts=attempts+1 WHERE code_sha256=?').run(hash)
  }
  private digestMatches(candidate: string, stored: unknown): boolean {
    const left = Buffer.from(candidate, 'hex')
    const right = Buffer.from(String(stored), 'hex')
    return left.length === 32 && right.length === 32 && timingSafeEqual(left, right)
  }
  deviceByHash(hash: string): Device | null {
    let row: Row | undefined
    for (const item of this.db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL').all() as Row[]) {
      if (this.digestMatches(hash, item.token_sha256)) row = item
    }
    return row
      ? {
          id: String(row.id),
          name: String(row.name),
          createdAt: String(row.created_at),
          lastSeenAt: row.last_seen_at as string | null,
          revokedAt: row.revoked_at as string | null,
        }
      : null
  }
  listDevices(): Device[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all() as Row[]).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      createdAt: String(row.created_at),
      lastSeenAt: row.last_seen_at as string | null,
      revokedAt: row.revoked_at as string | null,
    }))
  }
  touchDevice(id: string) {
    this.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(new Date().toISOString(), id)
  }
  revokeDevice(id: string) {
    return (
      this.db
        .prepare('UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
        .run(new Date().toISOString(), id).changes > 0
    )
  }
  insertBot(bot: FleetBot, secrets: BotSecrets) {
    this.transaction(() => {
      this.saveBot(bot)
      this.db
        .prepare('INSERT INTO bot_secrets(bot_id,control_token,gateway_token,gateway_token_sha256) VALUES(?,?,?,?)')
        .run(bot.id, secrets.controlToken, secrets.gatewayToken, secrets.gatewayTokenSha256)
    })
  }
  saveBot(bot: FleetBot) {
    this.db
      .prepare(`INSERT INTO bots(id,name,role,instructions,tint,ceiling,selection_json,talks_to_json,paused,lifecycle,setup_json,created_at,updated_at,archived_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,instructions=excluded.instructions,tint=excluded.tint,ceiling=excluded.ceiling,selection_json=excluded.selection_json,talks_to_json=excluded.talks_to_json,paused=excluded.paused,lifecycle=excluded.lifecycle,setup_json=excluded.setup_json,updated_at=excluded.updated_at,archived_at=excluded.archived_at`)
      .run(
        bot.id,
        bot.name,
        bot.role,
        bot.instructions,
        bot.tint,
        bot.ceiling,
        JSON.stringify(bot.selection),
        JSON.stringify(bot.talksTo),
        Number(bot.paused),
        bot.lifecycle,
        JSON.stringify(bot.setup),
        bot.createdAt,
        bot.updatedAt,
        bot.lifecycle === 'archived' ? bot.updatedAt : null
      )
  }
  private bot(row: Row): FleetBot {
    return {
      id: String(row.id),
      name: String(row.name),
      role: String(row.role),
      instructions: String(row.instructions),
      tint: String(row.tint),
      ceiling: row.ceiling as FleetBot['ceiling'],
      selection: JSON.parse(String(row.selection_json)),
      talksTo: JSON.parse(String(row.talks_to_json)),
      paused: Boolean(row.paused),
      lifecycle: row.lifecycle as FleetBot['lifecycle'],
      setup: JSON.parse(String(row.setup_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      status: 'offline',
      activity: null,
      pendingCount: 0,
      takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
      resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
      screen: { width: 1280, height: 800, display: ':0' },
      appVersion: null,
    }
  }
  getBot(id: string): FleetBot | null {
    const row = this.db.prepare('SELECT * FROM bots WHERE id=?').get(id) as Row | undefined
    return row ? this.bot(row) : null
  }
  listBots(includeArchived = false): FleetBot[] {
    return (
      this.db
        .prepare(
          includeArchived
            ? 'SELECT * FROM bots ORDER BY created_at'
            : "SELECT * FROM bots WHERE lifecycle!='archived' ORDER BY created_at"
        )
        .all() as Row[]
    ).map((row) => this.bot(row))
  }
  botSecrets(id: string): BotSecrets | null {
    const row = this.db.prepare('SELECT * FROM bot_secrets WHERE bot_id=?').get(id) as Row | undefined
    return row
      ? {
          controlToken: String(row.control_token),
          gatewayToken: String(row.gateway_token),
          gatewayTokenSha256: String(row.gateway_token_sha256),
        }
      : null
  }
  botByGatewayHash(hash: string): string | null {
    let row: Row | undefined
    for (const item of this.db.prepare('SELECT bot_id,gateway_token_sha256 FROM bot_secrets').all() as Row[]) {
      if (this.digestMatches(hash, item.gateway_token_sha256)) row = item
    }
    return row ? String(row.bot_id) : null
  }
  addActivity(
    botId: string | null,
    kind: FleetActivityKind,
    summary: string | null = null,
    data: FleetActivityEntry['data'] = {}
  ): FleetActivityEntry {
    const at = new Date().toISOString()
    const result = this.db
      .prepare('INSERT INTO activity(at,bot_id,kind,summary,data_json) VALUES(?,?,?,?,?)')
      .run(at, botId, kind, summary, JSON.stringify(data))
    return { seq: Number(result.lastInsertRowid), at, botId, kind, summary, data }
  }
  activity(after = 0, limit = 200): FleetActivityEntry[] {
    return (this.db.prepare('SELECT * FROM activity WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit) as Row[]).map(
      (row) => ({
        seq: Number(row.seq),
        at: String(row.at),
        botId: row.bot_id as string | null,
        kind: row.kind as FleetActivityKind,
        summary: row.summary as string | null,
        data: JSON.parse(String(row.data_json)),
      })
    )
  }
  lastActivitySeq(): number {
    return Number((this.db.prepare('SELECT MAX(seq) AS seq FROM activity').get() as Row).seq ?? 0)
  }
  peerMessages(limit = 200): FleetPeerMessage[] {
    return (this.db.prepare('SELECT * FROM peer_messages ORDER BY at DESC LIMIT ?').all(limit) as Row[]).map((row) => ({
      id: String(row.id),
      at: String(row.at),
      from: String(row.from_bot),
      to: String(row.to_bot),
      text: String(row.text),
      delivered: Boolean(row.delivered),
    }))
  }
  priorIdempotency<T>(scope: string, key: string, requestHash: string): { response: T; status: number } | null {
    this.db.prepare('DELETE FROM idempotency WHERE created_at<?').run(new Date(Date.now() - 86400000).toISOString())
    const row = this.db.prepare('SELECT * FROM idempotency WHERE scope=? AND key=?').get(scope, key) as Row | undefined
    if (!row) return null
    if (row.request_hash !== requestHash)
      throw new GatewayError('CONFLICT', 'Idempotency key used with different request')
    return { response: JSON.parse(String(row.response_json)) as T, status: Number(row.status) }
  }
  saveIdempotency(scope: string, key: string, requestHash: string, response: unknown, status: number) {
    this.db
      .prepare('INSERT INTO idempotency(scope,key,request_hash,response_json,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(scope, key, requestHash, JSON.stringify(response), status, new Date().toISOString())
  }
  idempotent<T>(
    scope: string,
    key: string,
    requestHash: string,
    create: () => { response: T; status: number }
  ): { response: T; status: number; replay: boolean } {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM idempotency WHERE created_at<?').run(new Date(Date.now() - 86400000).toISOString())
      const prior = this.db.prepare('SELECT * FROM idempotency WHERE scope=? AND key=?').get(scope, key) as
        | Row
        | undefined
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new GatewayError('CONFLICT', 'Idempotency key used with different request')
        return { response: JSON.parse(String(prior.response_json)) as T, status: Number(prior.status), replay: true }
      }
      const made = create()
      this.db
        .prepare('INSERT INTO idempotency(scope,key,request_hash,response_json,status,created_at) VALUES(?,?,?,?,?,?)')
        .run(scope, key, requestHash, JSON.stringify(made.response), made.status, new Date().toISOString())
      return { ...made, replay: false }
    })
  }
}
