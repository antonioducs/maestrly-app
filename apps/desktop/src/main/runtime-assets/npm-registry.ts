/**
 * Shared helpers for reading official runtime release metadata from the npm registry. Only small version documents
 * are read, with a size limit, a timeout supplied by the caller, and redirects restricted to the registry origin.
 */

export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const MAX_REDIRECTS = 3
const STABLE_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/
const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]{86}==)$/

export class RuntimeReleaseDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RuntimeReleaseDiscoveryError'
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
export function npmDownloadCeiling(unpackedBytes: number, fileCount: number | undefined, cap: number): number {
  const entries = Number.isSafeInteger(fileCount) && (fileCount ?? 0) > 0 ? (fileCount as number) : 4096
  return Math.min(cap, Math.ceil(unpackedBytes * 1.001) + entries * 1024 + 1024 * 1024)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function readLimitedBody(response: Response, maxBytes: number, url: string): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new RuntimeReleaseDiscoveryError(`Release metadata exceeds ${maxBytes} bytes: ${url}`)
  }
  if (!response.body) throw new RuntimeReleaseDiscoveryError(`Release metadata response has no body: ${url}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new RuntimeReleaseDiscoveryError(`Release metadata exceeds ${maxBytes} bytes: ${url}`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function fetchRegistryJson(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  maxBytes: number
): Promise<unknown> {
  let current = url
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const parsed = new URL(current)
    if (parsed.origin !== NPM_REGISTRY_ORIGIN) {
      throw new RuntimeReleaseDiscoveryError(`Release metadata redirected to another destination: ${parsed.origin}`)
    }
    const response = await fetchImpl(current, {
      signal,
      redirect: 'manual',
      headers: { accept: 'application/json' },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new RuntimeReleaseDiscoveryError(`Redirect without Location: ${current}`)
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new RuntimeReleaseDiscoveryError(`Release metadata request failed (${response.status}): ${current}`)
    }
    const body = await readLimitedBody(response, maxBytes, current)
    try {
      return JSON.parse(body) as unknown
    } catch (error) {
      throw new RuntimeReleaseDiscoveryError(`Release metadata is not valid JSON: ${current}`, { cause: error })
    }
  }
  throw new RuntimeReleaseDiscoveryError(`Too many redirects reading release metadata: ${url}`)
}
