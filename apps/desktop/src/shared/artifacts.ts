/** Artifacts shared between the main process and the renderer: settings, host status and list views. */

export interface ArtifactSettings {
  hostEnabled: boolean
  port: number
  quotaGb: number
}

export const DEFAULT_ARTIFACT_SETTINGS: ArtifactSettings = { hostEnabled: true, port: 4010, quotaGb: 2 }

export type ArtifactHostState = 'stopped' | 'starting' | 'running' | 'error'
export type ArtifactHostProblem = 'disabled' | 'port_in_use' | 'storage' | 'crashed'

export interface ArtifactHostStatus {
  state: ArtifactHostState
  problem?: ArtifactHostProblem
  port: number
  artifactCount?: number
  storageBytes?: number
  quotaBytes?: number
}

export type ArtifactVisibility = 'private' | 'people' | 'link'

export interface ArtifactListItem {
  id: string
  title: string
  description: string
  currentVersion: number
  versionCount: number
  visibility: ArtifactVisibility
  createdAt: number
  updatedAt: number
  host: 'local'
  /** The originating conversation; `exists` is false once it was deleted, with its last known title. */
  conversation: { id: string; title: string | null; exists: boolean } | null
}

export interface ArtifactVersionView {
  number: number
  summary: string
  createdAt: number
  fileCount: number
  totalBytes: number
}

export interface ArtifactDetailView extends ArtifactListItem {
  versions: ArtifactVersionView[]
}

/** What the chat card needs from an `artifact_create` or `artifact_update` result. */
export interface ArtifactToolResult {
  id: string
  title: string
  version: number
}

const ARTIFACT_ID = /^[A-Za-z0-9_-]{22}$/
const MAX_CARD_TITLE_CHARS = 200

export function parseArtifactToolResult(text: string): ArtifactToolResult | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const result = value as { ok?: unknown; artifact?: { id?: unknown; title?: unknown; version?: unknown } } | null
  const artifact = result?.ok === true ? result.artifact : undefined
  if (!artifact || typeof artifact.id !== 'string' || !ARTIFACT_ID.test(artifact.id)) return null
  if (typeof artifact.title !== 'string') return null
  if (typeof artifact.version !== 'number' || !Number.isInteger(artifact.version) || artifact.version < 1) return null
  return { id: artifact.id, title: artifact.title.slice(0, MAX_CARD_TITLE_CHARS), version: artifact.version }
}
