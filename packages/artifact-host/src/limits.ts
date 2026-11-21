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
/** A whiteboard's elements as stored JSON, deleted ones included. */
export const MAX_BOARD_BYTES = 16 * MiB
export { MAX_BOARD_PUSH_BYTES } from './shell/contract.js'
/** How long a canvas's request for changes waits for one: below the 30 s a gateway proxy keeps an idle request. */
export const BOARD_POLL_MS = 20_000
export const MAX_BOARD_WAITERS_PER_ARTIFACT = 400
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
/** Guests signed in to one artifact at a time; each guest is one browser. */
export const MAX_GUESTS_PER_ARTIFACT = 200
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
/** Comments of one artifact that were not deleted, replies included. */
export const MAX_COMMENTS_PER_ARTIFACT = 2000
export const MAX_COMMENT_CHARS = 4000
/** The quoted passage a comment is anchored to, and the text kept before and after it to find it again. */
export { MAX_QUOTE_CHARS, MAX_QUOTE_CONTEXT_CHARS, MAX_SELECTOR_CHARS } from './shell/contract.js'
export const COMMENTS_PAGE_SIZE = 200
/** Responses kept for one artifact: one per person, plus those brought with it from another host. */
export const MAX_RESPONSES_PER_ARTIFACT = 500
export const RESPONSES_PAGE_SIZE = 50
/** One response's size as UTF-8 JSON, and how deep its values may nest. */
export { MAX_RESPONSE_BYTES, MAX_RESPONSE_DEPTH } from './shell/contract.js'
export const MAX_MANIFEST_BYTES = 64 * 1024
export const MAX_TOKENS_FILE_BYTES = 256 * 1024
export const MAX_DESIGN_CACHE_ENTRIES = 64
export const MAX_SUGGESTION_CHANGES = 200
export {
  DESIGN_MANIFEST_PATH,
  DESIGN_SCHEMA,
  MAX_COMPUTED_STYLE_CHARS,
  MAX_DESIGN_SCREEN_NAME_CHARS,
  MAX_DESIGN_SCREEN_PATH_CHARS,
  MAX_DESIGN_SCREENS,
  MAX_DESIGN_TITLE_CHARS,
  MAX_DESIGN_TOKEN_FILES,
  MAX_DESIGN_TOKENS,
  MAX_DS_PROP_VALUE_CHARS,
  MAX_DS_PROPS,
  MAX_DS_PROPS_RAW_CHARS,
  MAX_INSPECTED_TOKENS,
  MAX_INVENTORY_COMPONENTS,
  MAX_INVENTORY_COUNT,
  MAX_THEME_SELECTOR_CHARS,
  MAX_TOKEN_VALUE_CHARS,
  MAX_VIEWPORT_DIMENSION,
  MIN_VIEWPORT_DIMENSION,
} from './shell/contract.js'
