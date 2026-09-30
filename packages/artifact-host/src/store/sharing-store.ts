import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { randomId } from '../ids.js'
import { ACCESS_REQUEST_TTL_MS, MAX_EVENTS_PER_ARTIFACT } from '../limits.js'
import { type SessionRecord, toSession, type Visibility } from './artifact-store.js'
import { transaction } from './db.js'

export type PrincipalKind = 'invited' | 'approved' | 'guest'

/** Someone other than the owner who can reach one artifact. */
export interface PrincipalRecord {
  id: string
  artifactId: string
  kind: PrincipalKind
  name: string
  inviteTokenHash: string | null
  inviteExpiresAt: number | null
  revokedAt: number | null
  createdAt: number
}

export type AccessRequestStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface AccessRequestRecord {
  id: string
  artifactId: string
  name: string
  message: string
  browserSecretHash: string
  status: AccessRequestStatus
  principalId: string | null
  createdAt: number
  decidedAt: number | null
}

export const ARTIFACT_EVENT_KINDS = ['device_added', 'access_requested', 'invite_declined', 'comment_added'] as const
export type ArtifactEventKind = (typeof ARTIFACT_EVENT_KINDS)[number]
export type EventData = Record<string, string | number>

export interface EventRecord {
  id: string
  artifactId: string
  kind: ArtifactEventKind
  data: EventData
  createdAt: number
  seenAt: number | null
}

export interface SharingFields {
  visibility: Visibility
  linkExpiresAt: number | null
  accessCodeHash: string | null
  commentsEnabled: boolean
}

type Row = Record<string, unknown>

const SHARING_COLUMNS: Record<keyof SharingFields, string> = {
  visibility: 'visibility',
  linkExpiresAt: 'link_expires_at',
  accessCodeHash: 'access_code_hash',
  commentsEnabled: 'comments_enabled',
}

const toPrincipal = (row: Row): PrincipalRecord => ({
  id: row.id as string,
  artifactId: row.artifact_id as string,
  kind: row.kind as PrincipalKind,
  name: row.name as string,
  inviteTokenHash: (row.invite_token_hash as string | null) ?? null,
  inviteExpiresAt: (row.invite_expires_at as number | null) ?? null,
  revokedAt: (row.revoked_at as number | null) ?? null,
  createdAt: row.created_at as number,
})

const toRequest = (row: Row): AccessRequestRecord => ({
  id: row.id as string,
  artifactId: row.artifact_id as string,
  name: row.name as string,
  message: row.message as string,
  browserSecretHash: row.browser_secret_hash as string,
  status: row.status as AccessRequestStatus,
  principalId: (row.principal_id as string | null) ?? null,
  createdAt: row.created_at as number,
  decidedAt: (row.decided_at as number | null) ?? null,
})

function parseData(json: unknown): EventData {
  try {
    const value: unknown = JSON.parse(json as string)
    if (typeof value !== 'object' || value === null) return {}
    const data: EventData = {}
    for (const [key, entry] of Object.entries(value))
      if (typeof entry === 'string' || typeof entry === 'number') data[key] = entry
    return data
  } catch {
    return {}
  }
}

const toEvent = (row: Row): EventRecord => ({
  id: row.id as string,
  artifactId: row.artifact_id as string,
  kind: row.kind as ArtifactEventKind,
  data: parseData(row.data_json),
  createdAt: row.created_at as number,
  seenAt: (row.seen_at as number | null) ?? null,
})

/** People, their devices, access requests and events of the host's artifacts. */
export class SharingStore {
  constructor(private readonly db: DatabaseSync) {}

  getSharing(artifactId: string): SharingFields | null {
    const row = this.db
      .prepare('SELECT visibility, link_expires_at, access_code_hash, comments_enabled FROM artifacts WHERE id = ?')
      .get(artifactId) as Row | undefined
    if (!row) return null
    return {
      visibility: row.visibility as Visibility,
      linkExpiresAt: (row.link_expires_at as number | null) ?? null,
      accessCodeHash: (row.access_code_hash as string | null) ?? null,
      commentsEnabled: row.comments_enabled === 1,
    }
  }

  setSharing(artifactId: string, patch: Partial<SharingFields>): void {
    const assignments: string[] = []
    const params: SQLInputValue[] = []
    for (const key of Object.keys(SHARING_COLUMNS) as (keyof SharingFields)[]) {
      const value = patch[key]
      if (value === undefined) continue
      assignments.push(`${SHARING_COLUMNS[key]} = ?`)
      params.push(typeof value === 'boolean' ? Number(value) : value)
    }
    if (!assignments.length) return
    this.db.prepare(`UPDATE artifacts SET ${assignments.join(', ')} WHERE id = ?`).run(...params, artifactId)
  }

  insertPrincipal(principal: PrincipalRecord): void {
    this.db
      .prepare(
        `INSERT INTO principals (id, artifact_id, kind, name, invite_token_hash, invite_expires_at, revoked_at,
           created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        principal.id,
        principal.artifactId,
        principal.kind,
        principal.name,
        principal.inviteTokenHash,
        principal.inviteExpiresAt,
        principal.revokedAt,
        principal.createdAt
      )
  }

  getPrincipal(id: string): PrincipalRecord | null {
    const row = this.db.prepare('SELECT * FROM principals WHERE id = ?').get(id) as Row | undefined
    return row ? toPrincipal(row) : null
  }

  findPrincipalByInvite(tokenHash: string, artifactId: string): PrincipalRecord | null {
    const row = this.db
      .prepare('SELECT * FROM principals WHERE invite_token_hash = ? AND artifact_id = ?')
      .get(tokenHash, artifactId) as Row | undefined
    return row ? toPrincipal(row) : null
  }

  listPrincipals(artifactId: string): PrincipalRecord[] {
    return (
      this.db.prepare('SELECT * FROM principals WHERE artifact_id = ? ORDER BY created_at, id').all(artifactId) as Row[]
    ).map(toPrincipal)
  }

  setInviteToken(id: string, tokenHash: string): void {
    this.db.prepare('UPDATE principals SET invite_token_hash = ? WHERE id = ?').run(tokenHash, id)
  }

  setPrincipalName(id: string, name: string): void {
    this.db.prepare('UPDATE principals SET name = ? WHERE id = ?').run(name, id)
  }

  /** Revokes the person and every device they joined with. */
  revokePrincipal(id: string, now: number): void {
    transaction(this.db, () => {
      this.db.prepare('UPDATE principals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id)
      this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL').run(now, id)
    })
  }

  /** The person's devices that still work. */
  listSessions(artifactId: string, principalId: string, now: number): SessionRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM sessions WHERE artifact_id = ? AND principal_id = ? AND revoked_at IS NULL AND expires_at > ?
           ORDER BY created_at, id`
        )
        .all(artifactId, principalId, now) as Row[]
    ).map(toSession)
  }

  countSessions(principalId: string, now: number): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM sessions WHERE principal_id = ? AND revoked_at IS NULL AND expires_at > ?')
        .get(principalId, now) as Row
    ).n as number
  }

  revokeSessionOf(artifactId: string, sessionId: string, now: number): boolean {
    return (
      this.db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND artifact_id = ? AND revoked_at IS NULL')
        .run(now, sessionId, artifactId).changes > 0
    )
  }

  /** Every session of the artifact, the owner's included. */
  revokeAllSessions(artifactId: string, now: number): void {
    this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE artifact_id = ? AND revoked_at IS NULL')
      .run(now, artifactId)
  }

  insertRequest(request: AccessRequestRecord): void {
    this.db
      .prepare(
        `INSERT INTO access_requests (id, artifact_id, name, message, browser_secret_hash, status, principal_id,
           created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        request.id,
        request.artifactId,
        request.name,
        request.message,
        request.browserSecretHash,
        request.status,
        request.principalId,
        request.createdAt,
        request.decidedAt
      )
  }

  /** The browser's most recent request for the artifact. */
  findRequestByBrowser(artifactId: string, secretHash: string): AccessRequestRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM access_requests WHERE artifact_id = ? AND browser_secret_hash = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(artifactId, secretHash) as Row | undefined
    return row ? toRequest(row) : null
  }

  getRequest(id: string): AccessRequestRecord | null {
    const row = this.db.prepare('SELECT * FROM access_requests WHERE id = ?').get(id) as Row | undefined
    return row ? toRequest(row) : null
  }

  /** Requests nobody answered within a day stop waiting, on every artifact. */
  expireRequests(now: number): void {
    this.db
      .prepare(
        `UPDATE access_requests SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at <= ?`
      )
      .run(now, now - ACCESS_REQUEST_TTL_MS)
  }

  listPendingRequests(artifactId: string, now: number): AccessRequestRecord[] {
    this.expireRequests(now)
    return (
      this.db
        .prepare(
          `SELECT * FROM access_requests WHERE artifact_id = ? AND status = 'pending' ORDER BY created_at, rowid`
        )
        .all(artifactId) as Row[]
    ).map(toRequest)
  }

  decideRequest(id: string, status: 'approved' | 'denied', principalId: string | null, now: number): void {
    this.db
      .prepare('UPDATE access_requests SET status = ?, principal_id = ?, decided_at = ? WHERE id = ?')
      .run(status, principalId, now, id)
  }

  /** Records an event, then keeps the artifact within its limit by dropping the oldest already-seen events first. */
  addEvent(artifactId: string, kind: ArtifactEventKind, data: EventData, now: number): EventRecord {
    const event: EventRecord = { id: randomId(), artifactId, kind, data, createdAt: now, seenAt: null }
    this.db
      .prepare('INSERT INTO events (id, artifact_id, kind, data_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(event.id, artifactId, kind, JSON.stringify(data), now)
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE artifact_id = ?').get(artifactId) as Row)
      .n as number
    if (total > MAX_EVENTS_PER_ARTIFACT)
      this.db
        .prepare(
          `DELETE FROM events WHERE id IN (
             SELECT id FROM events WHERE artifact_id = ? ORDER BY (seen_at IS NULL), created_at, rowid LIMIT ?
           )`
        )
        .run(artifactId, total - MAX_EVENTS_PER_ARTIFACT)
    return event
  }

  /** Newest first. */
  listEvents(filter: { artifactId?: string; unseenOnly?: boolean; limit?: number }): EventRecord[] {
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    if (filter.artifactId !== undefined) {
      clauses.push('artifact_id = ?')
      params.push(filter.artifactId)
    }
    if (filter.unseenOnly) clauses.push('seen_at IS NULL')
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (
      this.db
        .prepare(`SELECT * FROM events ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(...params, filter.limit ?? 100) as Row[]
    ).map(toEvent)
  }

  markSeen(artifactId: string | undefined, now: number): void {
    if (artifactId === undefined) this.db.prepare('UPDATE events SET seen_at = ? WHERE seen_at IS NULL').run(now)
    else this.db.prepare('UPDATE events SET seen_at = ? WHERE seen_at IS NULL AND artifact_id = ?').run(now, artifactId)
  }
}
