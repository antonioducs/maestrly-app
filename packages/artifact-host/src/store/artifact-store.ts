import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { ArtifactHostError } from '../errors.js'
import { transaction } from './db.js'

export type OwnerKind = 'local' | 'device' | 'bot'
export type Visibility = 'private' | 'people' | 'link'
export type VersionAuthor = 'agent' | 'owner'

export interface ArtifactRecord {
  id: string
  title: string
  description: string
  ownerKind: OwnerKind
  ownerId: string
  workspaceId: string | null
  conversationId: string | null
  conversationTitle: string | null
  currentVersion: number
  versionCount: number
  visibility: Visibility
  createdAt: number
  updatedAt: number
  /** Bytes of the distinct files and thumbnails of every version; blobs shared with other artifacts count here too. */
  storageBytes: number
  /** The newest version with a thumbnail, or null when no version has one. */
  thumbnailVersion: number | null
  /** Events (new devices, access requests, declined invitations, comments) the owner has not seen yet. */
  unseenEvents: number
  pendingRequests: number
  /** Comment threads that are neither resolved nor deleted. */
  openComments: number
}

export type NewArtifact = Pick<
  ArtifactRecord,
  | 'id'
  | 'title'
  | 'description'
  | 'ownerKind'
  | 'ownerId'
  | 'workspaceId'
  | 'conversationId'
  | 'conversationTitle'
  | 'createdAt'
>

export interface FileRecord {
  path: string
  sha256: string
  bytes: number
  contentType: string
}

export interface ThumbnailRecord {
  version: number
  sha256: string
  contentType: string
  bytes: number
  createdAt: number
}

export interface VersionRecord {
  artifactId: string
  number: number
  entry: string
  summary: string
  createdBy: VersionAuthor
  fileCount: number
  totalBytes: number
  createdAt: number
}

export interface NewVersion {
  entry: string
  summary: string
  createdBy: VersionAuthor
  createdAt: number
  files: FileRecord[]
}

export interface SessionRecord {
  id: string
  artifactId: string
  principalId: string | null
  tokenHash: string
  deviceLabel: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  revokedAt: number | null
}

export type NewSession = Pick<
  SessionRecord,
  'id' | 'artifactId' | 'principalId' | 'tokenHash' | 'deviceLabel' | 'createdAt' | 'expiresAt'
>

export interface ArtifactListFilter {
  ownerKind?: OwnerKind
  ownerId?: string
  workspaceId?: string
  conversationId?: string
}

type Row = Record<string, unknown>

const ARTIFACT_COLUMNS = `a.*,
  (SELECT COUNT(*) FROM versions v WHERE v.artifact_id = a.id) AS version_count,
  (SELECT COALESCE(SUM(u.bytes), 0) FROM (
    SELECT sha256, bytes FROM version_files WHERE artifact_id = a.id
    UNION SELECT sha256, bytes FROM thumbnails WHERE artifact_id = a.id
  ) u) AS storage_bytes,
  (SELECT MAX(t.version) FROM thumbnails t WHERE t.artifact_id = a.id) AS thumbnail_version,
  (SELECT COUNT(*) FROM events e WHERE e.artifact_id = a.id AND e.seen_at IS NULL) AS unseen_events,
  (SELECT COUNT(*) FROM access_requests r WHERE r.artifact_id = a.id AND r.status = 'pending') AS pending_requests,
  (SELECT COUNT(*) FROM comments c WHERE c.artifact_id = a.id AND c.parent_id IS NULL AND c.status = 'open'
     AND c.deleted_at IS NULL) AS open_comments`
const FILTER_COLUMNS: Record<keyof ArtifactListFilter, string> = {
  ownerKind: 'owner_kind',
  ownerId: 'owner_id',
  workspaceId: 'workspace_id',
  conversationId: 'conversation_id',
}

const toArtifact = (row: Row): ArtifactRecord => ({
  id: row.id as string,
  title: row.title as string,
  description: row.description as string,
  ownerKind: row.owner_kind as OwnerKind,
  ownerId: row.owner_id as string,
  workspaceId: (row.workspace_id as string | null) ?? null,
  conversationId: (row.conversation_id as string | null) ?? null,
  conversationTitle: (row.conversation_title as string | null) ?? null,
  currentVersion: row.current_version as number,
  versionCount: row.version_count as number,
  visibility: row.visibility as Visibility,
  createdAt: row.created_at as number,
  updatedAt: row.updated_at as number,
  storageBytes: row.storage_bytes as number,
  thumbnailVersion: (row.thumbnail_version as number | null) ?? null,
  unseenEvents: row.unseen_events as number,
  pendingRequests: row.pending_requests as number,
  openComments: row.open_comments as number,
})

const toVersion = (row: Row): VersionRecord => ({
  artifactId: row.artifact_id as string,
  number: row.number as number,
  entry: row.entry as string,
  summary: row.summary as string,
  createdBy: row.created_by as VersionAuthor,
  fileCount: row.file_count as number,
  totalBytes: row.total_bytes as number,
  createdAt: row.created_at as number,
})

const toFile = (row: Row): FileRecord => ({
  path: row.path as string,
  sha256: row.sha256 as string,
  bytes: row.bytes as number,
  contentType: row.content_type as string,
})

export const toSession = (row: Row): SessionRecord => ({
  id: row.id as string,
  artifactId: row.artifact_id as string,
  principalId: (row.principal_id as string | null) ?? null,
  tokenHash: row.token_hash as string,
  deviceLabel: row.device_label as string,
  createdAt: row.created_at as number,
  lastSeenAt: row.last_seen_at as number,
  expiresAt: row.expires_at as number,
  revokedAt: (row.revoked_at as number | null) ?? null,
})

/** Synchronous queries over one host database. Every multi-row write runs in a single transaction. */
export class ArtifactStore {
  constructor(readonly db: DatabaseSync) {}

  createArtifact(artifact: NewArtifact, version: NewVersion): void {
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO artifacts (id, title, description, owner_kind, owner_id, workspace_id, conversation_id,
             conversation_title, current_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(
          artifact.id,
          artifact.title,
          artifact.description,
          artifact.ownerKind,
          artifact.ownerId,
          artifact.workspaceId,
          artifact.conversationId,
          artifact.conversationTitle,
          artifact.createdAt,
          artifact.createdAt
        )
      this.insertVersion(artifact.id, 1, version)
    })
  }

  /** Adds version `expected + 1`, or fails with `version_conflict` when another version was added meanwhile. */
  addVersion(id: string, version: NewVersion, expected: number, conversationTitle?: string | null): number {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT current_version FROM artifacts WHERE id = ?').get(id) as Row | undefined
      if (!row) throw new ArtifactHostError('not_found', 'Artifact not found')
      const current = row.current_version as number
      if (current !== expected)
        throw new ArtifactHostError('version_conflict', `Version ${current} is the current version`, {
          currentVersion: current,
        })
      const next = expected + 1
      this.insertVersion(id, next, version)
      this.db
        .prepare(
          `UPDATE artifacts SET current_version = ?, updated_at = ?, conversation_title = COALESCE(?, conversation_title)
           WHERE id = ?`
        )
        .run(next, version.createdAt, conversationTitle ?? null, id)
      return next
    })
  }

  private insertVersion(id: string, number: number, version: NewVersion): void {
    const totalBytes = version.files.reduce((sum, file) => sum + file.bytes, 0)
    this.db
      .prepare(
        `INSERT INTO versions (artifact_id, number, entry, summary, created_by, file_count, total_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        number,
        version.entry,
        version.summary,
        version.createdBy,
        version.files.length,
        totalBytes,
        version.createdAt
      )
    const insertFile = this.db.prepare(
      `INSERT INTO version_files (artifact_id, version, path, sha256, bytes, content_type) VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const file of version.files) insertFile.run(id, number, file.path, file.sha256, file.bytes, file.contentType)
  }

  getArtifact(id: string): ArtifactRecord | null {
    const row = this.db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts a WHERE a.id = ?`).get(id) as Row | undefined
    return row ? toArtifact(row) : null
  }

  countArtifacts(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as Row).n as number
  }

  listArtifacts(filter: ArtifactListFilter = {}): ArtifactRecord[] {
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    for (const key of Object.keys(FILTER_COLUMNS) as (keyof ArtifactListFilter)[]) {
      const value = filter[key]
      if (value === undefined) continue
      clauses.push(`a.${FILTER_COLUMNS[key]} = ?`)
      params.push(value)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (
      this.db
        .prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts a ${where} ORDER BY a.updated_at DESC, a.id`)
        .all(...params) as Row[]
    ).map(toArtifact)
  }

  listVersions(id: string): VersionRecord[] {
    return (this.db.prepare('SELECT * FROM versions WHERE artifact_id = ? ORDER BY number DESC').all(id) as Row[]).map(
      toVersion
    )
  }

  getVersion(id: string, number: number): VersionRecord | null {
    const row = this.db.prepare('SELECT * FROM versions WHERE artifact_id = ? AND number = ?').get(id, number) as
      | Row
      | undefined
    return row ? toVersion(row) : null
  }

  listFiles(id: string, version: number): FileRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM version_files WHERE artifact_id = ? AND version = ? ORDER BY path')
        .all(id, version) as Row[]
    ).map(toFile)
  }

  getFile(id: string, version: number, filePath: string): FileRecord | null {
    const row = this.db
      .prepare('SELECT * FROM version_files WHERE artifact_id = ? AND version = ? AND path = ?')
      .get(id, version, filePath) as Row | undefined
    return row ? toFile(row) : null
  }

  deleteArtifact(id: string): boolean {
    return transaction(this.db, () => this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id).changes > 0)
  }

  /** Stores the thumbnail of a version and returns the blob of the one it replaced, if any. */
  setThumbnail(id: string, version: number, thumbnail: Omit<ThumbnailRecord, 'version'>): string | null {
    return transaction(this.db, () => {
      const previous = this.db
        .prepare('SELECT sha256 FROM thumbnails WHERE artifact_id = ? AND version = ?')
        .get(id, version) as Row | undefined
      this.db
        .prepare(
          `INSERT OR REPLACE INTO thumbnails (artifact_id, version, sha256, content_type, bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, version, thumbnail.sha256, thumbnail.contentType, thumbnail.bytes, thumbnail.createdAt)
      return previous ? (previous.sha256 as string) : null
    })
  }

  /** The thumbnail of the newest version up to `maxVersion` that has one. */
  getThumbnail(id: string, maxVersion: number): ThumbnailRecord | null {
    const row = this.db
      .prepare('SELECT * FROM thumbnails WHERE artifact_id = ? AND version <= ? ORDER BY version DESC LIMIT 1')
      .get(id, maxVersion) as Row | undefined
    return row
      ? {
          version: row.version as number,
          sha256: row.sha256 as string,
          contentType: row.content_type as string,
          bytes: row.bytes as number,
          createdAt: row.created_at as number,
        }
      : null
  }

  blobsOf(id: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT sha256 FROM version_files WHERE artifact_id = ? UNION SELECT sha256 FROM thumbnails WHERE artifact_id = ?'
        )
        .all(id, id) as Row[]
    ).map((row) => row.sha256 as string)
  }

  isBlobReferenced(sha: string): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM version_files WHERE sha256 = ? UNION ALL SELECT 1 FROM thumbnails WHERE sha256 = ? LIMIT 1'
        )
        .get(sha, sha) !== undefined
    )
  }

  referencedBlobs(): Set<string> {
    return new Set(
      (this.db.prepare('SELECT sha256 FROM version_files UNION SELECT sha256 FROM thumbnails').all() as Row[]).map(
        (row) => row.sha256 as string
      )
    )
  }

  insertOwnerTicket(tokenHash: string, artifactId: string, expiresAt: number): void {
    this.db
      .prepare('INSERT INTO owner_tickets (token_hash, artifact_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, artifactId, expiresAt)
  }

  /** Deletes the ticket and returns its artifact: a ticket works once, and never after it expires. */
  consumeOwnerTicket(tokenHash: string, now: number): string | null {
    return transaction(this.db, () => {
      this.db.prepare('DELETE FROM owner_tickets WHERE expires_at <= ?').run(now)
      const row = this.db
        .prepare('DELETE FROM owner_tickets WHERE token_hash = ? RETURNING artifact_id')
        .get(tokenHash) as Row | undefined
      return row ? (row.artifact_id as string) : null
    })
  }

  createSession(session: NewSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, artifact_id, principal_id, token_hash, device_label, created_at, last_seen_at,
           expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.artifactId,
        session.principalId,
        session.tokenHash,
        session.deviceLabel,
        session.createdAt,
        session.createdAt,
        session.expiresAt
      )
  }

  findSessionByToken(tokenHash: string, artifactId: string, now: number): SessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions WHERE token_hash = ? AND artifact_id = ? AND revoked_at IS NULL AND expires_at > ?`
      )
      .get(tokenHash, artifactId, now) as Row | undefined
    return row ? toSession(row) : null
  }

  findSessionById(id: string, now: number): SessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?')
      .get(id, now) as Row | undefined
    return row ? toSession(row) : null
  }

  touchSession(id: string, now: number, expiresAt: number): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now, expiresAt, id)
  }

  revokeSession(id: string, now: number): void {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id)
  }

  /** Writes a consistent copy of the database; the target must not exist. */
  vacuumInto(file: string): void {
    this.db.prepare('VACUUM INTO ?').run(file)
  }

  capabilityKey(): Buffer {
    const row = this.db.prepare("SELECT value FROM host_meta WHERE key = 'capability_key'").get() as Row
    return Buffer.from(row.value as string, 'base64')
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }
}
