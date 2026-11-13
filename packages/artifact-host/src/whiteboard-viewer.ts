import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { contentTypeFor, normalizeBundlePath } from './bundle-paths.js'

/** The canvas the host serves for every whiteboard, in place of the files of a version. */
export interface WhiteboardViewer {
  file(path: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
}

/**
 * Indexes the viewer's build once: regular files whose type the host serves, by the path a capability URL names.
 * Nothing outside the index is ever read, so a request cannot reach past the directory or follow a link out of it.
 */
export async function openWhiteboardViewer(dir: string): Promise<WhiteboardViewer> {
  const root = path.resolve(dir)
  const index = new Map<string, { file: string; contentType: string }>()
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    let key: string
    try {
      key = normalizeBundlePath(path.relative(root, file).split(path.sep).join('/'))
    } catch {
      continue
    }
    const contentType = contentTypeFor(key)
    if (contentType) index.set(key, { file, contentType })
  }
  if (!index.has('index.html')) throw new Error(`No whiteboard viewer in ${root}: index.html is missing`)
  return {
    async file(requested) {
      const found = index.get(requested)
      if (!found) return null
      return { bytes: new Uint8Array(await readFile(found.file)), contentType: found.contentType }
    },
  }
}
