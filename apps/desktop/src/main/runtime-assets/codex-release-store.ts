import {
  CODEX_MAX_DOWNLOAD_BYTES,
  CODEX_MAX_UNPACKED_BYTES,
  compareStableVersions,
  isStableRuntimeVersion,
} from './codex-releases'
import {
  CODEX_TARGET_LAYOUT,
  codexArtifactUrl,
  createCodexTarget,
  type RuntimeAssetDefinition,
  type RuntimeTargetId,
} from './registry'

/**
 * Persisted state of independently installed Codex releases. Accepted records carry the verified npm metadata of
 * each installed version so status, repair, rollback, and lease verification work offline after a restart. The
 * embedded registry remains authoritative for its own version and is the minimum version accepted for use.
 */

export const CODEX_RELEASE_STORE_KEY = 'runtimeAssets.codexReleases'

export interface CodexReleaseStorage {
  read(): string | null
  write(value: string): void
}

export type CodexRejectionReason = 'failed' | 'rollback'

interface StoredArtifact {
  readonly url: string
  readonly sha512: string
  readonly downloadBytes: number
  readonly maxDownloadBytes: number
  readonly unpackedBytes: number
}

interface StoredRelease {
  readonly version: string
  readonly target: RuntimeTargetId
  readonly artifact: StoredArtifact
  readonly acceptedAt: string
  readonly compatibilityRevision: number
}

interface StoredCandidate {
  readonly version: string
  readonly target: RuntimeTargetId
  readonly artifact: StoredArtifact
}

interface StoredRejection {
  readonly version: string
  readonly reason: CodexRejectionReason
  readonly at: string
}

interface StoredState {
  readonly schema: 1
  readonly automatic: boolean
  readonly lastCheckedAt?: string
  readonly candidate?: StoredCandidate
  readonly accepted: readonly StoredRelease[]
  readonly rejected?: StoredRejection
}

export interface AcceptedCodexRelease {
  readonly definition: RuntimeAssetDefinition
  readonly compatibilityRevision: number
  readonly acceptedAt: string
}

export class CodexReleaseMetadataUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Codex release metadata is temporarily unavailable', options)
    this.name = 'CodexReleaseMetadataUnavailableError'
  }
}

const EMPTY_STATE: StoredState = Object.freeze({ schema: 1, automatic: false, accepted: Object.freeze([]) })
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

function isTarget(value: unknown): value is RuntimeTargetId {
  return typeof value === 'string' && Object.hasOwn(CODEX_TARGET_LAYOUT, value)
}

function parseArtifact(value: unknown, version: string, target: RuntimeTargetId): StoredArtifact | null {
  if (!isRecord(value)) return null
  const { url, sha512, downloadBytes, maxDownloadBytes, unpackedBytes } = value
  if (url !== codexArtifactUrl(version, target)) return null
  if (typeof sha512 !== 'string' || !SHA512_BASE64.test(sha512)) return null
  for (const size of [downloadBytes, maxDownloadBytes, unpackedBytes]) {
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null
  }
  if ((maxDownloadBytes as number) > CODEX_MAX_DOWNLOAD_BYTES) return null
  if ((downloadBytes as number) > (maxDownloadBytes as number)) return null
  if ((unpackedBytes as number) > CODEX_MAX_UNPACKED_BYTES) return null
  return {
    url,
    sha512,
    downloadBytes: downloadBytes as number,
    maxDownloadBytes: maxDownloadBytes as number,
    unpackedBytes: unpackedBytes as number,
  }
}

function parseVersioned(value: unknown): { version: string; target: RuntimeTargetId; artifact: StoredArtifact } | null {
  if (!isRecord(value) || !isStableRuntimeVersion(value.version) || !isTarget(value.target)) return null
  const artifact = parseArtifact(value.artifact, value.version, value.target)
  return artifact ? { version: value.version, target: value.target, artifact } : null
}

/** Revalidate every field on load: a damaged or hand-edited entry is dropped instead of trusted. */
function parseState(raw: string | null): StoredState {
  if (!raw) return EMPTY_STATE
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_STATE
  }
  if (!isRecord(parsed) || parsed.schema !== 1) return EMPTY_STATE
  const accepted: StoredRelease[] = []
  for (const entry of Array.isArray(parsed.accepted) ? parsed.accepted : []) {
    const versioned = parseVersioned(entry)
    if (!versioned || !isRecord(entry) || !isTimestamp(entry.acceptedAt)) continue
    const revision = entry.compatibilityRevision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) continue
    if (accepted.some((item) => item.version === versioned.version && item.target === versioned.target)) continue
    accepted.push({ ...versioned, acceptedAt: entry.acceptedAt, compatibilityRevision: revision })
  }
  const candidate = parseVersioned(parsed.candidate) ?? undefined
  const rawRejected = isRecord(parsed.rejected) ? parsed.rejected : null
  const reason = rawRejected?.reason
  const rejected: StoredRejection | undefined =
    rawRejected &&
    isStableRuntimeVersion(rawRejected.version) &&
    (reason === 'failed' || reason === 'rollback') &&
    isTimestamp(rawRejected.at)
      ? { version: rawRejected.version, reason, at: rawRejected.at }
      : undefined
  return {
    schema: 1,
    automatic: parsed.automatic === true,
    ...(isTimestamp(parsed.lastCheckedAt) ? { lastCheckedAt: parsed.lastCheckedAt } : {}),
    ...(candidate ? { candidate } : {}),
    accepted,
    ...(rejected ? { rejected } : {}),
  }
}

function toArtifact(definition: RuntimeAssetDefinition, target: RuntimeTargetId): StoredArtifact {
  const entry = definition.targets[target]
  if (!entry || definition.id !== 'codex-runtime' || !isStableRuntimeVersion(definition.version)) {
    throw new Error(`Codex ${definition.version} has no ${target} artifact`)
  }
  const artifact = parseArtifact(
    {
      url: entry.url,
      sha512: entry.hash.algorithm === 'sha512' && entry.hash.encoding === 'base64' ? entry.hash.digest : '',
      downloadBytes: entry.downloadBytes,
      maxDownloadBytes: entry.maxDownloadBytes,
      unpackedBytes: entry.unpackedBytes,
    },
    definition.version,
    target
  )
  if (!artifact) throw new Error(`Codex ${definition.version} metadata is not an official ${target} artifact`)
  return artifact
}

function toDefinition(version: string, target: RuntimeTargetId, artifact: StoredArtifact): RuntimeAssetDefinition {
  return Object.freeze({
    id: 'codex-runtime' as const,
    version,
    targets: Object.freeze({
      [target]: createCodexTarget(target, version, {
        sha512Base64: artifact.sha512,
        downloadBytes: artifact.downloadBytes,
        maxDownloadBytes: artifact.maxDownloadBytes,
        unpackedBytes: artifact.unpackedBytes,
      }),
    }),
  })
}

export interface CodexReleaseStoreOptions {
  readonly storage: CodexReleaseStorage
  readonly target: RuntimeTargetId
  /** Embedded registry entry: authoritative for its version and the oldest version accepted for use. */
  readonly embedded: RuntimeAssetDefinition
  readonly now?: () => Date
}

export class CodexReleaseStore {
  private readonly storage: CodexReleaseStorage
  private readonly target: RuntimeTargetId
  private readonly embedded: RuntimeAssetDefinition
  private readonly now: () => Date
  private state: StoredState | null = null

  constructor(options: CodexReleaseStoreOptions) {
    this.storage = options.storage
    this.target = options.target
    this.embedded = options.embedded
    this.now = options.now ?? (() => new Date())
  }

  /** Load lazily and never cache a read failure, so a transient storage error is retried on the next call. */
  private load(): StoredState {
    if (this.state) return this.state
    let raw: string | null
    try {
      raw = this.storage.read()
    } catch (error) {
      throw new CodexReleaseMetadataUnavailableError({ cause: error })
    }
    this.state = parseState(raw)
    return this.state
  }

  /** Persist before updating memory: callers rely on a throw meaning nothing changed. */
  private save(next: StoredState): void {
    this.storage.write(JSON.stringify(next))
    this.state = next
  }

  get automatic(): boolean {
    return this.load().automatic
  }

  get lastCheckedAt(): string | undefined {
    return this.load().lastCheckedAt
  }

  get embeddedVersion(): string {
    return this.embedded.version
  }

  setAutomatic(enabled: boolean): void {
    this.save({ ...this.load(), automatic: enabled })
  }

  /** Record the latest discovered stable release; it is metadata only and never changes the active version. */
  recordCheck(latest: RuntimeAssetDefinition): void {
    const state = this.load()
    this.save({
      ...state,
      lastCheckedAt: this.now().toISOString(),
      candidate: { version: latest.version, target: this.target, artifact: toArtifact(latest, this.target) },
    })
  }

  candidate(): RuntimeAssetDefinition | null {
    const candidate = this.load().candidate
    if (!candidate || candidate.target !== this.target) return null
    return toDefinition(candidate.version, candidate.target, candidate.artifact)
  }

  /** Accept verified metadata for activation. Must be persisted before the active pointer moves to the version. */
  accept(definition: RuntimeAssetDefinition, compatibilityRevision: number): void {
    if (definition.version === this.embedded.version) return
    const artifact = toArtifact(definition, this.target)
    const state = this.load()
    const accepted = state.accepted.filter(
      (item) => !(item.version === definition.version && item.target === this.target)
    )
    accepted.push({
      version: definition.version,
      target: this.target,
      artifact,
      acceptedAt: this.now().toISOString(),
      compatibilityRevision,
    })
    this.save({ ...state, accepted })
  }

  acceptedRelease(version: string): AcceptedCodexRelease | null {
    if (version === this.embedded.version) return null
    const order = compareStableVersions(version, this.embedded.version)
    // The embedded pin is the minimum: a build never runs a Codex older than the one it was tested with.
    if (order === null || order < 0) return null
    const record = this.load().accepted.find((item) => item.version === version && item.target === this.target)
    if (!record) return null
    return {
      definition: toDefinition(record.version, record.target, record.artifact),
      compatibilityRevision: record.compatibilityRevision,
      acceptedAt: record.acceptedAt,
    }
  }

  acceptedDefinition(version: string): RuntimeAssetDefinition | null {
    return this.acceptedRelease(version)?.definition ?? null
  }

  markValidated(version: string, compatibilityRevision: number): void {
    const state = this.load()
    if (!state.accepted.some((item) => item.version === version && item.target === this.target)) return
    this.save({
      ...state,
      accepted: state.accepted.map((item) =>
        item.version === version && item.target === this.target ? { ...item, compatibilityRevision } : item
      ),
    })
  }

  rejected(): { readonly version: string; readonly reason: CodexRejectionReason } | null {
    const rejected = this.load().rejected
    return rejected ? { version: rejected.version, reason: rejected.reason } : null
  }

  reject(version: string, reason: CodexRejectionReason): void {
    this.save({ ...this.load(), rejected: { version, reason, at: this.now().toISOString() } })
  }

  clearRejection(version?: string): void {
    const state = this.load()
    if (!state.rejected || (version && state.rejected.version !== version)) return
    const { rejected: _rejected, ...rest } = state
    this.save(rest)
  }

  /** Keep only versions still installed, leased, or in flight; other accepted metadata has no remaining use. */
  prune(keepVersions: Iterable<string>): void {
    const keep = new Set(keepVersions)
    const state = this.load()
    const accepted = state.accepted.filter((item) => item.target === this.target && keep.has(item.version))
    if (accepted.length === state.accepted.length) return
    this.save({ ...state, accepted })
  }
}
