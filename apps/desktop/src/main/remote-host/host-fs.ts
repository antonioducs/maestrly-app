import { statSync } from 'node:fs'
import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HostFsEntry, HostFsErrorCode, HostFsListing, HostFsListOptions, HostFsRoot } from '../../shared/host-fs'
import type { IpcRegistrar } from '../ipc-registrar'

/**
 * Browsing a host's folders, for choosing a workspace folder from another computer, where a native folder dialog on
 * the host would show on a screen nobody looks at. Only the host's roots are reachable: its home folder and, on a
 * server, the workspaces folder the gateway mounts. Paths are resolved through links before they are checked.
 */
const LIST_LIMIT = 2_000

const fail = (code: HostFsErrorCode, message: string): Error => Object.assign(new Error(message), { code })

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

async function realRoots(roots: readonly string[]): Promise<string[]> {
  const real = await Promise.all(roots.map((root) => realpath(root).catch(() => null)))
  return real.filter((root): root is string => root !== null)
}

const within = (target: string, roots: readonly string[]): boolean =>
  roots.some((root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep))

/** The real path of an existing path, when it is an allowed folder or inside one. */
async function resolveInside(target: string, roots: readonly string[]): Promise<{ real: string; roots: string[] }> {
  const outside = () => fail('outside-roots', 'This folder is outside the folders Maestrly can use here.')
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw outside()
  const allowed = await realRoots(roots)
  let real: string
  try {
    real = await realpath(target)
  } catch (error) {
    // A missing path is only reported as missing when its own text is inside a root: nothing leaks about the rest.
    if (errno(error) === 'ENOENT' && within(path.resolve(target), allowed))
      throw fail('not-found', 'This folder does not exist.')
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
    if (errno(error) === 'ENOTDIR') throw fail('not-a-directory', 'This is not a folder.')
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

export async function createHostDirectory(parent: string, name: string, roots: readonly string[]): Promise<string> {
  const { real } = await resolveInside(parent, roots)
  if (typeof name !== 'string' || !/^[^/\\\0]{1,255}$/.test(name) || name === '.' || name === '..')
    throw fail('invalid-name', 'This folder name cannot be used.')
  const created = path.join(real, name)
  try {
    await mkdir(created)
  } catch (error) {
    if (errno(error) === 'EEXIST') throw fail('exists', 'A file or folder with this name already exists.')
    throw error
  }
  return created
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

export function registerHostFsIpc(reg: IpcRegistrar, deps: { roots: () => HostFsRoot[] }): void {
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
}
