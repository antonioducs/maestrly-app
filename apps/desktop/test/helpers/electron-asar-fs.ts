import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

/**
 * `node:fs` as Electron's main process has it, for what a test needs of it: a path through a file named `*.asar` is a
 * path into an archive, so such a real file can be neither opened, read, statted, copied nor removed as the file it
 * is, and a recursive removal of a folder that holds one stops on it. Linking, changing modes and creating a file by
 * stream still work, as they do there. A test mocks `node:fs` and `node:fs/promises` with `electronFs` and
 * `electronFsPromises`, built from the real modules.
 */
type Call = (...args: unknown[]) => Promise<unknown>

const throughAsar = (target: unknown): boolean =>
  (target instanceof URL ? target.pathname : String(target)).split(/[\\/]/).some((segment) => /\.asar$/i.test(segment))
const notFound = (target: unknown): NodeJS.ErrnoException =>
  Object.assign(new Error(`ENOENT, not found in ${String(target)}`), { code: 'ENOENT' })

/** Whether a folder holds a file named `*.asar`, at any depth, without following links. */
function holdsAsar(fs: typeof NodeFs, directory: string): boolean {
  let entries: NodeFs.Dirent[]
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return false
  }
  return entries.some((entry) =>
    entry.isDirectory() ? holdsAsar(fs, path.join(directory, entry.name)) : throughAsar(entry.name)
  )
}

export function electronFsPromises(real: typeof NodeFsPromises, fs: typeof NodeFs): typeof NodeFsPromises {
  const guarded =
    (call: Call, paths = 1): Call =>
    async (...args) => {
      for (const target of args.slice(0, paths)) if (throughAsar(target)) throw notFound(target)
      return call(...args)
    }
  const promises = real as unknown as Record<string, Call>
  return {
    ...real,
    access: guarded(promises.access),
    copyFile: guarded(promises.copyFile, 2),
    lstat: guarded(promises.lstat),
    open: guarded(promises.open),
    readdir: guarded(promises.readdir),
    readFile: guarded(promises.readFile),
    realpath: guarded(promises.realpath),
    stat: guarded(promises.stat),
    rm: async (target: NodeFs.PathLike, options?: NodeFs.RmOptions) => {
      if (throughAsar(target)) throw notFound(target)
      if (options?.recursive && holdsAsar(fs, String(target)))
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${String(target)}'`), {
          code: 'ENOTEMPTY',
        })
      return real.rm(target, options)
    },
  } as typeof NodeFsPromises
}

export function electronFs(real: typeof NodeFs): typeof NodeFs {
  const promises = electronFsPromises(real.promises, real)
  const createReadStream = ((target: NodeFs.PathLike, options?: unknown) => {
    if (!throughAsar(target)) return real.createReadStream(target, options as never)
    const stream = new Readable({ read() {} })
    process.nextTick(() => stream.destroy(notFound(target)))
    return stream
  }) as typeof NodeFs.createReadStream
  const fs = { ...real, createReadStream, promises }
  return { ...fs, default: fs } as typeof NodeFs
}
