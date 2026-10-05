import { getDb, transaction } from './store'
import type { WorkspaceCreationRemoteStatus, WorkspaceCreationSource } from '../shared/workspace-creation'

export type WorkspaceCreationPhase = 'creating' | 'registered' | 'failed'

/** Durable journal of one project created or cloned from a chat turn. */
export interface WorkspaceCreationRecord {
  creationId: string
  sourceConversationId: string
  /** Initiating human message (`message:<id>`). */
  originKey: string
  requestKey: string
  fingerprint: string
  source: WorkspaceCreationSource
  name: string
  destination: string
  remoteUrl: string | null
  phase: WorkspaceCreationPhase
  workspaceId: string | null
  reused: boolean
  remote: WorkspaceCreationRemoteStatus | null
  error: string | null
  createdAt: number
  updatedAt: number
}

type Row = Omit<WorkspaceCreationRecord, 'source' | 'remote' | 'reused'> & {
  sourceJson: string
  remoteJson: string | null
  reused: number
}

const columns = `creation_id AS creationId, source_conversation_id AS sourceConversationId, origin_key AS originKey,
  request_key AS requestKey, fingerprint, source_json AS sourceJson, name, destination, remote_url AS remoteUrl, phase,
  workspace_id AS workspaceId, reused, remote_json AS remoteJson, error, created_at AS createdAt,
  updated_at AS updatedAt`

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function fromRow(row: Row | undefined): WorkspaceCreationRecord | null {
  if (!row) return null
  const { sourceJson, remoteJson, reused, ...rest } = row
  return {
    ...rest,
    reused: reused === 1,
    source: parseJson<WorkspaceCreationSource>(sourceJson, { kind: 'new' }),
    remote: parseJson<WorkspaceCreationRemoteStatus | null>(remoteJson, null),
  }
}

export function findWorkspaceCreation(
  sourceConversationId: string,
  originKey: string,
  requestKey: string
): WorkspaceCreationRecord | null {
  return fromRow(
    getDb()
      .prepare(
        `SELECT ${columns} FROM workspace_creations WHERE source_conversation_id=? AND origin_key=? AND request_key=?`
      )
      .get(sourceConversationId, originKey, requestKey) as Row | undefined
  )
}

export function getWorkspaceCreation(creationId: string): WorkspaceCreationRecord | null {
  return fromRow(
    getDb().prepare(`SELECT ${columns} FROM workspace_creations WHERE creation_id=?`).get(creationId) as Row | undefined
  )
}

/** Request keys of one origin that created (or are creating) a workspace; failed attempts do not count. */
export function listWorkspaceCreationRequestKeys(sourceConversationId: string, originKey: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT request_key AS requestKey FROM workspace_creations
       WHERE source_conversation_id=? AND origin_key=? AND phase <> 'failed'`
    )
    .all(sourceConversationId, originKey) as Array<{ requestKey: string }>
  return rows.map((row) => row.requestKey)
}

/** Distinct workspaces registered by one origin, oldest first. */
export function listRegisteredWorkspaceCreationIds(sourceConversationId: string, originKey: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT workspace_id AS workspaceId FROM workspace_creations
       WHERE source_conversation_id=? AND origin_key=? AND phase='registered' AND workspace_id IS NOT NULL
       GROUP BY workspace_id ORDER BY MIN(created_at)`
    )
    .all(sourceConversationId, originKey) as Array<{ workspaceId: string }>
  return rows.map((row) => row.workspaceId)
}

export type NewWorkspaceCreation = Pick<
  WorkspaceCreationRecord,
  | 'creationId'
  | 'sourceConversationId'
  | 'originKey'
  | 'requestKey'
  | 'fingerprint'
  | 'source'
  | 'name'
  | 'destination'
  | 'remoteUrl'
>

/**
 * Record an attempt in `creating`. A failed record for the same key is renewed in place; any other existing
 * record is returned unchanged with `started: false` so the caller applies replay semantics.
 */
export function beginWorkspaceCreation(value: NewWorkspaceCreation): {
  record: WorkspaceCreationRecord
  started: boolean
} {
  let result = null as { record: WorkspaceCreationRecord; started: boolean } | null
  transaction(() => {
    const now = Date.now()
    const existing = findWorkspaceCreation(value.sourceConversationId, value.originKey, value.requestKey)
    if (existing && existing.phase !== 'failed') {
      result = { record: existing, started: false }
      return
    }
    if (existing) {
      getDb()
        .prepare(
          `UPDATE workspace_creations
           SET fingerprint=?, source_json=?, name=?, destination=?, remote_url=?, phase='creating', workspace_id=NULL,
               reused=0, remote_json=NULL, error=NULL, updated_at=?
           WHERE creation_id=? AND phase='failed'`
        )
        .run(
          value.fingerprint,
          JSON.stringify(value.source),
          value.name,
          value.destination,
          value.remoteUrl,
          now,
          existing.creationId
        )
      result = { record: getWorkspaceCreation(existing.creationId)!, started: true }
      return
    }
    getDb()
      .prepare(
        `INSERT INTO workspace_creations
         (creation_id, source_conversation_id, origin_key, request_key, fingerprint, source_json, name, destination,
          remote_url, phase, workspace_id, reused, remote_json, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', NULL, 0, NULL, NULL, ?, ?)`
      )
      .run(
        value.creationId,
        value.sourceConversationId,
        value.originKey,
        value.requestKey,
        value.fingerprint,
        JSON.stringify(value.source),
        value.name,
        value.destination,
        value.remoteUrl,
        now,
        now
      )
    result = { record: getWorkspaceCreation(value.creationId)!, started: true }
  })
  return result!
}

export function completeWorkspaceCreation(
  creationId: string,
  outcome: {
    workspaceId: string
    destination: string
    reused: boolean
    remoteUrl: string | null
    remote: WorkspaceCreationRemoteStatus | null
  }
): void {
  getDb()
    .prepare(
      `UPDATE workspace_creations
       SET phase='registered', workspace_id=?, destination=?, reused=?, remote_url=?, remote_json=?, error=NULL,
           updated_at=?
       WHERE creation_id=? AND phase='creating'`
    )
    .run(
      outcome.workspaceId,
      outcome.destination,
      outcome.reused ? 1 : 0,
      outcome.remoteUrl,
      outcome.remote ? JSON.stringify(outcome.remote) : null,
      Date.now(),
      creationId
    )
}

export function failWorkspaceCreation(creationId: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE workspace_creations SET phase='failed', error=?, updated_at=? WHERE creation_id=? AND phase='creating'`
    )
    .run(error, Date.now(), creationId)
}
