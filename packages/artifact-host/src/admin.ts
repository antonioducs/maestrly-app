import { contentTypeFor, isTextPath, normalizeBundlePath, validateBundle } from './bundle-paths.js'
import { applyEdits } from './edits.js'
import { ArtifactHostError } from './errors.js'
import { digest, isArtifactId, newArtifactId, newSecretToken } from './ids.js'
import { MAX_THUMBNAIL_BYTES, MAX_VERSIONS_PER_ARTIFACT, OWNER_TICKET_TTL_MS } from './limits.js'
import {
  type ArtifactDetail,
  type ArtifactFileInfo,
  type ArtifactListFilter,
  type ArtifactSummary,
  artifactListFilter,
  type BundleFile,
  type CreateArtifactInput,
  createArtifactInput,
  type HostStatusInfo,
  parseInput,
  type ThumbnailImage,
  type UpdateArtifactInput,
  updateArtifactInput,
} from './schemas.js'
import { createSharingAdmin, type SharingAdmin } from './sharing-admin.js'
import type { ArtifactStore, FileRecord } from './store/artifact-store.js'
import { BlobStore } from './store/blobs.js'
import { type ArtifactEventKind, SharingStore } from './store/sharing-store.js'

/** The owner's interface to a host: used in-process, or across a process boundary through `rpc.ts`. */
export interface ArtifactAdmin extends SharingAdmin {
  status(): Promise<HostStatusInfo>
  create(input: CreateArtifactInput): Promise<ArtifactDetail>
  update(input: UpdateArtifactInput): Promise<ArtifactDetail>
  get(id: string): Promise<ArtifactDetail | null>
  list(filter?: ArtifactListFilter): Promise<ArtifactSummary[]>
  listFiles(id: string, version?: number): Promise<ArtifactFileInfo[]>
  readFile(id: string, version: number, path: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
  delete(id: string): Promise<boolean>
  /** Stores the preview image of a version (PNG, JPEG or WebP), replacing an earlier one. */
  setThumbnail(id: string, version: number, image: Uint8Array): Promise<void>
  /** The preview of the newest version up to `version` (the current one by default) that has one. */
  getThumbnail(id: string, version?: number): Promise<ThumbnailImage | null>
  mintOwnerTicket(id: string): Promise<{ ticket: string; expiresAt: number }>
  snapshot(targetFile: string): Promise<void>
}

export interface ArtifactAdminDeps {
  store: ArtifactStore
  blobs: BlobStore
  clock: () => number
  quotaBytes: number
  maxVersions?: number
  onChange?: (artifactId: string) => void
  /** People, requests and events; opened on the store's database when not given. */
  sharing?: SharingStore
  /** Called for every event recorded for the owner, such as a new device or an access request. */
  onActivity?: (artifactId: string, kind: ArtifactEventKind) => void
}

const notFound = () => new ArtifactHostError('not_found', 'Artifact not found')

/** Recognizes the image formats a thumbnail may use from their signatures, never from a declared type. */
export function thumbnailContentType(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes.byteLength >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

export function createArtifactAdmin(deps: ArtifactAdminDeps): ArtifactAdmin {
  const { store, blobs, clock } = deps
  const maxVersions = deps.maxVersions ?? MAX_VERSIONS_PER_ARTIFACT
  const sharing = deps.sharing ?? new SharingStore(store.db)

  // Writes run one at a time, so deleting unreferenced blobs never races a version that is about to reference them.
  let queue: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  const detail = (id: string): ArtifactDetail | null => {
    sharing.expireRequests(clock())
    const artifact = store.getArtifact(id)
    if (!artifact) return null
    return {
      ...artifact,
      versions: store.listVersions(id).map((v) => ({
        number: v.number,
        entry: v.entry,
        summary: v.summary,
        createdBy: v.createdBy,
        fileCount: v.fileCount,
        totalBytes: v.totalBytes,
        createdAt: v.createdAt,
      })),
    }
  }

  /** Validates a bundle and writes its blobs; returns the file records and the blobs that did not exist before. */
  async function storeVersion(
    files: readonly BundleFile[],
    entry: string
  ): Promise<{ records: FileRecord[]; written: string[] }> {
    const normalized = files.map((f) => ({ path: normalizeBundlePath(f.path), bytes: f.bytes }))
    validateBundle(normalized, entry)
    const shas = normalized.map((f) => BlobStore.sha256(f.bytes))
    const fresh = new Map<string, number>()
    normalized.forEach((f, i) => {
      if (!blobs.has(shas[i]!)) fresh.set(shas[i]!, f.bytes.byteLength)
    })
    const incoming = [...fresh.values()].reduce((sum, bytes) => sum + bytes, 0)
    if (blobs.totalBytes() + incoming > deps.quotaBytes)
      throw new ArtifactHostError('quota_exceeded', 'The artifact storage limit was reached')
    const written: string[] = []
    try {
      // Blobs are written before the rows that reference them: an interrupted write leaves only orphans.
      for (const f of normalized) {
        const sha = await blobs.put(f.bytes)
        if (fresh.has(sha) && !written.includes(sha)) written.push(sha)
      }
    } catch (error) {
      await discard(written)
      throw error
    }
    const records = normalized.map((f, i) => ({
      path: f.path,
      sha256: shas[i]!,
      bytes: f.bytes.byteLength,
      contentType: contentTypeFor(f.path)!,
    }))
    return { records, written }
  }

  async function discard(shas: readonly string[]): Promise<void> {
    for (const sha of shas) if (!store.isBlobReferenced(sha)) await blobs.remove(sha).catch(() => {})
  }

  async function loadVersion(id: string, version: number): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>()
    for (const file of store.listFiles(id, version)) {
      const bytes = await blobs.read(file.sha256)
      if (!bytes) throw new ArtifactHostError('storage', `A stored file is missing: ${file.path}`)
      files.set(file.path, bytes)
    }
    return files
  }

  return {
    ...createSharingAdmin({ store, sharing, clock, onChange: deps.onChange }),

    async status() {
      return { artifactCount: store.countArtifacts(), storageBytes: blobs.totalBytes(), quotaBytes: deps.quotaBytes }
    },

    async create(raw) {
      const input = parseInput(createArtifactInput, raw)
      return exclusive(async () => {
        const { records, written } = await storeVersion(input.files, input.entry)
        const id = newArtifactId()
        const now = clock()
        try {
          store.createArtifact(
            {
              id,
              title: input.title,
              description: input.description,
              ownerKind: input.owner.kind,
              ownerId: input.owner.id,
              workspaceId: input.origin.workspaceId,
              conversationId: input.origin.conversationId,
              conversationTitle: input.origin.conversationTitle,
              createdAt: now,
            },
            { entry: input.entry, summary: input.summary, createdBy: input.createdBy, createdAt: now, files: records }
          )
        } catch (error) {
          await discard(written)
          throw error
        }
        deps.onChange?.(id)
        return detail(id)!
      })
    },

    async update(raw) {
      const input = parseInput(updateArtifactInput, raw)
      return exclusive(async () => {
        const artifact = store.getArtifact(input.id)
        if (!artifact) throw notFound()
        if (artifact.currentVersion !== input.baseVersion)
          throw new ArtifactHostError('version_conflict', `Version ${artifact.currentVersion} is the current version`, {
            currentVersion: artifact.currentVersion,
          })
        if (artifact.versionCount >= maxVersions)
          throw new ArtifactHostError('version_limit', `An artifact keeps at most ${maxVersions} versions`)
        const base = store.getVersion(input.id, input.baseVersion)
        if (!base) throw notFound()

        const change = input.change
        let next: Map<string, Uint8Array>
        if (change.kind === 'edits') {
          next = applyEdits(await loadVersion(input.id, input.baseVersion), change.edits)
        } else if (change.kind === 'files') {
          next = await loadVersion(input.id, input.baseVersion)
          for (const target of change.delete) {
            if (!next.delete(target))
              throw new ArtifactHostError('invalid_path', `Cannot delete ${target}: it is not in the version`, {
                path: target,
              })
          }
          for (const file of change.files) next.set(normalizeBundlePath(file.path), file.bytes)
        } else {
          next = new Map(change.files.map((file) => [file.path, file.bytes]))
        }

        const entry = input.entry ?? base.entry
        const { records, written } = await storeVersion(
          [...next].map(([path, bytes]) => ({ path, bytes })),
          entry
        )
        try {
          store.addVersion(
            input.id,
            { entry, summary: input.summary, createdBy: input.createdBy, createdAt: clock(), files: records },
            input.baseVersion,
            input.conversationTitle
          )
        } catch (error) {
          await discard(written)
          throw error
        }
        deps.onChange?.(input.id)
        return detail(input.id)!
      })
    },

    async get(id) {
      return isArtifactId(id) ? detail(id) : null
    },

    async list(filter = {}) {
      sharing.expireRequests(clock())
      return store.listArtifacts(parseInput(artifactListFilter, filter))
    },

    async listFiles(id, version) {
      const artifact = isArtifactId(id) ? store.getArtifact(id) : null
      if (!artifact) throw notFound()
      const number = version ?? artifact.currentVersion
      if (!Number.isInteger(number) || !store.getVersion(id, number))
        throw new ArtifactHostError('not_found', `Version ${number} does not exist`)
      return store.listFiles(id, number).map((file) => ({
        path: file.path,
        bytes: file.bytes,
        contentType: file.contentType,
        text: isTextPath(file.path),
      }))
    },

    async readFile(id, version, path) {
      if (!isArtifactId(id) || !Number.isInteger(version) || typeof path !== 'string') return null
      const file = store.getFile(id, version, path)
      if (!file) return null
      const bytes = await blobs.read(file.sha256)
      return bytes ? { bytes, contentType: file.contentType } : null
    },

    delete(id) {
      return exclusive(async () => {
        if (!isArtifactId(id)) return false
        const shas = store.blobsOf(id)
        if (!store.deleteArtifact(id)) return false
        await discard(shas)
        deps.onChange?.(id)
        return true
      })
    },

    setThumbnail(id, version, image) {
      return exclusive(async () => {
        if (!isArtifactId(id) || !Number.isInteger(version) || !store.getVersion(id, version)) throw notFound()
        if (!(image instanceof Uint8Array) || image.byteLength === 0)
          throw new ArtifactHostError('invalid_input', 'A thumbnail needs image bytes')
        if (image.byteLength > MAX_THUMBNAIL_BYTES)
          throw new ArtifactHostError('file_too_large', `A thumbnail cannot exceed ${MAX_THUMBNAIL_BYTES} bytes`)
        const contentType = thumbnailContentType(image)
        if (!contentType)
          throw new ArtifactHostError('unsupported_type', 'A thumbnail must be a PNG, JPEG or WebP image')
        const sha = BlobStore.sha256(image)
        if (!blobs.has(sha) && blobs.totalBytes() + image.byteLength > deps.quotaBytes)
          throw new ArtifactHostError('quota_exceeded', 'The artifact storage limit was reached')
        const fresh = !blobs.has(sha)
        await blobs.put(image)
        let previous: string | null
        try {
          previous = store.setThumbnail(id, version, {
            sha256: sha,
            contentType,
            bytes: image.byteLength,
            createdAt: clock(),
          })
        } catch (error) {
          if (fresh) await discard([sha])
          throw error
        }
        if (previous && previous !== sha) await discard([previous])
        deps.onChange?.(id)
      })
    },

    async getThumbnail(id, version) {
      const artifact = isArtifactId(id) ? store.getArtifact(id) : null
      if (!artifact) return null
      const max = version ?? artifact.currentVersion
      if (!Number.isInteger(max)) return null
      const thumbnail = store.getThumbnail(id, max)
      const bytes = thumbnail ? await blobs.read(thumbnail.sha256) : null
      return thumbnail && bytes ? { version: thumbnail.version, contentType: thumbnail.contentType, bytes } : null
    },

    async mintOwnerTicket(id) {
      if (!isArtifactId(id) || !store.getArtifact(id)) throw notFound()
      const ticket = newSecretToken()
      const expiresAt = clock() + OWNER_TICKET_TTL_MS
      store.insertOwnerTicket(digest(ticket), id, expiresAt)
      return { ticket, expiresAt }
    },

    async snapshot(targetFile) {
      if (typeof targetFile !== 'string' || targetFile.length === 0)
        throw new ArtifactHostError('invalid_input', 'A snapshot needs a target file')
      try {
        store.vacuumInto(targetFile)
      } catch (error) {
        throw new ArtifactHostError('storage', `Could not write the snapshot: ${(error as Error).message}`)
      }
    },
  }
}
