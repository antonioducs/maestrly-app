import { spawn } from 'node:child_process'
import { accessSync, constants, createWriteStream, promises as fs, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { app } from 'electron'
import { isWin } from '../platform'

/**
 * Download and maintain the official standalone VS Code CLI under userData for an isolated embedded
 * editor. Obtain it from Microsoft's official endpoint; the CLI downloads workbench server files on
 * first run. Version directories by commit so running executables are never overwritten, especially on
 * Windows. active names the current commit; pending names a downloaded candidate. Background checks
 * stage side-by-side, and applyStagedCliUpdate promotes only while serve-web is stopped. Restart the
 * internal server at a natural opportunity without restarting the app.
 */

const HTTPS_TIMEOUT = 60_000

function cliRoot(): string {
  return path.join(app.getPath('userData'), 'vscode-cli')
}

function binFor(commit: string): string {
  return path.join(cliRoot(), commit, isWin ? 'code.exe' : 'code')
}

function readMarker(name: string): string {
  try {
    return readFileSync(path.join(cliRoot(), name), 'utf8').trim()
  } catch {
    return ''
  }
}

function writeMarker(name: string, value: string): void {
  writeFileSync(path.join(cliRoot(), name), value, 'utf8')
}

function clearMarker(name: string): void {
  rmSync(path.join(cliRoot(), name), { force: true })
}

/** Whether the commit's binary exists and is executable. */
function commitReady(commit: string): boolean {
  if (!commit) return false
  try {
    accessSync(binFor(commit), constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Standalone CLI download identifier by OS/architecture: cli-prefixed Darwin/Linux/Windows, x64/arm64
 * and Linux armhf.
 */
function cliTarget(): string {
  const arch = process.arch
  if (process.platform === 'darwin') return arch === 'arm64' ? 'cli-darwin-arm64' : 'cli-darwin-x64'
  if (process.platform === 'win32') return arch === 'arm64' ? 'cli-win32-arm64' : 'cli-win32-x64'
  if (arch === 'arm64') return 'cli-linux-arm64'
  if (arch === 'arm') return 'cli-linux-armhf'
  return 'cli-linux-x64'
}

/** Version-API platform identifier omits cli-; the commit is shared. */
function updateTarget(): string {
  const arch = process.arch
  if (process.platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  if (process.platform === 'win32') return arch === 'arm64' ? 'win32-arm64' : 'win32-x64'
  if (arch === 'arm64') return 'linux-arm64'
  if (arch === 'arm') return 'linux-armhf'
  return 'linux-x64'
}

/** Whether the active CLI is downloaded and executable, controlling initial download UI. */
export function isVSCodeCliReady(): boolean {
  return commitReady(readMarker('active'))
}

/** Whether a downloaded pending CLI awaits server restart. */
export function hasStagedCliUpdate(): boolean {
  const pending = readMarker('pending')
  return !!pending && pending !== readMarker('active') && commitReady(pending)
}

/** Download a URL to dest following redirects from the official endpoint to its CDN. */
function download(url: string, dest: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: HTTPS_TIMEOUT }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirects <= 0) {
          reject(new Error('too many redirects while downloading VS Code CLI'))
          return
        }
        const next = new URL(res.headers.location, url).toString()
        download(next, dest, redirects - 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`VS Code CLI download failed (HTTP ${status})`))
        return
      }
      const out = createWriteStream(dest)
      res.on('error', reject)
      out.on('error', reject)
      out.on('finish', () => out.close(() => resolve()))
      res.pipe(out)
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('VS Code CLI download timed out')))
  })
}

/** Extract with tar: tar.gz on macOS/Linux, zip through native Windows bsdtar. */
function runTar(archive: string, dir: string): Promise<void> {
  const args = isWin ? ['-xf', archive, '-C', dir] : ['-xzf', archive, '-C', dir]
  return new Promise((resolve, reject) => {
    const p = spawn('tar', args, { stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))))
  })
}

/** Use PowerShell Expand-Archive if Windows tar is unavailable. */
function runPwshUnzip(archive: string, dir: string): Promise<void> {
  const cmd = `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Expand-Archive exited with code ${code}`))))
  })
}

function extract(archive: string, dir: string): Promise<void> {
  return runTar(archive, dir).catch((e) => {
    if (isWin) return runPwshUnzip(archive, dir)
    throw e
  })
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Find code/code.exe inside the extracted package, including fallback search. */
async function locateBin(dir: string): Promise<string | null> {
  const want = isWin ? 'code.exe' : 'code'
  const direct = path.join(dir, want)
  if (await fileExists(direct)) return direct
  const names = isWin ? ['code.exe', 'code-tunnel.exe'] : ['code', 'code-tunnel']
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isFile() && names.includes(e.name)) return path.join(dir, e.name)
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const sub = path.join(dir, e.name)
    const subEntries = await fs.readdir(sub, { withFileTypes: true })
    for (const se of subEntries) {
      if (se.isFile() && names.includes(se.name)) return path.join(sub, se.name)
    }
  }
  return null
}

/**
 * Extract the 40-hex commit from code --version by regex. Standalone CLI prints one line while GUI
 * code prints three; do not depend on line positions.
 */
function getCliCommit(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout?.on('data', (d) => (out += String(d)))
    p.on('error', reject)
    p.on('exit', () => {
      const commit = out.match(/[0-9a-f]{40}/)?.[0]
      if (commit) resolve(commit)
      else reject(new Error('could not read the VS Code CLI commit'))
    })
  })
}

/** Read latest stable commit from the official endpoint; silently return null on failure. */
function fetchLatestCommit(): Promise<string | null> {
  const url = `https://update.code.visualstudio.com/api/latest/${updateTarget()}/stable`
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15_000 }, (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        res.resume()
        resolve(null)
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          const v = (JSON.parse(body) as { version?: unknown }).version
          resolve(typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) ? v : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

let dlSeq = 0

/**
 * Download/extract the latest CLI into its commit directory and return the commit without changing
 * markers.
 */
async function downloadCliVersion(): Promise<string> {
  const root = cliRoot()
  await fs.mkdir(root, { recursive: true })
  const tmp = path.join(root, `dl-tmp-${process.pid}-${dlSeq++}`)
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(tmp, { recursive: true })
  try {
    const archive = path.join(tmp, isWin ? 'cli.zip' : 'cli.tar.gz')
    await download(`https://code.visualstudio.com/sha/download?build=stable&os=${cliTarget()}`, archive)
    await extract(archive, tmp)
    await fs.rm(archive, { force: true })
    const staged = await locateBin(tmp)
    if (!staged) throw new Error('VS Code CLI downloaded, but the executable was not found in the package')
    if (!isWin) await fs.chmod(staged, 0o755)
    const commit = await getCliCommit(staged)
    const destBin = binFor(commit)
    if (!commitReady(commit)) {
      await fs.mkdir(path.dirname(destBin), { recursive: true })
      await fs.rename(staged, destBin).catch(async () => {
        await fs.copyFile(staged, destBin)
      })
      if (!isWin) await fs.chmod(destBin, 0o755)
    }
    return commit
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** Best-effort removal of versions other than keep; Windows may retain in-use executables. */
async function cleanupOldCommits(keep: string): Promise<void> {
  try {
    const root = cliRoot()
    const entries = await fs.readdir(root, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory() && e.name !== keep && /^[0-9a-f]{40}$/.test(e.name)) {
        await fs.rm(path.join(root, e.name), { recursive: true, force: true }).catch(() => {})
      }
    }
  } catch {
    /* noop */
  }
}

let ensuring: Promise<string> | null = null

/**
 * Ensure active CLI availability and return its executable path. Share one in-flight Promise among
 * simultaneous requests; reset failures so reopening Code can retry after reconnecting.
 */
export function ensureVSCodeCli(): Promise<string> {
  const active = readMarker('active')
  if (commitReady(active)) return Promise.resolve(binFor(active))
  if (ensuring) return ensuring
  ensuring = (async () => {
    const commit = await downloadCliVersion()
    writeMarker('active', commit)
    return binFor(commit)
  })()
  ensuring.catch(() => {
    ensuring = null
  })
  return ensuring
}

let checking: Promise<boolean> | null = null

/**
 * Background-check latest stable CLI and stage a newer version alongside the active editor. Return
 * whether an update is staged; unavailable network/CLI returns false. Applying remains separate at
 * restart.
 */
export function checkForCliUpdate(): Promise<boolean> {
  if (checking) return checking
  checking = (async () => {
    try {
      const active = readMarker('active')
      if (!commitReady(active)) return false // CLI is not installed yet; nothing to compare
      const latest = await fetchLatestCommit()
      if (!latest || latest === active) return false
      if (latest === readMarker('pending') && commitReady(latest)) return true // already staged
      const commit = await downloadCliVersion()
      if (commit === active) return false
      writeMarker('pending', commit)
      return true
    } catch {
      return false
    }
  })()
  checking.finally(() => {
    checking = null
  })
  return checking
}

/**
 * Promote pending to active only at server startup while stopped, then clean old versions. Return
 * whether promotion occurred.
 */
export async function applyStagedCliUpdate(): Promise<boolean> {
  const pending = readMarker('pending')
  if (!pending || !commitReady(pending)) {
    clearMarker('pending')
    return false
  }
  if (pending === readMarker('active')) {
    clearMarker('pending')
    return false
  }
  writeMarker('active', pending)
  clearMarker('pending')
  void cleanupOldCommits(pending)
  return true
}
