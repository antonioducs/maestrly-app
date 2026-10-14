export type MoveErrorCode =
  | 'stale'
  | 'running'
  | 'base-unavailable'
  | 'clone-failed'
  | 'package-invalid'
  | 'version-mismatch'
  | 'conversation-exists'
  | 'branch-changed'
  | 'verification-failed'
  | 'host-unavailable'
  | 'already-released'
  | 'transfer-failed'
  | 'remote-only'
  | 'not-found'

/** `code` crosses the bridge: the host's hub forwards a string `code` property of a failed handler. */
export class MoveError extends Error {
  constructor(
    readonly code: MoveErrorCode,
    message: string
  ) {
    super(message)
  }
}

export const moveErrorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

export const moveErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
