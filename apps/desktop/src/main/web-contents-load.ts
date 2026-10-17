/**
 * `loadURL` and `loadFile` reject when the load does not finish: the view was closed or reused, the app started to
 * quit, or the page failed. Nobody else handles that rejection, and an unhandled one is reported for the whole process.
 */

interface LoadError {
  code?: unknown
  errno?: unknown
}

/** Chromium's net error for a load that a newer navigation or a stop replaced; the replacement is what counts. */
const ABORTED = 'ERR_ABORTED'

function loadErrorCode(error: unknown): string {
  const { code, errno } = (error ?? {}) as LoadError
  const name = typeof code === 'string' && /^ERR_[A-Z_]+$/.test(code) ? code : 'unknown'
  return typeof errno === 'number' ? `${name} (${errno})` : name
}

/**
 * Logs a load that did not finish, by its net error only: the URL can carry a token (an editor's) or a local path.
 * A superseded load is expected and stays quiet.
 */
export function reportLoadFailure(label: string, error: unknown, log: (line: string) => void = console.warn): void {
  if ((error as LoadError | null)?.code === ABORTED) return
  log(
    JSON.stringify({
      component: 'web-contents-load',
      level: 'warn',
      message: 'Load failed',
      label,
      error: loadErrorCode(error),
    })
  )
}

/** Waits for a load and tells whether it finished; a failure is reported, never thrown. */
export async function settleLoad(
  label: string,
  load: Promise<unknown>,
  log?: (line: string) => void
): Promise<boolean> {
  try {
    await load
    return true
  } catch (error) {
    reportLoadFailure(label, error, log)
    return false
  }
}

/** Starts a load nobody waits for, so that its failure is reported instead of left unhandled. */
export function startLoad(label: string, load: Promise<unknown>, log?: (line: string) => void): void {
  void settleLoad(label, load, log)
}
