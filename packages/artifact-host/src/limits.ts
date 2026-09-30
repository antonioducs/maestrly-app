const MiB = 1024 * 1024
const HOUR_MS = 60 * 60 * 1000

export const MAX_FILES_PER_VERSION = 500
export const MAX_FILE_BYTES = 10 * MiB
export const MAX_VERSION_BYTES = 50 * MiB
/** Files passed inline in one tool call; larger bundles are published from a directory. */
export const MAX_INLINE_BYTES = 5 * MiB
export const MAX_VERSIONS_PER_ARTIFACT = 200
export const DEFAULT_QUOTA_BYTES = 2 * 1024 * MiB
export const MAX_PATH_CHARS = 240
export const MAX_PATH_SEGMENTS = 10
export const MAX_TITLE_CHARS = 120
export const MAX_DESCRIPTION_CHARS = 500
export const MAX_SUMMARY_CHARS = 500
export const MAX_EDITS = 100
export const MAX_TEXT_READ_BYTES = 200 * 1024
export const OWNER_TICKET_TTL_MS = 60_000
export const OWNER_SESSION_TTL_MS = 30 * 24 * HOUR_MS
/** A session's sliding expiry is written at most this often, not on every request. */
export const SESSION_TOUCH_INTERVAL_MS = HOUR_MS
export const CAPABILITY_TTL_MS = 12 * HOUR_MS
export const MAX_API_BODY_BYTES = 64 * 1024
/** A preview image of one version, captured by the desktop after publishing. */
export const MAX_THUMBNAIL_BYTES = 512 * 1024
/** People's names, the owner's included. */
export const MAX_NAME_CHARS = 60
export const MAX_REQUEST_MESSAGE_CHARS = 280
export const MAX_PENDING_REQUESTS = 20
export const MAX_DEVICES_PER_PRINCIPAL = 10
/** Beyond it, the oldest events the owner already saw are dropped first. */
export const MAX_EVENTS_PER_ARTIFACT = 500
export const MIN_ACCESS_CODE_CHARS = 6
export const MAX_ACCESS_CODE_CHARS = 64
export const ACCESS_REQUEST_TTL_MS = 24 * HOUR_MS
/** Sliding lifetime of an invited or approved person's device, capped by the invitation's expiry. */
export const PERSON_SESSION_TTL_MS = 90 * 24 * HOUR_MS
/** Sliding lifetime of a guest's device, capped by the link's expiry. */
export const GUEST_SESSION_TTL_MS = 30 * 24 * HOUR_MS
export const VISITOR_COOKIE_TTL_MS = 30 * 24 * HOUR_MS
