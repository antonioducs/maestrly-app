import { FLEET_ENVIRONMENT_LIMITS } from '@maestrly/bot-fleet-protocol'
import {
  FLEET_ENVIRONMENTS_UNSUPPORTED,
  FLEET_UPDATES_UNSUPPORTED,
  FLEET_RUNTIME_UPDATES_UNSUPPORTED,
  FLEET_SCREEN_CONFLICT,
  FLEET_SCREEN_OFFLINE,
  FLEET_SCREEN_RESTART_REQUIRED,
} from '../../../shared/fleet-targets'

/** Error text for the Bots UI: IPC failures arrive wrapped by Electron, so drop that transport prefix. */
// Main-process errors arrive as "<Class>: message"; gateway failures are FleetClientError instances.
const IPC_PREFIX = /^(?:Error:\s*)?Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/

/** Stable marker the main process raises when the gateway refuses a takeover with 409. */
export const TAKEOVER_CONFLICT_MARKER = 'FLEET_TAKEOVER_CONFLICT'

export function fleetErrorMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const message = raw.replace(IPC_PREFIX, '').trim()
  return message.length > 0 ? message : raw
}

/** Stable marker the main process raises when the bot answers 404 for an image (evicted or unknown). */
export const IMAGE_NOT_FOUND_MARKER = 'FLEET_IMAGE_NOT_FOUND'

export function isImageNotFound(cause: unknown): boolean {
  return fleetErrorMessage(cause).includes(IMAGE_NOT_FOUND_MARKER)
}

export function isTakeoverConflict(cause: unknown): boolean {
  if (typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 409) return true
  return fleetErrorMessage(cause).includes(TAKEOVER_CONFLICT_MARKER)
}

/** The server predates environments and must be updated before this action. */
export function isEnvironmentsUnsupported(cause: unknown): boolean {
  return fleetErrorMessage(cause).includes(FLEET_ENVIRONMENTS_UNSUPPORTED)
}

/** The server cannot schedule environment updates yet and must be updated first. */
export function isEnvironmentUpdatesUnsupported(cause: unknown): boolean {
  return fleetErrorMessage(cause).includes(FLEET_UPDATES_UNSUPPORTED)
}

/** Another control session holds the environment display that its browser areas and its screen share. */
export function isScreenConflict(cause: unknown): boolean {
  return fleetErrorMessage(cause).includes(FLEET_SCREEN_CONFLICT)
}

/** The environment runs an image from before environments, without this screen until it restarts. */
export function isScreenRestartRequired(cause: unknown): boolean {
  return fleetErrorMessage(cause).includes(FLEET_SCREEN_RESTART_REQUIRED)
}

/** The screen's bot or environment stopped before the gateway issued its ticket. */
export function isScreenOffline(cause: unknown): boolean {
  return fleetErrorMessage(cause).includes(FLEET_SCREEN_OFFLINE)
}

export function isOwnerMemoryFull(cause: unknown): boolean {
  return /^Owner memory is full\s*\(/.test(fleetErrorMessage(cause))
}

type Translate = (key: string, options?: Record<string, unknown>) => string
type KnownRefusal = { matches: (message: string) => boolean; key: string; values?: Record<string, unknown> }

const exactly = (text: string) => (message: string) => message === text
const marked = (marker: string) => (message: string) => message.includes(marker)
/**
 * Refusals the owner can act on, and the hint the Bots UI shows for each. IPC keeps only an error's message, so they
 * are recognized by the markers the main process raises or by the gateway's exact messages; any other failure keeps
 * its own text.
 */
const KNOWN_REFUSALS: KnownRefusal[] = [
  { matches: marked(FLEET_ENVIRONMENTS_UNSUPPORTED), key: 'provisioning.updateServer' },
  { matches: marked(FLEET_UPDATES_UNSUPPORTED), key: 'updates.unsupported' },
  { matches: marked(FLEET_RUNTIME_UPDATES_UNSUPPORTED), key: 'environment.runtimes.unsupported' },
  {
    matches: exactly('Restart this environment to update it before checking its runtimes.'),
    key: 'environment.runtimes.restart',
  },
  { matches: exactly('Start the environment to update it'), key: 'errors.environmentNotRunning' },
  { matches: marked(FLEET_SCREEN_CONFLICT), key: 'screen.conflict' },
  { matches: marked(FLEET_SCREEN_RESTART_REQUIRED), key: 'screen.restartEnvironment' },
  { matches: marked(FLEET_SCREEN_OFFLINE), key: 'errors.screenOffline' },
  {
    matches: exactly('Restart this environment to update it before opening this screen.'),
    key: 'screen.restartEnvironment',
  },
  { matches: exactly('Restart this environment to update it before adding bots.'), key: 'environment.restartToJoin' },
  {
    matches: exactly('Restart this environment to update it before choosing its compaction model.'),
    key: 'environment.compaction.restart',
  },
  {
    matches: (message) => /^This environment already has (?:\d+ bots|the most bots it can hold)\.$/.test(message),
    key: 'errors.environmentFull',
    values: { max: FLEET_ENVIRONMENT_LIMITS.botsMax },
  },
  {
    matches: exactly('This bot shares its environment. Restart the environment instead.'),
    key: 'errors.sharedEnvironment',
  },
  { matches: exactly('Restore its environment first'), key: 'errors.restoreEnvironmentFirst' },
  { matches: exactly('Start its environment first'), key: 'errors.startEnvironmentFirst' },
  { matches: exactly('Its display slot is still in use. Start the bot again to retry.'), key: 'errors.slotInUse' },
  {
    matches: exactly('Restart this environment to update it before configuring it from the Mac.'),
    key: 'provisioning.restartEnvironment',
  },
  {
    matches: exactly('Restart this bot to update it before configuring it from the Mac.'),
    key: 'provisioning.restartBot',
  },
  { matches: exactly('Environment not running'), key: 'errors.environmentNotRunning' },
  { matches: exactly('Bot not running'), key: 'errors.botNotRunning' },
]

/** The text the Bots UI shows for a failure: a localized hint for a known refusal, else the failure's own message. */
export function fleetErrorText(cause: unknown, t: Translate): string {
  const message = fleetErrorMessage(cause)
  const known = KNOWN_REFUSALS.find((refusal) => refusal.matches(message))
  return known ? t(known.key, known.values) : message
}
