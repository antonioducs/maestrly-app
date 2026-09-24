/** Error text for the Bots UI: IPC failures arrive wrapped by Electron, so drop that transport prefix. */
const IPC_PREFIX = /^(?:Error:\s*)?Error invoking remote method '[^']*':\s*(?:Error:\s*)?/

/** Stable marker the main process raises when the gateway refuses a takeover with 409. */
export const TAKEOVER_CONFLICT_MARKER = 'FLEET_TAKEOVER_CONFLICT'

export function fleetErrorMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const message = raw.replace(IPC_PREFIX, '').trim()
  return message.length > 0 ? message : raw
}

export function isTakeoverConflict(cause: unknown): boolean {
  if (typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 409) return true
  return fleetErrorMessage(cause).includes(TAKEOVER_CONFLICT_MARKER)
}
