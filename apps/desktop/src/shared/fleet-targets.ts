import type { FleetCreateEnvironmentRequest, FleetScreenSurface } from '@maestrly/bot-fleet-protocol'

/** What the owner chooses for a new workspaces environment; anything omitted takes the server's default. */
export type FleetCreateWorkspacesInput = Partial<
  Pick<FleetCreateEnvironmentRequest, 'name' | 'memoryLimitBytes' | 'cpuLimit' | 'idleStopMinutes' | 'tint'>
>

/**
 * Where the Mac sends accounts, skills, MCP servers and sign-ins: an environment, shared by its bots, or a bot. On
 * gateways with environments a bot's routes act on its environment; older gateways only know bots.
 */
export type FleetProvisioningTarget = { environmentId: string } | { botId: string }
/** A bare string is a bot id, as the views from before environments pass it. */
export type FleetProvisioningTargetInput = FleetProvisioningTarget | string

/**
 * A screen: a bot's browser or apps area, an environment's own screen (its Maestrly settings window), or a workspaces
 * conversation's computer (`apps`) or browser tile (`browser`), by its id on the host.
 */
export type FleetScreenTarget =
  | { botId: string; surface: FleetScreenSurface }
  | { environmentId: string }
  | { environmentId: string; conversationId: string; surface: FleetScreenSurface }
/** A bare string is a bot's browser area, as the views from before environments open it. */
export type FleetScreenTargetInput = FleetScreenTarget | string

/** Environments and bots can share an id (an existing bot became the environment with its id): keys name the kind. */
export function fleetTargetKey(target: FleetProvisioningTargetInput): string {
  if (typeof target === 'string') return 'bot:' + target
  return 'environmentId' in target ? 'environment:' + target.environmentId : 'bot:' + target.botId
}

/** Raised by the main process when the gateway predates environments; IPC keeps only an error's message. */
export const FLEET_ENVIRONMENTS_UNSUPPORTED = 'FLEET_ENVIRONMENTS_UNSUPPORTED'
/** Raised by the main process when the gateway cannot schedule environment updates yet. */
export const FLEET_UPDATES_UNSUPPORTED = 'FLEET_UPDATES_UNSUPPORTED'
/**
 * Raised by the main process when the gateway cannot set the CPU limit, idle stop, tint or folder of an environment
 * yet (`workspaces-environments`).
 */
export const FLEET_SCOPES_UNSUPPORTED = 'FLEET_SCOPES_UNSUPPORTED'
/** Raised by the main process when the gateway cannot report or check the environments' runtimes yet. */
export const FLEET_RUNTIME_UPDATES_UNSUPPORTED = 'FLEET_RUNTIME_UPDATES_UNSUPPORTED'
/** Raised when another control session holds the environment display that browser areas and its screen share. */
export const FLEET_SCREEN_CONFLICT = 'FLEET_SCREEN_CONFLICT'
/** Raised when an environment still runs an image from before environments: restarting it updates it. */
export const FLEET_SCREEN_RESTART_REQUIRED = 'FLEET_SCREEN_RESTART_REQUIRED'
/** Raised when the gateway predates video screens (`video-screens`): updating the bot server opens them again. */
export const FLEET_SCREEN_UPDATE_REQUIRED = 'FLEET_SCREEN_UPDATE_REQUIRED'
/** Raised when the bot or environment of a screen stopped before the gateway could issue its ticket. */
export const FLEET_SCREEN_OFFLINE = 'FLEET_SCREEN_OFFLINE'
/** Raised when the gateway cannot list or remove paired devices yet (`devices`). */
export const FLEET_DEVICES_UNSUPPORTED = 'FLEET_DEVICES_UNSUPPORTED'
/** Raised when the gateway or the bot cannot edit messages yet (`message-edit`). */
export const FLEET_EDIT_UNSUPPORTED = 'FLEET_EDIT_UNSUPPORTED'
/** Raised when the gateway cannot move bots between environments yet (`bot-move`). */
export const FLEET_BOT_MOVE_UNSUPPORTED = 'FLEET_BOT_MOVE_UNSUPPORTED'
/** Where the renderer asks to move a bot: an existing bots environment, or a new one by its name. */
export type FleetMoveBotInput = { environmentId: string } | { newEnvironment: { name: string } }
/** Raised when the bot refuses an edit: it is busy, or the message is no longer its last one. */
export const FLEET_EDIT_CONFLICT = 'FLEET_EDIT_CONFLICT'
/** Raised when the gateway or the bot cannot keep routine runs in conversations of their own yet. */
export const FLEET_RUNS_UNSUPPORTED = 'FLEET_RUNS_UNSUPPORTED'
/** Raised when a routine run's conversation cannot change now: it is working, or it is gone. */
export const FLEET_RUN_CONFLICT = 'FLEET_RUN_CONFLICT'
/** Raised when the gateway or the bot cannot keep conversations with other bots apart yet (`peer-conversations`). */
export const FLEET_PEER_THREADS_UNSUPPORTED = 'FLEET_PEER_THREADS_UNSUPPORTED'
/** Raised when a thread's conversation cannot change now: it is working, or it is gone. */
export const FLEET_PEER_THREAD_CONFLICT = 'FLEET_PEER_THREAD_CONFLICT'
/** Raised when the gateway or the bot cannot list, delete or size the files the bot shared yet (`files-manage`). */
export const FLEET_FILES_MANAGE_UNSUPPORTED = 'FLEET_FILES_MANAGE_UNSUPPORTED'
