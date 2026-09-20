import type { DatabaseSync } from 'node:sqlite'
import type { BackgroundCompactionStatus } from '../../../shared/background-compaction'
import type { FrozenChatSelection } from '../../../shared/chat'
import { getDb, transaction } from '../../store/db'
import { parsePortableSummaryCheckpoint } from '../portable-context'
import {
  BACKGROUND_COMPACTION_PERSISTENCE_VERSION,
  type BackgroundCompactionBoundary,
  type BackgroundCompactionCandidate,
  type BackgroundCompactionPauseReason,
  type BackgroundCompactionRecord,
  type BackgroundCompactionWork,
} from './types'

type StatusName = BackgroundCompactionStatus['status']

interface PersistedEnvelope {
  version: typeof BACKGROUND_COMPACTION_PERSISTENCE_VERSION
  generation: number
  configIdentity?: string
  conversationWindow?: number
  pauseReason?: BackgroundCompactionPauseReason
  work: BackgroundCompactionWork | null
}

export interface WriteBackgroundCompactionRecord {
  generation: number
  configIdentity?: string
  conversationWindow?: number
  pauseReason?: BackgroundCompactionPauseReason
  status: StatusName
  error?: string
  ready: BackgroundCompactionCandidate | null
  work: BackgroundCompactionWork | null
}

const initialized = new WeakSet<object>()

function ensureTable(db: DatabaseSync): void {
  if (initialized.has(db)) return
  db.exec(`CREATE TABLE IF NOT EXISTS chat_background_compaction (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('idle','queued','running','ready','failed','paused')),
    error TEXT,
    ready_json TEXT,
    work_json TEXT,
    updated_at INTEGER NOT NULL
  )`)
  initialized.add(db)
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseBoundary(value: unknown): BackgroundCompactionBoundary | null {
  const raw = objectValue(value)
  const partIndex = nonNegativeInteger(raw?.partIndex)
  if (!raw || typeof raw.messageId !== 'string' || typeof raw.partId !== 'string' || partIndex == null) return null
  return { messageId: raw.messageId, partId: raw.partId, partIndex }
}

/** Explicit projection prevents provider adapters from accidentally persisting credentials. */
export function persistedBackgroundCompactionSelection(selection: FrozenChatSelection): FrozenChatSelection {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    fastMode: selection.fastMode,
    ...(selection.reasoning != null ? { reasoning: selection.reasoning } : {}),
    ...(selection.reasoningEffort != null ? { reasoningEffort: selection.reasoningEffort } : {}),
    ...(selection.serviceTier != null ? { serviceTier: selection.serviceTier } : {}),
    ...(selection.resolvedModelId != null ? { resolvedModelId: selection.resolvedModelId } : {}),
    ...(selection.behaviorProfileId !== undefined ? { behaviorProfileId: selection.behaviorProfileId } : {}),
    ...(selection.identityFingerprint != null ? { identityFingerprint: selection.identityFingerprint } : {}),
    ...(selection.identityEpoch != null ? { identityEpoch: selection.identityEpoch } : {}),
    ...(selection.providerFingerprint != null ? { providerFingerprint: selection.providerFingerprint } : {}),
    ...(selection.cursorModelSelection
      ? {
          cursorModelSelection: {
            modelId: selection.cursorModelSelection.modelId,
            params: selection.cursorModelSelection.params.map((item) => ({ id: item.id, value: item.value })),
          },
        }
      : {}),
  }
}

function parseSelection(value: unknown): FrozenChatSelection | null {
  const raw = objectValue(value)
  if (
    !raw ||
    typeof raw.providerId !== 'string' ||
    raw.providerId.length === 0 ||
    typeof raw.modelId !== 'string' ||
    raw.modelId.length === 0 ||
    typeof raw.fastMode !== 'boolean'
  ) {
    return null
  }
  if (
    (raw.reasoning != null && typeof raw.reasoning !== 'string') ||
    (raw.reasoningEffort != null && typeof raw.reasoningEffort !== 'string') ||
    (raw.serviceTier != null && typeof raw.serviceTier !== 'string') ||
    (raw.resolvedModelId != null && typeof raw.resolvedModelId !== 'string') ||
    (raw.behaviorProfileId !== undefined &&
      raw.behaviorProfileId !== null &&
      typeof raw.behaviorProfileId !== 'string') ||
    (raw.identityFingerprint != null && typeof raw.identityFingerprint !== 'string') ||
    (raw.identityEpoch != null && !Number.isSafeInteger(raw.identityEpoch)) ||
    (raw.providerFingerprint != null && typeof raw.providerFingerprint !== 'string')
  ) {
    return null
  }
  const selection = persistedBackgroundCompactionSelection({
    ...raw,
    cursorModelSelection: undefined,
  } as unknown as FrozenChatSelection)
  if (raw.cursorModelSelection != null) {
    const cursor = objectValue(raw.cursorModelSelection)
    if (!cursor || typeof cursor.modelId !== 'string' || !Array.isArray(cursor.params)) return null
    const params = cursor.params.flatMap((item) => {
      const param = objectValue(item)
      return param && typeof param.id === 'string' && typeof param.value === 'string'
        ? [{ id: param.id, value: param.value }]
        : []
    })
    if (params.length !== cursor.params.length) return null
    selection.cursorModelSelection = { modelId: cursor.modelId, params }
  }
  return selection
}

function parseCandidate(value: unknown): BackgroundCompactionCandidate | null {
  const raw = objectValue(value)
  const boundary = parseBoundary(raw?.boundary)
  const selection = parseSelection(raw?.selection)
  const generation = nonNegativeInteger(raw?.generation)
  const summaryTokens = nonNegativeInteger(raw?.summaryTokens)
  const coveredTokens = nonNegativeInteger(raw?.coveredTokens)
  const createdAt = finiteNumber(raw?.createdAt)
  if (
    !raw ||
    raw.version !== BACKGROUND_COMPACTION_PERSISTENCE_VERSION ||
    !boundary ||
    !selection ||
    generation == null ||
    summaryTokens == null ||
    coveredTokens == null ||
    createdAt == null ||
    typeof raw.id !== 'string' ||
    typeof raw.configIdentity !== 'string' ||
    typeof raw.sourceHash !== 'string' ||
    typeof raw.summary !== 'string'
  ) {
    return null
  }
  return {
    version: BACKGROUND_COMPACTION_PERSISTENCE_VERSION,
    id: raw.id,
    generation,
    configIdentity: raw.configIdentity,
    boundary,
    sourceHash: raw.sourceHash,
    summary: raw.summary,
    summaryTokens,
    coveredTokens,
    selection,
    createdAt,
  }
}

function parseWork(value: unknown): BackgroundCompactionWork | null {
  const raw = objectValue(value)
  const boundary = parseBoundary(raw?.boundary)
  const selection = parseSelection(raw?.selection)
  const generation = nonNegativeInteger(raw?.generation)
  const coveredTokens = nonNegativeInteger(raw?.coveredTokens)
  const newTokens = positiveInteger(raw?.newTokens)
  const intervalTokens = positiveInteger(raw?.intervalTokens)
  const conversationWindow = positiveInteger(raw?.conversationWindow)
  const contextWindow = positiveInteger(raw?.contextWindow)
  const maxSummaryTokens = positiveInteger(raw?.maxSummaryTokens)
  const attemptSequence = nonNegativeInteger(raw?.attemptSequence)
  const createdAt = finiteNumber(raw?.createdAt)
  const updatedAt = finiteNumber(raw?.updatedAt)
  const resume = raw?.resume == null ? undefined : parsePortableSummaryCheckpoint(raw.resume)
  if (
    !raw ||
    raw.version !== BACKGROUND_COMPACTION_PERSISTENCE_VERSION ||
    !boundary ||
    !selection ||
    generation == null ||
    coveredTokens == null ||
    newTokens == null ||
    intervalTokens == null ||
    conversationWindow == null ||
    contextWindow == null ||
    maxSummaryTokens == null ||
    attemptSequence == null ||
    createdAt == null ||
    updatedAt == null ||
    (raw.resume != null && !resume) ||
    typeof raw.id !== 'string' ||
    typeof raw.configIdentity !== 'string' ||
    typeof raw.sourceHash !== 'string'
  ) {
    return null
  }
  return {
    version: BACKGROUND_COMPACTION_PERSISTENCE_VERSION,
    id: raw.id,
    generation,
    configIdentity: raw.configIdentity,
    boundary,
    sourceHash: raw.sourceHash,
    selection,
    ...(typeof raw.baseCandidateId === 'string' ? { baseCandidateId: raw.baseCandidateId } : {}),
    coveredTokens,
    newTokens,
    intervalTokens,
    conversationWindow,
    contextWindow,
    maxSummaryTokens,
    attemptSequence,
    ...(resume ? { resume } : {}),
    createdAt,
    updatedAt,
  }
}

function parsePauseReason(value: unknown): BackgroundCompactionPauseReason | undefined {
  return value === 'stopped' || value === 'archived' || value === 'selection' || value === 'disabled'
    ? value
    : undefined
}

function parseEnvelope(value: unknown): PersistedEnvelope | null {
  const raw = objectValue(value)
  const generation = nonNegativeInteger(raw?.generation)
  const work = raw?.work == null ? null : parseWork(raw.work)
  if (
    !raw ||
    raw.version !== BACKGROUND_COMPACTION_PERSISTENCE_VERSION ||
    generation == null ||
    (raw.work != null && !work)
  ) {
    return null
  }
  return {
    version: BACKGROUND_COMPACTION_PERSISTENCE_VERSION,
    generation,
    ...(typeof raw.configIdentity === 'string' ? { configIdentity: raw.configIdentity } : {}),
    ...(positiveInteger(raw.conversationWindow)
      ? { conversationWindow: positiveInteger(raw.conversationWindow)! }
      : {}),
    ...(parsePauseReason(raw.pauseReason) ? { pauseReason: parsePauseReason(raw.pauseReason) } : {}),
    work,
  }
}

function normalizeStatus(value: unknown): StatusName {
  return value === 'idle' ||
    value === 'queued' ||
    value === 'running' ||
    value === 'ready' ||
    value === 'failed' ||
    value === 'paused'
    ? value
    : 'idle'
}

function rowToRecord(row: Record<string, unknown>): BackgroundCompactionRecord {
  const envelope = parseEnvelope(parseJson(row.work_json))
  const ready = parseCandidate(parseJson(row.ready_json))
  const generation = envelope?.generation ?? 0
  const consistentReady = ready?.generation === generation ? ready : null
  const consistentWork = envelope?.work?.generation === generation ? envelope.work : null
  const error = typeof row.error === 'string' && row.error.length > 0 ? row.error : undefined
  return {
    conversationId: String(row.conversation_id),
    version: BACKGROUND_COMPACTION_PERSISTENCE_VERSION,
    generation,
    ...(envelope?.configIdentity ? { configIdentity: envelope.configIdentity } : {}),
    ...(envelope?.conversationWindow ? { conversationWindow: envelope.conversationWindow } : {}),
    ...(envelope?.pauseReason ? { pauseReason: envelope.pauseReason } : {}),
    state: {
      revision: nonNegativeInteger(row.revision) ?? 0,
      status: normalizeStatus(row.status),
      ...(error ? { error } : {}),
    },
    ready: consistentReady,
    work: consistentWork,
    updatedAt: finiteNumber(row.updated_at) ?? 0,
  }
}

export class BackgroundCompactionStore {
  get(conversationId: string): BackgroundCompactionRecord | null {
    const db = getDb()
    ensureTable(db)
    const row = db.prepare('SELECT * FROM chat_background_compaction WHERE conversation_id = ?').get(conversationId)
    return row ? rowToRecord(row as Record<string, unknown>) : null
  }

  list(): BackgroundCompactionRecord[] {
    const db = getDb()
    ensureTable(db)
    return (
      db.prepare('SELECT * FROM chat_background_compaction ORDER BY updated_at ASC').all() as Array<
        Record<string, unknown>
      >
    ).map(rowToRecord)
  }

  write(
    conversationId: string,
    input: WriteBackgroundCompactionRecord,
    updatedAt = Date.now()
  ): BackgroundCompactionRecord {
    const db = getDb()
    ensureTable(db)
    const previous = this.get(conversationId)
    const revision = (previous?.state.revision ?? 0) + 1
    const error = input.error?.slice(0, 500) || null
    const envelope: PersistedEnvelope = {
      version: BACKGROUND_COMPACTION_PERSISTENCE_VERSION,
      generation: input.generation,
      ...(input.configIdentity ? { configIdentity: input.configIdentity } : {}),
      ...((input.conversationWindow ?? previous?.conversationWindow)
        ? { conversationWindow: input.conversationWindow ?? previous!.conversationWindow }
        : {}),
      ...(input.pauseReason ? { pauseReason: input.pauseReason } : {}),
      work: input.work,
    }
    db.prepare(
      `INSERT INTO chat_background_compaction
         (conversation_id, revision, status, error, ready_json, work_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         revision = excluded.revision,
         status = excluded.status,
         error = excluded.error,
         ready_json = excluded.ready_json,
         work_json = excluded.work_json,
         updated_at = excluded.updated_at`
    ).run(
      conversationId,
      revision,
      input.status,
      error,
      input.ready ? JSON.stringify(input.ready) : null,
      JSON.stringify(envelope),
      updatedAt
    )
    return {
      conversationId,
      version: BACKGROUND_COMPACTION_PERSISTENCE_VERSION,
      generation: input.generation,
      ...(input.configIdentity ? { configIdentity: input.configIdentity } : {}),
      ...(envelope.conversationWindow ? { conversationWindow: envelope.conversationWindow } : {}),
      ...(input.pauseReason ? { pauseReason: input.pauseReason } : {}),
      state: { revision, status: input.status, ...(error ? { error } : {}) },
      ready: input.ready,
      work: input.work,
      updatedAt,
    }
  }

  remove(conversationId: string): void {
    const db = getDb()
    ensureTable(db)
    db.prepare('DELETE FROM chat_background_compaction WHERE conversation_id = ?').run(conversationId)
  }

  transaction<T>(fn: () => T): T {
    let result!: T
    transaction(() => {
      result = fn()
    })
    return result
  }
}
