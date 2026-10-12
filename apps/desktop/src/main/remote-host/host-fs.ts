import { statSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  HOST_FS_ERROR_MESSAGES,
  type HostFsEntry,
  type HostFsErrorCode,
  type HostFsListing,
  type HostFsListOptions,
  type HostFsPreview,
  type HostFsRoot,
  type HostFsUsage,
} from '../../shared/host-fs'
import type { IpcRegistrar } from '../ipc-registrar'

/**
 * Browsing a host's folders, for choosing a workspace folder from another computer, where a native folder dialog on
 * the host would show on a screen nobody looks at. Only the host's roots are reachable: its home folder and, on a
 * server, the workspaces folder the gateway mounts. Paths are resolved through links before they are checked.
 */
const LIST_LIMIT = 2_000

const fail = (code: HostFsErrorCode): Error => Object.assign(new Error(HOST_FS_ERROR_MESSAGES[code]), { code })

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

async function realRoots(roots: readonly string[]): Promise<string[]> {
  const real = await Promise.all(roots.map((root) => realpath(root).catch(() => null)))
  return real.filter((root): root is string => root !== null)
}

const within = (target: string, roots: readonly string[]): boolean =>
  roots.some((root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep))

/** The real path of an existing path, when it is an allowed folder or inside one. */
export async function resolveInside(
  target: string,
  roots: readonly string[]
): Promise<{ real: string; roots: string[] }> {
  const outside = () => fail('outside-roots')
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw outside()
  const allowed = await realRoots(roots)
  let real: string
  try {
    real = await realpath(target)
  } catch (error) {
    // A missing path is only reported as missing when its own text is inside a root: nothing leaks about the rest.
    if (errno(error) === 'ENOENT' && within(path.resolve(target), allowed)) throw fail('not-found')
    throw outside()
  }
  if (!within(real, allowed)) throw outside()
  return { real, roots: allowed }
}

export async function listHostDirectory(
  target: string,
  options: HostFsListOptions,
  roots: readonly string[],
  limit: number = LIST_LIMIT
): Promise<HostFsListing> {
  const { real, roots: allowed } = await resolveInside(target, roots)
  let names: string[]
  try {
    names = await readdir(real)
  } catch (error) {
    if (errno(error) === 'ENOTDIR') throw fail('not-a-directory')
    throw error
  }
  const entries: HostFsEntry[] = []
  for (const name of names) {
    if (!options.includeHidden && name.startsWith('.')) continue
    const full = path.join(real, name)
    const info = await lstat(full).catch(() => null)
    if (!info) continue
    let kind: HostFsEntry['kind'] = info.isDirectory() ? 'directory' : 'file'
    let shown = info
    if (info.isSymbolicLink()) {
      kind = 'link'
      const destination = await realpath(full).catch(() => null)
      const resolved = destination && within(destination, allowed) ? await stat(destination).catch(() => null) : null
      if (resolved) {
        kind = resolved.isDirectory() ? 'directory' : 'file'
        shown = resolved
      }
    }
    if (kind !== 'directory' && !options.includeFiles) continue
    entries.push({
      name,
      path: full,
      kind,
      size: kind === 'file' ? shown.size : 0,
      modifiedAt: Math.floor(shown.mtimeMs),
    })
  }
  entries.sort(
    (a, b) =>
      Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  )
  return {
    path: real,
    parent: allowed.includes(real) ? null : path.dirname(real),
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
  }
}

function checkName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[^/\\\0]{1,255}$/.test(name) || name === '.' || name === '..')
    throw fail('invalid-name')
}

export async function createHostDirectory(parent: string, name: string, roots: readonly string[]): Promise<string> {
  const { real } = await resolveInside(parent, roots)
  checkName(name)
  const created = path.join(real, name)
  try {
    await mkdir(created)
  } catch (error) {
    if (errno(error) === 'EEXIST') throw fail('exists')
    throw error
  }
  return created
}

const PREVIEW_BYTES = 64 * 1024

/** The entry a path names inside an allowed folder, never what a link there points to; roots themselves are kept. */
async function entryInside(target: string, roots: readonly string[]): Promise<string> {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw fail('outside-roots')
  // A root's parent is outside the roots: a root is recognized before its parent is checked.
  const named = path.resolve(target)
  if (roots.includes(named) || (await realRoots(roots)).includes(named)) throw fail('is-root')
  const { real: parent, roots: allowed } = await resolveInside(path.dirname(target), roots)
  const entry = path.join(parent, path.basename(target))
  if (allowed.includes(entry)) throw fail('is-root')
  if (!(await lstat(entry).catch(() => null))) throw fail('not-found')
  return entry
}

export async function previewHostFile(target: string, roots: readonly string[]): Promise<HostFsPreview> {
  const { real } = await resolveInside(target, roots)
  const info = await stat(real)
  if (!info.isFile()) throw fail('not-a-file')
  const handle = await open(real, 'r')
  try {
    const sample = Buffer.alloc(Math.min(PREVIEW_BYTES, info.size))
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
    const bytes = sample.subarray(0, bytesRead)
    const truncated = info.size > bytesRead
    if (bytes.includes(0)) return { binary: true, text: null, truncated, size: info.size }
    // `stream` drops a character cut at the end of the sample instead of showing a replacement mark.
    return { binary: false, text: new TextDecoder().decode(bytes, { stream: true }), truncated, size: info.size }
  } finally {
    await handle.close()
  }
}

export async function renameHostEntry(target: string, name: string, roots: readonly string[]): Promise<string> {
  checkName(name)
  const entry = await entryInside(target, roots)
  const destination = path.join(path.dirname(entry), name)
  if (await lstat(destination).catch(() => null)) throw fail('exists')
  await rename(entry, destination)
  return destination
}

export async function deleteHostEntry(target: string, roots: readonly string[]): Promise<void> {
  // `rm` removes a link itself, not what it points to.
  await rm(await entryInside(target, roots), { recursive: true, force: false })
}

export async function hostFsUsage(target: string, roots: readonly string[]): Promise<HostFsUsage> {
  const { real } = await resolveInside(target, roots)
  const info = await statfs(real)
  return { total: info.blocks * info.bsize, free: info.bavail * info.bsize }
}

/** A conversation's folder, when it lies inside the allowed folders: where its Files tab opens. */
export async function conversationHostFolder(cwd: string | null, roots: readonly string[]): Promise<string | null> {
  if (!cwd) return null
  try {
    const { real } = await resolveInside(cwd, roots)
    return (await stat(real)).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** This host's home folder and, when the gateway mounted one, its workspaces folder. */
export function hostFsRoots(env: NodeJS.ProcessEnv = process.env): HostFsRoot[] {
  const roots: HostFsRoot[] = [{ path: os.homedir(), label: 'home' }]
  const workspaces = env.MAESTRLY_WORKSPACES_ROOT
  if (workspaces && path.isAbsolute(workspaces)) {
    try {
      if (statSync(workspaces).isDirectory()) roots.push({ path: workspaces, label: 'workspaces' })
    } catch {
      /* The folder is not mounted: only the home folder is offered. */
    }
  }
  return roots
}

export function registerHostFsIpc(
  reg: IpcRegistrar,
  deps: { roots: () => HostFsRoot[]; conversationFolder: (conversationId: string) => string | null }
): void {
  const paths = (): string[] => deps.roots().map((root) => root.path)
  reg.handle('host-fs:roots', () => deps.roots())
  reg.handle('host-fs:list', (_event, target: unknown, options: unknown) => {
    const value = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>
    return listHostDirectory(
      target as string,
      { includeHidden: value.includeHidden === true, includeFiles: value.includeFiles === true },
      paths()
    )
  })
  reg.mhandle('host-fs:mkdir', (_event, parent: unknown, name: unknown) =>
    createHostDirectory(parent as string, name as string, paths())
  )
  reg.handle('host-fs:conversation-folder', (_event, id: unknown) =>
    typeof id === 'string' ? conversationHostFolder(deps.conversationFolder(id), paths()) : null
  )
  reg.handle('host-fs:preview', (_event, target: unknown) => previewHostFile(target as string, paths()))
  reg.handle('host-fs:usage', (_event, target: unknown) => hostFsUsage(target as string, paths()))
  reg.mhandle('host-fs:rename', (_event, target: unknown, name: unknown) =>
    renameHostEntry(target as string, name as string, paths())
  )
  reg.mhandle('host-fs:delete', (_event, target: unknown) => deleteHostEntry(target as string, paths()))
}
