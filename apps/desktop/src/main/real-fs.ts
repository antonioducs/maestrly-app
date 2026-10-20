import fs from 'node:fs'
import { createRequire } from 'node:module'

/**
 * The file system without Electron's ASAR support. Inside Electron, `node:fs` takes any path through a file named
 * `*.asar` for a path into an archive: such a real file, like the `default_app.asar` an installed `electron` package
 * ships, can then be neither opened, read, copied nor created as the file it is. Files a person, a bot or a
 * conversation owns are always plain files, so what moves or hashes them goes through this one.
 */
export function realFileSystem(
  versions: { electron?: string } = process.versions,
  load: (id: string) => unknown = createRequire(import.meta.url)
): typeof fs {
  return versions.electron ? (load('original-fs') as typeof fs) : fs
}

export const realFs = realFileSystem()
