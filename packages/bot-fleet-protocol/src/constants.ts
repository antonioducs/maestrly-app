export const FLEET_PROTOCOL_VERSION = 1 as const
export const FLEET_PROTOCOL_HEADER = 'X-Maestrly-Fleet-Protocol' as const
/** The upgrade token of a screen connection: the video stream of `screen-stream.ts`. */
export const FLEET_SCREEN_UPGRADE = 'maestrly-video' as const

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
 * `intervalTokens` of new conversation, and the same model compacts on the spot when no prepared summary fits. The owner
 * may also cap the conversation's context window below its model's (`contextLimitTokens`) to bound what each turn costs.
 */
export const FLEET_COMPACTION_LIMITS = {
  intervalTokensMin: 10_000,
  intervalTokensMax: 1_000_000,
  intervalTokensDefault: 100_000,
  contextLimitTokensMin: 100_000,
  contextLimitTokensMax: 10_000_000,
} as const
/** A compaction summary shown in the transcript is cut here (the bot keeps the whole summary). */
export const FLEET_COMPACTION_SUMMARY_MAX = 16_000
export const FLEET_PEER_MESSAGE_MAX = 4_000
export const FLEET_TOOL_OUTPUT_MAX = 400
/** The to-do list a bot keeps with todo_write, shown to the owner as a checklist; longer lists and items are cut. */
export const FLEET_TODO_LIMITS = { itemsMax: 50, contentMax: 500 } as const
/** Reasoning shown in the transcript is cut here (the bot keeps all of it). */
export const FLEET_REASONING_TEXT_MAX = 16_000
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
/** Gateway and instance capability for document attachments and private file downloads. */
export const FLEET_FILES_FEATURE = 'files'
export const FLEET_FILE_LIMITS = {
  pdfMaxBytes: 10 * 1024 * 1024,
  pdfsMax: 4,
  textMaxBytes: 256 * 1024,
  attachmentsMax: 8,
  attachmentsTotalMaxBytes: 20 * 1024 * 1024,
  downloadMaxBytes: 100 * 1024 * 1024,
  publishedTotalMaxBytes: 1024 * 1024 * 1024,
  publishedCountMax: 200,
} as const
/** JSON body limit for routes that carry base64 attachments (20 MiB of images, base64-encoded, plus text). */
export const FLEET_MESSAGE_BODY_MAX = 28 * 1024 * 1024

export const FLEET_ARTIFACTS_FEATURE = 'artifacts'
/** The gateway also serves the artifact viewer on its public port, so one address reaches bots and artifacts. */
export const FLEET_ARTIFACTS_GATEWAY_VIEWER_FEATURE = 'artifacts-gateway-viewer'
/** A paired device can move an artifact in with its ID, history and comments (`exportArtifact`, `importArtifact`). */
export const FLEET_ARTIFACTS_TRANSFER_FEATURE = 'artifacts-transfer'
/** JSON body limit for artifact uploads, including base64 encoding. */
export const FLEET_ARTIFACT_BODY_MAX = 72 * 1024 * 1024

export const FLEET_PORTS = {
  artifacts: 4010,
  public: 7443,
  internal: 7444,
  instanceControl: 7680,
} as const

export const FLEET_SCREEN = { width: 1280, height: 800 } as const

export const FLEET_GATEWAY_ENV = {
  dataDir: 'MAESTRLY_GATEWAY_DATA_DIR',
  displayName: 'MAESTRLY_GATEWAY_DISPLAY_NAME',
  publicHost: 'MAESTRLY_GATEWAY_PUBLIC_HOST',
  publicPort: 'MAESTRLY_GATEWAY_PUBLIC_PORT',
  internalPort: 'MAESTRLY_GATEWAY_INTERNAL_PORT',
  artifactsPort: 'MAESTRLY_GATEWAY_ARTIFACTS_PORT',
  artifactsHost: 'MAESTRLY_GATEWAY_ARTIFACTS_HOST',
  internalUrl: 'MAESTRLY_GATEWAY_INTERNAL_URL',
  botImage: 'MAESTRLY_GATEWAY_BOT_IMAGE',
  network: 'MAESTRLY_GATEWAY_NETWORK',
  dockerSocket: 'MAESTRLY_GATEWAY_DOCKER_SOCKET',
  botMemory: 'MAESTRLY_GATEWAY_BOT_MEMORY',
  botEgress: 'MAESTRLY_GATEWAY_BOT_EGRESS',
  botShm: 'MAESTRLY_GATEWAY_BOT_SHM',
  /**
   * A directory of the Docker host whose subfolders the gateway mounts into its workspaces environments, each at the
   * same path.
   */
  workspacesRoot: 'MAESTRLY_GATEWAY_WORKSPACES_ROOT',
  /**
   * The gateway's own container (name or id), which joins the network of each workspaces environment. Unset: the
   * gateway finds it on the fleet network by its own address.
   */
  container: 'MAESTRLY_GATEWAY_CONTAINER',
  /** `off` stops bots from updating Claude Code and Codex on their own; manual checks in a bot still work. */
  botRuntimeUpdates: 'MAESTRLY_GATEWAY_BOT_RUNTIME_UPDATES',
  /** `off` sends no push notifications to phones; `expo` (the default) sends them through Expo's push service. */
  push: 'MAESTRLY_GATEWAY_PUSH',
  /** An Expo access token, when the Expo account requires one for push notifications. */
  expoAccessToken: 'MAESTRLY_GATEWAY_EXPO_ACCESS_TOKEN',
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
  egress: 'MAESTRLY_BOT_EGRESS',
  /** Set instead of `mode` in a workspaces environment: the full Maestrly, driven from the owner's computers. */
  serverMode: 'MAESTRLY_SERVER_MODE',
  /** The server folder mounted into a workspaces environment (its own, or the shared root), when the gateway has one. */
  workspacesRoot: 'MAESTRLY_WORKSPACES_ROOT',
  /**
   * The token a workspaces environment publishes its chats' artifacts with on the gateway's internal API. It is not
   * `gatewayToken`, which images from before environments read as the token of their one bot.
   */
  hostGatewayToken: 'MAESTRLY_HOST_GATEWAY_TOKEN',
  runtimeUpdates: 'MAESTRLY_BOT_RUNTIME_UPDATES',
} as const

export const FLEET_BOT_EGRESS_MODES = ['open', 'public'] as const
export type FleetBotEgress = (typeof FLEET_BOT_EGRESS_MODES)[number]

/** Whether bots check for and install new Claude Code and Codex releases on their own. */
export const FLEET_BOT_RUNTIME_UPDATE_MODES = ['auto', 'off'] as const
export type FleetBotRuntimeUpdates = (typeof FLEET_BOT_RUNTIME_UPDATE_MODES)[number]

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
/**
 * Gateway feature (`/v1/meta`): environments have a default compaction model that their bots without one of their own
 * inherit. As an instance capability: the instance lists its environment's model options.
 */
export const FLEET_ENVIRONMENT_COMPACTION_FEATURE = 'environment-compaction'
/**
 * Gateway feature (`/v1/meta`): an environment update can wait for the environment's bots to be idle, and each
 * environment reports whether its container runs an older image than the configured one.
 */
export const FLEET_ENVIRONMENT_UPDATES_FEATURE = 'environment-updates'
/**
 * Gateway feature (`/v1/meta`) and bot capability (instance health and status): transcripts carry the model's
 * reasoning as `reasoning` items. A bot and a gateway send them only to a reader that asks with `reasoning=1` on the
 * transcript and event routes, so an older gateway or Mac never receives an item kind it cannot read.
 */
export const FLEET_TRANSCRIPT_REASONING_FEATURE = 'transcript-reasoning'
/** The query parameter a reader of transcripts and events sets to `1` to receive `reasoning` items. */
export const FLEET_REASONING_QUERY = 'reasoning'
/**
 * Gateway feature (`/v1/meta`) and instance capability: the owner may edit their last message to an idle bot. The
 * bot's conversation is cut from that message and the edited text runs as a new turn.
 */
export const FLEET_MESSAGE_EDIT_FEATURE = 'message-edit'
/**
 * Gateway feature (`/v1/meta`) and instance capability: an environment reports the versions of its Claude Code and
 * Codex runtimes and can be asked to check for newer releases.
 */
export const FLEET_RUNTIME_UPDATES_FEATURE = 'runtime-updates'
/**
 * Instance capability: each bot has one desktop, its apps display, where the environment's Maestrly browser is
 * presented beside its other programs. Screens open its `apps` surface; images without it keep separate Browser and
 * Apps areas.
 */
export const FLEET_UNIFIED_DESKTOP_FEATURE = 'unified-desktop'
/**
 * Gateway feature (`/v1/meta`) and instance capability: screens stream as acknowledged H.264 video
 * (`FLEET_SCREEN_UPGRADE`, see `screen-stream.ts`). Gateways refuse screens of environments without it, which restart
 * onto a newer image first; apps refuse screens through gateways without it.
 */
export const FLEET_VIDEO_SCREENS_FEATURE = 'video-screens'
export const FLEET_RUNTIME_IDS = ['claude-code', 'codex', 'antigravity-acp'] as const
/** The release channel of a runtime, as the desktop reports it (`RuntimeAssetUpdateState`). */
export const FLEET_RUNTIME_STATES = [
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'verifying',
  'installing',
  'validating',
  'rolling-back',
  'failed',
] as const
/** Bot statuses that a restart of their environment would interrupt: an update waits while any bot has one. */
export const FLEET_UPDATE_BUSY_STATUSES = ['working', 'waiting', 'human'] as const
/**
 * Gateway feature (`/v1/meta`): compaction configs carry `contextLimitTokens`. As an instance capability: the instance
 * caps its bots' conversations at it; a running image without it ignores the limit until its environment restarts.
 */
export const FLEET_CONTEXT_LIMIT_FEATURE = 'context-limit'
/**
 * Gateway feature (`/v1/meta`): an environment can host workspaces (kind `workspaces`) and paired computers can open a
 * bridge to it. As an instance capability: the image runs Maestrly in server mode and serves that bridge.
 */
export const FLEET_WORKSPACES_HOST_FEATURE = 'workspaces-host'
/**
 * Gateway feature (`/v1/meta`): paired computers move files to and from a workspaces environment through the gateway.
 * As an instance capability: the environment's Maestrly serves those files.
 */
export const FLEET_HOST_FILES_FEATURE = 'host-files'
/**
 * Gateway feature (`/v1/meta`): the gateway passes the folder-archive routes of host files through. As an instance
 * capability: the environment's Maestrly packs folders for download and extracts uploaded folders.
 */
export const FLEET_HOST_FILES_FOLDERS_FEATURE = 'host-files-folders'
/**
 * Gateway feature (`/v1/meta`): a server hosts several workspaces environments, one per scope of the owner's work, each
 * with a Docker network and a server folder of its own, and every environment may have a CPU limit, a tint and (for
 * workspaces) an idle stop.
 */
export const FLEET_WORKSPACES_ENVIRONMENTS_FEATURE = 'workspaces-environments'
/**
 * Instance capability: a workspaces host gives its conversations computers of their own, and streams a conversation's
 * browser from its tile of the environment display. Not a gateway feature: a gateway serves conversation screens once
 * it knows the conversation screen ticket route.
 */
export const FLEET_CONVERSATION_COMPUTERS_FEATURE = 'conversation-computers'
/**
 * A workspaces host's computers: as many as the environment display has tiles for browsers, given back once idle for
 * `idleMs` (checked every `checkEveryMs`), on X display numbers from `firstDisplay` to `lastDisplay`, one per
 * conversation, so they never meet a bot's display numbers (its slot).
 */
export const FLEET_CONVERSATION_COMPUTER_LIMITS = {
  slots: 8,
  idleMs: 60_000,
  checkEveryMs: 5_000,
  firstDisplay: 10,
  lastDisplay: 4095,
} as const
/** Where a workspaces environment's control server accepts the bridge, as a WebSocket upgrade. */
export const FLEET_INSTANCE_BRIDGE_PATH = '/v1/bridge'
/**
 * A bridge ticket is one-use and short-lived; each paired computer holds a bounded number of bridges: one per
 * workspaces environment, with room for those still closing while their replacements open.
 */
export const FLEET_BRIDGE_LIMITS = { ticketTtlMs: 30_000, perDevice: 16 } as const
/**
 * Bots per environment; workspaces environments per server; and the ranges of the container memory limit, the CPU
 * limit (in CPUs) and the idle stop (in minutes) the owner may set.
 */
export const FLEET_ENVIRONMENT_LIMITS = {
  botsMax: 8,
  workspacesMax: 8,
  memoryLimitMinBytes: 2 * 1024 ** 3,
  memoryLimitMaxBytes: 64 * 1024 ** 3,
  cpuLimitMin: 0.5,
  cpuLimitMax: 64,
  idleStopMinutesMin: 15,
  idleStopMinutesMax: 7 * 24 * 60,
} as const
/**
 * The environment display: a grid of `FLEET_SCREEN`-sized tiles. Tile 0 holds the environment screen (Maestrly's
 * settings); tile k (1 to 8) holds the browser of the bot in slot k.
 */
export const FLEET_ENVIRONMENT_DISPLAY = { columns: 3, rows: 3, width: 3840, height: 2400 } as const

/** Typed, revision-aware environment configuration, independent of any bot. */
export const FLEET_ENVIRONMENT_SETTINGS_FEATURE = 'environment-settings-v1'
/**
 * Gateway feature (`/v1/meta`) and instance capability: an environment installs and manages plugins (from Git, on its
 * own) and keeps the OAuth sign-ins of its remote MCP servers, which the owner's computer runs in its browser.
 */
export const FLEET_ENVIRONMENT_PLUGINS_FEATURE = 'environment-plugins-v1'
/**
 * Gateway feature (`/v1/meta`) and instance capability: an environment's settings read and set the order in which its
 * Claude and Codex subscription accounts take over a turn once one reaches its usage limit (`failover`,
 * `setFailoverRoute`). An older gateway or image has no such routes.
 */
export const FLEET_ACCOUNT_FAILOVER_FEATURE = 'account-failover'

/**
 * Gateway feature (`/v1/meta`) and instance capability: a bot reaches the workspaces of the Macs that gave it access,
 * one Mac at a time, through each Mac's own event stream. Every Mac decides on its own: the gateway only keeps which
 * Macs linked which bot and routes a call to the one it names; grants, conversations and worktrees stay on the Mac.
 */
export const FLEET_DESKTOP_BRIDGE_FEATURE = 'desktop-bridge'
/** The query parameter a device's event stream sets to `1` to receive desktop calls: it is then online for its bots. */
export const FLEET_DESKTOP_BRIDGE_QUERY = 'desktopBridge'
/**
 * Gateway feature (`moreFeatures` of `/v1/meta`) and workspaces host capability: a bot reaches the workspaces of a
 * workspaces environment of its server as it reaches a computer's, through the desktop_* tools. The host links the bot
 * itself, with its host token, once the owner gives the bot access there; the gateway sends each call to the host's
 * control server. Grants, conversations and worktrees stay on the host.
 */
export const FLEET_HOST_DESKTOP_CALLS_FEATURE = 'host-desktop-calls'
/**
 * How long the gateway waits for a Mac to answer one call (a wait for conversation events takes up to 20 s on the
 * Mac), how many calls of one bot may wait at once, how many Macs may link one bot, and the size of what crosses.
 */
export const FLEET_DESKTOP_BRIDGE_LIMITS = {
  callTimeoutMs: 25_000,
  pendingPerBotMax: 16,
  linksPerBotMax: 20,
  nameMax: 60,
  inputBytesMax: 320 * 1024,
  resultBytesMax: 2 * 1024 * 1024,
} as const

/**
 * Gateway feature: what phones need of the gateway. A paired device may create one-use pairing codes for another
 * device, which the desktop shows as a QR code; a bridge ticket may name the Origin its WebSocket will send, which
 * phones always send; and phones register for push notifications (`/v1/devices/self/push`). These ship together, so
 * they are one feature, announced in `moreFeatures` of `/v1/meta`.
 */
export const FLEET_PHONES_FEATURE = 'phones'
/**
 * Gateway feature: a paired device lists the devices paired with the server, and removes another one
 * (`/v1/devices`), as the CLI's `devices list` and `devices revoke` do. Announced in `moreFeatures` of `/v1/meta`.
 */
export const FLEET_DEVICES_FEATURE = 'devices'
/** Unused, unexpired codes paired devices may have at once. The CLI is not limited. */
export const FLEET_ACTIVE_PAIRINGS_MAX = 5
/** Workspaces host capability: it speaks the mobile API (`mobile:v1:*` channels) to phones over the bridge. */
export const FLEET_MOBILE_HOST_FEATURE = 'mobile-api'

/** A gateway reading an environment's events with this query set to 1 also gets `chat.attention` events. */
export const FLEET_CHAT_ATTENTION_QUERY = 'chatAttention'

/**
 * Gateway feature (`moreFeatures` of `/v1/meta`) and instance capability: a bot moves to another bots environment of
 * its server under its own id, with everything that is its own (conversation, queue, files, images, memory, settings
 * and browser profile). The gateway moves it only between environments whose Maestrly has the capability, and streams
 * its package from one to the other; the accounts, skills and MCP servers of each environment stay where they are.
 */
export const FLEET_BOT_MOVE_FEATURE = 'bot-move'
/** The largest package a bot moves in, and how long one leg of its transfer (export or import) may take. */
export const FLEET_BOT_MOVE_LIMITS = { packageMaxBytes: 32 * 1024 ** 3, transferTimeoutMs: 2 * 60 * 60_000 } as const
/** The header that carries a bot move package's SHA-256 (hex) with its bytes, on both legs of its transfer. */
export const FLEET_BOT_MOVE_SHA256_HEADER = 'X-Maestrly-Package-Sha256'
