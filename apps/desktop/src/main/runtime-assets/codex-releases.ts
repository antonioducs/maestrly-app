import {
  CODEX_NPM_REGISTRY_ORIGIN,
  CODEX_TARGET_LAYOUT,
  codexArtifactUrl,
  createCodexTarget,
  type RuntimeAssetDefinition,
  type RuntimeTargetId,
} from './registry'

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
const MAX_REDIRECTS = 3
const STABLE_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/
const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]{86}==)$/

export class CodexReleaseDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CodexReleaseDiscoveryError'
  }
}

export function isStableRuntimeVersion(version: unknown): version is string {
  return typeof version === 'string' && STABLE_VERSION.test(version)
}

/** Numeric comparison of `major.minor.patch`; `null` when either side is not a stable version. */
export function compareStableVersions(left: string, right: string): number | null {
  const a = STABLE_VERSION.exec(left)
  const b = STABLE_VERSION.exec(right)
  if (!a || !b) return null
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index])
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

export function isSha512Integrity(value: unknown): value is string {
  return typeof value === 'string' && SHA512_INTEGRITY.test(value)
}

/**
 * Conservative compressed-size ceiling: a gzip-compressed tar cannot meaningfully exceed its payload plus one
 * header and padding block per entry. The absolute cap still applies when metadata would allow more.
 */
export function codexDownloadCeiling(unpackedBytes: number, fileCount?: number): number {
  const entries = Number.isSafeInteger(fileCount) && (fileCount ?? 0) > 0 ? (fileCount as number) : 4096
  return Math.min(CODEX_MAX_DOWNLOAD_BYTES, Math.ceil(unpackedBytes * 1.001) + entries * 1024 + 1024 * 1024)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export interface CodexReleaseDiscoveryDependencies {
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

async function readLimitedBody(response: Response, maxBytes: number, url: string): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new CodexReleaseDiscoveryError(`Release metadata exceeds ${maxBytes} bytes: ${url}`)
  }
  if (!response.body) throw new CodexReleaseDiscoveryError(`Release metadata response has no body: ${url}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new CodexReleaseDiscoveryError(`Release metadata exceeds ${maxBytes} bytes: ${url}`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchRegistryJson(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  maxBytes: number
): Promise<unknown> {
  let current = url
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const parsed = new URL(current)
    if (parsed.origin !== CODEX_NPM_REGISTRY_ORIGIN) {
      throw new CodexReleaseDiscoveryError(`Release metadata redirected to another destination: ${parsed.origin}`)
    }
    const response = await fetchImpl(current, {
      signal,
      redirect: 'manual',
      headers: { accept: 'application/json' },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new CodexReleaseDiscoveryError(`Redirect without Location: ${current}`)
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new CodexReleaseDiscoveryError(`Release metadata request failed (${response.status}): ${current}`)
    }
    const body = await readLimitedBody(response, maxBytes, current)
    try {
      return JSON.parse(body) as unknown
    } catch (error) {
      throw new CodexReleaseDiscoveryError(`Release metadata is not valid JSON: ${current}`, { cause: error })
    }
  }
  throw new CodexReleaseDiscoveryError(`Too many redirects reading release metadata: ${url}`)
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
