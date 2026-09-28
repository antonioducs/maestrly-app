import type { FleetInstallerError, FleetInstallerErrorCode } from '../../../shared/fleet-installer'

const DETAIL_MAX = 300

/** A failure the installer explains to the owner by its code; the detail is short and never holds a secret. */
export class InstallerError extends Error {
  readonly detail: string | null
  constructor(
    readonly code: FleetInstallerErrorCode,
    detail: string | null = null
  ) {
    const bounded = detail === null ? null : detail.slice(0, DETAIL_MAX)
    super(bounded ? `${code}: ${bounded}` : code)
    this.name = 'InstallerError'
    this.detail = bounded
  }
}

export function installerErrorOf(error: unknown): FleetInstallerError {
  if (error instanceof InstallerError) return { code: error.code, detail: error.detail }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  return { code: 'unknown', detail: message ? message.slice(0, DETAIL_MAX) : null }
}
