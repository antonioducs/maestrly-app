import type { FleetRunnerJobLogPage } from '@maestrly/bot-fleet-protocol'

/** How often a live log asks for what was written since. */
export const RUNNER_LOG_POLL_MS = 1_500
/** The most text the viewer keeps; the oldest lines go first. */
export const RUNNER_LOG_MAX_CHARS = 512 * 1024
/** A cut that falls mid-line moves to the next line start if one is this near. */
const LINE_SNAP_CHARS = 4_096

/** Where a job's whole log is saved in its folder once the job ends. */
export const runnerLogPath = (jobId: string | undefined): string => `.maestrly/runner-jobs/${jobId ?? '<jobId>'}.log`

/** Keeps the end of `text`, within `max` characters and starting at a line start where one is near. */
export function fitRunnerLog(text: string, max = RUNNER_LOG_MAX_CHARS): { text: string; dropped: boolean } {
  if (text.length <= max) return { text, dropped: false }
  const cut = text.length - max
  const newline = text.indexOf('\n', cut)
  const from = newline >= 0 && newline - cut < LINE_SNAP_CHARS && newline + 1 < text.length ? newline + 1 : cut
  return { text: text.slice(from), dropped: true }
}

export interface RunnerLogState {
  text: string
  /** Lines before the text are not shown. */
  earlier: boolean
  /** The log was read at least once. */
  loaded: boolean
  /** Why the last read failed; empty after one that worked. */
  error: string
}

export const EMPTY_RUNNER_LOG: RunnerLogState = { text: '', earlier: false, loaded: false, error: '' }

/** What the viewer shows after a page: the first replaces everything, the others follow what is there. */
export function applyRunnerLogPage(state: RunnerLogState, page: FleetRunnerJobLogPage, first: boolean): RunnerLogState {
  const fit = fitRunnerLog(first ? page.text : state.text + page.text)
  return {
    text: fit.text,
    earlier: (first ? page.start > 0 : state.earlier) || fit.dropped,
    loaded: true,
    error: '',
  }
}

/** Where a log is read on from; null until its end was read. It outlives one `followRunnerLog`. */
export interface RunnerLogCursor {
  next: number | null
}

/**
 * Reads a log at once and, while `live`, again every 1.5 seconds from where the last page ended (at once again while a
 * page stopped short of what the log holds). A failed read is reported and, while live, tried again. Without `live` it
 * reads once. The function it returns stops it: a read still under way is dropped.
 */
export function followRunnerLog(options: {
  read(offset: number | null): Promise<FleetRunnerJobLogPage>
  live: boolean
  cursor: RunnerLogCursor
  onPage(page: FleetRunnerJobLogPage, first: boolean): void
  onError(cause: unknown): void
}): () => void {
  const { read, live, cursor, onPage, onError } = options
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async (): Promise<void> => {
    let more = false
    try {
      const offset = cursor.next
      const page = await read(offset)
      if (stopped) return
      // A page that stopped short of what the log holds is followed at once; one that went nowhere is not.
      more = page.next < page.size && page.next > (offset ?? -1)
      cursor.next = page.next
      onPage(page, offset === null)
    } catch (cause) {
      if (stopped) return
      onError(cause)
    }
    if (live) timer = setTimeout(() => void poll(), more ? 0 : RUNNER_LOG_POLL_MS)
  }
  void poll()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
