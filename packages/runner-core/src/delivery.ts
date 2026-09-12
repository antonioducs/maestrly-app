import { createHash } from 'node:crypto'
import type { ExecutionArtifact } from './executor.js'

export interface DeliveryArtifact {
  kind: ExecutionArtifact['kind']
  name: string
  contentType: string
  sizeBytes: number
  digest: string
  storageKey: string
}

export function describeArtifacts(runId: string, artifacts: ExecutionArtifact[]): DeliveryArtifact[] {
  return artifacts.map((artifact) => {
    const digest = createHash('sha256').update(artifact.bytes).digest('hex')
    return {
      kind: artifact.kind,
      name: artifact.name,
      contentType: artifact.contentType,
      sizeBytes: artifact.bytes.byteLength,
      digest,
      storageKey: `runs/${runId}/${digest}/${encodeURIComponent(artifact.name)}`,
    }
  })
}
