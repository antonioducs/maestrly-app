import type { UpdatableRuntimeAssetId } from '../../shared/runtime-assets'
import type { RuntimeAssetTarget, RuntimeTargetId } from './registry'

/** npm publisher integrity, or explicit Google HTTPS provenance/local acceptance, with bounded artifact sizes. */
export interface RuntimeArtifactMetadata {
  readonly sha512Base64?: string
  readonly googleIntegrity?: { readonly sha256: string } | { readonly pending: true }
  readonly downloadBytes: number
  readonly maxDownloadBytes: number
  readonly unpackedBytes: number
}

/**
 * What differs between independently updated runtimes. Release stores and update controllers take every
 * runtime-specific rule from here: which targets exist, the only artifact URL accepted, the target layout, and the
 * size limits applied to published metadata.
 */
export interface RuntimeReleaseProfile {
  readonly id: UpdatableRuntimeAssetId
  /** Diagnostics only. */
  readonly label: string
  readonly maxDownloadBytes: number
  readonly maxUnpackedBytes: number
  supportsTarget(target: RuntimeTargetId): boolean
  artifactUrl(version: string, target: RuntimeTargetId): string
  createTarget(target: RuntimeTargetId, version: string, metadata: RuntimeArtifactMetadata): RuntimeAssetTarget
}
