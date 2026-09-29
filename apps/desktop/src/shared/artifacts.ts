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
