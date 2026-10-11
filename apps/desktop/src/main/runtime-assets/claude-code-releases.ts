import {
  fetchRegistryJson,
  isRecord,
  isSha512Integrity,
  isStableRuntimeVersion,
  NPM_REGISTRY_ORIGIN,
  npmDownloadCeiling,
  RuntimeReleaseDiscoveryError,
} from './npm-registry'
import {
  CLAUDE_CODE_TARGET_LAYOUT,
  claudeCodeArtifactUrl,
  createClaudeCodeTarget,
  isClaudeCodeTarget,
  type RuntimeAssetDefinition,
  type RuntimeTargetId,
} from './registry'
import type { RuntimeArtifactMetadata, RuntimeReleaseProfile } from './release-profile'

/**
 * Discovery of official Claude Code releases on the npm registry, for bots. Two small version documents are read:
 * the `latest` dist-tag of `@anthropic-ai/claude-code` and the platform package it declares for this target. The
 * platform package holds the native `claude` binary, the same file the Agent SDK bundles for that version. Every
 * field that later drives a download is validated here: package identity, stable version, platform coherence,
 * canonical tarball URL, SHA-512 integrity, and size.
 */

export const CLAUDE_CODE_PACKAGE_NAME = '@anthropic-ai/claude-code'
export const CLAUDE_CODE_RELEASE_DISCOVERY_TIMEOUT_MS = 10_000
/** Version documents are a few KB; anything much larger is not the expected metadata. */
export const CLAUDE_CODE_RELEASE_METADATA_MAX_BYTES = 256 * 1024
/** Explicit download ceiling for dynamically discovered artifacts, regardless of published metadata. */
export const CLAUDE_CODE_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
/** Upper bound accepted for the published extracted size. */
export const CLAUDE_CODE_MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
/** Measured official archives are 0.45 of `unpackedSize`; the estimate only drives progress. */
const CLAUDE_CODE_ESTIMATED_COMPRESSION_RATIO = 0.45

function requireTarget(target: RuntimeTargetId) {
  if (!isClaudeCodeTarget(target)) throw new RuntimeReleaseDiscoveryError(`Claude Code is not managed on ${target}`)
  return target
}

export const CLAUDE_CODE_RELEASE_PROFILE: RuntimeReleaseProfile = Object.freeze({
  id: 'claude-code-runtime' as const,
  label: 'Claude Code',
  maxDownloadBytes: CLAUDE_CODE_MAX_DOWNLOAD_BYTES,
  maxUnpackedBytes: CLAUDE_CODE_MAX_UNPACKED_BYTES,
  supportsTarget: isClaudeCodeTarget,
  artifactUrl: (version: string, target: RuntimeTargetId) => claudeCodeArtifactUrl(version, requireTarget(target)),
  createTarget: (target: RuntimeTargetId, version: string, metadata: RuntimeArtifactMetadata) =>
    createClaudeCodeTarget(requireTarget(target), version, metadata),
})

export interface ClaudeCodeReleaseDiscoveryDependencies {
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

/**
 * Resolve the latest stable official Claude Code release for one platform. The returned definition contains only the
 * requested target; it is not trusted for activation until the caller installs, verifies, and validates it.
 */
export async function discoverClaudeCodeRelease(
  target: RuntimeTargetId,
  signal?: AbortSignal,
  dependencies: ClaudeCodeReleaseDiscoveryDependencies = {}
): Promise<RuntimeAssetDefinition> {
  const platformTarget = requireTarget(target)
  const platformName = `${CLAUDE_CODE_PACKAGE_NAME}-${CLAUDE_CODE_TARGET_LAYOUT[platformTarget].suffix}`
  const fetchImpl = dependencies.fetch ?? fetch
  const maxBytes = dependencies.maxResponseBytes ?? CLAUDE_CODE_RELEASE_METADATA_MAX_BYTES
  const timeout = AbortSignal.timeout(dependencies.timeoutMs ?? CLAUDE_CODE_RELEASE_DISCOVERY_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

  try {
    const latest = await fetchRegistryJson(
      `${NPM_REGISTRY_ORIGIN}/${CLAUDE_CODE_PACKAGE_NAME}/latest`,
      combined,
      fetchImpl,
      maxBytes
    )
    if (!isRecord(latest) || latest.name !== CLAUDE_CODE_PACKAGE_NAME) {
      throw new RuntimeReleaseDiscoveryError(`Latest release metadata does not describe ${CLAUDE_CODE_PACKAGE_NAME}`)
    }
    if (!isStableRuntimeVersion(latest.version)) {
      throw new RuntimeReleaseDiscoveryError(
        `Latest Claude Code release is not a stable version: ${String(latest.version)}`
      )
    }
    const version = latest.version
    const declared = isRecord(latest.optionalDependencies) ? latest.optionalDependencies[platformName] : undefined
    if (declared !== version) {
      throw new RuntimeReleaseDiscoveryError(`Claude Code ${version} does not declare a coherent ${platformName}`)
    }

    const platform = await fetchRegistryJson(
      `${NPM_REGISTRY_ORIGIN}/${platformName}/${version}`,
      combined,
      fetchImpl,
      maxBytes
    )
    if (!isRecord(platform) || platform.name !== platformName || platform.version !== version) {
      throw new RuntimeReleaseDiscoveryError(`Platform metadata does not describe ${platformName}@${version}`)
    }
    const dist = isRecord(platform.dist) ? platform.dist : null
    if (!dist || dist.tarball !== claudeCodeArtifactUrl(version, platformTarget)) {
      throw new RuntimeReleaseDiscoveryError(`${platformName}@${version} is not served from the official URL`)
    }
    if (!isSha512Integrity(dist.integrity)) {
      throw new RuntimeReleaseDiscoveryError(`${platformName}@${version} does not publish a valid SHA-512 integrity`)
    }
    const unpackedBytes = dist.unpackedSize
    if (
      typeof unpackedBytes !== 'number' ||
      !Number.isSafeInteger(unpackedBytes) ||
      unpackedBytes <= 0 ||
      unpackedBytes > CLAUDE_CODE_MAX_UNPACKED_BYTES
    ) {
      throw new RuntimeReleaseDiscoveryError(`${platformName}@${version} publishes an invalid unpacked size`)
    }
    const fileCount = typeof dist.fileCount === 'number' ? dist.fileCount : undefined
    const maxDownloadBytes = npmDownloadCeiling(unpackedBytes, fileCount, CLAUDE_CODE_MAX_DOWNLOAD_BYTES)

    return Object.freeze({
      id: 'claude-code-runtime' as const,
      version,
      targets: Object.freeze({
        [platformTarget]: createClaudeCodeTarget(platformTarget, version, {
          sha512Base64: dist.integrity.slice('sha512-'.length),
          downloadBytes: Math.min(
            maxDownloadBytes,
            Math.round(unpackedBytes * CLAUDE_CODE_ESTIMATED_COMPRESSION_RATIO)
          ),
          maxDownloadBytes,
          unpackedBytes,
        }),
      }),
    })
  } catch (error) {
    if (error instanceof RuntimeReleaseDiscoveryError) throw error
    if (timeout.aborted && !signal?.aborted) {
      throw new RuntimeReleaseDiscoveryError('Timed out checking for Claude Code releases', { cause: error })
    }
    if (signal?.aborted) throw signal.reason ?? error
    throw new RuntimeReleaseDiscoveryError(
      `Unable to check for Claude Code releases: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}
