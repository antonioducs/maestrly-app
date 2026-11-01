import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { renameWithRetry, type ShadowStore } from './store'
import { readBlobs, type TreeEntry } from './tree'

/**
 * Writes files back from captured trees. The app writes them itself, never `git checkout`: a temporary file next to
 * the target is renamed over it, keeping the target's permissions with Git's executable bit. Every path stays inside
 * the folder through real directories: a parent that became a link, or any `.git` component, is refused.
 */

export type RestoreFailure =
  | 'invalid-path'
  | 'parent-link'
  | 'blocked'
  | 'is-directory'
  | 'unavailable'
  | 'submodule'
  | 'symlink'
  | 'io'

export interface RestoreTarget {
  path: string
  /** What the path must hold; null removes it. */
  entry: Pick<TreeEntry, 'mode' | 'oid'> | null
}

export interface RestoreOutcome {
  restored: string[]
  failed: Array<{ path: string; reason: RestoreFailure }>
}

/** A tree path that can only name something inside the folder. */
export function isSafeTreePath(file: string): boolean {
  if (!file || file.includes('\0') || file.includes('\\') || file.startsWith('/')) return false
  if (process.platform === 'win32' && /[:*?"<>|]/.test(file)) return false
  return file.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

const WINDOWS_RETRY = new Set(['EBUSY', 'EPERM', 'EACCES'])

async function withRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || attempt >= 5 || !WINDOWS_RETRY.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

/** Checks the existing parents of `file` from the root down: each must be a real directory. */
async function checkParents(root: string, file: string): Promise<RestoreFailure | null> {
  const parts = file.split('/')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    const info = await fsp
      .lstat(current)
      .catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : error))
    if (info === null) return null
    if (info instanceof Error) return 'io'
    if (info.isSymbolicLink()) return 'parent-link'
    if (!info.isDirectory()) return 'blocked'
  }
  return null
}

async function removeEmptyParents(root: string, file: string): Promise<void> {
  let dir = path.dirname(path.join(root, file))
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      await fsp.rmdir(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

async function removePath(root: string, file: string): Promise<RestoreFailure | null> {
  const target = path.join(root, file)
  const info = await fsp.lstat(target).catch(() => null)
  if (!info) return null
  if (info.isDirectory()) {
    try {
      await fsp.rmdir(target)
      return null
    } catch {
      return 'is-directory'
    }
  }
  try {
    await withRetry(() => fsp.unlink(target))
    return null
  } catch {
    return 'io'
  }
}

function executableMode(mode: number, executable: boolean): number {
  const permissions = mode & 0o7777
  return executable ? permissions | ((permissions & 0o444) >> 2) : permissions & ~0o111
}

async function writePath(
  root: string,
  file: string,
  entry: { mode: string },
  content: Buffer
): Promise<RestoreFailure | null> {
  const target = path.join(root, file)
  const parent = path.dirname(target)
  const existing = await fsp.lstat(target).catch(() => null)
  if (existing?.isDirectory()) {
    try {
      await fsp.rmdir(target)
    } catch {
      return 'is-directory'
    }
  }
  try {
    await fsp.mkdir(parent, { recursive: true })
  } catch {
    return 'blocked'
  }
  if (entry.mode === '120000') {
    try {
      if (existing && !existing.isDirectory()) await withRetry(() => fsp.unlink(target))
      await fsp.symlink(content.toString('utf8'), target)
      return null
    } catch {
      return 'symlink'
    }
  }
  const executable = entry.mode === '100755'
  const tmp = path.join(parent, `.${path.basename(target).slice(0, 80)}.maestrly-${randomUUID()}.tmp`)
  try {
    await fsp.writeFile(tmp, content, { flag: 'wx', mode: executable ? 0o777 : 0o666 })
    if (existing?.isFile()) await fsp.chmod(tmp, executableMode(existing.mode, executable))
    await renameWithRetry(tmp, target)
    return null
  } catch {
    return 'io'
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
  }
}

/**
 * Applies the targets inside `root` (a real path): removals first, deepest first, with the folders they empty, then
 * writes. A failure leaves that path as it was and the others still proceed.
 */
export async function applyTargets(
  store: ShadowStore,
  root: string,
  targets: readonly RestoreTarget[]
): Promise<RestoreOutcome> {
  const outcome: RestoreOutcome = { restored: [], failed: [] }
  const valid: RestoreTarget[] = []
  for (const target of targets) {
    if (!isSafeTreePath(target.path)) outcome.failed.push({ path: target.path, reason: 'invalid-path' })
    else if (target.entry?.mode === '160000') outcome.failed.push({ path: target.path, reason: 'submodule' })
    else valid.push(target)
  }
  const realRoot = await fsp.realpath(root).catch(() => null)
  if (!realRoot || realRoot !== root) {
    for (const target of valid) outcome.failed.push({ path: target.path, reason: 'blocked' })
    return outcome
  }
  const removals = valid.filter((target) => !target.entry).sort((a, b) => b.path.length - a.path.length)
  const writes = valid.filter((target) => target.entry)
  for (const target of removals) {
    const failure = (await checkParents(root, target.path)) ?? (await removePath(root, target.path))
    if (failure) outcome.failed.push({ path: target.path, reason: failure })
    else {
      outcome.restored.push(target.path)
      await removeEmptyParents(root, target.path)
    }
  }
  const contents = await readBlobs(
    store,
    writes.map((target) => target.entry!.oid)
  )
  for (const target of writes) {
    const content = contents.get(target.entry!.oid)
    if (!content) {
      outcome.failed.push({ path: target.path, reason: 'unavailable' })
      continue
    }
    const failure =
      (await checkParents(root, target.path)) ?? (await writePath(root, target.path, target.entry!, content))
    if (failure) outcome.failed.push({ path: target.path, reason: failure })
    else outcome.restored.push(target.path)
  }
  return outcome
}
