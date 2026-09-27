export const FLEET_PROTOCOL_VERSION = 1 as const
export const FLEET_PROTOCOL_HEADER = 'X-Maestrly-Fleet-Protocol' as const
export const FLEET_SCREEN_UPGRADE = 'maestrly-rfb' as const

export const FLEET_MESSAGE_TEXT_MAX = 16_000
export const FLEET_INSTRUCTIONS_MAX = 8_000
export const FLEET_NAME_MAX = 40
export const FLEET_ROLE_MAX = 80
export const FLEET_NOTE_MAX = 1_000
export const FLEET_ROUTINE_TITLE_MAX = 80
export const FLEET_ROUTINE_PROMPT_MAX = 4_000
/**
 * Every routine run is a full model turn, so intervals have a floor. A bot may create routines for itself (the owner
 * approves each one unless its ceiling allows it), up to `botCreatedMax`; the owner's own routines do not count.
 */
export const FLEET_ROUTINE_LIMITS = { intervalMinMinutes: 15, intervalMaxMinutes: 1440, botCreatedMax: 10 } as const
/**
 * A bot compacts its conversation with a model the owner chooses: summaries are prepared in the background every
 * `intervalTokens` of new conversation, and the same model compacts on the spot when no prepared summary fits.
 */
export const FLEET_COMPACTION_LIMITS = {
  intervalTokensMin: 10_000,
  intervalTokensMax: 1_000_000,
  intervalTokensDefault: 100_000,
} as const
/** A compaction summary shown in the transcript is cut here (the bot keeps the whole summary). */
export const FLEET_COMPACTION_SUMMARY_MAX = 16_000
export const FLEET_PEER_MESSAGE_MAX = 4_000
export const FLEET_TOOL_OUTPUT_MAX = 400
export const FLEET_QUEUE_PREVIEW_MAX = 80

/** Image limits. Attachments match the desktop composer's own limits; reads cover tool screenshots too. */
export const FLEET_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const FLEET_IMAGE_LIMITS = {
  attachmentMaxBytes: 5 * 1024 * 1024,
  attachmentsMax: 8,
  attachmentsTotalMaxBytes: 20 * 1024 * 1024,
  imageReadMaxBytes: 32 * 1024 * 1024,
  imagesPerItemMax: 8,
} as const
/** JSON body limit for routes that carry base64 attachments (20 MiB of images, base64-encoded, plus text). */
export const FLEET_MESSAGE_BODY_MAX = 28 * 1024 * 1024

export const FLEET_PORTS = {
  public: 7443,
  internal: 7444,
  instanceControl: 7680,
  vncControl: 5900,
  vncView: 5901,
} as const

export const FLEET_SCREEN = { width: 1280, height: 800 } as const

export const FLEET_GATEWAY_ENV = {
  dataDir: 'MAESTRLY_GATEWAY_DATA_DIR',
  displayName: 'MAESTRLY_GATEWAY_DISPLAY_NAME',
  publicHost: 'MAESTRLY_GATEWAY_PUBLIC_HOST',
  publicPort: 'MAESTRLY_GATEWAY_PUBLIC_PORT',
  internalPort: 'MAESTRLY_GATEWAY_INTERNAL_PORT',
  internalUrl: 'MAESTRLY_GATEWAY_INTERNAL_URL',
  botImage: 'MAESTRLY_GATEWAY_BOT_IMAGE',
  network: 'MAESTRLY_GATEWAY_NETWORK',
  dockerSocket: 'MAESTRLY_GATEWAY_DOCKER_SOCKET',
  botMemory: 'MAESTRLY_GATEWAY_BOT_MEMORY',
  botShm: 'MAESTRLY_GATEWAY_BOT_SHM',
  timezone: 'TZ',
} as const

export const FLEET_BOT_ENV = {
  mode: 'MAESTRLY_BOT_MODE',
  id: 'MAESTRLY_BOT_ID',
  name: 'MAESTRLY_BOT_NAME',
  controlHost: 'MAESTRLY_BOT_CONTROL_HOST',
  controlPort: 'MAESTRLY_BOT_CONTROL_PORT',
  controlToken: 'MAESTRLY_BOT_CONTROL_TOKEN',
  gatewayUrl: 'MAESTRLY_BOT_GATEWAY_URL',
  gatewayToken: 'MAESTRLY_BOT_GATEWAY_TOKEN',
  environmentId: 'MAESTRLY_ENVIRONMENT_ID',
} as const

export const FLEET_SCREEN_CLOSE_CODES = {
  released: 4001,
  botOffline: 4002,
  ticketInvalid: 4003,
} as const

export const FLEET_PEER_BUDGETS = {
  messagesPerHour: 30,
  pairMessages: 20,
  pairWindowMinutes: 30,
  pairBlockedMinutes: 30,
} as const

// constants.ts
/** Facts and preferences about the owner, shared by every bot; every active entry is in each bot's prompt. */
export const FLEET_OWNER_MEMORY_LIMITS = { entryMax: 500, activeCharsMax: 4_000, reasonMax: 300 } as const
/** A routine run's report, and the previous reports a new run receives. */
export const FLEET_ROUTINE_RUN_LIMITS = {
  summaryMax: 600,
  pendingMax: 400,
  notesMax: 600,
  finalTextMax: 4_000,
  previousRuns: 3,
  keepPerRoutine: 50,
} as const
export const FLEET_BOT_MEMORY_LIMITS = { contentMax: 4_000, listMax: 200 } as const

/** Bringing a bot what the owner's Mac has: accounts, skills and MCP servers. */
export const FLEET_PROVISIONING_LIMITS = {
  importItemsMax: 50,
  skillFilesMax: 400,
  skillBytesMax: 8 * 1024 * 1024,
  skillFileBytesMax: 4 * 1024 * 1024,
  skillPathMax: 240,
  loginTtlMs: 15 * 60_000,
  callbackBodyMax: 64 * 1024,
} as const
/** JSON body limit for one skill install: 8 MiB of files, base64-encoded, plus paths. */
export const FLEET_SKILL_BODY_MAX = 12 * 1024 * 1024
/** Gateway feature (`/v1/meta`) and bot capability (instance status) the Mac checks before offering provisioning. */
export const FLEET_PROVISIONING_FEATURE = 'provisioning'

/**
 * Gateway feature (`/v1/meta`) and bot capability (instance status) for environments: one container, one Maestrly and
 * one set of accounts, skills, MCP servers and site logins shared by up to `FLEET_ENVIRONMENT_LIMITS.botsMax` bots.
 */
export const FLEET_ENVIRONMENTS_FEATURE = 'environments'
/** Bots per environment, and the range of the container memory limit the owner may set. */
export const FLEET_ENVIRONMENT_LIMITS = {
  botsMax: 8,
  memoryLimitMinBytes: 2 * 1024 ** 3,
  memoryLimitMaxBytes: 64 * 1024 ** 3,
} as const
/**
 * The environment display: a grid of `FLEET_SCREEN`-sized tiles. Tile 0 holds the environment screen (Maestrly's
 * settings); tile k (1 to 8) holds the browser of the bot in slot k.
 */
export const FLEET_ENVIRONMENT_DISPLAY = { columns: 3, rows: 3, width: 3840, height: 2400 } as const
