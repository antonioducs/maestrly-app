import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ExecutionArtifact } from '../executor.js'

export async function collectArtifact(
  workspace: string,
  relativePath: string,
  kind: ExecutionArtifact['kind'],
  maxBytes = 10 * 1024 * 1024,
): Promise<ExecutionArtifact> {
  const root = path.resolve(workspace)
  const target = path.resolve(root, relativePath)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Artifact path escapes the workspace.')
  const metadata = await stat(target)
  if (!metadata.isFile() || metadata.size > maxBytes) throw new Error('Artifact is not a file or exceeds its size limit.')
  return { kind, name: path.basename(target), contentType: 'application/octet-stream', bytes: await readFile(target) }
}
