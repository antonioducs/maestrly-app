import {
  compareStableVersions,
  fetchRegistryJson,
  isRecord,
  isSha512Integrity,
  isStableRuntimeVersion,
  npmDownloadCeiling,
  RuntimeReleaseDiscoveryError,
} from './npm-registry'
import {
  CODEX_NPM_REGISTRY_ORIGIN,
  CODEX_TARGET_LAYOUT,
  codexArtifactUrl,
  createCodexTarget,
  type RuntimeAssetDefinition,
  type RuntimeTargetId,
} from './registry'
import type { RuntimeReleaseProfile } from './release-profile'

export { compareStableVersions, isSha512Integrity, isStableRuntimeVersion }

/**
 * Discovery of official stable Codex releases on the npm registry. Only two small version documents are read:
 * the `latest` dist-tag of `@openai/codex` and the exact platform alias it declares. The full packument (every
 * historical version) is never downloaded. Every field that later drives a download is validated here: package
 * identity, stable version, alias coherence, canonical tarball URL, and SHA-512 integrity.
 */

export const CODEX_PACKAGE_NAME = '@openai/codex'
export const CODEX_RELEASE_DISCOVERY_TIMEOUT_MS = 10_000
/** Version documents are ~4 KB; anything much larger is not the expected metadata. */
export const CODEX_RELEASE_METADATA_MAX_BYTES = 256 * 1024
/** Explicit download ceiling for dynamically discovered artifacts, regardless of published metadata. */
export const CODEX_MAX_DOWNLOAD_BYTES = 640 * 1024 * 1024
/** Upper bound accepted for the published extracted size. */
export const CODEX_MAX_UNPACKED_BYTES = 1536 * 1024 * 1024
/**
 * npm does not publish compressed tarball sizes. Measured official archives are 0.36–0.41 of `unpackedSize`;
 * the estimate only drives progress and the size shown before the download starts.
 */
const CODEX_ESTIMATED_COMPRESSION_RATIO = 0.42

export const CodexReleaseDiscoveryError = RuntimeReleaseDiscoveryError

export const CODEX_RELEASE_PROFILE: RuntimeReleaseProfile = Object.freeze({
  id: 'codex-runtime' as const,
  label: 'Codex',
  maxDownloadBytes: CODEX_MAX_DOWNLOAD_BYTES,
  maxUnpackedBytes: CODEX_MAX_UNPACKED_BYTES,
  supportsTarget: (target: RuntimeTargetId) => Object.hasOwn(CODEX_TARGET_LAYOUT, target),
  artifactUrl: codexArtifactUrl,
  createTarget: createCodexTarget,
})

/**
 * Conservative compressed-size ceiling: a gzip-compressed tar cannot meaningfully exceed its payload plus one
 * header and padding block per entry. The absolute cap still applies when metadata would allow more.
 */
export function codexDownloadCeiling(unpackedBytes: number, fileCount?: number): number {
  return npmDownloadCeiling(unpackedBytes, fileCount, CODEX_MAX_DOWNLOAD_BYTES)
}

export interface CodexReleaseDiscoveryDependencies {
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

/**
 * Resolve the latest stable official Codex release for one platform. The returned definition contains only the
 * requested target; it is not trusted for activation until the caller installs, verifies, and validates it.
 */
export async function discoverCodexRelease(
  target: RuntimeTargetId,
  signal?: AbortSignal,
  dependencies: CodexReleaseDiscoveryDependencies = {}
): Promise<RuntimeAssetDefinition> {
  const layout = CODEX_TARGET_LAYOUT[target]
  if (!layout) throw new CodexReleaseDiscoveryError(`Codex does not publish a ${target} runtime`)
  const fetchImpl = dependencies.fetch ?? fetch
  const maxBytes = dependencies.maxResponseBytes ?? CODEX_RELEASE_METADATA_MAX_BYTES
  const timeout = AbortSignal.timeout(dependencies.timeoutMs ?? CODEX_RELEASE_DISCOVERY_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

  try {
    const latest = await fetchRegistryJson(
      `${CODEX_NPM_REGISTRY_ORIGIN}/${CODEX_PACKAGE_NAME}/latest`,
      combined,
      fetchImpl,
      maxBytes
    )
    if (!isRecord(latest) || latest.name !== CODEX_PACKAGE_NAME) {
      throw new CodexReleaseDiscoveryError('Latest release metadata does not describe @openai/codex')
    }
    if (!isStableRuntimeVersion(latest.version)) {
      throw new CodexReleaseDiscoveryError(`Latest Codex release is not a stable version: ${String(latest.version)}`)
    }
    const version = latest.version
    const aliasName = `${CODEX_PACKAGE_NAME}-${layout.suffix}`
    const platformVersion = `${version}-${layout.suffix}`
    const alias = isRecord(latest.optionalDependencies) ? latest.optionalDependencies[aliasName] : undefined
    if (alias !== `npm:${CODEX_PACKAGE_NAME}@${platformVersion}`) {
      throw new CodexReleaseDiscoveryError(`Codex ${version} does not declare a coherent ${aliasName} artifact`)
    }

    const platform = await fetchRegistryJson(
      `${CODEX_NPM_REGISTRY_ORIGIN}/${CODEX_PACKAGE_NAME}/${platformVersion}`,
      combined,
      fetchImpl,
      maxBytes
    )
    if (!isRecord(platform) || platform.name !== CODEX_PACKAGE_NAME || platform.version !== platformVersion) {
      throw new CodexReleaseDiscoveryError(
        `Platform metadata does not describe ${CODEX_PACKAGE_NAME}@${platformVersion}`
      )
    }
    const dist = isRecord(platform.dist) ? platform.dist : null
    const expectedUrl = codexArtifactUrl(version, target)
    if (!dist || dist.tarball !== expectedUrl) {
      throw new CodexReleaseDiscoveryError(`Codex ${platformVersion} artifact is not served from the official URL`)
    }
    if (!isSha512Integrity(dist.integrity)) {
      throw new CodexReleaseDiscoveryError(`Codex ${platformVersion} does not publish a valid SHA-512 integrity`)
    }
    const unpackedBytes = dist.unpackedSize
    if (
      typeof unpackedBytes !== 'number' ||
      !Number.isSafeInteger(unpackedBytes) ||
      unpackedBytes <= 0 ||
      unpackedBytes > CODEX_MAX_UNPACKED_BYTES
    ) {
      throw new CodexReleaseDiscoveryError(`Codex ${platformVersion} publishes an invalid unpacked size`)
    }
    const fileCount = typeof dist.fileCount === 'number' ? dist.fileCount : undefined
    const maxDownloadBytes = codexDownloadCeiling(unpackedBytes, fileCount)

    return Object.freeze({
      id: 'codex-runtime' as const,
      version,
      targets: Object.freeze({
        [target]: createCodexTarget(target, version, {
          sha512Base64: dist.integrity.slice('sha512-'.length),
          downloadBytes: Math.min(maxDownloadBytes, Math.round(unpackedBytes * CODEX_ESTIMATED_COMPRESSION_RATIO)),
          maxDownloadBytes,
          unpackedBytes,
        }),
      }),
    })
  } catch (error) {
    if (error instanceof CodexReleaseDiscoveryError) throw error
    if (timeout.aborted && !signal?.aborted) {
      throw new CodexReleaseDiscoveryError('Timed out checking for Codex releases', { cause: error })
    }
    if (signal?.aborted) throw signal.reason ?? error
    throw new CodexReleaseDiscoveryError(
      `Unable to check for Codex releases: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}
