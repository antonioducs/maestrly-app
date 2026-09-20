/**
 * Single source of truth for the in-app update state, shared main↔preload↔renderer. Pure module (no
 * Electron/Node imports) so the main-process service, the preload contract and the renderer mirror
 * can all import it without a cycle, and so the semver comparison stays unit-testable in plain Node.
 *
 * The authoritative state lives in the main process (`update-service.ts`); the renderer only mirrors
 * it through `update:state` plus the `update:status` broadcast.
 */

/**
 * Updater state machine:
 *   idle → checking → available → downloading → downloaded
 * `error` is terminal-recoverable: a retry returns to checking/downloading. Installation happens on
 * restart, so there is no `installing` phase to render.
 */
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

/**
 * How this build can update:
 * - `off`: dev/beta/unpackaged/E2E builds never check.
 * - `installer`: electron-updater downloads and swaps the app on restart (macOS zip, NSIS, AppImage).
 * - `notify`: the package cannot self-update (Linux `.deb`); the app only announces the new release.
 */
export type UpdateMode = 'off' | 'installer' | 'notify'

/** Snapshot exposed to the renderer through `update:state` and the `update:status` broadcast. */
export interface UpdateState {
  phase: UpdatePhase
  mode: UpdateMode
  /** Version running right now (`app.getVersion()`). */
  currentVersion: string
  /** Version offered by the feed; present from `available` onward. */
  availableVersion?: string
  releaseNotes?: string
  /** GitHub release page, used by `notify` mode and the Settings section. */
  releaseUrl?: string
  /** Download progress (0–100); present during `downloading`. */
  progressPercent?: number
  /** Epoch milliseconds of the last completed check. */
  lastCheckedAt?: number
  /** Failure message; present in `error`. */
  error?: string
}

export const GITHUB_OWNER = 'antonioducs'
export const GITHUB_REPO = 'maestrly-app'

/** Release page for a version, matching the `v<version>` tags the release workflow pushes. */
export function releasePageUrl(version: string): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${version}`
}

export interface ParsedSemver {
  nums: [number, number, number]
  pre: string[]
}

/** Parse `x.y.z`, `vX.Y.Z` and `x.y.z-beta.N` (build metadata ignored); null when unparseable. */
export function parseSemver(version: string): ParsedSemver | null {
  if (typeof version !== 'string') return null
  const match = version
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

/**
 * SemVer precedence: numbers first, then a release outranks any prerelease, then identifier by
 * identifier (numeric identifiers compare numerically and rank below alphanumeric ones; a shorter
 * identifier list with an equal prefix ranks lower). An unparseable input compares as equal so
 * callers fail open instead of offering or forcing a bogus update.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return 0
  for (let index = 0; index < 3; index++) {
    if (left.nums[index] !== right.nums[index]) return left.nums[index] < right.nums[index] ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index++) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xIsNumeric = /^\d+$/.test(x)
    const yIsNumeric = /^\d+$/.test(y)
    if (xIsNumeric && yIsNumeric) {
      const delta = Number(x) - Number(y)
      if (delta !== 0) return delta < 0 ? -1 : 1
    } else if (xIsNumeric !== yIsNumeric) {
      return xIsNumeric ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Strict `a < b`; the basis for "a newer version is available". */
export function semverLt(a: string, b: string): boolean {
  return compareSemver(a, b) < 0
}
