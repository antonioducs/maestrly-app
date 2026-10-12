import { constants as fsConstants } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PLUGIN_LIMITS } from './limits'
import { isSafeTreePath } from './paths'

export type TreeEntryMode = 'file' | 'executable' | 'symlink' | 'submodule'
export interface TreeEntry {
  path: string
  mode: TreeEntryMode
}

/**
 * A plugin package seen as a flat list of entries, read from disk or from a sparse Git checkout. Reads only ever return
 * regular files listed with a file mode; symlinks and submodules are listed but never read.
 */
export interface PackageTree {
  /** Repo/plugin-relative POSIX paths of every non-directory entry (from lstat or `git ls-tree`). */
  readonly entries: ReadonlyMap<string, TreeEntry>
  /** Reads a regular file (never a symlink); null when absent, not materialized, or larger than maxBytes. */
  read(path: string, maxBytes: number): Promise<Buffer | null>
  /** Sub-tree rooted at `prefix` (paths re-based). */
  sub(prefix: string): PackageTree
}

const isReadableMode = (entry: TreeEntry | undefined): boolean => entry?.mode === 'file' || entry?.mode === 'executable'

/** Opens without following a final symlink and refuses anything that is not a regular file of at most `maxBytes`. */
async function readRegularFile(abs: string, maxBytes: number): Promise<Buffer | null> {
  let handle: import('node:fs/promises').FileHandle
  try {
    handle = await fsp.open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch {
    return null
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) return null
    const buffer = Buffer.alloc(stat.size)
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0)
    return buffer.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function makeTree(baseDir: string, entries: ReadonlyMap<string, TreeEntry>): PackageTree {
  return {
    entries,
    async read(rel, maxBytes) {
      if (!isSafeTreePath(rel) || !isReadableMode(entries.get(rel))) return null
      return readRegularFile(path.join(baseDir, ...rel.split('/')), maxBytes)
    },
    sub(prefix) {
      const clean = prefix.replace(/^\/+|\/+$/g, '')
      if (!clean) return this
      if (!isSafeTreePath(clean)) return makeTree(baseDir, new Map())
      const start = `${clean}/`
      const rebased = new Map<string, TreeEntry>()
      for (const [key, entry] of entries)
        if (key.startsWith(start)) rebased.set(key.slice(start.length), { ...entry, path: key.slice(start.length) })
      return makeTree(path.join(baseDir, ...clean.split('/')), rebased)
    },
  }
}

/** Walks `root` with lstat (never following links), skipping `.git`. Bounded by the plugin tree-entry limit. */
export async function fsPackageTree(root: string): Promise<PackageTree> {
  const entries = new Map<string, TreeEntry>()
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > PLUGIN_LIMITS.depth + 1) return
    let names: string[]
    try {
      names = await fsp.readdir(path.join(root, rel))
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (name === '.git') continue
      const childRel = rel ? `${rel}/${name}` : name
      let stat: import('node:fs').Stats
      try {
        stat = await fsp.lstat(path.join(root, childRel))
      } catch {
        continue
      }
      if (entries.size >= PLUGIN_LIMITS.treeEntries) return
      if (stat.isSymbolicLink()) entries.set(childRel, { path: childRel, mode: 'symlink' })
      else if (stat.isDirectory()) await walk(childRel, depth + 1)
      else if (stat.isFile()) entries.set(childRel, { path: childRel, mode: stat.mode & 0o111 ? 'executable' : 'file' })
    }
  }
  await walk('', 0)
  return makeTree(root, entries)
}

/** A sparse Git checkout: `entries` come from `git ls-tree`; files outside the sparse set read as null. */
export function gitPackageTree(checkoutDir: string, entries: readonly TreeEntry[]): PackageTree {
  return makeTree(checkoutDir, new Map(entries.filter((e) => isSafeTreePath(e.path)).map((e) => [e.path, e])))
}
