import { z } from 'zod'
import { ArtifactHostError } from './errors.js'
import { ARTIFACT_ID_PATTERN } from './ids.js'
import {
  MAX_DESCRIPTION_CHARS,
  MAX_EDITS,
  MAX_FILES_PER_VERSION,
  MAX_PATH_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TITLE_CHARS,
} from './limits.js'
import type { ArtifactRecord, VersionAuthor } from './store/artifact-store.js'

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

export interface HostStatusInfo {
  artifactCount: number
  storageBytes: number
  quotaBytes: number
}

/** Parses untrusted input, turning the first validation issue into an `invalid_input` error. */
export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
  throw new ArtifactHostError('invalid_input', `${where}${issue?.message ?? 'Invalid input'}`)
}
