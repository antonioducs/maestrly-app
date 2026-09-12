import { createHash } from 'node:crypto'
import { promises as fsp, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import type { RuntimeAssetLease } from '../../../shared/runtime-assets'
import type { LocalMemory, MemoryIndexStatus, MemorySearchHit, SharedKnowledgeDocument } from '../../../shared/memory'
import { workspaceDataDir } from '../../app-paths'
import { getWorkspace } from '../../store'
import { acquireRuntimeAssetLease, ensureRuntimeAsset, readyRuntimeAsset } from '../../runtime-assets/app-service'
import { embedTexts, trackEmbeddingWrite } from '../../local-ml/embedding-service'
import { isWorkspaceMemoryEnabled, onWorkspaceMemoryEnabledChanged } from '../access'
import { listLocalMemories, onLocalMemoryChange } from '../local-memory-service'
import { chunkSharedKnowledge, discoverSharedKnowledge } from '../shared-knowledge'
import { findTrustedVectorExtension, openMemoryIndexDatabase, type VectorBackend } from './vector-backend'

const INDEX_SCHEMA_VERSION = '1'
const INDEX_CHUNKER_VERSION = '1'
const INDEX_MODEL_VERSION = 'all-MiniLM-L6-v2:384'
const MEMORY_INDEX_FILE = 'memory-index.sqlite'
const EMBEDDING_BATCH = 32
const MAX_LOCAL_CHUNK_CHARS = 4_000

export interface MemoryScopeRoot {
  root: string
  linkName?: string
}

export interface IndexedMemoryCandidate extends MemorySearchHit {
  chunkId: string
  rowid: number
  rank: number
}

interface IndexHandle {
  workspaceId: string
  file: string
  db: DatabaseSync
  vector: VectorBackend
  lease?: RuntimeAssetLease
  watchers: Map<string, FSWatcher>
  watcherTimers: Map<string, ReturnType<typeof setTimeout>>
  reconcileController?: AbortController
  embeddingController?: AbortController
  reconcileFlight?: Promise<void>
  initializedAt: number
  state: MemoryIndexStatus['state']
  errorCode?: string
}

interface IndexedChunkInput {
  id: string
  ordinal: number
  content: string
  heading?: string
  startLine?: number
  endLine?: number
}

interface IndexedDocumentInput {
  id: string
  sourceKind: 'local' | 'shared'
  sourceId: string
  scopeKey: string
  title: string
  contentHash: string
  type: string
  status: string
  scope: string
  tags: string[]
  pinned: boolean
  alwaysApply: boolean
  eligible: boolean
  source?: string
  repo?: string
  relativePath?: string
  warnings: string[]
  updatedAt: number
  chunks: IndexedChunkInput[]
}

const handles = new Map<string, IndexHandle>()
const openingHandles = new Map<string, { epoch: number; promise: Promise<IndexHandle> }>()
const handleEpochs = new Map<string, number>()
const warmupFlights = new Map<string, { controller: AbortController; promise: Promise<void> }>()
const warmupTimers = new Map<string, ReturnType<typeof setTimeout>>()
const events = new EventEmitter()
events.setMaxListeners(50)
let disposeLocalEvents: (() => void) | undefined
let disposeEnabledEvents: (() => void) | undefined

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function transaction(db: DatabaseSync, operation: () => void): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    operation()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function emitStatus(handle: IndexHandle): void {
  events.emit('status', statusForHandle(handle))
}

export function onMemoryIndexStatus(listener: (status: MemoryIndexStatus) => void): () => void {
  events.on('status', listener)
  return () => events.off('status', listener)
}

function closeHandle(handle: IndexHandle): void {
  handle.reconcileController?.abort(new Error('memory index closed'))
  handle.embeddingController?.abort(new Error('memory index closed'))
  for (const timer of handle.watcherTimers.values()) clearTimeout(timer)
  for (const watcher of handle.watchers.values()) watcher.close()
  handle.watcherTimers.clear()
  handle.watchers.clear()
  try {
    handle.db.close()
  } catch {
    // already closed
  }
  handle.lease?.release()
  if (handles.get(handle.workspaceId) === handle) handles.delete(handle.workspaceId)
}

function closeUnpublishedHandle(handle: IndexHandle): void {
  try {
    handle.db.close()
  } catch {
    // already closed
  }
  handle.lease?.release()
}

function initializeSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_scopes (
      scope_key TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      root TEXT NOT NULL,
      real_root TEXT NOT NULL,
      link_name TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_documents (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      always_apply INTEGER NOT NULL DEFAULT 0,
      eligible INTEGER NOT NULL DEFAULT 1,
      source TEXT,
      repo TEXT,
      relative_path TEXT,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_documents_source ON memory_documents(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_memory_documents_scope ON memory_documents(scope_key, status, eligible);
    CREATE TABLE IF NOT EXISTS memory_chunks (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      document_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      heading TEXT,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      embedding_state TEXT NOT NULL DEFAULT 'pending',
      UNIQUE(document_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_document ON memory_chunks(document_id, ordinal);
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      chunk_id UNINDEXED,
      title,
      content,
      tags,
      scope,
      path,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `)
  const expected = {
    schema_version: INDEX_SCHEMA_VERSION,
    chunker_version: INDEX_CHUNKER_VERSION,
    model_version: INDEX_MODEL_VERSION,
  }
  const read = db.prepare('SELECT value FROM memory_index_meta WHERE key = ?')
  const upsert = db.prepare(
    'INSERT INTO memory_index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  for (const [key, value] of Object.entries(expected)) {
    const existing = read.get(key) as { value: string } | undefined
    if (existing && existing.value !== value) throw new Error(`memory-index-incompatible:${key}`)
    upsert.run(key, value)
  }
}

async function quarantineIndex(file: string): Promise<void> {
  const diagnostic = `${file}.diagnostic-${Date.now()}`
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      await fsp.rename(`${file}${suffix}`, `${diagnostic}${suffix}`)
    } catch {
      // absent sidecar
    }
  }
  const directory = path.dirname(file)
  const prefix = `${path.basename(file)}.diagnostic-`
  const diagnostics = (await fsp.readdir(directory).catch(() => []))
    .filter((entry) => entry.startsWith(prefix) && !entry.endsWith('-wal') && !entry.endsWith('-shm'))
    .sort()
  for (const stale of diagnostics.slice(0, Math.max(0, diagnostics.length - 3))) {
    await fsp.rm(path.join(directory, stale), { force: true }).catch(() => undefined)
    await fsp.rm(path.join(directory, `${stale}-wal`), { force: true }).catch(() => undefined)
    await fsp.rm(path.join(directory, `${stale}-shm`), { force: true }).catch(() => undefined)
  }
}

async function createHandle(workspaceId: string, epoch: number): Promise<IndexHandle> {
  const directory = workspaceDataDir(workspaceId)
  await fsp.mkdir(directory, { recursive: true })
  const file = path.join(directory, MEMORY_INDEX_FILE)
  let lease: RuntimeAssetLease | undefined
  let extension: string | undefined
  try {
    await readyRuntimeAsset('local-ml-runtime')
    lease = await acquireRuntimeAssetLease('local-ml-runtime')
    extension = findTrustedVectorExtension(lease.path)
    if (!extension) {
      lease.release()
      lease = undefined
    }
  } catch {
    // FTS-only is a supported first-class mode.
  }

  const create = () => {
    const opened = openMemoryIndexDatabase(file, extension)
    try {
      initializeSchema(opened.db)
      const check = opened.db.prepare('PRAGMA quick_check').get() as Record<string, unknown>
      if (Object.values(check)[0] !== 'ok') throw new Error('memory-index-corrupt')
      return opened
    } catch (error) {
      opened.db.close() // Windows cannot quarantine a database while its handle remains open.
      throw error
    }
  }
  let opened: ReturnType<typeof openMemoryIndexDatabase>
  try {
    opened = create()
  } catch (error) {
    lease?.release()
    lease = undefined
    try {
      await quarantineIndex(file)
    } catch {
      // If quarantine itself fails, the second open surfaces the useful error.
    }
    extension = undefined
    opened = create()
    console.warn('[memory-index] cache rebuilt:', error instanceof Error ? error.message : error)
  }
  const handle: IndexHandle = {
    workspaceId,
    file,
    db: opened.db,
    vector: opened.vector,
    ...(lease ? { lease } : {}),
    watchers: new Map(),
    watcherTimers: new Map(),
    initializedAt: Date.now(),
    state: opened.vector.available ? 'ready' : 'text-only',
  }
  if (opened.vector.available) {
    handle.db
      .prepare("UPDATE memory_chunks SET embedding_state = 'pending' WHERE embedding_state = 'unavailable'")
      .run()
  }
  if ((handleEpochs.get(workspaceId) ?? 0) !== epoch) {
    closeUnpublishedHandle(handle)
    throw new Error('memory index open cancelled')
  }
  handles.set(workspaceId, handle)
  return handle
}

async function openHandle(workspaceId: string): Promise<IndexHandle> {
  const existing = handles.get(workspaceId)
  if (existing) return existing
  const epoch = handleEpochs.get(workspaceId) ?? 0
  const opening = openingHandles.get(workspaceId)
  if (opening?.epoch === epoch) return opening.promise
  let promise: Promise<IndexHandle>
  promise = createHandle(workspaceId, epoch).finally(() => {
    if (openingHandles.get(workspaceId)?.promise === promise) openingHandles.delete(workspaceId)
  })
  openingHandles.set(workspaceId, { epoch, promise })
  return promise
}

export function memoryScopeKey(workspaceId: string, realRoot: string): string {
  return `${workspaceId}:${digest(realRoot).slice(0, 24)}`
}

async function normalizeRoots(
  workspaceId: string,
  roots?: MemoryScopeRoot[]
): Promise<Array<MemoryScopeRoot & { realRoot: string; scopeKey: string }>> {
  const workspace = getWorkspace(workspaceId)
  const source = roots?.length ? roots : workspace ? [{ root: workspace.path }] : []
  const result: Array<MemoryScopeRoot & { realRoot: string; scopeKey: string }> = []
  const seen = new Set<string>()
  for (const item of source) {
    try {
      const realRoot = await fsp.realpath(item.root)
      if (seen.has(realRoot)) continue
      seen.add(realRoot)
      result.push({ ...item, realRoot, scopeKey: memoryScopeKey(workspaceId, realRoot) })
    } catch {
      // Missing roots are omitted and cannot leak data from a similarly named path.
    }
  }
  return result
}

function localChunks(memory: LocalMemory): IndexedChunkInput[] {
  const lines = memory.content.replaceAll('\r\n', '\n').split('\n')
  const chunks: IndexedChunkInput[] = []
  let start = 0
  while (start < lines.length) {
    let end = start
    let chars = 0
    while (end < lines.length && (chars === 0 || chars + lines[end].length + 1 <= MAX_LOCAL_CHUNK_CHARS)) {
      chars += lines[end].length + 1
      end += 1
    }
    const ordinal = chunks.length
    chunks.push({
      id: `local:${memory.id}:${ordinal}`,
      ordinal,
      content: lines.slice(start, end).join('\n'),
      startLine: start + 1,
      endLine: Math.max(start + 1, end),
    })
    start = end
  }
  return chunks
}

function localDocument(memory: LocalMemory): IndexedDocumentInput {
  const metadataHash = digest(
    JSON.stringify({
      hash: memory.contentHash,
      title: memory.title,
      type: memory.type,
      status: memory.status,
      scope: memory.scope,
      tags: memory.tags,
      pinned: memory.pinned,
      source: memory.source,
    })
  )
  return {
    id: `local:${memory.id}`,
    sourceKind: 'local',
    sourceId: memory.id,
    scopeKey: '',
    title: memory.title,
    contentHash: metadataHash,
    type: memory.type,
    status: memory.status,
    scope: memory.scope,
    tags: memory.tags,
    pinned: memory.pinned,
    alwaysApply: false,
    eligible: memory.status === 'active',
    source: memory.source,
    warnings: [],
    updatedAt: memory.updatedAt,
    chunks: localChunks(memory),
  }
}

function sharedDocument(scopeKey: string, document: SharedKnowledgeDocument): IndexedDocumentInput {
  return {
    id: `${scopeKey}:shared:${document.id}`,
    sourceKind: 'shared',
    sourceId: document.id,
    scopeKey,
    title: document.title,
    contentHash: document.contentHash,
    type: document.type,
    status: document.status,
    scope: document.scope,
    tags: document.tags,
    pinned: false,
    alwaysApply: document.alwaysApply,
    eligible: document.eligibleForContext,
    repo: document.root,
    relativePath: document.relativePath,
    warnings: document.warnings,
    updatedAt: document.modifiedAt,
    chunks: chunkSharedKnowledge(document).map((chunk) => ({
      id: `${scopeKey}:shared:${chunk.id}`,
      ordinal: chunk.ordinal,
      content: chunk.content,
      ...(chunk.heading ? { heading: chunk.heading } : {}),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    })),
  }
}

function deleteDocument(handle: IndexHandle, id: string): void {
  const rows = handle.db.prepare('SELECT rowid, id FROM memory_chunks WHERE document_id = ?').all(id) as Array<{
    rowid: number | bigint
    id: string
  }>
  for (const row of rows) {
    handle.db.prepare('DELETE FROM memory_fts WHERE chunk_id = ?').run(row.id)
    handle.vector.delete(Number(row.rowid))
  }
  handle.db.prepare('DELETE FROM memory_documents WHERE id = ?').run(id)
}

function upsertDocument(handle: IndexHandle, document: IndexedDocumentInput): boolean {
  const existing = handle.db.prepare('SELECT content_hash FROM memory_documents WHERE id = ?').get(document.id) as
    | { content_hash: string }
    | undefined
  if (existing?.content_hash === document.contentHash) return false
  transaction(handle.db, () => {
    if (existing) deleteDocument(handle, document.id)
    handle.db
      .prepare(
        `INSERT INTO memory_documents
         (id, source_kind, source_id, scope_key, title, content_hash, type, status, scope, tags_json,
          pinned, always_apply, eligible, source, repo, relative_path, warnings_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        document.id,
        document.sourceKind,
        document.sourceId,
        document.scopeKey,
        document.title,
        document.contentHash,
        document.type,
        document.status,
        document.scope,
        JSON.stringify(document.tags),
        document.pinned ? 1 : 0,
        document.alwaysApply ? 1 : 0,
        document.eligible ? 1 : 0,
        document.source ?? null,
        document.repo ?? null,
        document.relativePath ?? null,
        JSON.stringify(document.warnings),
        document.updatedAt
      )
    const insertChunk = handle.db.prepare(
      `INSERT INTO memory_chunks
       (id, document_id, ordinal, heading, content, content_hash, start_line, end_line, embedding_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertFts = handle.db.prepare(
      'INSERT INTO memory_fts(chunk_id, title, content, tags, scope, path) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const chunk of document.chunks) {
      insertChunk.run(
        chunk.id,
        document.id,
        chunk.ordinal,
        chunk.heading ?? null,
        chunk.content,
        digest(chunk.content),
        chunk.startLine ?? null,
        chunk.endLine ?? null,
        handle.vector.available ? 'pending' : 'unavailable'
      )
      insertFts.run(
        chunk.id,
        document.title,
        chunk.content,
        document.tags.join(' '),
        document.scope,
        document.relativePath ?? ''
      )
    }
  })
  return true
}

function removeMissing(handle: IndexHandle, sourceKind: 'local' | 'shared', scopeKey: string, seen: Set<string>): void {
  const rows = handle.db
    .prepare('SELECT id FROM memory_documents WHERE source_kind = ? AND scope_key = ?')
    .all(sourceKind, scopeKey) as Array<{ id: string }>
  transaction(handle.db, () => {
    for (const row of rows) if (!seen.has(row.id)) deleteDocument(handle, row.id)
  })
}

function attachWatcher(handle: IndexHandle, root: MemoryScopeRoot & { realRoot: string; scopeKey: string }): void {
  if (
    handles.get(handle.workspaceId) !== handle ||
    handle.watchers.has(root.realRoot) ||
    !isWorkspaceMemoryEnabled(handle.workspaceId)
  )
    return
  const preferred = path.join(root.realRoot, '.agents', 'knowledge')
  const fallback = path.join(root.realRoot, '.agents')
  void (async () => {
    let watched = preferred
    try {
      const stat = await fsp.lstat(preferred)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return
    } catch {
      watched = fallback
      try {
        const stat = await fsp.lstat(fallback)
        if (!stat.isDirectory() || stat.isSymbolicLink()) return
      } catch {
        return
      }
    }
    if (handles.get(handle.workspaceId) !== handle || !isWorkspaceMemoryEnabled(handle.workspaceId)) return
    try {
      const watcher = watch(watched, { recursive: true }, () => {
        if (handles.get(handle.workspaceId) !== handle || !isWorkspaceMemoryEnabled(handle.workspaceId)) return
        const previous = handle.watcherTimers.get(root.realRoot)
        if (previous) clearTimeout(previous)
        handle.watcherTimers.set(
          root.realRoot,
          setTimeout(() => {
            handle.watcherTimers.delete(root.realRoot)
            if (handles.get(handle.workspaceId) !== handle) return
            void reconcileMemoryIndex(handle.workspaceId, [root]).catch(() => undefined)
          }, 250)
        )
      })
      handle.watchers.set(root.realRoot, watcher)
      watcher.on('error', () => {
        watcher.close()
        handle.watchers.delete(root.realRoot)
      })
    } catch {
      // Authoritative scan before retrieval remains available without live watch.
    }
  })()
}

async function runEmbeddingPass(handle: IndexHandle): Promise<void> {
  if (!handle.vector.available || !isWorkspaceMemoryEnabled(handle.workspaceId)) return
  handle.embeddingController?.abort(new Error('embedding pass superseded'))
  const controller = new AbortController()
  handle.embeddingController = controller
  const operation = (async () => {
    for (;;) {
      if (controller.signal.aborted || !isWorkspaceMemoryEnabled(handle.workspaceId)) return
      const rows = handle.db
        .prepare(
          `SELECT rowid, content FROM memory_chunks
           WHERE embedding_state = 'pending' ORDER BY rowid LIMIT ?`
        )
        .all(EMBEDDING_BATCH) as Array<{ rowid: number | bigint; content: string }>
      if (rows.length === 0) return
      const vectors = await embedTexts(
        rows.map((row) => row.content),
        { signal: controller.signal, retry: true }
      )
      if (!vectors || vectors.length !== rows.length) return
      transaction(handle.db, () => {
        rows.forEach((row, index) => {
          handle.vector.upsert(Number(row.rowid), vectors[index]!)
          handle.db.prepare("UPDATE memory_chunks SET embedding_state = 'ready' WHERE rowid = ?").run(row.rowid)
        })
      })
    }
  })()
  trackEmbeddingWrite(operation)
  await operation
}

async function reconcileNow(handle: IndexHandle, roots?: MemoryScopeRoot[]): Promise<void> {
  const active = (): boolean =>
    handles.get(handle.workspaceId) === handle &&
    !handle.reconcileController?.signal.aborted &&
    isWorkspaceMemoryEnabled(handle.workspaceId)
  if (!active()) return
  handle.state = 'indexing'
  emitStatus(handle)
  const normalizedRoots = await normalizeRoots(handle.workspaceId, roots)
  if (!active()) return
  const localSeen = new Set<string>()
  for (const memory of listLocalMemories(handle.workspaceId, { limit: 500 })) {
    const document = localDocument(memory)
    localSeen.add(document.id)
    upsertDocument(handle, document)
  }
  removeMissing(handle, 'local', '', localSeen)

  for (const root of normalizedRoots) {
    if (!active()) return
    handle.db
      .prepare(
        `INSERT INTO memory_scopes(scope_key, workspace_id, root, real_root, link_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET root=excluded.root, real_root=excluded.real_root,
           link_name=excluded.link_name, updated_at=excluded.updated_at`
      )
      .run(root.scopeKey, handle.workspaceId, root.root, root.realRoot, root.linkName ?? '', Date.now())
    const discovery = await discoverSharedKnowledge(root.realRoot)
    if (!active()) return
    const sharedSeen = new Set<string>()
    for (const source of discovery.documents) {
      const document = sharedDocument(root.scopeKey, source)
      sharedSeen.add(document.id)
      upsertDocument(handle, document)
    }
    removeMissing(handle, 'shared', root.scopeKey, sharedSeen)
    attachWatcher(handle, root)
  }
  handle.db
    .prepare(
      `INSERT INTO memory_index_meta(key, value) VALUES ('last_reconciled_at', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )
    .run(String(Date.now()))
  handle.state = handle.vector.available ? 'ready' : 'text-only'
  handle.errorCode = undefined
  emitStatus(handle)
  void runEmbeddingPass(handle)
    .then(() => emitStatus(handle))
    .catch((error) => {
      if (!handle.embeddingController?.signal.aborted) {
        handle.errorCode = error instanceof Error ? error.name : 'embedding-error'
        emitStatus(handle)
      }
    })
}

export async function reconcileMemoryIndex(workspaceId: string, roots?: MemoryScopeRoot[]): Promise<void> {
  if (!isWorkspaceMemoryEnabled(workspaceId)) return
  const handle = await openHandle(workspaceId)
  const previous = handle.reconcileFlight ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (handles.get(workspaceId) !== handle || !isWorkspaceMemoryEnabled(workspaceId)) return
      const controller = new AbortController()
      handle.reconcileController = controller
      try {
        await reconcileNow(handle, roots)
      } finally {
        if (handle.reconcileController === controller) handle.reconcileController = undefined
      }
    })
  handle.reconcileFlight = next
  try {
    await next
  } finally {
    if (handle.reconcileFlight === next) handle.reconcileFlight = undefined
  }
}

function ftsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 24)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' OR ')
}

function scopeClause(scopeKeys: string[]): { sql: string; params: string[] } {
  if (scopeKeys.length === 0) return { sql: "d.source_kind = 'local'", params: [] }
  return {
    sql: `(d.source_kind = 'local' OR d.scope_key IN (${scopeKeys.map(() => '?').join(',')}))`,
    params: scopeKeys,
  }
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function rowToCandidate(row: Record<string, unknown>, rank: number, score: number): IndexedMemoryCandidate {
  const kind = row.source_kind === 'shared' ? 'shared' : 'local'
  return {
    kind,
    id: String(row.source_id),
    title: String(row.title),
    content: String(row.content),
    type: String(row.type) as IndexedMemoryCandidate['type'],
    status: String(row.status) as IndexedMemoryCandidate['status'],
    scope: String(row.scope ?? ''),
    tags: parseTags(String(row.tags_json ?? '[]')),
    score,
    rank,
    chunkId: String(row.chunk_id),
    rowid: Number(row.rowid),
    ...(row.pinned === 1 ? { pinned: true } : {}),
    ...(row.always_apply === 1 ? { alwaysApply: true } : {}),
    ...(typeof row.source === 'string' ? { source: row.source as IndexedMemoryCandidate['source'] } : {}),
    ...(typeof row.repo === 'string' ? { repo: row.repo } : {}),
    ...(typeof row.relative_path === 'string' ? { path: row.relative_path } : {}),
    ...(typeof row.heading === 'string' ? { heading: row.heading } : {}),
    ...(typeof row.start_line === 'number' ? { startLine: row.start_line } : {}),
    ...(typeof row.end_line === 'number' ? { endLine: row.end_line } : {}),
    ...(typeof row.updated_at === 'number' ? { updatedAt: row.updated_at } : {}),
  }
}

export async function searchMemoryIndexLexical(
  workspaceId: string,
  query: string,
  roots?: MemoryScopeRoot[],
  limit = 40
): Promise<IndexedMemoryCandidate[]> {
  if (!isWorkspaceMemoryEnabled(workspaceId)) return []
  await reconcileMemoryIndex(workspaceId, roots)
  if (!isWorkspaceMemoryEnabled(workspaceId)) return []
  const handle = await openHandle(workspaceId)
  const normalizedRoots = await normalizeRoots(workspaceId, roots)
  const scope = scopeClause(normalizedRoots.map((root) => root.scopeKey))
  const bounded = Math.max(1, Math.min(limit, 100))
  const match = ftsQuery(query)
  const baseSelect = `SELECT c.rowid, c.id AS chunk_id, c.content, c.heading, c.start_line, c.end_line,
      d.source_kind, d.source_id, d.title, d.type, d.status, d.scope, d.tags_json, d.pinned,
      d.always_apply, d.source,
      CASE WHEN d.source_kind='shared' THEN COALESCE(NULLIF(ms.link_name, ''), d.repo) ELSE d.repo END AS repo,
      d.relative_path, d.updated_at`
  const rows = match
    ? (handle.db
        .prepare(
          `${baseSelect}, bm25(memory_fts, 0, 2, 1, 0.4, 0.4, 0.3) AS lexical_rank
           FROM memory_fts
           JOIN memory_chunks c ON c.id = memory_fts.chunk_id
           JOIN memory_documents d ON d.id = c.document_id
           LEFT JOIN memory_scopes ms ON ms.scope_key = d.scope_key
           WHERE memory_fts MATCH ? AND d.status = 'active' AND d.eligible = 1 AND ${scope.sql}
           ORDER BY lexical_rank LIMIT ?`
        )
        .all(match, ...scope.params, bounded) as Array<Record<string, unknown>>)
    : (handle.db
        .prepare(
          `${baseSelect}, 0 AS lexical_rank FROM memory_chunks c
           JOIN memory_documents d ON d.id = c.document_id
           LEFT JOIN memory_scopes ms ON ms.scope_key = d.scope_key
           WHERE d.status = 'active' AND d.eligible = 1 AND (d.pinned = 1 OR d.always_apply = 1) AND ${scope.sql}
           ORDER BY d.pinned DESC, d.always_apply DESC, d.updated_at DESC LIMIT ?`
        )
        .all(...scope.params, bounded) as Array<Record<string, unknown>>)
  return rows.map((row, index) => rowToCandidate(row, index + 1, 1 / (1 + Math.abs(Number(row.lexical_rank ?? index)))))
}

export async function searchMemoryIndexVector(
  workspaceId: string,
  query: string,
  roots?: MemoryScopeRoot[],
  limit = 40,
  signal?: AbortSignal
): Promise<IndexedMemoryCandidate[]> {
  if (!isWorkspaceMemoryEnabled(workspaceId)) return []
  await reconcileMemoryIndex(workspaceId, roots)
  const handle = await openHandle(workspaceId)
  if (!handle.vector.available || !isWorkspaceMemoryEnabled(workspaceId)) return []
  const vectors = await embedTexts([query], { signal })
  if (!vectors?.[0]) return []
  const normalizedRoots = await normalizeRoots(workspaceId, roots)
  const scope = scopeClause(normalizedRoots.map((root) => root.scopeKey))
  const nearest = handle.vector.search(vectors[0], Math.max(limit * 3, limit))
  if (nearest.length === 0) return []
  const read = handle.db.prepare(
    `SELECT c.rowid, c.id AS chunk_id, c.content, c.heading, c.start_line, c.end_line,
      d.source_kind, d.source_id, d.title, d.type, d.status, d.scope, d.tags_json, d.pinned,
      d.always_apply, d.source,
      CASE WHEN d.source_kind='shared' THEN COALESCE(NULLIF(ms.link_name, ''), d.repo) ELSE d.repo END AS repo,
      d.relative_path, d.updated_at
     FROM memory_chunks c JOIN memory_documents d ON d.id = c.document_id
     LEFT JOIN memory_scopes ms ON ms.scope_key = d.scope_key
     WHERE c.rowid = ? AND c.embedding_state = 'ready' AND d.status = 'active' AND d.eligible = 1 AND ${scope.sql}`
  )
  const candidates: IndexedMemoryCandidate[] = []
  for (const [index, hit] of nearest.entries()) {
    const row = read.get(hit.rowid, ...scope.params) as Record<string, unknown> | undefined
    if (!row) continue
    candidates.push(rowToCandidate(row, index + 1, 1 / (1 + hit.distance)))
    if (candidates.length >= limit) break
  }
  return candidates
}

function statusForHandle(handle: IndexHandle): MemoryIndexStatus {
  const counts = handle.db
    .prepare(
      `SELECT COUNT(DISTINCT d.id) AS documents, COUNT(c.rowid) AS chunks,
       COUNT(DISTINCT CASE WHEN d.source_kind='local' THEN d.id END) AS local_documents,
       COUNT(DISTINCT CASE WHEN d.source_kind='shared' THEN d.id END) AS shared_documents,
       SUM(CASE WHEN c.embedding_state='pending' THEN 1 ELSE 0 END) AS pending
       FROM memory_documents d LEFT JOIN memory_chunks c ON c.document_id=d.id`
    )
    .get() as Record<string, number | null>
  const reconciled = handle.db.prepare("SELECT value FROM memory_index_meta WHERE key='last_reconciled_at'").get() as
    | { value: string }
    | undefined
  return {
    workspaceId: handle.workspaceId,
    state: isWorkspaceMemoryEnabled(handle.workspaceId) ? handle.state : 'disabled',
    documents: Number(counts.documents ?? 0),
    chunks: Number(counts.chunks ?? 0),
    localDocuments: Number(counts.local_documents ?? 0),
    sharedDocuments: Number(counts.shared_documents ?? 0),
    semanticAvailable: handle.vector.available,
    pendingEmbeddings: Number(counts.pending ?? 0),
    ...(reconciled ? { lastReconciledAt: Number(reconciled.value) } : {}),
    ...(handle.errorCode ? { errorCode: handle.errorCode } : {}),
  }
}

export async function getMemoryIndexStatus(workspaceId: string): Promise<MemoryIndexStatus> {
  if (!isWorkspaceMemoryEnabled(workspaceId) && !handles.has(workspaceId)) {
    return {
      workspaceId,
      state: 'disabled',
      documents: 0,
      chunks: 0,
      localDocuments: 0,
      sharedDocuments: 0,
      semanticAvailable: false,
      pendingEmbeddings: 0,
    }
  }
  return statusForHandle(await openHandle(workspaceId))
}

export async function rebuildMemoryIndex(workspaceId: string, roots?: MemoryScopeRoot[]): Promise<void> {
  const existing = handles.get(workspaceId)
  if (existing) closeHandle(existing)
  const file = path.join(workspaceDataDir(workspaceId), MEMORY_INDEX_FILE)
  for (const suffix of ['', '-wal', '-shm']) await fsp.rm(`${file}${suffix}`, { force: true }).catch(() => undefined)
  if (isWorkspaceMemoryEnabled(workspaceId)) await reconcileMemoryIndex(workspaceId, roots)
}

/**
 * Installs the optional local ML component and prepares this workspace's disposable memory index. Calls for the
 * same workspace share one flight. A text-only handle is reopened after installation so sqlite-vec can be loaded;
 * reconciliation itself remains limited to durable local memories and `.agents/knowledge`.
 */
export function warmWorkspaceMemoryIndex(workspaceId: string, roots?: MemoryScopeRoot[]): Promise<void> {
  if (!isWorkspaceMemoryEnabled(workspaceId)) return Promise.resolve()
  const existing = warmupFlights.get(workspaceId)
  if (existing) return existing.promise

  const controller = new AbortController()
  const flight = { controller, promise: undefined as unknown as Promise<void> }
  const active = (): boolean => warmupFlights.get(workspaceId) === flight && !controller.signal.aborted
  flight.promise = (async () => {
    let runtimeReady = false
    try {
      await ensureRuntimeAsset('local-ml-runtime', controller.signal)
      runtimeReady = true
    } catch {
      if (!active()) return
      // Text-only indexing and the knowledge watcher remain useful if the optional component cannot be installed.
    }
    if (!active()) return
    const handle = handles.get(workspaceId)
    if (runtimeReady && handle && !handle.vector.available) closeHandle(handle)
    if (!active()) return
    await reconcileMemoryIndex(workspaceId, roots)
  })()
    .catch((error) => {
      if (active()) throw error
    })
    .finally(() => {
      if (warmupFlights.get(workspaceId) === flight) warmupFlights.delete(workspaceId)
    })
  warmupFlights.set(workspaceId, flight)
  return flight.promise
}

/** Defers warm-up so workspace creation/binding never waits for runtime installation or indexing. */
export function scheduleWorkspaceMemoryIndexWarmup(workspaceId: string, roots?: MemoryScopeRoot[]): void {
  if (warmupTimers.has(workspaceId) || warmupFlights.has(workspaceId)) return
  const timer = setTimeout(() => {
    if (warmupTimers.get(workspaceId) !== timer) return
    warmupTimers.delete(workspaceId)
    void warmWorkspaceMemoryIndex(workspaceId, roots).catch(() => undefined)
  }, 0)
  warmupTimers.set(workspaceId, timer)
}

export function stopWorkspaceMemoryIndex(workspaceId: string): void {
  const timer = warmupTimers.get(workspaceId)
  if (timer) clearTimeout(timer)
  warmupTimers.delete(workspaceId)
  const warmup = warmupFlights.get(workspaceId)
  if (warmup) {
    warmupFlights.delete(workspaceId)
    warmup.controller.abort(new Error('memory index warm-up cancelled'))
  }
  handleEpochs.set(workspaceId, (handleEpochs.get(workspaceId) ?? 0) + 1)
  const handle = handles.get(workspaceId)
  if (handle) closeHandle(handle)
}

export function initMemoryIndexService(): void {
  if (disposeLocalEvents || disposeEnabledEvents) return
  disposeLocalEvents = onLocalMemoryChange((event) => {
    if (!isWorkspaceMemoryEnabled(event.workspaceId)) return
    setTimeout(() => void reconcileMemoryIndex(event.workspaceId).catch(() => undefined), 0)
  })
  disposeEnabledEvents = onWorkspaceMemoryEnabledChanged(({ workspaceId, enabled }) => {
    if (!enabled) {
      stopWorkspaceMemoryIndex(workspaceId)
      events.emit('status', {
        workspaceId,
        state: 'disabled',
        documents: 0,
        chunks: 0,
        localDocuments: 0,
        sharedDocuments: 0,
        semanticAvailable: false,
        pendingEmbeddings: 0,
      } satisfies MemoryIndexStatus)
    } else {
      setTimeout(() => void reconcileMemoryIndex(workspaceId).catch(() => undefined), 0)
    }
  })
}

export function disposeMemoryIndexService(): void {
  disposeLocalEvents?.()
  disposeEnabledEvents?.()
  disposeLocalEvents = undefined
  disposeEnabledEvents = undefined
  const workspaceIds = new Set([
    ...handles.keys(),
    ...openingHandles.keys(),
    ...warmupFlights.keys(),
    ...warmupTimers.keys(),
  ])
  for (const workspaceId of workspaceIds) stopWorkspaceMemoryIndex(workspaceId)
}

export function assertSharedPathInScope(root: string, absolute: string): void {
  if (!isInside(root, absolute)) throw new Error('shared memory path escaped repository scope')
}
