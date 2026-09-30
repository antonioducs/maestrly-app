import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { ArtifactsService } from './service'

let service: ArtifactsService | null = null

export function setArtifactsService(next: ArtifactsService): void {
  service = next
}

export function getArtifactsService(): ArtifactsService {
  if (!service) throw new Error('The artifacts service is not initialized')
  return service
}

export const artifactsDataDir = (): string => path.join(app.getPath('userData'), 'artifacts')

/**
 * Before a data export: writes a snapshot of the artifacts database to `artifacts/export/`, next to the blobs the
 * asset walker exports. Returns the cleanup that removes the snapshot afterwards.
 */
export async function prepareArtifactsExport(omissions: string[]): Promise<() => Promise<void>> {
  const target = path.join(artifactsDataDir(), 'export')
  const cleanup = () => rm(target, { recursive: true, force: true })
  await cleanup()
  if (!existsSync(path.join(artifactsDataDir(), 'artifacts.sqlite'))) return cleanup
  try {
    if (!service || !(await service.prepareExport(target))) throw new Error('unavailable')
  } catch {
    omissions.push('Could not export artifacts.')
  }
  return cleanup
}
