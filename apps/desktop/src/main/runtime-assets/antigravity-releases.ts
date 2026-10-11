import { isRecord, isStableRuntimeVersion, RuntimeReleaseDiscoveryError } from './npm-registry'
import {
  RUNTIME_ASSET_REGISTRY,
  type RuntimeAssetDefinition,
  type RuntimeAssetTarget,
  type RuntimeTargetId,
} from './registry'
import type { RuntimeArtifactMetadata, RuntimeReleaseProfile } from './release-profile'

export const ANTIGRAVITY_RELEASE_METADATA_URL =
  'https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json'
export const ANTIGRAVITY_MAX_DOWNLOAD_BYTES = 768 * 1024 * 1024
export const ANTIGRAVITY_MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024
export const ANTIGRAVITY_TARGETS = {
  'mac-arm64': ['darwin-aarch64', 'macos', 'darwin-arm64'],
  'mac-x64': ['darwin-x86_64', 'macos', 'darwin-x86_64'],
  'linux-arm64': ['linux-aarch64', 'linux', 'linux-arm64'],
  'linux-x64': ['linux-x86_64', 'linux', 'linux-x86_64'],
  'win-arm64': ['windows-aarch64', 'windows', 'windows-arm64'],
  'win-x64': ['windows-x86_64', 'windows', 'windows-x86_64'],
} as const

export function antigravityArtifactUrl(version: string, target: RuntimeTargetId): string {
  const [, os, suffix] = ANTIGRAVITY_TARGETS[target]
  return `https://dl.google.com/agy-extensions/releases/${os}/agy-acp-server-${version}-${suffix}.zip`
}

export function createAntigravityTarget(
  target: RuntimeTargetId,
  version: string,
  metadata: RuntimeArtifactMetadata
): RuntimeAssetTarget {
  const integrity = metadata.googleIntegrity
  if (!integrity) throw new Error('Missing Google artifact provenance')
  const windows = target.startsWith('win-')
  const server = windows ? 'agy_acp_server.exe' : 'agy_acp_server.par'
  return Object.freeze({
    id: target,
    url: antigravityArtifactUrl(version, target),
    archive: 'zip',
    hash:
      'sha256' in integrity
        ? { algorithm: 'sha256' as const, encoding: 'hex' as const, digest: integrity.sha256 }
        : { algorithm: 'sha256' as const, encoding: 'hex' as const, provenance: 'google-origin-pending' as const },
    downloadBytes: metadata.downloadBytes,
    maxDownloadBytes: metadata.maxDownloadBytes,
    unpackedBytes: metadata.unpackedBytes,
    criticalPaths: [server, windows ? 'localharness_external.exe' : 'localharness_external'],
    executablePath: server,
  })
}

export const ANTIGRAVITY_RELEASE_PROFILE: RuntimeReleaseProfile = Object.freeze({
  id: 'antigravity-acp-runtime',
  label: 'Google Antigravity ACP',
  maxDownloadBytes: ANTIGRAVITY_MAX_DOWNLOAD_BYTES,
  maxUnpackedBytes: ANTIGRAVITY_MAX_UNPACKED_BYTES,
  supportsTarget: (target: RuntimeTargetId) => Object.hasOwn(ANTIGRAVITY_TARGETS, target),
  artifactUrl: antigravityArtifactUrl,
  createTarget: createAntigravityTarget,
})

/** The sole hashless installation contract: canonical Google HTTPS artifact, fixed layout and bounded sizes. */
export function isPendingAntigravityArtifact(definition: RuntimeAssetDefinition, target: RuntimeTargetId): boolean {
  const entry = definition.targets[target]
  if (definition.id !== 'antigravity-acp-runtime' || !isStableRuntimeVersion(definition.version) || !entry) return false
  if (entry.hash.provenance !== 'google-origin-pending') return false
  const canonical = createAntigravityTarget(target, definition.version, {
    googleIntegrity: { pending: true },
    downloadBytes: entry.downloadBytes,
    maxDownloadBytes: entry.maxDownloadBytes,
    unpackedBytes: entry.unpackedBytes,
  })
  return (
    entry.id === target &&
    entry.url === canonical.url &&
    entry.archive === 'zip' &&
    entry.hash.algorithm === 'sha256' &&
    entry.hash.encoding === 'hex' &&
    entry.hash.digest === undefined &&
    entry.stripPrefix === undefined &&
    entry.fileName === undefined &&
    entry.executablePath === canonical.executablePath &&
    JSON.stringify(entry.criticalPaths) === JSON.stringify(canonical.criticalPaths) &&
    [entry.downloadBytes, entry.maxDownloadBytes, entry.unpackedBytes].every(
      (value) => Number.isSafeInteger(value) && value > 0
    ) &&
    entry.downloadBytes <= entry.maxDownloadBytes &&
    entry.maxDownloadBytes <= ANTIGRAVITY_MAX_DOWNLOAD_BYTES &&
    entry.unpackedBytes <= ANTIGRAVITY_MAX_UNPACKED_BYTES
  )
}

/** Reads only bounded registry metadata. Google publishes no digest; HTTPS provenance is explicit until acceptance. */
export async function discoverAntigravityRelease(
  target: RuntimeTargetId,
  signal?: AbortSignal,
  dependencies: {
    readonly fetch?: typeof fetch
    readonly timeoutMs?: number
    readonly maxResponseBytes?: number
  } = {}
): Promise<RuntimeAssetDefinition> {
  if (!ANTIGRAVITY_RELEASE_PROFILE.supportsTarget(target))
    throw new RuntimeReleaseDiscoveryError('Unsupported Antigravity target')
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(dependencies.timeoutMs ?? 10_000)])
  const maxBytes = dependencies.maxResponseBytes ?? 64 * 1024
  const response = await (dependencies.fetch ?? fetch)(ANTIGRAVITY_RELEASE_METADATA_URL, {
    signal: combined,
    redirect: 'manual',
  })
  if (
    !response.ok ||
    response.redirected ||
    !response.body ||
    Number(response.headers.get('content-length')) > maxBytes
  ) {
    await response.body?.cancel()
    throw new RuntimeReleaseDiscoveryError('Invalid Antigravity release metadata response')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      combined.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new RuntimeReleaseDiscoveryError('Antigravity release metadata exceeds size limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const metadata: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!isRecord(metadata) || metadata.id !== 'antigravity-acp' || !isStableRuntimeVersion(metadata.version))
    throw new RuntimeReleaseDiscoveryError('Invalid Antigravity release identity or version')
  const binary =
    isRecord(metadata.distribution) && isRecord(metadata.distribution.binary) ? metadata.distribution.binary : null
  for (const [id, [key]] of Object.entries(ANTIGRAVITY_TARGETS)) {
    const entry = binary?.[key]
    const expectedArgs = id.startsWith('linux-') ? ['--uid='] : []
    if (
      !isRecord(entry) ||
      entry.archive !== antigravityArtifactUrl(metadata.version, id as RuntimeTargetId) ||
      entry.cmd !== (id.startsWith('win-') ? './agy_acp_server.exe' : './agy_acp_server.par') ||
      JSON.stringify(entry.args ?? []) !== JSON.stringify(expectedArgs)
    )
      throw new RuntimeReleaseDiscoveryError(`Invalid Antigravity ${key} distribution`)
  }
  const embedded = RUNTIME_ASSET_REGISTRY['antigravity-acp-runtime']
  if (metadata.version === embedded.version) return embedded
  return Object.freeze({
    id: 'antigravity-acp-runtime',
    version: metadata.version,
    targets: Object.freeze({
      [target]: createAntigravityTarget(target, metadata.version, {
        googleIntegrity: { pending: true },
        downloadBytes: embedded.targets[target]?.downloadBytes ?? ANTIGRAVITY_MAX_DOWNLOAD_BYTES,
        maxDownloadBytes: ANTIGRAVITY_MAX_DOWNLOAD_BYTES,
        unpackedBytes: ANTIGRAVITY_MAX_UNPACKED_BYTES,
      }),
    }),
  })
}
