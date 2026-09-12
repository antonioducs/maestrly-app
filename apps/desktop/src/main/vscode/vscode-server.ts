import http from 'node:http'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { ensureVSCodeCli, applyStagedCliUpdate } from './vscode-cli-download'
import { findFreePort } from '../net-port'
import { chmod0600 } from '../secret-file'
import { vscodeUserDir, vscodeExtDir, killProcessTree, isLinux, isWin, spawnCli } from '../platform'
import { EXT_ID, EXT_DIRNAME, EXT_VERSION, EXT_PACKAGE_JSON, EXT_JS } from './vscode-ext-source'
import { registerOwnedProcess, unregisterOwnedProcess } from '../performance/owned-processes'

/**
 * Run one authenticated loopback official VS Code serve-web for all conversations, varying folder in
 * each view URL. Download the standalone CLI on demand into userData and isolate server data from the
 * user's editor. Seed local settings/extensions/theme once, then maintain independent state.
 */

const PORT_BASE = 8930
let port = PORT_BASE // actual free port selected at startup, avoiding orphan server conflicts
let serverProc: ChildProcess | null = null
let token = ''
let ready: Promise<void> | null = null

function dataDir(): string {
  return path.join(app.getPath('userData'), 'vscode-serve-web')
}

// Platform-specific local VS Code user and extension directories.
const LOCAL_USER = vscodeUserDir()
const LOCAL_EXT = vscodeExtDir()

/** Remove JSONC comments and trailing commas from settings. */
function parseJsonc(text: string): Record<string, unknown> {
  let out = ''
  let inStr = false
  let esc = false
  let line = false
  let block = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (line) {
      if (c === '\n') {
        line = false
        out += c
      }
      continue
    }
    if (block) {
      if (c === '*' && n === '/') {
        block = false
        i++
      }
      continue
    }
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '/' && n === '/') {
      line = true
      i++
      continue
    }
    if (c === '/' && n === '*') {
      block = true
      i++
      continue
    }
    out += c
  }
  out = out.replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(out)
  } catch {
    return {}
  }
}

/** Resolve the user's color theme from local settings, then state.vscdb, then the dark default. */
function readUserColorTheme(localSettings: Record<string, unknown>): string {
  const fromSettings = localSettings['workbench.colorTheme']
  if (typeof fromSettings === 'string' && fromSettings) return fromSettings
  try {
    const db = new DatabaseSync(path.join(LOCAL_USER, 'globalStorage', 'state.vscdb'), {
      readOnly: true,
    })
    const row = db.prepare("SELECT value FROM ItemTable WHERE key='workbench.colorTheme'").get() as
      | { value: string }
      | undefined
    db.close()
    if (row?.value) {
      const v = JSON.parse(String(row.value))
      if (typeof v === 'string' && v) return v
    }
  } catch {
    /* fall back to default */
  }
  return 'Default Dark Modern'
}

/**
 * Merge local settings with explicit web theme overrides: disable automatic scheme detection, align
 * preferred themes, and disable restricted workspace trust that blocks theme extensions. Inject into
 * web IndexedDB /User/settings.json because serve-web does not read disk user settings.
 */
export async function getMergedSettingsJson(): Promise<string> {
  let localSettings: Record<string, unknown> = {}
  try {
    localSettings = parseJsonc(await fs.readFile(path.join(LOCAL_USER, 'settings.json'), 'utf8'))
  } catch {
    /* No local settings available. */
  }
  const theme = readUserColorTheme(localSettings)
  const merged = {
    ...localSettings,
    'workbench.colorTheme': theme,
    'window.autoDetectColorScheme': false,
    'workbench.preferredDarkColorTheme': theme,
    'workbench.preferredLightColorTheme': theme,
    'security.workspace.trust.enabled': false,
  }
  return JSON.stringify(merged, null, 2)
}

/** Seed local extensions into serve-web once; extensions.json is portable. */
async function seedExtensions(): Promise<void> {
  if (isLinux) return // seed macOS/Windows extensions; Linux paths vary and are not seeded
  const serveExt = path.join(dataDir(), 'extensions')
  try {
    const marker = path.join(serveExt, 'extensions.json')
    try {
      await fs.access(marker)
      return // already seeded
    } catch {
      /* primeira vez */
    }
    await fs.mkdir(serveExt, { recursive: true })
    await fs.cp(LOCAL_EXT, serveExt, { recursive: true })
  } catch {
    /* If custom extensions cannot be seeded, start with the default theme. */
  }
}

/**
 * Write/register the app bridge extension without replacing other extensions. Check EXT_VERSION each
 * startup; plain CommonJS requires no bundler.
 */
async function seedAppExtension(): Promise<void> {
  const serveExt = path.join(dataDir(), 'extensions')
  const extDir = path.join(serveExt, EXT_DIRNAME)
  try {
    await fs.mkdir(extDir, { recursive: true })
    await fs.writeFile(path.join(extDir, 'package.json'), EXT_PACKAGE_JSON, 'utf8')
    await fs.writeFile(path.join(extDir, 'extension.js'), EXT_JS, 'utf8')

    // merge into VS Code's authoritative extensions.json format
    const manifest = path.join(serveExt, 'extensions.json')
    let list: Array<Record<string, unknown>> = []
    try {
      list = JSON.parse(await fs.readFile(manifest, 'utf8'))
      if (!Array.isArray(list)) list = []
    } catch {
      /* Missing or invalid registry; start empty. */
    }
    // Remove older versions of our extension.
    list = list.filter((e) => (e?.identifier as { id?: string })?.id !== EXT_ID)
    list.push({
      identifier: { id: EXT_ID },
      version: EXT_VERSION,
      location: { $mid: 1, fsPath: extDir, path: extDir, scheme: 'file' },
      relativeLocation: EXT_DIRNAME,
      metadata: { installedTimestamp: 1, source: 'vsix', isApplicationScoped: false },
    })
    await fs.writeFile(manifest, JSON.stringify(list), 'utf8')
  } catch {
    /* Failure disables conversation-selection forwarding but leaves the editor usable. */
  }
}

function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve() // any HTTP response confirms the server is listening
      })
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('timed out waiting for code serve-web'))
        else setTimeout(tick, 400)
      })
      req.setTimeout(2000, () => req.destroy())
    }
    tick()
  })
}

/** Idempotently start on the first call and reuse the server afterward. */
export function startVSCodeServer(): Promise<void> {
  if (ready) return ready

  const startPromise = (async () => {
    // The previous server is stopped, so safely promote a downloaded pending CLI version before startup.
    // No-op when none exists.
    await applyStagedCliUpdate()
    // Use the app-owned standalone CLI with isolated server data. No installed VS Code is required and
    // Linux snap wrapper arguments cannot interfere. First use downloads it; network failure propagates to
    // the caller.
    const launcher = await ensureVSCodeCli()

    await seedExtensions()
    await seedAppExtension() // our bridge extension forwards file/selection references to Chat

    // Reuse a persistent connection token across boots to avoid stale-cookie or previous-instance
    // authentication mismatches.
    const tokenFile = path.join(app.getPath('userData'), 'vscode.token')
    try {
      token = (await fs.readFile(tokenFile, 'utf8')).trim()
    } catch {
      token = ''
    }
    if (!token) {
      token = randomBytes(16).toString('hex')
      await fs.writeFile(tokenFile, token, 'utf8')
    }
    // serve-web requires a plaintext connection-token file; apply best-effort 0600 to new and existing
    // files (#264).
    await chmod0600(tokenFile)

    port = await findFreePort(PORT_BASE) // choose a free port even if an orphan owns the base port
    const proc = spawnCli(
      launcher,
      [
        'serve-web',
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
        '--connection-token-file',
        tokenFile,
        '--server-data-dir',
        dataDir(),
        '--accept-server-license-terms',
        '--disable-telemetry',
      ],
      // Use a dedicated POSIX process group to terminate children; hide the Windows launcher console.
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true }
    )
    serverProc = proc
    // Include descendants because the small code launcher spawns the memory-heavy serve-web process.
    registerOwnedProcess({
      key: 'vscode-serve-web',
      kind: 'vscode-serve-web',
      pid: () => serverProc?.pid ?? null,
      state: () => (serverProc ? 'ready' : 'idle'),
      includeDescendants: true,
    })
    proc.stdout?.on('data', (d) => console.log('[vscode]', String(d).trim()))
    proc.stderr?.on('data', (d) => console.error('[vscode]', String(d).trim()))
    proc.on('exit', (code, signal) => {
      console.log('[vscode] serve-web saiu', code)
      // Handle exit only if this process is still current. Stop/restart clears or replaces serverProc
      // before termination, preventing expected old exits from clearing new-server state or logging false
      // failures.
      if (serverProc !== proc) return
      // Log unexpected current-server nonzero or signal exits locally.
      if (signal != null || (code !== 0 && code !== null)) {
        console.error('[vscode] serve-web exited unexpectedly', { exitCode: code, signal })
      }
      serverProc = null
      ready = null
      unregisterOwnedProcess('vscode-serve-web')
    })
    proc.on('error', (err) => {
      console.error('[vscode] serve-web error', err)
    })

    await waitForHttp(`http://127.0.0.1:${port}/`, 45000)
  })()

  ready = startPromise
  startPromise.catch(() => {
    if (ready === startPromise) ready = null
  })
  return startPromise
}

/**
 * Normalize web folder paths: leading slash means a remote path, while C: would otherwise parse as a
 * URI scheme. Convert Windows paths to /C:/... idempotently so reload URLs can pass through again.
 */
function toFolderParam(folder: string): string {
  if (!isWin) return folder
  const p = folder.replace(/\\/g, '/')
  return p.startsWith('/') ? p : `/${p}`
}

/** Web VS Code URL for a single-root folder. */
export function getVSCodeUrl(folder: string): string {
  const u = new URL(`http://127.0.0.1:${port}/`)
  u.searchParams.set('tkn', token)
  if (folder) u.searchParams.set('folder', toFolderParam(folder))
  return u.toString()
}

/**
 * Distinguish editor readiness from process HTTP availability. ready means the workbench is served;
 * downloading means the server's download page; starting means no response/connection failure. Startup
 * HTTP checks alone accept any response.
 */
export type VSCodePhase = 'ready' | 'downloading' | 'starting'

/**
 * Probe once and classify editor readiness. The request itself triggers server-side download as a
 * browser would; read only the body prefix needed to recognize the download page.
 */
export function probeVSCode(timeoutMs = 2500): Promise<VSCodePhase> {
  const url = `http://127.0.0.1:${port}/?tkn=${token}`
  return new Promise((resolve) => {
    let settled = false
    const done = (p: VSCodePhase): void => {
      if (!settled) {
        settled = true
        resolve(p)
      }
    }
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
        if (body.length >= 8192) res.destroy() // only the body prefix is needed
      })
      const classify = (): void => done(/server is downloading|is downloading/i.test(body) ? 'downloading' : 'ready')
      res.on('end', classify)
      res.on('close', classify)
    })
    req.on('error', () => done('starting'))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done('starting')
    })
  })
}

/**
 * Poll until ready or timeout, advancing server download. On timeout callers may show the real server
 * page instead of trapping the user in custom loading UI.
 */
export function waitForEditorReady(timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = async (): Promise<void> => {
      if ((await probeVSCode(2500)) === 'ready') return resolve()
      if (Date.now() > deadline) return reject(new Error('timed out waiting for VS Code editor'))
      setTimeout(() => void tick(), 1200)
    }
    void tick()
  })
}

/**
 * Whether serve-web is alive, determining whether a CLI update needs an immediate restart or can wait
 * for next opening.
 */
export function isVSCodeServerRunning(): boolean {
  return serverProc != null
}

export function stopVSCodeServer(): void {
  const p = serverProc
  // Clear serverProc/ready before termination so its exit is recognized as expected and cannot affect a
  // replacement server.
  serverProc = null
  ready = null
  unregisterOwnedProcess('vscode-serve-web')
  if (!p?.pid) return
  // Kill launcher and descendant server together so no orphan retains the port: POSIX process group or
  // Windows taskkill /T /F.
  killProcessTree(p.pid)
}

/**
 * Restart serve-web without closing the app (#318). The port may change; callers reload every open
 * editor using getVSCodeUrl/reloadAllVSCode.
 */
export async function restartVSCodeServer(): Promise<void> {
  stopVSCodeServer()
  await startVSCodeServer()
}
