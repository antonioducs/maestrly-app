import { createHash } from 'node:crypto'
import path from 'node:path'

/** Directories a host keeps under `<userData>/plugins`. Staging and packages share a volume, so renames are atomic. */
export interface PluginLayout {
  root: string
  source(id: string): string
  extSource(hash: string): string
  packages(keyHash: string): string
  packageDir(keyHash: string, dirName: string): string
  data(keyHash: string): string
  staging(): string
}

export function pluginLayout(base: string): PluginLayout {
  const root = path.resolve(base)
  return {
    root,
    source: (id) => path.join(root, 'sources', id),
    extSource: (hash) => path.join(root, 'sources', 'ext', hash),
    packages: (keyHash) => path.join(root, 'packages', keyHash),
    packageDir: (keyHash, dirName) => path.join(root, 'packages', keyHash, dirName),
    data: (keyHash) => path.join(root, 'data', keyHash),
    staging: () => path.join(root, '.staging'),
  }
}

export const pluginKeyHash = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 16)
