import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  FleetRoutineRun,
  FleetOwnerMemoryEntry,
  FleetActivityEntry,
  FleetActivityKind,
  FleetBot,
  FleetPeerMessage,
  FleetRoutine,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'

export type StoredRoutineRun = FleetRoutineRun & { inputId: string }

type Row = Record<string, unknown>
export type Device = {
  id: string
  name: string
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}
export type BotSecrets = {
  controlToken: string
  gatewayToken: string
  gatewayTokenSha256: string
  keyringPassword: string
}
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
      if (version > 5) throw new Error('Gateway database schema is newer than this binary')
      if (version === 0) {
        this.db.exec(`
          CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT);
          CREATE TABLE pairing_codes (code_sha256 TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT, attempts INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL, tint TEXT NOT NULL, ceiling TEXT NOT NULL, selection_json TEXT, talks_to_json TEXT NOT NULL, paused INTEGER NOT NULL, lifecycle TEXT NOT NULL, setup_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
          CREATE TABLE bot_secrets (bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, control_token TEXT NOT NULL, gateway_token TEXT NOT NULL, gateway_token_sha256 TEXT NOT NULL UNIQUE, keyring_password TEXT NOT NULL);
          CREATE TABLE routines (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), title TEXT NOT NULL, prompt TEXT NOT NULL, schedule_json TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at TEXT, last_run_at TEXT, last_outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT 'owner', last_input_id TEXT);
          CREATE TABLE activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, bot_id TEXT REFERENCES bots(id), kind TEXT NOT NULL, summary TEXT, data_json TEXT NOT NULL);
          CREATE TABLE peer_messages (id TEXT PRIMARY KEY, at TEXT NOT NULL, from_bot TEXT NOT NULL, to_bot TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL);
          CREATE TABLE pending_deliveries (message_id TEXT PRIMARY KEY REFERENCES peer_messages(id), to_bot TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE owner_messages (bot_id TEXT PRIMARY KEY, at TEXT NOT NULL);
          CREATE TABLE pair_blocks (pair_key TEXT PRIMARY KEY, blocked_until TEXT NOT NULL);
          CREATE TABLE idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, status INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,key));
          CREATE INDEX idx_activity_seq ON activity(seq);
          CREATE INDEX idx_idempotency_created ON idempotency(created_at);
        `)
        this.db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','3')").run()
      }
      if (version === 1) {
        this.db.exec('ALTER TABLE bot_secrets ADD COLUMN keyring_password TEXT')
        this.db.exec(
          'CREATE TABLE owner_messages (bot_id TEXT PRIMARY KEY, at TEXT NOT NULL); CREATE TABLE pair_blocks (pair_key TEXT PRIMARY KEY, blocked_until TEXT NOT NULL)'
        )
        for (const row of this.db.prepare('SELECT bot_id FROM bot_secrets').all() as Row[])
          this.db
            .prepare('UPDATE bot_secrets SET keyring_password=? WHERE bot_id=?')
            .run(randomBytes(32).toString('base64url'), row.bot_id as string)
        this.db.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run()
      }
      if (version === 1 || version === 2) {
        this.db.exec(
          "ALTER TABLE routines ADD COLUMN created_by TEXT NOT NULL DEFAULT 'owner'; ALTER TABLE routines ADD COLUMN last_input_id TEXT"
        )
        this.db.prepare("UPDATE meta SET value='3' WHERE key='schema_version'").run()
      }
      if (version <= 3) {
        const columns = this.db.prepare('PRAGMA table_info(bots)').all() as Row[]
        if (columns.length && !columns.some((column) => column.name === 'compaction_json'))
          this.db.exec('ALTER TABLE bots ADD COLUMN compaction_json TEXT')
        this.db.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run()
      }
      if (version <= 4) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS owner_memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL, author_kind TEXT NOT NULL, author_bot_id TEXT, author_name TEXT, origin TEXT, replaces_id TEXT, replaced_by_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS idx_owner_memories_status ON owner_memories(status, created_at);
          CREATE TABLE IF NOT EXISTS routine_runs (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, bot_id TEXT NOT NULL, input_id TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, delivered_at TEXT NOT NULL, finished_at TEXT, report_json TEXT, final_text TEXT);
          CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id, delivered_at DESC);
          CREATE INDEX IF NOT EXISTS idx_routine_runs_input ON routine_runs(bot_id, input_id);
        `)
        this.db
          .prepare("INSERT INTO meta(key,value) VALUES('owner_memory_revision','0') ON CONFLICT(key) DO NOTHING")
          .run()
        this.db.prepare("UPDATE meta SET value='5' WHERE key='schema_version'").run()
      }

      if (this.db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('Gateway migration foreign key check failed')
      const integrity = this.db.prepare('PRAGMA integrity_check').get() as Row
      if (integrity.integrity_check !== 'ok') throw new Error('Gateway migration integrity check failed')
    })
  }
  private routineRun(row: Row): StoredRoutineRun {
    return {
      id: String(row.id),
      routineId: String(row.routine_id),
      botId: String(row.bot_id),
      inputId: String(row.input_id),
      trigger: row.trigger as FleetRoutineRun['trigger'],
      status: row.status as FleetRoutineRun['status'],
      deliveredAt: String(row.delivered_at),
      finishedAt: (row.finished_at as string | null) ?? null,
      report: row.report_json ? (JSON.parse(String(row.report_json)) as FleetRoutineRun['report']) : null,
      finalText: (row.final_text as string | null) ?? null,
    }
  }
  insertRoutineRun(run: StoredRoutineRun) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO routine_runs(id,routine_id,bot_id,input_id,trigger,status,delivered_at,finished_at,report_json,final_text) VALUES(?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        run.id,
        run.routineId,
        run.botId,
        run.inputId,
        run.trigger,
        run.status,
        run.deliveredAt,
        run.finishedAt,
        run.report ? JSON.stringify(run.report) : null,
        run.finalText
      )
  }
  updateRoutineRun(run: StoredRoutineRun) {
    this.db
      .prepare('UPDATE routine_runs SET status=?, finished_at=?, report_json=?, final_text=? WHERE id=?')
      .run(run.status, run.finishedAt, run.report ? JSON.stringify(run.report) : null, run.finalText, run.id)
  }
  routineRuns(routineId: string, limit: number): StoredRoutineRun[] {
    return (
      this.db
        .prepare('SELECT * FROM routine_runs WHERE routine_id=? ORDER BY delivered_at DESC LIMIT ?')
        .all(routineId, limit) as Row[]
    ).map((row) => this.routineRun(row))
  }
  routineRunById(id: string): StoredRoutineRun | null {
    const row = this.db.prepare('SELECT * FROM routine_runs WHERE id=?').get(id) as Row | undefined
    return row ? this.routineRun(row) : null
  }
  routineRunByInput(botId: string, inputId: string): StoredRoutineRun | null {
    const row = this.db.prepare('SELECT * FROM routine_runs WHERE bot_id=? AND input_id=?').get(botId, inputId) as
      | Row
      | undefined
    return row ? this.routineRun(row) : null
  }
  pruneRoutineRuns(routineId: string, keep: number) {
    this.db
      .prepare(
        'DELETE FROM routine_runs WHERE routine_id=? AND id NOT IN (SELECT id FROM routine_runs WHERE routine_id=? ORDER BY delivered_at DESC LIMIT ?)'
      )
      .run(routineId, routineId, keep)
  }

  private ownerMemory(row: Row): FleetOwnerMemoryEntry {
    return {
      id: String(row.id),
      content: String(row.content),
      status: row.status as FleetOwnerMemoryEntry['status'],
      author:
        row.author_kind === 'bot'
          ? { kind: 'bot', botId: String(row.author_bot_id), name: String(row.author_name ?? row.author_bot_id) }
          : { kind: 'owner' },
      origin: (row.origin as FleetOwnerMemoryEntry['origin']) ?? null,
      replacesId: (row.replaces_id as string | null) ?? null,
      replacedById: (row.replaced_by_id as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
  ownerMemories(status?: 'active'): FleetOwnerMemoryEntry[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM owner_memories WHERE status='active' ORDER BY created_at").all()
      : this.db.prepare('SELECT * FROM owner_memories ORDER BY created_at').all()
    return (rows as Row[]).map((row) => this.ownerMemory(row))
  }
  ownerMemoryById(id: string): FleetOwnerMemoryEntry | null {
    const row = this.db.prepare('SELECT * FROM owner_memories WHERE id=?').get(id) as Row | undefined
    return row ? this.ownerMemory(row) : null
  }
  saveOwnerMemory(entry: FleetOwnerMemoryEntry) {
    this.db
      .prepare(`INSERT INTO owner_memories(id,content,status,author_kind,author_bot_id,author_name,origin,replaces_id,replaced_by_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,status=excluded.status,replaces_id=excluded.replaces_id,replaced_by_id=excluded.replaced_by_id,updated_at=excluded.updated_at`)
      .run(
        entry.id,
        entry.content,
        entry.status,
        entry.author.kind,
        entry.author.kind === 'bot' ? entry.author.botId : null,
        entry.author.kind === 'bot' ? entry.author.name : null,
        entry.origin,
        entry.replacesId,
        entry.replacedById,
        entry.createdAt,
        entry.updatedAt
      )
  }
  deleteOwnerMemory(id: string) {
    this.transaction(() => {
      this.db.prepare('UPDATE owner_memories SET replaces_id=NULL WHERE replaces_id=?').run(id)
      this.db.prepare('UPDATE owner_memories SET replaced_by_id=NULL WHERE replaced_by_id=?').run(id)
      this.db.prepare('DELETE FROM owner_memories WHERE id=?').run(id)
    })
  }
  ownerMemoryRevision(): number {
    return Number(
      (this.db.prepare("SELECT value FROM meta WHERE key='owner_memory_revision'").get() as Row | undefined)?.value ?? 0
    )
  }
  bumpOwnerMemoryRevision(): number {
    const next = this.ownerMemoryRevision() + 1
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES('owner_memory_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(String(next))
    return next
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
  deviceRevoked(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM devices WHERE id=? AND revoked_at IS NOT NULL').get(id)
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
        .prepare(
          'INSERT INTO bot_secrets(bot_id,control_token,gateway_token,gateway_token_sha256,keyring_password) VALUES(?,?,?,?,?)'
        )
        .run(bot.id, secrets.controlToken, secrets.gatewayToken, secrets.gatewayTokenSha256, secrets.keyringPassword)
    })
  }
  saveBot(bot: FleetBot) {
    this.db
      .prepare(`INSERT INTO bots(id,name,role,instructions,tint,ceiling,selection_json,compaction_json,talks_to_json,paused,lifecycle,setup_json,created_at,updated_at,archived_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,instructions=excluded.instructions,tint=excluded.tint,ceiling=excluded.ceiling,selection_json=excluded.selection_json,compaction_json=excluded.compaction_json,talks_to_json=excluded.talks_to_json,paused=excluded.paused,lifecycle=excluded.lifecycle,setup_json=excluded.setup_json,updated_at=excluded.updated_at,archived_at=excluded.archived_at`)
      .run(
        bot.id,
        bot.name,
        bot.role,
        bot.instructions,
        bot.tint,
        bot.ceiling,
        JSON.stringify(bot.selection),
        bot.compaction ? JSON.stringify(bot.compaction) : null,
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
      compaction: row.compaction_json ? JSON.parse(String(row.compaction_json)) : null,
      compactionState: null,
      talksTo: JSON.parse(String(row.talks_to_json)),
      paused: Boolean(row.paused),
      lifecycle: row.lifecycle as FleetBot['lifecycle'],
      setup: JSON.parse(String(row.setup_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      status: 'offline',
      usage: null,
      activity: null,
      pendingCount: 0,
      accounts: { connected: false, providers: [] },
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
  archivedBots(): { bot: FleetBot; archivedAt: string }[] {
    return (
      this.db.prepare("SELECT * FROM bots WHERE lifecycle='archived' ORDER BY archived_at, created_at").all() as Row[]
    ).map((row) => ({ bot: this.bot(row), archivedAt: String(row.archived_at ?? row.updated_at) }))
  }
  /** Removes a bot and everything recorded about it (secrets cascade), so a new bot may reuse its id. */
  deleteBot(id: string) {
    this.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM pending_deliveries WHERE to_bot=? OR message_id IN (SELECT id FROM peer_messages WHERE from_bot=? OR to_bot=?)'
        )
        .run(id, id, id)
      this.db.prepare('DELETE FROM peer_messages WHERE from_bot=? OR to_bot=?').run(id, id)
      this.db.prepare('DELETE FROM routine_runs WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM routines WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM activity WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM owner_messages WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM pair_blocks WHERE pair_key LIKE ?').run('%|' + id + '|%')
      this.db
        .prepare('DELETE FROM idempotency WHERE scope IN (?,?,?,?)')
        .run('botMessageSend:' + id, 'routineCreate:' + id, 'botRoutineCreate:' + id, 'botOwnerMemorySave:' + id)
      this.db.prepare('DELETE FROM bots WHERE id=?').run(id)
    })
  }
  botSecrets(id: string): BotSecrets | null {
    const row = this.db.prepare('SELECT * FROM bot_secrets WHERE bot_id=?').get(id) as Row | undefined
    return row
      ? {
          controlToken: String(row.control_token),
          gatewayToken: String(row.gateway_token),
          gatewayTokenSha256: String(row.gateway_token_sha256),
          keyringPassword: String(row.keyring_password),
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
  insertPeerMessage(message: FleetPeerMessage) {
    this.db
      .prepare('INSERT INTO peer_messages(id,at,from_bot,to_bot,text,delivered) VALUES(?,?,?,?,?,?)')
      .run(message.id, message.at, message.from, message.to, message.text, Number(message.delivered))
    if (!message.delivered)
      this.db
        .prepare('INSERT INTO pending_deliveries(message_id,to_bot,created_at) VALUES(?,?,?)')
        .run(message.id, message.to, message.at)
  }
  pendingPeers(toBot?: string): FleetPeerMessage[] {
    const rows = toBot
      ? this.db
          .prepare(
            'SELECT p.* FROM peer_messages p JOIN pending_deliveries d ON p.id=d.message_id WHERE d.to_bot=? ORDER BY p.at'
          )
          .all(toBot)
      : this.db
          .prepare('SELECT p.* FROM peer_messages p JOIN pending_deliveries d ON p.id=d.message_id ORDER BY p.at')
          .all()
    return (rows as Row[]).map((row) => ({
      id: String(row.id),
      at: String(row.at),
      from: String(row.from_bot),
      to: String(row.to_bot),
      text: String(row.text),
      delivered: false,
    }))
  }
  markPeerDelivered(id: string) {
    this.transaction(() => {
      this.db.prepare('UPDATE peer_messages SET delivered=1 WHERE id=?').run(id)
      this.db.prepare('DELETE FROM pending_deliveries WHERE message_id=?').run(id)
    })
  }
  countPeerMessages(from: string, since: string) {
    return Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS count FROM peer_messages WHERE from_bot=? AND at>=?')
          .get(from, since) as Row
      ).count
    )
  }
  countPairMessages(a: string, b: string, since: string) {
    return Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM peer_messages WHERE at>=? AND ((from_bot=? AND to_bot=?) OR (from_bot=? AND to_bot=?))'
          )
          .get(since, a, b, b, a) as Row
      ).count
    )
  }
  markOwnerMessage(botId: string, at = new Date().toISOString()) {
    this.db
      .prepare('INSERT INTO owner_messages(bot_id,at) VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET at=excluded.at')
      .run(botId, at)
    this.db.prepare('DELETE FROM pair_blocks WHERE pair_key LIKE ?').run('%|' + botId + '|%')
  }
  pairLastOwner(a: string, b: string): string | null {
    const row = this.db.prepare('SELECT MAX(at) AS at FROM owner_messages WHERE bot_id IN (?,?)').get(a, b) as Row
    return row.at as string | null
  }
  pairBlockedUntil(a: string, b: string): string | null {
    const row = this.db.prepare('SELECT blocked_until FROM pair_blocks WHERE pair_key=?').get(this.pairKey(a, b)) as
      | Row
      | undefined
    return row ? String(row.blocked_until) : null
  }
  blockPair(a: string, b: string, until: string) {
    this.db
      .prepare(
        'INSERT INTO pair_blocks(pair_key,blocked_until) VALUES(?,?) ON CONFLICT(pair_key) DO UPDATE SET blocked_until=excluded.blocked_until'
      )
      .run(this.pairKey(a, b), until)
  }
  private pairKey(a: string, b: string) {
    return '|' + [a, b].sort().join('|') + '|'
  }
  private routine(row: Row): FleetRoutine {
    return {
      id: String(row.id),
      botId: String(row.bot_id),
      title: String(row.title),
      prompt: String(row.prompt),
      schedule: JSON.parse(String(row.schedule_json)),
      enabled: Boolean(row.enabled),
      nextRunAt: row.next_run_at as string | null,
      lastRunAt: row.last_run_at as string | null,
      lastOutcome: row.last_outcome as FleetRoutine['lastOutcome'],
      createdBy: row.created_by as FleetRoutine['createdBy'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
  routines(botId?: string): FleetRoutine[] {
    const rows = botId
      ? this.db.prepare('SELECT * FROM routines WHERE bot_id=? ORDER BY created_at').all(botId)
      : this.db.prepare('SELECT * FROM routines ORDER BY created_at').all()
    return (rows as Row[]).map((row) => this.routine(row))
  }
  routineById(id: string): FleetRoutine | null {
    const row = this.db.prepare('SELECT * FROM routines WHERE id=?').get(id) as Row | undefined
    return row ? this.routine(row) : null
  }
  routineLastInputId(id: string): string | null {
    const row = this.db.prepare('SELECT last_input_id FROM routines WHERE id=?').get(id) as Row | undefined
    return (row?.last_input_id as string | null) ?? null
  }
  setRoutineLastInputId(id: string, inputId: string) {
    this.db.prepare('UPDATE routines SET last_input_id=? WHERE id=?').run(inputId, id)
  }
  saveRoutine(routine: FleetRoutine) {
    this.db
      .prepare(`INSERT INTO routines(id,bot_id,title,prompt,schedule_json,enabled,next_run_at,last_run_at,last_outcome,created_at,updated_at,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,prompt=excluded.prompt,
      schedule_json=excluded.schedule_json,enabled=excluded.enabled,next_run_at=excluded.next_run_at,
      last_run_at=excluded.last_run_at,last_outcome=excluded.last_outcome,updated_at=excluded.updated_at`)
      .run(
        routine.id,
        routine.botId,
        routine.title,
        routine.prompt,
        JSON.stringify(routine.schedule),
        Number(routine.enabled),
        routine.nextRunAt,
        routine.lastRunAt,
        routine.lastOutcome,
        routine.createdAt,
        routine.updatedAt,
        routine.createdBy
      )
  }
  deleteRoutine(id: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM routine_runs WHERE routine_id=?').run(id)
      this.db.prepare('DELETE FROM routines WHERE id=?').run(id)
    })
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
