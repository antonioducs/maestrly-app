import { nulRecords } from './git'
import type { ShadowStore } from './store'

/** Read-only views of captured trees: entries, file-level differences, patches and blob contents. */

export interface TreeEntry {
  mode: string
  type: 'blob' | 'commit' | 'tree'
  oid: string
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted'

export interface TreeChange {
  path: string
  status: FileChangeStatus
  additions: number
  deletions: number
  binary: boolean
  /** Old and new entries; null where the path is absent. */
  from: { mode: string; oid: string } | null
  to: { mode: string; oid: string } | null
}

// Keeps each command line well under Windows' 32,767-character limit.
const ARGUMENT_BUDGET = 24_000

function chunkPaths(paths: readonly string[]): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let length = 0
  for (const file of paths) {
    if (current.length && length + file.length + 1 > ARGUMENT_BUDGET) {
      chunks.push(current)
      current = []
      length = 0
    }
    current.push(file)
    length += file.length + 1
  }
  if (current.length) chunks.push(current)
  return chunks
}

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function isZeroOid(oid: string): boolean {
  return /^0+$/.test(oid)
}

/** Entries of `paths` in `tree`; a path absent from the tree is absent from the map. */
export async function treeEntries(
  store: ShadowStore,
  tree: string,
  paths: readonly string[]
): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>()
  for (const chunk of chunkPaths(paths)) {
    const result = await store.read(['ls-tree', '-z', '--full-tree', tree, '--', ...chunk], { timeoutMs: 120_000 })
    for (const record of nulRecords(result.stdout)) {
      const match = /^(\d+) (blob|commit|tree) ([0-9a-f]+)\t(.*)$/s.exec(record)
      if (match) entries.set(match[4]!, { mode: match[1]!, type: match[2] as TreeEntry['type'], oid: match[3]! })
    }
  }
  return entries
}

/** Every file that differs between two trees, with line counts. Renames are a deletion plus an addition. */
export async function diffTrees(
  store: ShadowStore,
  from: string,
  to: string,
  paths?: readonly string[]
): Promise<TreeChange[]> {
  if (from === to || paths?.length === 0) return []
  const groups = paths ? chunkPaths(paths) : [undefined]
  const changes: TreeChange[] = []
  for (const group of groups) {
    const base = ['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv']
    const tail = [from || EMPTY_TREE_SHA1, to || EMPTY_TREE_SHA1, ...(group ? ['--', ...group] : [])]
    const [raw, numstat] = await Promise.all([
      store.read([...base, '--raw', ...tail], { timeoutMs: 300_000 }),
      store.read([...base, '--numstat', ...tail], { timeoutMs: 300_000 }),
    ])
    const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>()
    for (const record of nulRecords(numstat.stdout)) {
      const [additions, deletions, ...rest] = record.split('\t')
      if (additions === undefined || deletions === undefined || !rest.length) continue
      const binary = additions === '-' || deletions === '-'
      stats.set(rest.join('\t'), {
        additions: binary ? 0 : Number(additions) || 0,
        deletions: binary ? 0 : Number(deletions) || 0,
        binary,
      })
    }
    const records = nulRecords(raw.stdout)
    for (let i = 0; i + 1 < records.length; i += 2) {
      const header = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(records[i]!)
      const file = records[i + 1]!
      if (!header) continue
      const [, oldMode, newMode, oldOid, newOid, code] = header as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
      ]
      const fromEntry = isZeroOid(oldOid) && oldMode === '000000' ? null : { mode: oldMode, oid: oldOid }
      const toEntry = isZeroOid(newOid) && newMode === '000000' ? null : { mode: newMode, oid: newOid }
      const stat = stats.get(file) ?? { additions: 0, deletions: 0, binary: false }
      changes.push({
        path: file,
        status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
        ...stat,
        from: fromEntry,
        to: toEntry,
      })
    }
  }
  return changes
}

/** Unified patch of one file between two trees, cut at `maxBytes`. */
export async function diffPatch(
  store: ShadowStore,
  from: string,
  to: string,
  file: string,
  maxBytes: number
): Promise<{ patch: string; truncated: boolean }> {
  try {
    const result = await store.read(
      [
        'diff-tree',
        '-p',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '-U3',
        from || EMPTY_TREE_SHA1,
        to || EMPTY_TREE_SHA1,
        '--',
        file,
      ],
      { timeoutMs: 60_000, maxStdoutBytes: maxBytes }
    )
    return { patch: result.stdout.toString('utf8'), truncated: false }
  } catch (error) {
    if ((error as { kind?: string }).kind === 'too-large') return { patch: '', truncated: true }
    throw error
  }
}

/** Contents of blobs by object id; an id the store cannot read is left out. */
export async function readBlobs(store: ShadowStore, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(oids)]
  const contents = new Map<string, Buffer>()
  if (!unique.length) return contents
  const checked = await store.read(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    input: unique.join('\n') + '\n',
    timeoutMs: 120_000,
  })
  const sizes = new Map<string, number>()
  for (const line of checked.stdout.toString('utf8').split('\n')) {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(line.trim())
    if (match) sizes.set(match[1]!, Number(match[2]))
  }
  // Batches bound the memory one command returns; a large blob goes alone.
  const batches: string[][] = []
  let batch: string[] = []
  let bytes = 0
  for (const oid of unique) {
    const size = sizes.get(oid)
    if (size === undefined) continue
    if (batch.length && bytes + size > 32 * 1024 * 1024) {
      batches.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(oid)
    bytes += size
  }
  if (batch.length) batches.push(batch)
  for (const group of batches) {
    const expected = group.reduce((total, oid) => total + (sizes.get(oid) ?? 0) + 128, 0)
    const result = await store.read(['cat-file', '--batch'], {
      input: group.join('\n') + '\n',
      timeoutMs: 300_000,
      maxStdoutBytes: expected + 1024,
    })
    const out = result.stdout
    let offset = 0
    while (offset < out.length) {
      const newline = out.indexOf(0x0a, offset)
      if (newline < 0) break
      const header = out.subarray(offset, newline).toString('utf8')
      offset = newline + 1
      const match = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header)
      if (!match) continue
      const size = Number(match[3])
      if (match[2] === 'blob') contents.set(match[1]!, Buffer.from(out.subarray(offset, offset + size)))
      offset += size + 1
    }
  }
  return contents
}
