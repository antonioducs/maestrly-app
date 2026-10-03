import { z } from 'zod'
import { contentTypeFor, isTextPath, normalizeBundlePath, validateBundle } from './bundle-paths.js'
import {
  type CommentAnchor,
  type CommentListInput,
  type CommentView,
  commentAnchorSchema,
  commentBody,
  createCommentService,
  toCommentView,
} from './comments.js'
import { applyEdits } from './edits.js'
import { ArtifactHostError } from './errors.js'
import { ARTIFACT_ID_PATTERN, digest, isArtifactId, newArtifactId, newSecretToken } from './ids.js'
import {
  MAX_COMMENTS_PER_ARTIFACT,
  MAX_DESCRIPTION_CHARS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_VERSION,
  MAX_NAME_CHARS,
  MAX_PATH_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_THUMBNAIL_BYTES,
  MAX_TITLE_CHARS,
  MAX_VERSION_BYTES,
  MAX_VERSIONS_PER_ARTIFACT,
  OWNER_TICKET_TTL_MS,
} from './limits.js'
import {
  type ArtifactDetail,
  type ArtifactExport,
  type ArtifactFileInfo,
  type ArtifactListFilter,
  type ArtifactSummary,
  artifactListFilter,
  type BundleFile,
  type CreateArtifactInput,
  createArtifactInput,
  type HostStatusInfo,
  parseInput,
  sameContent,
  type ThumbnailImage,
  type UpdateArtifactInput,
  updateArtifactInput,
} from './schemas.js'
import { createSharingAdmin, type SharingAdmin } from './sharing-admin.js'
import type { ArtifactStore, FileRecord, ImportedArtifact } from './store/artifact-store.js'
import { BlobStore } from './store/blobs.js'
import { type CommentRecord, CommentStore } from './store/comment-store.js'
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
  /** Comments in the order they were written, a page at a time. */
  listComments(id: string, filter?: CommentListInput): Promise<{ comments: CommentView[]; nextCursor: string | null }>
  /** A comment by the owner or, on the owner's behalf, by an agent. With `parentId` it is a reply. */
  addComment(
    id: string,
    input: { author: 'owner' | 'agent'; version?: number; body: string; anchor?: CommentAnchor; parentId?: string }
  ): Promise<CommentView>
  setCommentResolved(id: string, commentId: string, resolved: boolean): Promise<void>
  /** Deletes a comment; deleting the one that starts a thread deletes its replies too. */
  deleteComment(id: string, commentId: string): Promise<void>
  /** Everything needed to recreate an artifact on another host, except the file bytes and its sharing. */
  exportArtifact(id: string): Promise<ArtifactExport>
  /** Stores file bytes ahead of an import, once each; returns their SHA-256 in the order given. */
  putBlobs(blobs: Uint8Array[]): Promise<{ sha256: string[] }>
  /**
   * Recreates an exported artifact with its ID, private, once its files are stored. Importing the same artifact for
   * the same owner again returns it unchanged; any other artifact with that ID is refused with `already_exists`.
   */
  importArtifact(
    input: ArtifactExport & { owner: { kind: 'local' | 'device' | 'bot'; id: string } }
  ): Promise<ArtifactDetail>
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
  /** The owner's display name, stored with the comments the owner and their agents write. */
  ownerName?: string
  maxComments?: number
}

const adminComment = z
  .object({
    author: z.enum(['owner', 'agent']),
    version: z.number().int().min(1).optional(),
    body: commentBody,
    anchor: commentAnchorSchema.optional(),
    parentId: z.string().optional(),
  })
  .strict()

const notFound = () => new ArtifactHostError('not_found', 'Artifact not found')

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'Invalid SHA-256')
const timestamp = z.number().int().min(0)
const recordId = z.string().regex(ARTIFACT_ID_PATTERN, 'Invalid ID')
const ref = z.string().min(1).max(128)
/** Sizes and types in a manifest are not trusted: they are taken from the stored files and their paths. */
const importInput = z.object({
  id: recordId,
  owner: z.object({ kind: z.enum(['local', 'device', 'bot']), id: ref }),
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  description: z.string().trim().max(MAX_DESCRIPTION_CHARS),
  workspaceId: ref.nullable(),
  conversationId: ref.nullable(),
  conversationTitle: z
    .string()
    .nullable()
    .transform((value) => (value === null ? null : value.slice(0, 300))),
  commentsEnabled: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
  versions: z
    .array(
      z.object({
        number: z.number().int().min(1),
        entry: z.string().min(1).max(MAX_PATH_CHARS),
        summary: z.string().trim().max(MAX_SUMMARY_CHARS),
        createdBy: z.enum(['agent', 'owner']),
        createdAt: timestamp,
        files: z
          .array(z.object({ path: z.string().min(1).max(MAX_PATH_CHARS), sha256 }))
          .min(1)
          .max(MAX_FILES_PER_VERSION),
      })
    )
    .min(1)
    .max(MAX_VERSIONS_PER_ARTIFACT),
  thumbnails: z
    .array(z.object({ version: z.number().int().min(1), sha256, createdAt: timestamp }))
    .max(MAX_VERSIONS_PER_ARTIFACT),
  comments: z
    .array(
      z.object({
        id: recordId,
        version: z.number().int().min(1),
        parentId: recordId.nullable(),
        authorKind: z.enum(['owner', 'agent', 'invited', 'approved', 'guest']),
        authorName: z
          .string()
          .max(MAX_NAME_CHARS)
          .regex(/^\P{Cc}*$/u, 'Use a single line of text'),
        body: commentBody,
        anchor: commentAnchorSchema.nullable(),
        status: z.enum(['open', 'resolved']),
        createdAt: timestamp,
      })
    )
    .max(MAX_COMMENTS_PER_ARTIFACT),
})
const blobList = z
  .array(z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'Expected file bytes'))
  .min(1)
  .max(MAX_FILES_PER_VERSION)
const missingBlob = (sha: string) =>
  new ArtifactHostError('storage', 'A file of the artifact is not stored on this host', {
    reason: 'missing_blob',
    sha256: sha,
  })
const invalidImport = (message: string) => new ArtifactHostError('invalid_input', message)

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
  const commentStore = new CommentStore(store.db)
  const comments = createCommentService({
    store,
    comments: commentStore,
    clock,
    maxComments: deps.maxComments,
    onChange: deps.onChange,
  })
  const ownerName = (deps.ownerName ?? '').trim().slice(0, MAX_NAME_CHARS)

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

  function exportOf(id: string): ArtifactExport {
    const artifact = store.getArtifact(id)
    if (!artifact) throw notFound()
    return {
      id: artifact.id,
      title: artifact.title,
      description: artifact.description,
      workspaceId: artifact.workspaceId,
      conversationId: artifact.conversationId,
      conversationTitle: artifact.conversationTitle,
      commentsEnabled: sharing.getSharing(id)?.commentsEnabled ?? true,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      versions: store
        .listVersions(id)
        .reverse()
        .map((version) => ({
          number: version.number,
          entry: version.entry,
          summary: version.summary,
          createdBy: version.createdBy,
          createdAt: version.createdAt,
          files: store.listFiles(id, version.number),
        })),
      thumbnails: store.listThumbnails(id),
      comments: commentStore.listAll(id).map((comment) => {
        const view = toCommentView(comment)
        return {
          id: view.id,
          version: view.version,
          parentId: view.parentId,
          authorKind: view.author.kind,
          authorName: view.author.name,
          body: view.body,
          anchor: view.anchor,
          status: view.status,
          createdAt: view.createdAt,
        }
      }),
    }
  }

  /** Turns a validated manifest into rows, checking it as the host checks what it creates itself. */
  async function importRecord(
    input: z.output<typeof importInput>
  ): Promise<{ record: ImportedArtifact; comments: CommentRecord[] }> {
    const sizeOf = (sha: string): number => {
      const size = blobs.size(sha)
      if (size === null) throw missingBlob(sha)
      return size
    }
    const versions = input.versions.map((version, index) => {
      if (version.number !== index + 1) throw invalidImport('versions: Expected versions numbered from 1')
      const files: FileRecord[] = version.files.map((file) => {
        const path = normalizeBundlePath(file.path)
        if (path !== file.path) throw invalidImport(`Invalid file path "${file.path}"`)
        return { path, sha256: file.sha256, bytes: sizeOf(file.sha256), contentType: contentTypeFor(path)! }
      })
      validateBundle(
        files.map((file) => ({ path: file.path, bytes: { byteLength: file.bytes } })),
        version.entry
      )
      return { ...version, files }
    })
    const numbers = new Set(versions.map((version) => version.number))
    const thumbnails = []
    for (const thumbnail of input.thumbnails) {
      if (!numbers.has(thumbnail.version))
        throw invalidImport(`thumbnails: Version ${thumbnail.version} does not exist`)
      const bytes = await blobs.read(thumbnail.sha256)
      if (!bytes) throw missingBlob(thumbnail.sha256)
      const contentType = thumbnailContentType(bytes)
      if (!contentType || bytes.byteLength > MAX_THUMBNAIL_BYTES)
        throw invalidImport('thumbnails: A thumbnail must be a PNG, JPEG or WebP image')
      thumbnails.push({ ...thumbnail, contentType, bytes: bytes.byteLength })
    }
    if (new Set(thumbnails.map((thumbnail) => thumbnail.version)).size !== thumbnails.length)
      throw invalidImport('thumbnails: One thumbnail per version')
    const threads = new Map<string, number>()
    const imported: CommentRecord[] = []
    for (const comment of input.comments) {
      if (!numbers.has(comment.version)) throw invalidImport(`comments: Version ${comment.version} does not exist`)
      if (comment.parentId !== null) {
        // Threads are one level deep, and a reply carries its thread's version.
        if (threads.get(comment.parentId) !== comment.version) throw invalidImport('comments: Unknown thread')
        if (comment.anchor) throw invalidImport('comments: A reply has no anchor of its own')
      } else threads.set(comment.id, comment.version)
      if (imported.some((other) => other.id === comment.id) || commentStore.exists(comment.id))
        throw new ArtifactHostError('already_exists', 'A comment with this ID already exists')
      imported.push({
        id: comment.id,
        artifactId: input.id,
        version: comment.version,
        parentId: comment.parentId,
        authorKind: comment.authorKind,
        // The people an artifact was shared with stay behind, so comments keep their names but no link to them.
        principalId: null,
        authorName: comment.authorName,
        body: comment.body,
        anchorJson: comment.anchor && Object.keys(comment.anchor).length ? JSON.stringify(comment.anchor) : null,
        status: comment.status,
        createdAt: comment.createdAt,
      })
    }
    return {
      record: {
        artifact: {
          id: input.id,
          title: input.title,
          description: input.description,
          ownerKind: input.owner.kind,
          ownerId: input.owner.id,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          conversationTitle: input.conversationTitle,
          commentsEnabled: input.commentsEnabled,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        },
        versions: versions.map((version) => ({
          number: version.number,
          entry: version.entry,
          summary: version.summary,
          createdBy: version.createdBy,
          createdAt: version.createdAt,
          files: version.files,
        })),
        thumbnails,
      },
      comments: imported,
    }
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

    async listComments(id, filter) {
      return comments.list(id, filter)
    },

    async addComment(id, raw) {
      const { author, ...input } = parseInput(adminComment, raw)
      return comments.add(id, { kind: author, name: ownerName, principalId: null }, input)
    },

    async setCommentResolved(id, commentId, resolved) {
      comments.setResolved(id, commentId, resolved)
    },

    async deleteComment(id, commentId) {
      comments.remove(id, commentId)
    },

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

    async exportArtifact(id) {
      if (!isArtifactId(id)) throw notFound()
      return exportOf(id)
    },

    async putBlobs(raw) {
      const list = parseInput(blobList, raw)
      return exclusive(async () => {
        let total = 0
        const fresh = new Map<string, number>()
        for (const bytes of list) {
          if (bytes.byteLength > MAX_FILE_BYTES)
            throw new ArtifactHostError('file_too_large', 'A file cannot exceed 10 MiB')
          total += bytes.byteLength
          const sha = BlobStore.sha256(bytes)
          if (!blobs.has(sha)) fresh.set(sha, bytes.byteLength)
        }
        if (total > MAX_VERSION_BYTES)
          throw new ArtifactHostError('bundle_too_large', 'One call cannot carry more than 50 MiB')
        const incoming = [...fresh.values()].reduce((sum, bytes) => sum + bytes, 0)
        if (blobs.totalBytes() + incoming > deps.quotaBytes)
          throw new ArtifactHostError('quota_exceeded', 'The artifact storage limit was reached')
        // Until an import references them, these blobs are unreferenced: a restart of the host removes them.
        const sha256: string[] = []
        for (const bytes of list) sha256.push(await blobs.put(bytes))
        return { sha256 }
      })
    },

    async importArtifact(raw) {
      const input = parseInput(importInput, raw)
      return exclusive(async () => {
        const existing = store.getArtifact(input.id)
        if (existing) {
          if (
            existing.ownerKind === input.owner.kind &&
            existing.ownerId === input.owner.id &&
            sameContent(exportOf(input.id), input)
          )
            return detail(input.id)!
          throw new ArtifactHostError('already_exists', 'An artifact with this ID already exists')
        }
        const { record, comments: imported } = await importRecord(input)
        store.importArtifact(record, () => commentStore.importComments(imported))
        deps.onChange?.(input.id)
        return detail(input.id)!
      })
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
