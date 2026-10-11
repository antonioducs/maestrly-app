import { z } from 'zod'
import { ArtifactHostError } from './errors.js'
import { ARTIFACT_ID_PATTERN } from './ids.js'
import {
  MAX_ACCESS_CODE_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_EDITS,
  MAX_EVENTS_PER_ARTIFACT,
  MAX_FILES_PER_VERSION,
  MAX_NAME_CHARS,
  MAX_PATH_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TITLE_CHARS,
  MIN_ACCESS_CODE_CHARS,
} from './limits.js'
import type { CommentAnchor, CommentAuthorKind } from './shell/contract.js'
import type { ArtifactRecord, VersionAuthor, Visibility } from './store/artifact-store.js'
import type { ArtifactEventKind, EventData, PrincipalKind } from './store/sharing-store.js'

export type BundleFile = { path: string; bytes: Uint8Array }

const MAX_CONVERSATION_TITLE_CHARS = 300
const MAX_REF_CHARS = 128

const bundleFile = z.object({
  path: z.string().min(1).max(MAX_PATH_CHARS),
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'Expected file bytes'),
})
const textEdit = z.object({
  path: z.string().min(1).max(MAX_PATH_CHARS),
  oldText: z.string().min(1),
  newText: z.string(),
})
const artifactId = z.string().regex(ARTIFACT_ID_PATTERN, 'Invalid artifact ID')
const ref = z.string().min(1).max(MAX_REF_CHARS)
// Conversation titles are a display snapshot: long ones are shortened rather than rejected.
const conversationTitle = z
  .string()
  .nullable()
  .transform((value) => (value === null ? null : value.slice(0, MAX_CONVERSATION_TITLE_CHARS)))
const author = z.enum(['agent', 'owner'])

export const createArtifactInput = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  description: z.string().trim().max(MAX_DESCRIPTION_CHARS).default(''),
  owner: z.object({ kind: z.enum(['local', 'device', 'bot']), id: ref }),
  origin: z.object({
    workspaceId: ref.nullable(),
    conversationId: ref.nullable(),
    conversationTitle,
  }),
  entry: z.string().min(1).max(MAX_PATH_CHARS).default('index.html'),
  summary: z.string().trim().max(MAX_SUMMARY_CHARS).default(''),
  createdBy: author.default('agent'),
  files: z.array(bundleFile).min(1).max(MAX_FILES_PER_VERSION),
})

export const updateArtifactInput = z.object({
  id: artifactId,
  baseVersion: z.number().int().min(1),
  summary: z.string().trim().max(MAX_SUMMARY_CHARS).default(''),
  createdBy: author.default('agent'),
  entry: z.string().min(1).max(MAX_PATH_CHARS).optional(),
  conversationTitle: conversationTitle.optional(),
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('edits'), edits: z.array(textEdit).min(1).max(MAX_EDITS) }),
    z
      .object({
        kind: z.literal('files'),
        files: z.array(bundleFile).max(MAX_FILES_PER_VERSION),
        delete: z.array(z.string().min(1).max(MAX_PATH_CHARS)).max(MAX_FILES_PER_VERSION).default([]),
      })
      .refine((change) => change.files.length > 0 || change.delete.length > 0, 'Add, replace or delete a file'),
    z.object({ kind: z.literal('replace'), files: z.array(bundleFile).min(1).max(MAX_FILES_PER_VERSION) }),
  ]),
})

export const artifactListFilter = z
  .object({
    ownerKind: z.enum(['local', 'device', 'bot']).optional(),
    ownerId: ref.optional(),
    workspaceId: ref.optional(),
    conversationId: ref.optional(),
  })
  .strict()

export type CreateArtifactInput = z.input<typeof createArtifactInput>
export type UpdateArtifactInput = z.input<typeof updateArtifactInput>
export type ArtifactListFilter = z.input<typeof artifactListFilter>

export type ArtifactSummary = ArtifactRecord

export interface ArtifactVersionInfo {
  number: number
  entry: string
  summary: string
  createdBy: VersionAuthor
  fileCount: number
  totalBytes: number
  createdAt: number
}

export interface ArtifactDetail extends ArtifactSummary {
  versions: ArtifactVersionInfo[]
}

export interface ArtifactFileInfo {
  path: string
  bytes: number
  contentType: string
  text: boolean
}

export interface ThumbnailImage {
  /** The version the image shows, which may be older than the one asked for. */
  version: number
  contentType: string
  bytes: Uint8Array
}

/** A person's name as shown to others: one line, without control characters. */
export const personName = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME_CHARS)
  .regex(/^\P{Cc}*$/u, 'Use a single line of text')

export const sharingPatch = z
  .object({
    visibility: z.enum(['private', 'people', 'link']).optional(),
    linkExpiresAt: z.number().int().nullable().optional(),
    accessCode: z.string().min(MIN_ACCESS_CODE_CHARS).max(MAX_ACCESS_CODE_CHARS).nullable().optional(),
    commentsEnabled: z.boolean().optional(),
  })
  .strict()

export const inviteInput = z.object({ name: personName, expiresAt: z.number().int().nullable().optional() }).strict()
export const requestDecision = z.object({ approve: z.boolean(), name: personName.optional() }).strict()
export const eventsFilter = z
  .object({
    artifactId: artifactId.optional(),
    unseenOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(MAX_EVENTS_PER_ARTIFACT).optional(),
  })
  .strict()

export type SharingPatch = z.input<typeof sharingPatch>

/** One browser a person joined with; the label is coarse ("Safari/iPhone"), never a raw user agent. */
export interface DeviceView {
  id: string
  label: string
  createdAt: number
  lastSeenAt: number
}

export interface PersonView {
  id: string
  kind: PrincipalKind
  name: string
  createdAt: number
  inviteExpiresAt: number | null
  devices: DeviceView[]
}

export interface AccessRequestView {
  id: string
  name: string
  message: string
  createdAt: number
}

/** Who can open an artifact, as the owner sees it. It never carries tokens, digests or the access code. */
export interface SharingView {
  visibility: Visibility
  linkExpiresAt: number | null
  hasAccessCode: boolean
  commentsEnabled: boolean
  people: PersonView[]
  requests: AccessRequestView[]
}

export interface ArtifactEventView {
  id: string
  artifactId: string
  kind: ArtifactEventKind
  data: EventData
  createdAt: number
  seen: boolean
}

export interface HostStatusInfo {
  artifactCount: number
  storageBytes: number
  quotaBytes: number
}

/**
 * An artifact as it moves to another host: its content, history and comments, but nobody it was shared with. File
 * bytes travel separately (`putBlobs`) and are referenced by SHA-256. Deleted comments are left behind.
 */
export interface ArtifactExport {
  id: string
  title: string
  description: string
  workspaceId: string | null
  conversationId: string | null
  conversationTitle: string | null
  commentsEnabled: boolean
  createdAt: number
  updatedAt: number
  /** Oldest first, numbered from 1. */
  versions: {
    number: number
    entry: string
    summary: string
    createdBy: VersionAuthor
    createdAt: number
    files: { path: string; sha256: string; bytes: number; contentType: string }[]
  }[]
  thumbnails: { version: number; sha256: string; contentType: string; bytes: number; createdAt: number }[]
  /** In the order they were written, so a thread always comes before its replies. */
  comments: {
    id: string
    version: number
    parentId: string | null
    authorKind: CommentAuthorKind
    authorName: string
    body: string
    anchor: CommentAnchor | null
    status: 'open' | 'resolved'
    createdAt: number
  }[]
}

/** JSON with object keys in a fixed order, so equal anchors compare equal however they were built. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** What `sameContent` compares: an export, or a manifest whose sizes and types were not derived from its files yet. */
export interface ArtifactContent extends Omit<ArtifactExport, 'versions' | 'thumbnails' | 'updatedAt'> {
  versions: (Omit<ArtifactExport['versions'][number], 'files'> & { files: { path: string; sha256: string }[] })[]
  thumbnails: { version: number; sha256: string }[]
}

/**
 * Whether two exports hold the same artifact: the same content, history and comments. Sizes and types are derived
 * from the files, and `updatedAt` from the history, so neither is compared.
 */
export function sameContent(a: ArtifactContent, b: ArtifactContent): boolean {
  const key = (value: ArtifactContent) =>
    canonical([
      value.id,
      value.title,
      value.description,
      value.workspaceId,
      value.conversationId,
      value.conversationTitle,
      value.commentsEnabled,
      value.createdAt,
      [...value.versions]
        .sort((x, y) => x.number - y.number)
        .map((version) => [
          version.number,
          version.entry,
          version.summary,
          version.createdBy,
          version.createdAt,
          version.files.map((file) => [file.path, file.sha256]).sort(([x], [y]) => (x! < y! ? -1 : x! > y! ? 1 : 0)),
        ]),
      [...value.thumbnails]
        .sort((x, y) => x.version - y.version)
        .map((thumbnail) => [thumbnail.version, thumbnail.sha256]),
      value.comments.map((comment) => [
        comment.id,
        comment.version,
        comment.parentId,
        comment.authorKind,
        comment.authorName,
        comment.body,
        comment.anchor,
        comment.status,
        comment.createdAt,
      ]),
    ])
  return key(a) === key(b)
}

/** Parses untrusted input, turning the first validation issue into an `invalid_input` error. */
export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
  throw new ArtifactHostError('invalid_input', `${where}${issue?.message ?? 'Invalid input'}`)
}
