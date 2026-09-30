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
