import fsp from 'node:fs/promises'
import path from 'node:path'
import { forgetStore, openExistingStore, storesDir, type ShadowStore } from './store'

/**
 * Collection of shadow stores. Snapshot trees are kept alive only by refs (`refs/maestrly/t/<record>/<name>`), and
 * each folder's index by a ref to a tree written from it (`refs/maestrly/i/<dir>`), since Git does not know about
 * the extra indexes. Refs of records that no longer exist are deleted, then unreachable objects are pruned and the
 * rest repacked. Objects borrowed from the user's repository are never packed or touched.
 */

export const RECORD_REF_PREFIX = 'refs/maestrly/t/'
const INDEX_REF_PREFIX = 'refs/maestrly/i/'
const LOOSE_OBJECT_LIMIT = 2_000
const PACK_LIMIT = 20

/** Ref of one of a record's trees: `start-<root>`, `end-<root>`, `now-<root>`, `op<n>-pre-<root>`... */
export function recordRef(recordId: string, name: string): string {
  return `${RECORD_REF_PREFIX}${recordId}/${name}`
}

export interface StoreCollection {
  removedRefs: number
  removedIndexes: number
  packed: boolean
}

async function countObjects(store: ShadowStore): Promise<{ loose: number; packs: number }> {
  const result = await store.write(['count-objects', '-v'])
  const text = result.stdout.toString('utf8')
  return {
    loose: Number(/^count: (\d+)/m.exec(text)?.[1] ?? 0),
    packs: Number(/^packs: (\d+)/m.exec(text)?.[1] ?? 0),
  }
}

/**
 * Collects one store. `liveRecords` are the records whose refs stay; `indexMaxIdleMs` drops the index of a folder
 * not captured for that long. `force` repacks even when nothing was removed.
 */
export function collectStore(
  store: ShadowStore,
  liveRecords: ReadonlySet<string>,
  opts: { indexMaxIdleMs: number; force?: boolean; now?: number }
): Promise<StoreCollection> {
  return store.exclusive(async () => {
    const now = opts.now ?? Date.now()
    const result: StoreCollection = { removedRefs: 0, removedIndexes: 0, packed: false }
    const indexDir = path.join(store.gitDir, 'indexes')
    const indexes = (await fsp.readdir(indexDir).catch(() => [] as string[])).filter((name) =>
      /^[0-9a-f]{64}$/.test(name)
    )
    const refUpdates: string[] = []
    for (const dirKey of indexes) {
      const meta = store.meta.dirs[dirKey]
      const index = path.join(indexDir, dirKey)
      if (!meta || now - meta.lastUsedAt > opts.indexMaxIdleMs) {
        await fsp.rm(index, { force: true })
        await fsp.rm(`${index}.lock`, { force: true }).catch(() => undefined)
        delete store.meta.dirs[dirKey]
        refUpdates.push(`delete ${INDEX_REF_PREFIX}${dirKey}`)
        result.removedIndexes++
        continue
      }
      const written = await store.write(['write-tree', '--missing-ok'], { index, timeoutMs: 300_000 }).catch(() => null)
      const tree = written?.stdout.toString('utf8').trim()
      if (tree && /^[0-9a-f]{40,64}$/.test(tree)) refUpdates.push(`update ${INDEX_REF_PREFIX}${dirKey} ${tree}`)
    }
    for (const dirKey of Object.keys(store.meta.dirs)) if (!indexes.includes(dirKey)) delete store.meta.dirs[dirKey]
    // Ref names cannot hold a newline.
    const refs = (await store.write(['for-each-ref', '--format=%(refname)', RECORD_REF_PREFIX])).stdout
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
    for (const ref of refs) {
      const recordId = ref.slice(RECORD_REF_PREFIX.length).split('/')[0] ?? ''
      if (!liveRecords.has(recordId)) {
        refUpdates.push(`delete ${ref}`)
        result.removedRefs++
      }
    }
    if (refUpdates.length) await store.ref(['update-ref', '--stdin'], { input: refUpdates.join('\n') + '\n' })
    const counts = await countObjects(store)
    if (
      opts.force ||
      result.removedRefs > 0 ||
      result.removedIndexes > 0 ||
      counts.loose > LOOSE_OBJECT_LIMIT ||
      counts.packs > PACK_LIMIT
    ) {
      // Reachability walks trees only; the alternate lets it see blobs a seeded tree borrows without copying them.
      await store.read(['prune', '--expire=now'], { timeoutMs: 600_000 })
      await store.read(['repack', '-a', '-d', '-l', '-q'], { timeoutMs: 600_000 })
      await store.write(['pack-refs', '--all', '--prune'], { timeoutMs: 120_000 })
      result.packed = true
    }
    await store.saveMeta().catch(() => undefined)
    return result
  })
}

/** Bytes used under `dir`, without following links. */
export async function directorySize(dir: string): Promise<number> {
  let total = 0
  const pending = [dir]
  while (pending.length) {
    const current = pending.pop()!
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(full)
      else if (entry.isFile()) total += (await fsp.lstat(full).catch(() => null))?.size ?? 0
    }
  }
  return total
}

export interface StoreSweep {
  removedStores: string[]
}

/**
 * Removes stores no live record uses and not captured for `maxIdleMs`, and creations interrupted an hour ago or
 * more. `liveStores` are the stores that live records name.
 */
export async function sweepStores(
  liveStores: ReadonlySet<string>,
  opts: { maxIdleMs: number; now?: number }
): Promise<StoreSweep> {
  const now = opts.now ?? Date.now()
  const removed: string[] = []
  const root = storesDir()
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.name.startsWith('.init-')) {
      const created = Number(entry.name.slice('.init-'.length).split('-')[0])
      if (!Number.isFinite(created) || now - created > 60 * 60 * 1000)
        await fsp.rm(full, { recursive: true, force: true }).catch(() => undefined)
      continue
    }
    if (!entry.isDirectory() || liveStores.has(entry.name)) continue
    const store = await openExistingStore(entry.name)
    if (store && now - store.meta.lastUsedAt <= opts.maxIdleMs) continue
    const remove = async () => {
      await fsp.rm(full, { recursive: true, force: true })
      forgetStore(entry.name)
      removed.push(entry.name)
    }
    await (store ? store.exclusive(remove) : remove()).catch(() => undefined)
  }
  return { removedStores: removed }
}
