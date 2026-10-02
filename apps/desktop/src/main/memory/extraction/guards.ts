import type { LocalMemory } from '../../../shared/memory'
import { onPersonalMemorySettingsChanged, readPersonalMemorySettings } from '../personal-memory-settings'
import type { MemorySpace } from '../spaces'

let personalRevision = 0
onPersonalMemorySettingsChanged(() => {
  personalRevision += 1
})

/** A disable/enable cycle must not revive an answer produced under the old permission. */
export function extractionCommitGuard(space: MemorySpace): () => boolean {
  const revision = personalRevision
  return () => extractionAllowed(space) && (space.kind !== 'personal' || revision === personalRevision)
}

export function extractionAllowed(space: MemorySpace): boolean {
  if (space.kind !== 'personal') return true
  const settings = readPersonalMemorySettings()
  return settings.enabled && settings.extraction.enabled
}

export type MemorySnapshot = Pick<LocalMemory, 'contentHash' | 'status' | 'updatedAt'>
export function matchesSnapshot(memory: LocalMemory, snapshot: MemorySnapshot | undefined): boolean {
  return Boolean(
    snapshot &&
      memory.contentHash === snapshot.contentHash &&
      memory.status === snapshot.status &&
      memory.updatedAt === snapshot.updatedAt
  )
}

const applying = new Map<string, Promise<unknown>>()
/** Serialize extraction and consolidation commits within each host-derived space. */
export async function withSpaceApply<T>(spaceId: string, apply: () => Promise<T> | T): Promise<T> {
  const previous = applying.get(spaceId)
  const current = (previous ?? Promise.resolve()).catch(() => {}).then(apply)
  applying.set(spaceId, current)
  try {
    return await current
  } finally {
    if (applying.get(spaceId) === current) applying.delete(spaceId)
  }
}
