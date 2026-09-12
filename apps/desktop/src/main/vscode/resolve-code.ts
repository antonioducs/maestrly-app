import { accessSync, constants } from 'node:fs'
import os from 'node:os'
import { isWin, winCliCandidates, whichBin } from '../platform'

const HOME = os.homedir()

/**
 * Resolve installed official code CLI for Open in VS Code. Embedded editing uses its own downloaded
 * CLI and does not depend on this. Handle GUI PATH and Windows shims plus platform candidates; return
 * null to hide the action when unavailable.
 */
let cached: string | null = null

export function resolveCode(): string | null {
  if (cached) return cached

  const candidates = isWin
    ? winCliCandidates('code')
    : [
        '/usr/local/bin/code',
        '/opt/homebrew/bin/code',
        '/usr/bin/code',
        '/usr/share/code/bin/code',
        '/snap/bin/code',
        `${HOME}/.local/bin/code`,
      ]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      cached = candidate
      return cached
    } catch {
      /* Try the next candidate. */
    }
  }

  const found = whichBin('code')
  if (found) {
    cached = found
    return cached
  }

  return null
}
