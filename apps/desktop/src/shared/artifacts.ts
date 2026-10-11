/** Artifacts shared between the main process and the renderer: list views, sharing, and the bot server's state. */

export const MAX_ARTIFACT_NAME_CHARS = 60
export const MIN_ACCESS_CODE_CHARS = 6
export const MAX_ACCESS_CODE_CHARS = 64
export const MAX_LINK_EXPIRY_DAYS = 365

export type ArtifactVisibility = 'private' | 'people' | 'link'

export interface ArtifactListItem {
  id: string
  title: string
  description: string
  currentVersion: number
  versionCount: number
  visibility: ArtifactVisibility
  createdAt: number
  updatedAt: number
  bot: { id: string; name: string | null } | null
  elsewhere: boolean
  /** The originating conversation; `exists` is false once it was deleted, with its last known title. */
  conversation: { id: string; title: string | null; exists: boolean } | null
  /** The project it was published in; null for standalone conversations. `name` is null once the project is gone. */
  project: { id: string; name: string | null } | null
  /** Space its versions and thumbnails take; content shared with other artifacts counts for each of them. */
  storageBytes: number
  /** The newest version with a preview image, or null while none was captured. */
  thumbnailVersion: number | null
  /** New devices, access requests, declined invitations and comments the owner has not seen yet. */
  unseenEvents: number
  pendingRequests: number
  /** Comment threads that are neither resolved nor deleted. */
  openComments: number
}

export const MAX_ARTIFACT_COMMENT_CHARS = 4000

export type ArtifactCommentAuthorKind = 'owner' | 'agent' | 'invited' | 'approved' | 'guest'

/** A comment as the owner sees it in the app. A reply carries its thread's ID and version. */
export interface ArtifactCommentView {
  id: string
  version: number
  parentId: string | null
  /** Guests are unverified: nobody confirmed the name they typed. */
  author: { kind: ArtifactCommentAuthorKind; name: string; verified: boolean }
  body: string
  /** What the thread is about: a passage of the page, a spot on it, or the whole page. */
  place: 'passage' | 'spot' | 'page'
  /** The passage the thread is about, when it is anchored to one. */
  quote: string | null
  status: 'open' | 'resolved'
  createdAt: number
}

export type ArtifactPersonKind = 'invited' | 'approved' | 'guest'

/** One browser a person joined with; the label is coarse ("Safari/iPhone"). */
export interface ArtifactDeviceView {
  id: string
  label: string
  createdAt: number
  lastSeenAt: number
}

export interface ArtifactPersonView {
  id: string
  kind: ArtifactPersonKind
  name: string
  createdAt: number
  inviteExpiresAt: number | null
  /** Whether the personal link can be shown again; otherwise it can only be reset. */
  linkAvailable: boolean
  devices: ArtifactDeviceView[]
}

export interface ArtifactAccessRequestView {
  id: string
  name: string
  message: string
  createdAt: number
}

export interface ArtifactSharingView {
  visibility: ArtifactVisibility
  linkExpiresAt: number | null
  hasAccessCode: boolean
  commentsEnabled: boolean
  people: ArtifactPersonView[]
  requests: ArtifactAccessRequestView[]
  /** The configured public address, or null when links only work on this computer. */
  publicBase: string | null
  defaultLinkExpiryDays: number | null
  localBase: string
}

export interface ArtifactSharingPatch {
  visibility?: ArtifactVisibility
  linkExpiresAt?: number | null
  /** A new access code, or null to remove it. */
  accessCode?: string | null
  commentsEnabled?: boolean
}

export type ArtifactEventKind = 'device_added' | 'access_requested' | 'invite_declined' | 'comment_added'

export interface ArtifactEventView {
  id: string
  artifactId: string
  kind: ArtifactEventKind
  data: Record<string, string | number>
  createdAt: number
  seen: boolean
}

/** Something that just happened on a shared artifact. */
export interface ArtifactActivity {
  artifactId: string
  kind: ArtifactEventKind
}

/** A version's preview image, ready for an `<img>`. It may show an earlier version than the one asked for. */
export interface ArtifactThumbnailView {
  version: number
  dataUrl: string
}

export interface ArtifactRemoveResult {
  removed: boolean
  /** Storage released; less than the artifact's size when other artifacts share its content. */
  freedBytes: number
}

export interface ArtifactVersionView {
  number: number
  summary: string
  createdAt: number
  fileCount: number
  totalBytes: number
}

export interface ArtifactDetailView extends ArtifactListItem {
  versions: ArtifactVersionView[]
}

/** What the chat card needs from an `artifact_create` or `artifact_update` result. */
export interface ArtifactToolResult {
  id: string
  title: string
  version: number
}

const ARTIFACT_ID = /^[A-Za-z0-9_-]{22}$/
const MAX_CARD_TITLE_CHARS = 200

export function parseArtifactToolResult(text: string): ArtifactToolResult | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const result = value as { ok?: unknown; artifact?: { id?: unknown; title?: unknown; version?: unknown } } | null
  const artifact = result?.ok === true ? result.artifact : undefined
  if (!artifact || typeof artifact.id !== 'string' || !ARTIFACT_ID.test(artifact.id)) return null
  if (typeof artifact.title !== 'string') return null
  if (typeof artifact.version !== 'number' || !Number.isInteger(artifact.version) || artifact.version < 1) return null
  return { id: artifact.id, title: artifact.title.slice(0, MAX_CARD_TITLE_CHARS), version: artifact.version }
}

/** The paired bot server's artifact host, where every artifact lives. */
export type ArtifactServerStatus =
  | { state: 'absent' }
  | { state: 'unsupported' }
  | { state: 'unreachable' }
  | {
      state: 'off'
      /** Whether the server accepts artifacts moved from this computer. */
      canMove: boolean
    }
  | {
      state: 'ready'
      canOpen: boolean
      /** Whether the server accepts artifacts moved from this computer. */
      canMove: boolean
      artifactCount: number
      storageBytes: number
      quotaBytes: number
      problem: string | null
    }

/** An artifact an earlier version published on this computer; it no longer opens until it moves to the server. */
export interface LegacyArtifactView {
  id: string
  title: string
  versionCount: number
  commentCount: number
  storageBytes: number
  /** Shared with anyone: it becomes private when it moves, because its links change. */
  shared: boolean
}

export type LegacyMoveStep = 'upload' | 'verify' | 'remove'

/** Why a move stopped; with `quota_exceeded`, how much space it needs and how much the server has left. */
export interface LegacyMoveError {
  code: string
  reason?: string
  neededBytes?: number
  freeBytes?: number
}

/** Moving the artifacts on this computer to the bot server, one at a time, in the main process. */
export interface LegacyMoveState {
  phase: 'idle' | 'running' | 'done' | 'failed'
  /** What this move covers, as listed when it started. */
  items: LegacyArtifactView[]
  /** IDs already on the server and gone from this computer. */
  moved: string[]
  /** The artifact being moved, and how far along: `progress` goes from 0 to 1 within each step. */
  current: { id: string; step: LegacyMoveStep; progress: number } | null
  /** Stop after the artifact being moved. */
  stopping: boolean
  error: LegacyMoveError | null
}
