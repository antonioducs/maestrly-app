import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const MEMORY_VECTOR_DIMENSIONS = 384

export interface VectorSearchRow {
  rowid: number
  distance: number
}

export interface MemoryIndexDatabase {
  db: DatabaseSync
  vector: VectorBackend
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export function vectorExtensionCandidates(runtimeRoot: string): string[] {
  const suffix = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'
  const packageName = `sqlite-vec-${process.platform}-${process.arch}`
  return [
    path.join(runtimeRoot, 'node_modules', packageName, `vec0.${suffix}`),
    path.join(runtimeRoot, 'node_modules', 'sqlite-vec', `vec0.${suffix}`),
    path.join(runtimeRoot, 'sqlite-vec', `vec0.${suffix}`),
  ]
}

/** Accept binaries only inside a runtime asset already verified by hash and lease. */
export function findTrustedVectorExtension(runtimeRoot: string): string | undefined {
  const realRoot = realpathSync(runtimeRoot)
  for (const candidate of vectorExtensionCandidates(realRoot)) {
    if (!existsSync(candidate)) continue
    const realCandidate = realpathSync(candidate)
    if (inside(realRoot, realCandidate)) return realCandidate
  }
  return undefined
}

function vectorBlob(vector: number[]): Uint8Array {
  if (vector.length !== MEMORY_VECTOR_DIMENSIONS) {
    throw new Error(`expected ${MEMORY_VECTOR_DIMENSIONS}-dimension vector, received ${vector.length}`)
  }
  return new Uint8Array(new Float32Array(vector).buffer)
}

export class VectorBackend {
  readonly available: boolean
  readonly version?: string

  constructor(
    private readonly db: DatabaseSync,
    available: boolean,
    version?: string
  ) {
    this.available = available
    this.version = version
  }

  ensureSchema(): void {
    if (!this.available) return
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[${MEMORY_VECTOR_DIMENSIONS}])`
    )
  }

  upsert(rowid: number, embedding: number[]): void {
    if (!this.available) return
    this.db.prepare('DELETE FROM memory_vec WHERE rowid = ?').run(rowid)
    this.db.prepare('INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)').run(rowid, vectorBlob(embedding))
  }

  delete(rowid: number): void {
    if (this.available) this.db.prepare('DELETE FROM memory_vec WHERE rowid = ?').run(rowid)
  }

  search(embedding: number[], limit: number): VectorSearchRow[] {
    if (!this.available) return []
    const bounded = Math.max(1, Math.min(limit, 100))
    return this.db
      .prepare(
        `SELECT rowid, distance FROM memory_vec
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
      )
      .all(vectorBlob(embedding), bounded)
      .map((row) => ({
        rowid: Number((row as { rowid: number | bigint }).rowid),
        distance: Number((row as { distance: number }).distance),
      }))
  }
}

export function openMemoryIndexDatabase(file: string, trustedExtension?: string): MemoryIndexDatabase {
  if (!trustedExtension) {
    const db = new DatabaseSync(file)
    return { db, vector: new VectorBackend(db, false) }
  }
  let extensionDb: DatabaseSync | undefined
  try {
    extensionDb = new DatabaseSync(file, { allowExtension: true })
    extensionDb.loadExtension(trustedExtension)
    const versionRow = extensionDb.prepare('SELECT vec_version() AS version').get() as { version: string }
    extensionDb.enableLoadExtension(false)
    const vector = new VectorBackend(extensionDb, true, versionRow.version)
    vector.ensureSchema()
    return { db: extensionDb, vector }
  } catch (error) {
    try {
      extensionDb?.enableLoadExtension(false)
      extensionDb?.close()
    } catch {
      // best effort before text-only fallback
    }
    console.warn('[memory-index] sqlite-vec unavailable:', error instanceof Error ? error.message : error)
    const db = new DatabaseSync(file)
    return { db, vector: new VectorBackend(db, false) }
  }
}

/** Insert/update/delete/KNN/reopen smoke check for tests and packaged utility-process validation. */
export function runVectorBackendSmoke(file: string, trustedExtension: string): { version: string; nearest: number } {
  const first = openMemoryIndexDatabase(file, trustedExtension)
  if (!first.vector.available) throw new Error('sqlite-vec failed to load')
  first.db.exec('CREATE TABLE IF NOT EXISTS smoke_rows (id INTEGER PRIMARY KEY)')
  first.db.prepare('INSERT OR IGNORE INTO smoke_rows(id) VALUES (1), (2)').run()
  first.vector.upsert(
    1,
    Array.from({ length: MEMORY_VECTOR_DIMENSIONS }, (_, index) => (index === 0 ? 1 : 0))
  )
  first.vector.upsert(
    2,
    Array.from({ length: MEMORY_VECTOR_DIMENSIONS }, (_, index) => (index === 1 ? 1 : 0))
  )
  first.vector.upsert(
    2,
    Array.from({ length: MEMORY_VECTOR_DIMENSIONS }, (_, index) => (index === 0 ? 0.9 : 0))
  )
  first.vector.delete(1)
  first.db.close()
  const reopened = openMemoryIndexDatabase(file, trustedExtension)
  try {
    if (!reopened.vector.available) throw new Error('sqlite-vec failed to reopen')
    const hit = reopened.vector.search(
      Array.from({ length: MEMORY_VECTOR_DIMENSIONS }, (_, index) => (index === 0 ? 1 : 0)),
      1
    )[0]
    if (hit?.rowid !== 2) throw new Error('sqlite-vec KNN smoke returned an unexpected row')
    return { version: reopened.vector.version!, nearest: hit.rowid }
  } finally {
    reopened.db.close()
  }
}
