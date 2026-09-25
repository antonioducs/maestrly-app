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

export function isOwnerMemoryFull(cause: unknown): boolean {
  return /^Owner memory is full\s*\(/.test(fleetErrorMessage(cause))
}
