/**
 * Supervisor for OpenAI's `tunnel-client` (Apache-2.0, vendored and pinned binary; see
 * scripts/fetch-tunnel-client.mjs), used by the "ChatGPT Web" companion integration.
 *
 * The daemon makes ONLY outbound connections (long-poll at api.openai.com/v1/tunnels/*) and forwards each
 * MCP request to the app's loopback bridge. No port is internet-facing, and the credential is passed
 * through an environment variable (`--control-plane.api-key env:VAR`), never argv, which any process
 * running as the user can read.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { registerOwnedProcess, unregisterOwnedProcess } from '../../performance/owned-processes'
import { ensureRuntimeAsset, readyRuntimeAsset } from '../../runtime-assets/app-service'

const BIN_NAME = process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client'
const HOST_OS_DIR = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
const API_KEY_ENV = 'MAESTRLY_TUNNEL_CONTROL_PLANE_API_KEY'
const READY_TIMEOUT_MS = 45_000
const READY_POLL_MS = 500
const MAX_LOG_LINES = 120
const MAX_RESTARTS = 5
/** Healthy uptime that clears crash history (resets the restart budget to zero). */
const STABLE_RESET_MS = 2 * 60 * 1000
let managedBinaryPath: string | null = null

export type TunnelRuntimeState = 'stopped' | 'starting' | 'ready' | 'error'

export interface TunnelRuntimeOptions {
  tunnelId: string
  apiKey: string
  /** Loopback URL of the MCP bridge (see bridge-http.ts). */
  mcpServerUrl: string
  onState?: (state: TunnelRuntimeState, detail?: string) => void
  /** Pinned path held by a RuntimeAssetService lease for this supervisor lifetime. */
  binaryPath?: string
  onStopped?: () => void
}

/** Already verified path: prod → managed asset in userData; dev → resources/<os>-<arch>/. */
export function tunnelClientBinPath(): string | null {
  if (app.isPackaged) {
    if (managedBinaryPath && existsSync(managedBinaryPath)) return managedBinaryPath
    managedBinaryPath = null
    return null
  }
  const candidate = path.join(app.getAppPath(), 'resources', 'tunnel-client', `${HOST_OS_DIR}-${process.arch}`, BIN_NAME)
  return existsSync(candidate) ? candidate : null
}

/** Resolves the managed production path. Installation is allowed only for an explicit setup/start action. */
export async function prepareTunnelClient(install: boolean): Promise<string> {
  if (!app.isPackaged) {
    const candidate = tunnelClientBinPath()
    if (!candidate) throw new Error('tunnel-client is missing; run the development materialization step')
    return candidate
  }
  try {
    const asset = install ? await ensureRuntimeAsset('tunnel-client') : await readyRuntimeAsset('tunnel-client')
    const candidate = path.join(asset.path!, BIN_NAME)
    if (!existsSync(candidate)) throw new Error(`Managed tunnel-client executable is missing: ${candidate}`)
    managedBinaryPath = candidate
    return candidate
  } catch (error) {
    managedBinaryPath = null
    throw error
  }
}

function getLoopback(url: string, timeoutMs = 2000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

export function createTunnelRuntime(options: TunnelRuntimeOptions) {
  let child: ChildProcess | null = null
  let state: TunnelRuntimeState = 'stopped'
  let stopping = false
  /** The first start never silently schedules a retry; retries require a previously ready generation. */
  let startInProgress = false
  let restarts = 0
  let tmpDir = ''
  /** Each spawn is a GENERATION: an old wait never determines the state of a new process. */
  let generation = 0
  let lastReadyAt = 0
  let restartTimer: NodeJS.Timeout | null = null
  let stoppedNotified = false
  const logs: string[] = []

  const notifyStopped = () => {
    if (stoppedNotified) return
    stoppedNotified = true
    options.onStopped?.()
  }

  interface Attempt {
    proc: ChildProcess
    generation: number
    /** Health file OWNED by this generation (the previous process would point to a dead port). */
    urlFile: string
    /** Logs and the start signal are also per-generation: old output never validates or diagnoses a new process. */
    logs: string[]
    startedAnnounced: boolean
    startScanTail: string
  }

  const setState = (next: TunnelRuntimeState, detail?: string) => {
    if (state === next && !detail) return
    state = next
    try {
      options.onState?.(next, detail)
    } catch {
      /* observer failures never terminate the supervisor */
    }
  }

  /** Never trust the daemon not to print the key: redact before storing or exposing diagnostics. */
  const redact = (line: string) =>
    (options.apiKey ? line.split(options.apiKey).join('«api-key»') : line).replace(
      /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g,
      '«api-key»'
    )

  const pushLog = (line: string) => {
    for (const part of line.split('\n')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      logs.push(redact(trimmed))
      if (logs.length > MAX_LOG_LINES) logs.shift()
    }
  }

  /** Daemon errors are structured JSON; extract the message for UI status. */
  const findLastError = (source: string[]): string | undefined => {
    for (let i = source.length - 1; i >= 0; i--) {
      const line = source[i]
      if (!/"level":"(ERROR|WARN)"/.test(line) && !/error/i.test(line)) continue
      try {
        const parsed = JSON.parse(line) as { msg?: string; error?: string; level?: string }
        if (parsed.level === 'ERROR') return parsed.error || parsed.msg
      } catch {
        return line.slice(0, 300)
      }
    }
    return undefined
  }
  const lastError = (): string | undefined => findLastError(logs)

  /** Wait for ONE GENERATION to become ready; the caller discards results from older generations. */
  async function waitForReady(attempt: Attempt): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    let healthUrl = ''
    while (Date.now() < deadline) {
      if (attempt.proc.exitCode !== null || attempt.proc.signalCode !== null) {
        const termination =
          attempt.proc.signalCode !== null
            ? `signal ${attempt.proc.signalCode}`
            : `exit code ${attempt.proc.exitCode ?? 'unknown'}`
        throw new Error(findLastError(attempt.logs) || `tunnel-client exited during startup (${termination})`)
      }
      if (!healthUrl && existsSync(attempt.urlFile)) {
        healthUrl = readFileSync(attempt.urlFile, 'utf8').trim()
      }
      if (healthUrl) {
        try {
          const res = await getLoopback(`${healthUrl}/readyz`)
          // `ready` requires an MCP probe, no-auth/OAuth discovery, and a successful control-plane poll.
          // Never reduce this to "process started": the daemon may be connected yet unable to forward
          // ChatGPT calls.
          if (res.status === 200 && res.body.trim() === 'ready') return
        } catch {
          /* still starting */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
    throw new Error(findLastError(attempt.logs) || 'tunnel-client did not become ready in time')
  }

  function spawnDaemon(): Attempt {
    const bin = options.binaryPath ?? tunnelClientBinPath()
    if (!bin) throw new Error('binary-missing')
    tmpDir ||= mkdtempSync(path.join(os.tmpdir(), 'maestrly-tunnel-'))
    const gen = ++generation
    // Per-generation file: reusing `health.url` would make the new wait read the previous dead port.
    const urlFile = path.join(tmpDir, `health-${gen}.url`)
    const args = [
      'run',
      '--control-plane.tunnel-id',
      options.tunnelId,
      '--control-plane.api-key',
      `env:${API_KEY_ENV}`,
      '--mcp.server-url',
      `url=${options.mcpServerUrl},channel=main`,
      '--health.listen-addr',
      '127.0.0.1:0',
      '--health.url-file',
      urlFile,
      '--log.format',
      'json',
    ]
    const proc = spawn(bin, args, {
      cwd: tmpDir,
      env: { ...process.env, [API_KEY_ENV]: options.apiKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const attempt: Attempt = {
      proc,
      generation: gen,
      urlFile,
      logs: [],
      startedAnnounced: false,
      startScanTail: '',
    }
    child = proc
    registerOwnedProcess({
      key: 'tunnel-client',
      kind: 'tunnel-client',
      owner: options.tunnelId,
      pid: () => child?.pid ?? null,
      state: () => (state === 'ready' ? 'ready' : state === 'error' ? 'error' : state === 'stopped' ? 'idle' : 'starting'),
    })
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    const capture = (chunk: unknown) => {
      const text = String(chunk)
      const startScan = `${attempt.startScanTail}${text}`
      if (startScan.includes('tunnel-client started')) attempt.startedAnnounced = true
      attempt.startScanTail = startScan.slice(-64)
      for (const part of redact(text).split('\n')) {
        const trimmed = part.trim()
        if (trimmed) attempt.logs.push(trimmed)
      }
      pushLog(text)
    }
    proc.stdout?.on('data', capture)
    proc.stderr?.on('data', capture)
    proc.on('error', (error) => {
      capture(String(error))
      if (generation === gen) setState('error', error.message)
    })
    proc.on('exit', (code, signal) => {
      if (child !== proc) return
      child = null
      if (stopping) {
        setState('stopped')
        return
      }
      // A tunnel crash after a long healthy interval is a NEW crash, not part of the previous burst;
      // otherwise five crashes spread across hours would condemn the session.
      if (lastReadyAt && Date.now() - lastReadyAt > STABLE_RESET_MS) restarts = 0
      lastReadyAt = 0
      const detail =
        findLastError(attempt.logs) || `tunnel-client saiu (code=${code ?? 'null'} signal=${signal ?? 'null'})`
      if (startInProgress) {
        setState('error', detail)
        return
      }
      if (restarts < MAX_RESTARTS) {
        // Exponential backoff: transient network failures must not terminate the user session.
        const delay = Math.min(30_000, 1000 * 2 ** restarts)
        restarts++
        setState('starting', `${detail} — reconnecting in ${Math.round(delay / 1000)}s`)
        restartTimer = setTimeout(() => {
          restartTimer = null
          if (stopping) return
          try {
            const attempt = spawnDaemon()
            void waitForReady(attempt)
              .then(() => markReady(attempt))
              .catch((error) => {
                if (attempt.generation !== generation || stopping) return
                // A live process that cannot become ready also CONSUMES the restart budget.
                // Killing it makes the `exit` handler apply the same backoff and try a new generation.
                const detail = error instanceof Error ? error.message : String(error)
                pushLog(`[supervisor] attempt did not become ready: ${detail}`)
                if (child === attempt.proc && attempt.proc.exitCode === null) {
                  attempt.proc.kill('SIGTERM')
                  const hard = setTimeout(() => attempt.proc.kill('SIGKILL'), 3000)
                  hard.unref?.()
                  attempt.proc.once('exit', () => clearTimeout(hard))
                }
              })
          } catch (error) {
            setState('error', error instanceof Error ? error.message : String(error))
            notifyStopped()
          }
        }, delay)
        restartTimer.unref?.()
        return
      }
      setState('error', detail)
      notifyStopped()
    })
    return attempt
  }

  /** Publish `ready` only if this attempt is still current (guards against out-of-order waits). */
  function markReady(attempt: Attempt): void {
    if (attempt.generation !== generation || stopping) return
    lastReadyAt = Date.now()
    setState('ready')
  }

  async function start(): Promise<void> {
    if (child || restartTimer) return
    stopping = false
    restarts = 0
    startInProgress = true
    setState('starting')
    try {
      const attempt = spawnDaemon()
      await waitForReady(attempt)
      markReady(attempt)
    } catch (error) {
      await stop()
      const message = error instanceof Error ? error.message : String(error)
      setState('error', message)
      throw error instanceof Error ? error : new Error(message)
    } finally {
      startInProgress = false
    }
  }

  async function stop(): Promise<void> {
    stopping = true
    startInProgress = false
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    const proc = child
    child = null
    if (proc && proc.exitCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(term)
          clearTimeout(hard)
          resolve()
        }
        // SIGKILL is not the end: release the temporary directory only after the actual 'exit'
        // (otherwise removal races with process writes). `hard` is the final guard.
        const term = setTimeout(() => proc.kill('SIGKILL'), 3000)
        const hard = setTimeout(finish, 6000)
        proc.once('exit', finish)
        proc.kill('SIGTERM')
      })
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = ''
    }
    lastReadyAt = 0
    unregisterOwnedProcess('tunnel-client')
    setState('stopped')
    notifyStopped()
  }

  return {
    start,
    stop,
    getState: () => state,
    getError: lastError,
    /** Recent daemon lines for wizard diagnostics; no raw HTTP (the binary does not log bodies by default). */
    getLogs: () => [...logs],
    // The supervisor retains recovery ownership during backoff. This prevents the manager from creating
    // a second daemon while the previous generation's timer is still scheduled.
    isRunning: () => !!child || !!restartTimer,
  }
}

export type TunnelRuntime = ReturnType<typeof createTunnelRuntime>
