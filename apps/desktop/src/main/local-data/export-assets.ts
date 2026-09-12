import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface ExportedAsset {
  /** Relative to Electron userData; never an arbitrary path from stored content. */
  path: string
  owner: { kind: 'conversation' | 'workspace' | 'app'; id?: string }
  encoding: 'base64'
  data: string
  byteSize: number
  sha256: string
}

export const safeAssetId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id)

/** Walk only dedicated asset roots. Symlinks and special files are omissions, never followed. */
export async function exportOwnedAssets(omissions: string[]): Promise<ExportedAsset[]> {
  const base = path.resolve(app.getPath('userData'))
  const assets: ExportedAsset[] = []
  const visit = async (relative: string, owner: ExportedAsset['owner'], missingAllowed = false): Promise<void> => {
    const absolute = path.join(base, relative)
    try {
      const stat = await fs.lstat(absolute)
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are excluded')
      if (stat.isDirectory()) {
        for (const entry of (await fs.readdir(absolute)).sort()) {
          await visit(`${relative}/${entry}`, owner)
        }
      } else if (stat.isFile()) {
        const real = await fs.realpath(absolute)
        if (real !== path.join(await fs.realpath(base), relative)) throw new Error('Asset escaped its owned root')
        const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const opened = await handle.stat()
          if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
            throw new Error('Asset changed during export')
          const bytes = await handle.readFile()
          assets.push({
            path: relative,
            owner,
            encoding: 'base64',
            data: bytes.toString('base64'),
            byteSize: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          })
        } finally {
          await handle.close()
        }
      } else throw new Error('Special files are excluded')
    } catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      omissions.push(`Could not export app-owned asset ${relative}.`)
    }
  }
  const children = async (root: string, action: (entry: string) => Promise<void>): Promise<void> => {
    try {
      const stat = await fs.lstat(path.join(base, root))
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe asset root')
      for (const entry of (await fs.readdir(path.join(base, root))).sort()) await action(entry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        omissions.push(`Could not export app-owned asset root ${root}.`)
    }
  }
  for (const root of ['chat-generated-images', 'chat-attachment-images']) {
    await children(root, async (id) => visit(`${root}/${id}`, { kind: 'conversation', id }))
  }
  await visit('chat-tool-output', { kind: 'app' }, true)
  await children('workspace-data', async (id) => {
    // Check the intermediate workspace and notebook directories before descending into assets.
    let relative = `workspace-data/${id}`
    try {
      for (const segment of ['', '/project-notes']) {
        relative += segment
        const stat = await fs.lstat(path.join(base, relative))
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe notebook root')
      }
      await visit(`${relative}/assets`, { kind: 'workspace', id }, true)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        omissions.push(`Could not export app-owned asset root ${relative}.`)
    }
  })
  return assets
}
