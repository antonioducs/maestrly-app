import type { RuntimeAssetId } from '../../shared/runtime-assets'
import localMlManifest from '../../../runtime-assets/local-ml/manifest.json'
import { NPM_REGISTRY_ORIGIN } from './npm-registry'
import type { RuntimeArtifactMetadata } from './release-profile'

export type RuntimeTargetId = 'mac-arm64' | 'mac-x64' | 'linux-arm64' | 'linux-x64' | 'win-arm64' | 'win-x64'
export type ArchiveFormat = 'tar.gz' | 'zip' | 'file'

/** Pending Google artifacts have HTTPS provenance, not a publisher signature or an accepted digest. */
export type RuntimeArtifactHash =
  | Readonly<{ algorithm: 'sha256' | 'sha512'; digest: string; encoding: 'hex' | 'base64'; provenance?: never }>
  | Readonly<{ algorithm: 'sha256'; encoding: 'hex'; provenance: 'google-origin-pending'; digest?: never }>

export interface RuntimeAssetTarget {
  readonly id: RuntimeTargetId
  readonly url: string
  readonly archive: ArchiveFormat
  readonly hash: RuntimeArtifactHash
  /** Estimated compressed archive size, used for download progress when Content-Length is unavailable. */
  readonly downloadBytes: number
  /** Maximum compressed archive size accepted by the downloader and reserved by the disk preflight. */
  readonly maxDownloadBytes: number
  /** Expected size of the extracted installation tree. */
  readonly unpackedBytes: number
  readonly stripPrefix?: string
  /** Installed name of a single-file download; required for, and only used by, archive 'file'. */
  readonly fileName?: string
  readonly criticalPaths: readonly string[]
  /** Executable used by the release smoke after the service verifies the extracted layout. */
  readonly executablePath?: string
}

export interface RuntimeAssetDefinition {
  readonly id: RuntimeAssetId
  readonly version: string
  readonly targets: Readonly<Partial<Record<RuntimeTargetId, RuntimeAssetTarget>>>
}

const TARGET_IDS = ['mac-arm64', 'mac-x64', 'linux-arm64', 'linux-x64', 'win-arm64', 'win-x64'] as const
const codex = [
  [
    'mac-arm64',
    'darwin-arm64',
    'aarch64-apple-darwin',
    'cYxzGcRRoBrncyHlR8ed4yXwcoVJZC1pipGULSyJkGFKXJw/Uu57BklvzayuAptjJIipamnOk32CfUkk1F0bLw==',
  ],
  [
    'mac-x64',
    'darwin-x64',
    'x86_64-apple-darwin',
    'FDpc+PdELYlyDnhd76Ckm6jNLF+1n3x34Ygd4QLQger810Vkxx/InQ5LY5jwkecJYKcbvyhMmuxTspaj1dLZrA==',
  ],
  [
    'linux-arm64',
    'linux-arm64',
    'aarch64-unknown-linux-musl',
    'X3fRXm2orhJ3KeB8LgKym4XDUiQaqaOGuaa181bcHTsQI7C8m6tcQQbQsKDzT/2IibikzgYL82jvsgMbq43jww==',
  ],
  [
    'linux-x64',
    'linux-x64',
    'x86_64-unknown-linux-musl',
    'atv3HF0mubqB0J/XkQ2JopqKzXJ+/7aQtTB2MkJ9MrraujMIz8zbCCLylLkN3PzpVGTJzzQFN/wD1oq8oJPJKg==',
  ],
  [
    'win-arm64',
    'win32-arm64',
    'aarch64-pc-windows-msvc',
    'k5x8VO1aF8Xx/nuh1P31TeBgs11WA6i2GJiHqx5YCndFbWzOzUz6aeBaq9+PO6Qfe/Ivennh3I1FKJBU6Q8mpg==',
  ],
  [
    'win-x64',
    'win32-x64',
    'x86_64-pc-windows-msvc',
    'MO+cCZrgU0Ec7lJP/5NsTe5obJ9/qtRMkQUK0jYWTY1omxLA3lp5IOD2IAmsejlEJB931XRo51LZ7hl178CDjA==',
  ],
] as const
const copilot = [
  [
    'mac-arm64',
    'darwin-arm64',
    'mEWzyqbqRAWgyU7i2uuSRoVPx/TwaFQX0nZmw0bc30aJ0BnO7cy2kYQyCHw8ykmf/tfxT0xauZ6k0BOFmWizzQ==',
  ],
  ['mac-x64', 'darwin-x64', 'Md9yEg406OBVBx3w4PeEj62TubulVLBcHleqmCoOoUmPgUxPZotUbrqz3rtbzADbXfrrD7JWvVsbd2UiNL194w=='],
  [
    'linux-arm64',
    'linux-arm64',
    'ykLJYOqBj3jRB5IJCDugLClAqbr7DmtTbUjlNY7+Jdq/n6i+d7xUQGclf1IWL5gnxbGQVAf+zkToD+sRM389Kg==',
  ],
  [
    'linux-x64',
    'linux-x64',
    'pC0FNHG+BBwZd6yZlM85kkAGN+uJhM6o+THi76N2GnnSxmw7+remb1mvYxdgRVbdCm+LBUIbCKRWJLuMwrfb6A==',
  ],
  [
    'win-arm64',
    'win32-arm64',
    '+HI1DokixXhHUahj06Fw67ZAigBuXKC58BFma4UJOGrQsDgwOSbqeTQHCw6vuymzjKlg3sactfsCUTaefkjscQ==',
  ],
  ['win-x64', 'win32-x64', '02kXOBd9CwBbCaztuf71WYWn+uGapCuiaasomN4tcMH3HBVZ4gi3J0ZUoRcgcS80xh81uQyeBHbnUKzb/RE/9A=='],
] as const
const tunnel = [
  ['mac-arm64', 'darwin-arm64', '288accc7fd20cfee1d495adb933773af9e19ebc0cdef3173f7fb544afa5065b2'],
  ['mac-x64', 'darwin-amd64', '1a48616e584484f8bef4c1128d515ac96cf44d0d9609c1462abccc1793f4b847'],
  ['linux-arm64', 'linux-arm64', 'b842a9b2352eebd80514cf01a1fbb1c0d400a7d24a4015e85a7ea5f1aeaa5b30'],
  ['linux-x64', 'linux-amd64', 'b9e0388a343f2d7adeff3992f411a0bd3d916a64bc56534aac5fd15ac1b20cd5'],
  ['win-arm64', 'windows-arm64', '08954ccda078abfeac9382f9b19d178ce0656cfe1e84f5941f0f8a5c4e91ea78'],
  ['win-x64', 'windows-amd64', '5e64a056f1d96786da0a6f8db1da5f5f4a03fd19a90d951a25cf2ca8d9093d00'],
] as const

function targetRecord(rows: readonly (readonly string[])[], make: (row: readonly string[]) => RuntimeAssetTarget) {
  return Object.freeze(Object.fromEntries(rows.map((row) => [row[0], Object.freeze(make(row))])))
}

/** Measured size of each pinned tarball; the archives are immutable, so these are exact. */
const codexArchiveBytes: Readonly<Record<RuntimeTargetId, number>> = {
  'mac-arm64': 127_465_533,
  'mac-x64': 135_811_357,
  'linux-arm64': 135_126_766,
  'linux-x64': 142_140_011,
  'win-arm64': 135_509_012,
  'win-x64': 145_165_338,
}
/** npm dist.unpackedSize; includes the tiny package envelope, so disk preflight remains conservative. */
const codexUnpackedBytes: Readonly<Record<RuntimeTargetId, number>> = {
  'mac-arm64': 317_014_114,
  'mac-x64': 337_809_946,
  'linux-arm64': 327_523_648,
  'linux-x64': 370_485_590,
  'win-arm64': 351_334_049,
  'win-x64': 407_521_436,
}
const copilotArchiveBytes: Readonly<Record<RuntimeTargetId, number>> = {
  'mac-arm64': 130_336_069,
  'mac-x64': 146_101_321,
  'linux-arm64': 147_266_596,
  'linux-x64': 142_982_140,
  'win-arm64': 131_060_040,
  'win-x64': 130_154_451,
}
/** Small headroom over the measured size so a byte-exact archive never trips the guard. */
function downloadCap(bytes: number): number {
  return Math.ceil((bytes * 1.05) / 1_000_000) * 1_000_000
}

/** Official npm platform alias suffix and native target triple of each Codex runtime target. */
export const CODEX_TARGET_LAYOUT: Readonly<
  Record<RuntimeTargetId, { readonly suffix: string; readonly triple: string }>
> = Object.freeze(
  Object.fromEntries(codex.map(([id, suffix, triple]) => [id, Object.freeze({ suffix, triple })])) as Record<
    RuntimeTargetId,
    { suffix: string; triple: string }
  >
)

export const CODEX_NPM_REGISTRY_ORIGIN = NPM_REGISTRY_ORIGIN

/** Canonical tarball URL of one official Codex platform artifact; dynamic releases must match it exactly. */
export function codexArtifactUrl(version: string, id: RuntimeTargetId): string {
  return `${CODEX_NPM_REGISTRY_ORIGIN}/@openai/codex/-/codex-${version}-${CODEX_TARGET_LAYOUT[id].suffix}.tgz`
}

/**
 * Build one Codex target from verified metadata. The embedded pin and dynamically discovered releases share this
 * layout so both install through the same extraction, critical-path, and executable contract.
 */
export function createCodexTarget(
  id: RuntimeTargetId,
  version: string,
  metadata: RuntimeArtifactMetadata
): RuntimeAssetTarget {
  if (!metadata.sha512Base64) throw new Error('Missing npm SHA-512 integrity')
  const executable = `bin/${id.startsWith('win-') ? 'codex.exe' : 'codex'}`
  return Object.freeze({
    id,
    url: codexArtifactUrl(version, id),
    archive: 'tar.gz' as const,
    hash: Object.freeze({ algorithm: 'sha512' as const, digest: metadata.sha512Base64, encoding: 'base64' as const }),
    downloadBytes: metadata.downloadBytes,
    maxDownloadBytes: metadata.maxDownloadBytes,
    unpackedBytes: metadata.unpackedBytes,
    stripPrefix: `package/vendor/${CODEX_TARGET_LAYOUT[id].triple}`,
    criticalPaths: Object.freeze([executable, 'codex-package.json']),
    executablePath: executable,
  })
}

const CODEX_PINNED_VERSION = '0.155.1'
const codexTargets = targetRecord(codex, ([id, , , digest]) =>
  createCodexTarget(id as RuntimeTargetId, CODEX_PINNED_VERSION, {
    sha512Base64: digest,
    downloadBytes: codexArchiveBytes[id as RuntimeTargetId],
    maxDownloadBytes: downloadCap(codexArchiveBytes[id as RuntimeTargetId]),
    unpackedBytes: codexUnpackedBytes[id as RuntimeTargetId],
  })
)
/**
 * Claude Code the installed Agent SDK bundles (its package.json `claudeCodeVersion`): the version a bot image ships,
 * and the minimum a bot's managed installation may run. Managed only on the Linux targets bots run on.
 */
export const CLAUDE_CODE_PINNED_VERSION = '2.1.285'
export type ClaudeCodeTargetId = 'linux-arm64' | 'linux-x64'
export const CLAUDE_CODE_TARGET_LAYOUT: Readonly<Record<ClaudeCodeTargetId, { readonly suffix: string }>> =
  Object.freeze({
    'linux-arm64': Object.freeze({ suffix: 'linux-arm64' }),
    'linux-x64': Object.freeze({ suffix: 'linux-x64' }),
  })

export function isClaudeCodeTarget(id: RuntimeTargetId): id is ClaudeCodeTargetId {
  return Object.hasOwn(CLAUDE_CODE_TARGET_LAYOUT, id)
}

/** Canonical tarball URL of one official Claude Code platform package; dynamic releases must match it exactly. */
export function claudeCodeArtifactUrl(version: string, id: ClaudeCodeTargetId): string {
  const { suffix } = CLAUDE_CODE_TARGET_LAYOUT[id]
  return `${NPM_REGISTRY_ORIGIN}/@anthropic-ai/claude-code-${suffix}/-/claude-code-${suffix}-${version}.tgz`
}

/** One Claude Code target: the package holds the native `claude` binary next to its package.json. */
export function createClaudeCodeTarget(
  id: ClaudeCodeTargetId,
  version: string,
  metadata: RuntimeArtifactMetadata
): RuntimeAssetTarget {
  if (!metadata.sha512Base64) throw new Error('Missing npm SHA-512 integrity')
  return Object.freeze({
    id,
    url: claudeCodeArtifactUrl(version, id),
    archive: 'tar.gz' as const,
    hash: Object.freeze({ algorithm: 'sha512' as const, digest: metadata.sha512Base64, encoding: 'base64' as const }),
    downloadBytes: metadata.downloadBytes,
    maxDownloadBytes: metadata.maxDownloadBytes,
    unpackedBytes: metadata.unpackedBytes,
    stripPrefix: 'package',
    criticalPaths: Object.freeze(['claude', 'package.json']),
    executablePath: 'claude',
  })
}

/** npm metadata of the pinned `@anthropic-ai/claude-code-<platform>` packages; archive sizes measured. */
const claudeCodePins: Readonly<Record<ClaudeCodeTargetId, RuntimeArtifactMetadata>> = {
  'linux-arm64': {
    sha512Base64: 'vAvIr+MVnm5IrSq8KoJrZkoG3BFpLvVEqfrx15w7hWW+gcSYHPvN33lfkzXvs5L8MYXxNW0Ae86MLiCH+x4ldQ==',
    downloadBytes: 107_804_240,
    maxDownloadBytes: downloadCap(107_804_240),
    unpackedBytes: 239_723_082,
  },
  'linux-x64': {
    sha512Base64: '6qNST8qKemr+rD9zvUEwEq0UtWt0E5Js8bkbjh13/LM62FiGWcN6IqiJPxybJ2FNd+I3liXq6JYNv/vrGnmAow==',
    downloadBytes: 107_536_804,
    maxDownloadBytes: downloadCap(107_536_804),
    unpackedBytes: 240_328_450,
  },
}
const claudeCodeTargets = Object.freeze(
  Object.fromEntries(
    (Object.keys(claudeCodePins) as ClaudeCodeTargetId[]).map((id) => [
      id,
      createClaudeCodeTarget(id, CLAUDE_CODE_PINNED_VERSION, claudeCodePins[id]),
    ])
  ) as Partial<Record<RuntimeTargetId, RuntimeAssetTarget>>
)

const copilotTargets = targetRecord(copilot, ([id, suffix, digest]) => ({
  id: id as RuntimeTargetId,
  url: `https://registry.npmjs.org/@github/copilot-${suffix}/-/copilot-${suffix}-1.0.71.tgz`,
  archive: 'tar.gz',
  hash: { algorithm: 'sha512', digest, encoding: 'base64' },
  downloadBytes: copilotArchiveBytes[id as RuntimeTargetId],
  maxDownloadBytes: downloadCap(copilotArchiveBytes[id as RuntimeTargetId]),
  // Measured on mac-arm64: 130.3 MB archive -> 277.5 MB extracted (~2.15x).
  unpackedBytes: Math.round(copilotArchiveBytes[id as RuntimeTargetId] * 2.15),
  stripPrefix: 'package',
  criticalPaths: [id.startsWith('win-') ? 'copilot.exe' : 'copilot', 'package.json', 'LICENSE.md'],
  executablePath: id.startsWith('win-') ? 'copilot.exe' : 'copilot',
}))
const tunnelTargets = targetRecord(tunnel, ([id, asset, digest]) => ({
  id: id as RuntimeTargetId,
  url: `https://persistent.oaistatic.com/tunnel-client/v0.0.10/tunnel-client-v0.0.10-${asset}.zip`,
  archive: 'zip',
  hash: { algorithm: 'sha256', digest, encoding: 'hex' },
  downloadBytes: 20_000_000,
  maxDownloadBytes: 20_000_000,
  unpackedBytes: 20_000_000,
  criticalPaths: [id.startsWith('win-') ? 'tunnel-client.exe' : 'tunnel-client'],
  executablePath: id.startsWith('win-') ? 'tunnel-client.exe' : 'tunnel-client',
}))
const localMlTargets = Object.freeze(
  Object.fromEntries(
    Object.entries(localMlManifest.targets).map(([id, target]) => [
      id,
      Object.freeze({
        id: id as RuntimeTargetId,
        url: `bundled:local-ml-runtime-${localMlManifest.version}-${id}.tar.gz`,
        archive: 'tar.gz' as const,
        hash: { algorithm: 'sha256' as const, digest: target.sha256, encoding: 'hex' as const },
        downloadBytes: target.archiveBytes,
        maxDownloadBytes: target.archiveBytes,
        unpackedBytes: target.unpackedBytes,
        criticalPaths: Object.freeze(target.criticalPaths),
      }),
    ])
  ) as Partial<Record<RuntimeTargetId, RuntimeAssetTarget>>
)

export const ANTIGRAVITY_ACP_VERSION = '1.2.1'
/**
 * Google publishes no checksums for these archives: the digests and sizes below were measured on 2026-09-30
 * and must be re-measured when this reference version changes. Independent updates record their own accepted digest.
 */
const antigravityAcp = [
  ['mac-arm64', 'macos', 'darwin-arm64', '0fab9938812e6b32b3b543e65e4f3a0025ceef755413db13542d9a9b81ea803c'],
  ['mac-x64', 'macos', 'darwin-x86_64', 'd09bf99bdea7b82021e1afcff829da35e4aa583d8f0984ef364dc3a7c064e07e'],
  ['linux-arm64', 'linux', 'linux-arm64', '7e7ef4088bc185e1af4204029e0f4ec4210af20724f3ff262186ac0bcea6aa0e'],
  ['linux-x64', 'linux', 'linux-x86_64', '9fbf0bd584a26478161f637cabd75113f72541c842d148f578ef1a6a9edcb843'],
  ['win-arm64', 'windows', 'windows-arm64', '21db37ae246284053212f2670e05c4de8d6ee9488b000bf304e1fe4ea191f7b8'],
  ['win-x64', 'windows', 'windows-x86_64', '9b82493819bc14613baa76264d55ad307ddd8ab4a8d6e110edb32da35498c07b'],
] as const
const antigravityAcpArchiveBytes: Readonly<Record<RuntimeTargetId, number>> = {
  'mac-arm64': 111_725_488,
  'mac-x64': 117_493_869,
  'linux-arm64': 321_280_184,
  'linux-x64': 333_590_110,
  'win-arm64': 124_945_935,
  'win-x64': 124_869_770,
}
/** Sum of the two extracted executables, measured from each pinned archive. */
const antigravityAcpUnpackedBytes: Readonly<Record<RuntimeTargetId, number>> = {
  'mac-arm64': 397_584_640,
  'mac-x64': 407_317_424,
  'linux-arm64': 1_046_993_459,
  'linux-x64': 1_052_767_112,
  'win-arm64': 222_828_616,
  'win-x64': 228_295_160,
}
const antigravityAcpTargets = targetRecord(antigravityAcp, ([id, os, suffix, digest]) => {
  const target = id as RuntimeTargetId
  const windows = target.startsWith('win-')
  const server = windows ? 'agy_acp_server.exe' : 'agy_acp_server.par'
  return {
    id: target,
    url: `https://dl.google.com/agy-extensions/releases/${os}/agy-acp-server-${ANTIGRAVITY_ACP_VERSION}-${suffix}.zip`,
    archive: 'zip',
    hash: { algorithm: 'sha256', digest, encoding: 'hex' },
    downloadBytes: antigravityAcpArchiveBytes[target],
    maxDownloadBytes: downloadCap(antigravityAcpArchiveBytes[target]),
    unpackedBytes: antigravityAcpUnpackedBytes[target],
    criticalPaths: [server, windows ? 'localharness_external.exe' : 'localharness_external'],
    executablePath: server,
  }
})

/** whisper.cpp speech model file, pinned to an immutable Hugging Face revision and installed as one file. */
export const WHISPER_MODEL_FILE = 'ggml-large-v3-turbo-q5_0.bin'
const WHISPER_MODEL_BYTES = 574_041_195
const whisperModelTargets = Object.freeze(
  Object.fromEntries(
    Object.keys(localMlManifest.targets).map((id) => [
      id,
      Object.freeze({
        id: id as RuntimeTargetId,
        url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/${WHISPER_MODEL_FILE}`,
        archive: 'file' as const,
        fileName: WHISPER_MODEL_FILE,
        hash: {
          algorithm: 'sha256' as const,
          digest: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
          encoding: 'hex' as const,
        },
        downloadBytes: WHISPER_MODEL_BYTES,
        maxDownloadBytes: WHISPER_MODEL_BYTES,
        unpackedBytes: WHISPER_MODEL_BYTES,
        criticalPaths: Object.freeze([WHISPER_MODEL_FILE]),
      }),
    ])
  ) as Partial<Record<RuntimeTargetId, RuntimeAssetTarget>>
)

export const RUNTIME_ASSET_REGISTRY: Readonly<Record<RuntimeAssetId, RuntimeAssetDefinition>> = Object.freeze({
  'codex-runtime': Object.freeze({ id: 'codex-runtime', version: CODEX_PINNED_VERSION, targets: codexTargets }),
  'claude-code-runtime': Object.freeze({
    id: 'claude-code-runtime',
    version: CLAUDE_CODE_PINNED_VERSION,
    targets: claudeCodeTargets,
  }),
  'github-copilot-runtime': Object.freeze({ id: 'github-copilot-runtime', version: '1.0.71', targets: copilotTargets }),
  'tunnel-client': Object.freeze({ id: 'tunnel-client', version: '0.0.10', targets: tunnelTargets }),
  'local-ml-runtime': Object.freeze({
    id: 'local-ml-runtime',
    version: localMlManifest.version,
    targets: localMlTargets,
  }),
  'whisper-model': Object.freeze({ id: 'whisper-model', version: 'large-v3-turbo-q5', targets: whisperModelTargets }),
  'antigravity-acp-runtime': Object.freeze({
    id: 'antigravity-acp-runtime',
    version: ANTIGRAVITY_ACP_VERSION,
    targets: antigravityAcpTargets,
  }),
})

export function hostRuntimeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): RuntimeTargetId {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform === 'linux' ? 'linux' : null
  if (!os || (arch !== 'arm64' && arch !== 'x64')) throw new Error(`Unsupported runtime target: ${platform}-${arch}`)
  return `${os}-${arch}` as RuntimeTargetId
}

export { TARGET_IDS as RUNTIME_TARGET_IDS }
