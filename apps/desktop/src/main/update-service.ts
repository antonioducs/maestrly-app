import { app, net, shell } from 'electron'
// electron-updater is CommonJS while the main process is bundled as ESM with the dependency
// externalized, so a named import would fail to resolve at load time. Default import plus LAZY
// singleton access is the supported pattern: reading `electronUpdater.autoUpdater` instantiates the
// updater, and its constructor touches `app.getVersion()`, which must not run at module load.
import electronUpdater from 'electron-updater'
import { getChannel } from './channel'
import { getAppSetting, setAppSetting } from './store'
import { isE2E } from './test-mode'
import { broadcast } from './window-ipc'
import { GITHUB_OWNER, GITHUB_REPO, releasePageUrl, semverLt, type UpdatePhase, type UpdateState } from '../shared/update'

let updaterSingleton: typeof electronUpdater.autoUpdater | undefined
function au(): typeof electronUpdater.autoUpdater {
  return (updaterSingleton ??= electronUpdater.autoUpdater)
}

/**
 * AUTO-UPDATE — source of truth for the update state in the main process. The renderer only mirrors
 * it through `update:state` plus the `update:status` broadcast.
 *
 * Two shapes over the same state:
 *  - `installer` (macOS zip, Windows NSIS, Linux AppImage): electron-updater checks on launch and
 *    every six hours; the download starts only under explicit consent and the swap happens on the
 *    next restart. "Skip" persists the version so its banner never returns.
 *  - `notify` (Linux `.deb`, which cannot self-update): the same schedule reads the GitHub releases
 *    API and only announces the new version, linking to its release page.
 *
 * HARD GATE: the real updater runs only in packaged `prod` builds outside E2E. Development exercises
 * the UI through `AGENTS_UPDATE_FIXTURE=available|downloading|downloaded|notify`, which simulates the
 * state without any feed. Every failure is fail-open: it records `phase: 'error'` and never blocks.
 */

export const UPDATE_SKIP_KEY = 'update.skippedVersion'

const BOOT_DELAY_MS = 10_000
const PERIOD_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
/** An updater that never answers must not hold the IPC call open forever. */
const CHECK_TIMEOUT_MS = 30_000
const FIXTURE_VERSION = '0.0.0-fixture'
const LATEST_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

let state: UpdateState = { phase: 'idle', mode: 'off', currentVersion: app.getVersion() }
/** Development simulation: no feed, no timers, no real updater. */
let fixture: string | null = null
/** The quit came from `installUpdate()`, so the quit confirmation is skipped. */
let installing = false
let installLaunched = false
let bootTimer: ReturnType<typeof setTimeout> | null = null
let periodic: ReturnType<typeof setInterval> | null = null
let pendingCheck: { resolve: (snapshot: UpdateState) => void; ignoreSkip: boolean; timer: ReturnType<typeof setTimeout> } | null =
  null

type UpdaterEventHandler = (payload?: unknown) => void
const attachedListeners: { event: string; handler: UpdaterEventHandler }[] = []

// ── state ────────────────────────────────────────────────────────────────────────────────────────

function setState(patch: Partial<UpdateState>): UpdateState {
  state = { ...state, ...patch }
  broadcast('update:status', state)
  return state
}

export function getUpdateState(): UpdateState {
  return state
}

export function isInstalling(): boolean {
  return installing
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unrefTimer(timer: { unref?: () => unknown }): void {
  if (typeof timer.unref === 'function') timer.unref()
}

function skippedVersion(): string | null {
  try {
    const value = getAppSetting(UPDATE_SKIP_KEY)
    return value && value.length > 0 ? value : null
  } catch {
    return null
  }
}

function writeSkippedVersion(version: string): void {
  try {
    setAppSetting(UPDATE_SKIP_KEY, version)
  } catch (error) {
    console.warn('[update] could not persist the skipped version:', errorMessage(error))
  }
}

/** Release notes arrive as plain text or as a list of per-version entries. */
function notesToString(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    const joined = notes
      .map((entry) => (typeof entry === 'string' ? entry : ((entry as { note?: string | null })?.note ?? '')))
      .filter((note) => note.length > 0)
      .join('\n')
    return joined.length > 0 ? joined : undefined
  }
  return undefined
}

/**
 * Apply a version found in the feed. A version the user skipped stays silent until a newer one
 * appears, which also clears the skip; a manual check ignores the skip without discarding it.
 */
function applyAvailable(
  version: string,
  notes: string | undefined,
  url: string,
  ignoreSkip: boolean
): UpdateState {
  const skipped = skippedVersion()
  if (skipped && semverLt(skipped, version)) writeSkippedVersion('')
  else if (!ignoreSkip && skipped === version) return setState({ phase: 'idle', lastCheckedAt: Date.now() })

  return setState({
    phase: 'available',
    availableVersion: version,
    releaseNotes: notes,
    releaseUrl: url,
    progressPercent: undefined,
    error: undefined,
    lastCheckedAt: Date.now(),
  })
}

function failWith(message: string): UpdateState {
  console.warn('[update]', message)
  const snapshot = setState({ phase: 'error', error: message, lastCheckedAt: Date.now() })
  resolveCheck()
  return snapshot
}

function resolveCheck(): void {
  if (!pendingCheck) return
  const { resolve, timer } = pendingCheck
  pendingCheck = null
  clearTimeout(timer)
  resolve(state)
}

// ── mode ─────────────────────────────────────────────────────────────────────────────────────────

/** Fixtures exist only for development; a packaged build never simulates an update. */
function resolveFixture(): string | null {
  const raw = process.env.AGENTS_UPDATE_FIXTURE?.trim()
  if (!raw) return null
  return getChannel() === 'dev' ? raw : null
}

function resolveMode(simulated: string | null): UpdateState['mode'] {
  if (simulated) return simulated === 'notify' ? 'notify' : 'installer'
  if (!app.isPackaged || isE2E() || getChannel() !== 'prod') return 'off'
  // electron-updater only replaces the AppImage on Linux; `.deb` installs are managed by the system.
  if (process.platform === 'linux' && !process.env.APPIMAGE) return 'notify'
  return 'installer'
}

// ── updater listeners ────────────────────────────────────────────────────────────────────────────

function listen(event: string, handler: UpdaterEventHandler): void {
  attachedListeners.push({ event, handler })
  ;(au() as unknown as NodeJS.EventEmitter).on(event, handler)
}

function removeListeners(): void {
  if (attachedListeners.length === 0) return
  const updater = au() as unknown as NodeJS.EventEmitter
  for (const { event, handler } of attachedListeners) updater.removeListener(event, handler)
  attachedListeners.length = 0
}

function wireListeners(): void {
  listen('checking-for-update', () => setState({ phase: 'checking', error: undefined }))

  listen('update-available', (info) => {
    const version = String((info as { version?: string } | undefined)?.version ?? '')
    if (!version) {
      failWith('The update feed returned a release without a version.')
      return
    }
    applyAvailable(
      version,
      notesToString((info as { releaseNotes?: unknown } | undefined)?.releaseNotes),
      releasePageUrl(version),
      pendingCheck?.ignoreSkip === true
    )
    resolveCheck()
  })

  listen('update-not-available', () => {
    setState({ phase: 'idle', availableVersion: undefined, progressPercent: undefined, lastCheckedAt: Date.now() })
    resolveCheck()
  })

  listen('download-progress', (progress) => {
    const percent = Number((progress as { percent?: number } | undefined)?.percent ?? 0)
    setState({ phase: 'downloading', progressPercent: Math.max(0, Math.min(100, Math.round(percent))) })
  })

  listen('update-downloaded', () => setState({ phase: 'downloaded', progressPercent: 100, error: undefined }))

  listen('error', (error) => failWith(errorMessage(error)))
}

// ── lifecycle ────────────────────────────────────────────────────────────────────────────────────

/** Idempotent: re-running it re-resolves the mode and never duplicates listeners or timers. */
export function configureUpdateService(): void {
  disposeUpdateService()
  fixture = resolveFixture()
  const mode = resolveMode(fixture)
  state = { phase: 'idle', mode, currentVersion: app.getVersion() }

  if (fixture) {
    applyFixture(fixture)
    return
  }
  if (mode === 'off') {
    broadcast('update:status', state)
    return
  }

  if (mode === 'installer') {
    const updater = au()
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    updater.logger = null
    // Defense in depth beside the `app-update.yml` embedded at packaging time.
    updater.setFeedURL({ provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO })
    wireListeners()
  }

  broadcast('update:status', state)
  bootTimer = setTimeout(() => void checkForUpdates(), BOOT_DELAY_MS)
  periodic = setInterval(() => void checkForUpdates(), PERIOD_MS)
  unrefTimer(bootTimer)
  unrefTimer(periodic)
}

function applyFixture(simulated: string): void {
  const phase: UpdatePhase =
    simulated === 'downloading' ? 'downloading' : simulated === 'downloaded' ? 'downloaded' : 'available'
  setState({
    phase,
    availableVersion: FIXTURE_VERSION,
    releaseNotes: 'Fixture release notes',
    releaseUrl: releasePageUrl(FIXTURE_VERSION),
    progressPercent: phase === 'downloading' ? 42 : phase === 'downloaded' ? 100 : undefined,
    lastCheckedAt: Date.now(),
  })
}

/** Stops scheduled work. Installation intent survives so the quit path can complete it. */
export function disposeUpdateService(): void {
  if (bootTimer) clearTimeout(bootTimer)
  if (periodic) clearInterval(periodic)
  bootTimer = null
  periodic = null
  if (pendingCheck) clearTimeout(pendingCheck.timer)
  pendingCheck = null
  removeListeners()
}

// ── actions ──────────────────────────────────────────────────────────────────────────────────────

export async function checkForUpdates(options: { ignoreSkip?: boolean } = {}): Promise<UpdateState> {
  const ignoreSkip = options.ignoreSkip === true
  if (fixture || state.mode === 'off') return state
  // A download in flight or already on disk owns the state; a check would only fight it.
  if (state.phase === 'downloading' || state.phase === 'downloaded') return state
  if (state.mode === 'notify') return checkNotify(ignoreSkip)
  if (pendingCheck) return state

  setState({ phase: 'checking', error: undefined })
  const settled = new Promise<UpdateState>((resolve) => {
    const timer = setTimeout(() => {
      pendingCheck = null
      resolve(state)
    }, CHECK_TIMEOUT_MS)
    unrefTimer(timer)
    pendingCheck = { resolve, ignoreSkip, timer }
  })

  try {
    await au().checkForUpdates()
  } catch (error) {
    failWith(errorMessage(error))
  }
  return settled
}

/** `.deb` builds read the releases API directly: there is no feed manifest to consume. */
async function checkNotify(ignoreSkip: boolean): Promise<UpdateState> {
  setState({ phase: 'checking', error: undefined })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  unrefTimer(timer)
  try {
    const response = await net.fetch(LATEST_API, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `maestrly/${app.getVersion()}` },
    })
    if (!response.ok) return failWith(`GitHub releases responded with ${response.status}.`)
    const body = (await response.json()) as {
      tag_name?: string
      body?: string
      html_url?: string
      prerelease?: boolean
    }
    const version = typeof body?.tag_name === 'string' ? body.tag_name.replace(/^v/i, '') : ''
    if (!version || body.prerelease === true || !semverLt(state.currentVersion, version)) {
      return setState({ phase: 'idle', availableVersion: undefined, lastCheckedAt: Date.now() })
    }
    return applyAvailable(
      version,
      typeof body.body === 'string' ? body.body : undefined,
      typeof body.html_url === 'string' ? body.html_url : releasePageUrl(version),
      ignoreSkip
    )
  } catch (error) {
    return failWith(errorMessage(error))
  } finally {
    clearTimeout(timer)
  }
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (fixture) return setState({ phase: 'downloaded', progressPercent: 100 })
  if (state.mode !== 'installer' || state.phase !== 'available') return state

  setState({ phase: 'downloading', progressPercent: 0, error: undefined })
  try {
    await au().downloadUpdate()
  } catch (error) {
    return failWith(errorMessage(error))
  }
  // `update-downloaded` usually lands first; settle the phase when the promise wins the race.
  if (getUpdateState().phase === 'downloading') return setState({ phase: 'downloaded', progressPercent: 100 })
  return getUpdateState()
}

/**
 * Request the swap. The quit path performs it: the app still tears down runners, chat and pending
 * memory writes, and `finishInstall()` replaces the binary as the last step.
 */
export function installUpdate(): void {
  if (state.phase !== 'downloaded') return
  installing = true
  app.quit()
}

/** Called once at the end of the quit sequence; a no-op unless `installUpdate()` requested it. */
export function finishInstall(): void {
  if (!installing || installLaunched) return
  installLaunched = true
  if (fixture) return
  try {
    au().quitAndInstall(false, true)
  } catch (error) {
    console.warn('[update] installation on quit failed:', errorMessage(error))
  }
}

export async function skipVersion(): Promise<UpdateState> {
  if (state.availableVersion) writeSkippedVersion(state.availableVersion)
  return setState({ phase: 'idle', progressPercent: undefined })
}

export async function openRelease(): Promise<void> {
  if (!state.releaseUrl) return
  try {
    await shell.openExternal(state.releaseUrl)
  } catch (error) {
    console.warn('[update] could not open the release page:', errorMessage(error))
  }
}
