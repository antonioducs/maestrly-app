// How the viewer keeps a whiteboard's canvas current: one request for changes after another, from the newest revision
// it knows, waiting longer after each failure. No DOM here, so it is tested on its own.
import type { BoardError } from './contract.js'

const FIRST_RETRY_MS = 1000
const LONGEST_RETRY_MS = 30_000

export interface BoardPoller {
  /** The next request to make, after how long; null once the board is gone. */
  next(): { since: number; delayMs: number } | null
  /** How the last request went: its status (0 when it never got an answer) and the revision it reported. */
  result(reply: { status: number; revision?: number }): void
}

export function createBoardPoller(): BoardPoller {
  let since = 0
  let failures = 0
  let stopped = false
  return {
    next() {
      if (stopped) return null
      const delayMs = failures ? Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(failures - 1, 16)) : 0
      return { since, delayMs }
    },
    result({ status, revision }) {
      if (stopped) return
      if (status === 404) {
        stopped = true
        return
      }
      if (status !== 200) {
        failures++
        return
      }
      failures = 0
      if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) since = revision
    },
  }
}

/** What a canvas learns when the host refuses what it sent or asked for. */
export function boardError(status: number): BoardError {
  if (status === 403) return 'read_only'
  if (status === 400) return 'invalid'
  if (status === 413) return 'too_large'
  if (status === 409) return 'full'
  if (status === 429) return 'rate_limited'
  if (status === 404) return 'unavailable'
  return 'failed'
}
