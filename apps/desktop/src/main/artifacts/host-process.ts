/**
 * Lifecycle of the artifact host utility process. The host serves agent-generated pages over HTTP, so it runs
 * outside the main process and holds no app credentials. It starts on demand, restarts with backoff after a crash,
 * and stays down after repeated crashes or a busy port until the owner acts.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ArtifactAdmin,
  ArtifactHostError,
  type ArtifactHostEvent,
  createAdminClient,
  type RpcChannel,
} from '@maestrly/artifact-host'
import { utilityProcess } from 'electron'
import type {
  ArtifactHostProblem,
  ArtifactHostState,
  ArtifactHostStatus,
  ArtifactSettings,
} from '../../shared/artifacts'

export interface UtilityLike {
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  removeListener(event: 'message', listener: (message: unknown) => void): unknown
}

export interface ArtifactHostProcessDeps {
  fork: () => UtilityLike
  dataDir: () => string
  settings: () => ArtifactSettings
  onStatus: (status: ArtifactHostStatus) => void
  onEvent: (event: ArtifactHostEvent) => void
  schedule?: (fn: () => void, ms: number) => void
  now?: () => number
}

const READY_TIMEOUT_MS = 20_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const RESTART_BACKOFF_MS = [500, 2_000, 5_000, 10_000, 20_000]
const CRASH_WINDOW_MS = 2 * 60_000
const MAX_CRASHES = 5

// electron-vite emits the worker next to the main bundle (see chat/pdf-text.ts).
const MAIN_BUNDLE_DIR = path.dirname(fileURLToPath(import.meta.url))

export function forkArtifactHostWorker(): UtilityLike {
  const child = utilityProcess.fork(path.join(MAIN_BUNDLE_DIR, 'artifact-host-worker.js'), [], {
    serviceName: 'artifact-host',
    stdio: 'pipe',
  })
  child.stderr?.on('data', (data) => console.error('[artifact-host]', String(data).trim()))
  return child as unknown as UtilityLike
}

const unavailable = (reason: ArtifactHostProblem) =>
  new ArtifactHostError('host_unavailable', `The artifact host is unavailable (${reason})`, { reason })

function isHostEvent(value: unknown): value is ArtifactHostEvent {
  const event = value as Partial<ArtifactHostEvent> | null
  return event?.type === 'changed' && typeof event.artifactId === 'string'
}

export class ArtifactHostProcess {
  private state: ArtifactHostState = 'stopped'
  private problem: ArtifactHostProblem | undefined
  private port: number | null = null
  private child: UtilityLike | null = null
  private client: (ArtifactAdmin & { dispose(): void }) | null = null
  private starting: Promise<ArtifactAdmin> | null = null
  /** Bumped by every start and stop: late exits, replies and scheduled restarts of an older generation are ignored. */
  private generation = 0
  private crashes: number[] = []
  private readonly intentional = new WeakSet<UtilityLike>()
  private readonly schedule: (fn: () => void, ms: number) => void
  private readonly now: () => number

  constructor(private readonly deps: ArtifactHostProcessDeps) {
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms).unref?.()
      })
    this.now = deps.now ?? Date.now
  }

  status(): ArtifactHostStatus {
    const settings = this.deps.settings()
    const problem =
      this.problem ?? (this.state === 'stopped' && !settings.hostEnabled ? ('disabled' as const) : undefined)
    return {
      state: this.state,
      ...(problem ? { problem } : {}),
      port: this.state === 'running' && this.port !== null ? this.port : settings.port,
    }
  }

  private setStatus(state: ArtifactHostState, problem?: ArtifactHostProblem): void {
    this.state = state
    this.problem = problem
    this.deps.onStatus(this.status())
  }

  ensureStarted(): Promise<ArtifactAdmin> {
    if (this.client && this.state === 'running') return Promise.resolve(this.client)
    if (this.starting) return this.starting
    const settings = this.deps.settings()
    if (!settings.hostEnabled) {
      this.setStatus('stopped')
      return Promise.reject(unavailable('disabled'))
    }
    const starting = this.start(settings).finally(() => {
      if (this.starting === starting) this.starting = null
    })
    this.starting = starting
    return starting
  }

  private start(settings: ArtifactSettings): Promise<ArtifactAdmin> {
    const generation = ++this.generation
    this.setStatus('starting')
    const child = this.deps.fork()
    this.child = child
    const listeners = new Set<(message: unknown) => void>()
    const channel: RpcChannel = {
      post: (message) => child.postMessage(message),
      onMessage: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const client = createAdminClient(channel)

    return new Promise<ArtifactAdmin>((resolve, reject) => {
      let settled = false
      const readyTimer = setTimeout(() => fail('storage'), READY_TIMEOUT_MS)
      readyTimer.unref?.()
      const fail = (problem: ArtifactHostProblem) => {
        if (settled) return
        settled = true
        clearTimeout(readyTimer)
        client.dispose()
        this.intentional.add(child)
        try {
          child.kill()
        } catch {
          // Already exited.
        }
        if (generation === this.generation) {
          this.child = null
          this.client = null
          this.setStatus('error', problem)
        }
        reject(unavailable(problem))
      }

      child.on('message', (message) => {
        for (const listener of listeners) listener(message)
        const m = message as { type?: unknown; code?: unknown; port?: unknown; event?: unknown } | null
        if (m?.type === 'event') {
          if (isHostEvent(m.event)) this.deps.onEvent(m.event)
        } else if (m?.type === 'ready' && !settled && generation === this.generation) {
          settled = true
          clearTimeout(readyTimer)
          this.client = client
          this.port = typeof m.port === 'number' ? m.port : settings.port
          this.setStatus('running')
          resolve(client)
        } else if (m?.type === 'init-error') {
          fail(m.code === 'port_in_use' ? 'port_in_use' : 'storage')
        }
      })

      child.on('exit', () => {
        client.dispose()
        if (this.intentional.has(child)) {
          if (!settled) {
            settled = true
            clearTimeout(readyTimer)
            reject(unavailable('crashed'))
          }
          return
        }
        if (!settled) return fail('crashed')
        if (generation === this.generation) this.onCrash()
      })

      child.postMessage({
        type: 'init',
        config: {
          dataDir: this.deps.dataDir(),
          port: settings.port,
          quotaBytes: settings.quotaGb * 1024 ** 3,
          publicOrigins: [],
        },
      })
    })
  }

  private onCrash(): void {
    this.child = null
    this.client = null
    const now = this.now()
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now]
    if (this.crashes.length >= MAX_CRASHES) {
      this.setStatus('error', 'crashed')
      return
    }
    this.setStatus('starting')
    const generation = this.generation
    this.schedule(
      () => {
        if (generation !== this.generation || this.client || this.starting) return
        this.ensureStarted().catch(() => {})
      },
      RESTART_BACKOFF_MS[this.crashes.length - 1] ?? RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1]!
    )
  }

  async stop(): Promise<void> {
    this.generation++
    const child = this.child
    this.client?.dispose()
    this.child = null
    this.client = null
    this.port = null
    this.setStatus('stopped')
    if (!child) return
    this.intentional.add(child)
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      child.on('exit', finish)
      try {
        child.postMessage({ type: 'shutdown' })
      } catch {
        child.kill()
        return finish()
      }
      this.schedule(() => {
        if (done) return
        try {
          child.kill()
        } catch {
          // Already exited.
        }
        finish()
      }, SHUTDOWN_TIMEOUT_MS)
    })
  }

  /** Applies new settings: stops the current worker and, when hosting is on, starts a fresh one. */
  async restart(): Promise<void> {
    await this.stop()
    this.crashes = []
    if (this.deps.settings().hostEnabled) await this.ensureStarted().catch(() => {})
  }
}
