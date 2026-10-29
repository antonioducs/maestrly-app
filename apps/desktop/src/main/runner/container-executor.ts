import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { botServerImages } from '../fleet/installer/images'
import { realFs } from '../real-fs'
import { isDiskFull } from './errors'
import type { RunnerExecutor, RunnerExecutorJob, RunnerExecutorResult, RunnerExecutorUsage } from './executor'

const STOP_GRACE_SECONDS = 10
/** How long the run's own output is kept to tell a Docker error from the command's. */
const OUTPUT_TAIL = 8 * 1024
/** After a stop, how long the `docker run` client has to end before it is killed. */
const DRAIN_MS = 5_000
/** How many times a stop is retried while the container may not exist yet, and the wait between tries. */
const STOP_ATTEMPTS = 20
const STOP_RETRY_MS = 250
const MAX_TIMER_MS = 2 ** 31 - 1
const PROBE_TIMEOUT_MS = 10_000
/** How often the running container is asked what it uses, and how long one answer may take. */
const STATS_INTERVAL_MS = 5_000
const STATS_TIMEOUT_MS = 10_000

const HOME_MOUNT = '/maestrly-home'
const CACHES_MOUNT = '/maestrly-caches'
const ENV_FILE = 'container.env'
const JOB_LABEL = 'maestrly.runner.job'
const SCOPE_LABEL = 'maestrly.runner.scope'
const OWNER_LABEL = 'maestrly.runner.owner'
const VOLUME_PREFIX = 'maestrly-runner-'
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** The same shape the installer accepts for an image: a bot's image must not be read as a `docker run` option. */
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/

type Spawn = typeof spawn

export type ContainerExecutorOptions = {
  /** The path of the Docker CLI; null when it is not installed. */
  docker: () => string | null
  /** The runner's per-job limits; `gpu` is true only when the runner allows it and the probe passed. */
  limits: () => { cpus: number | null; memoryBytes: number | null; gpu: boolean }
  /** The bot environment image of this app's version. */
  defaultImage: () => string
  platform?: NodeJS.Platform
  /** On Linux, the ids the job runs as; by default the app's own. */
  user?: () => { uid: number; gid: number } | null
  spawn?: Spawn
  /** How long `docker stop` waits for the command to end before Docker kills it. */
  stopGraceSeconds?: number
  /** How often `docker stats` asks what the running container uses. */
  statsIntervalMs?: number
  /**
   * A key of this app's runner, put on its containers: two Maestrly apps of one computer share its Docker, and a
   * restart of one removes only the containers it started.
   */
  owner?: () => string | null
}

export type ContainerArgsOptions = {
  image: string
  cpus: number | null
  memoryBytes: number | null
  gpu: boolean
  /** The ids passed as `--user`; null to leave the image's user (Docker Desktop maps file ownership itself). */
  user: { uid: number; gid: number } | null
  /** The `--env-file` that carries the job's environment. */
  envFile: string
  /** The job's writable home folder on this computer, mounted at `/maestrly-home`. */
  homeDir: string
  /** The runner's key, as a label; see `ContainerExecutorOptions.owner`. */
  owner?: string | null
}

/** The job asks for something this executor cannot do; the message tells the bot what. */
class JobRefused extends Error {}

const failure = (code: 'executor_unavailable' | 'runner_disk_full', message: string): RunnerExecutorResult => ({
  exitCode: null,
  timedOut: false,
  cancelled: false,
  error: { code, message },
})
const cancelledResult = (): RunnerExecutorResult => ({ exitCode: null, timedOut: false, cancelled: true })

const containerName = (jobId: string): string => `maestrly-job-${jobId}`

/** The last non-empty line of a text, where Docker puts the reason it failed. */
function lastLine(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1)
  return line ? line.slice(0, 300) : null
}

/** The line of a Docker error that says why: the one the CLI prefixes with `docker:`, else the last, without its usage hint. */
function reasonLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith("See 'docker "))
  const line = [...lines].reverse().find((item) => item.startsWith('docker: ')) ?? lines.at(-1)
  return line ? line.slice(0, 300) : null
}

const volumePart = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, '_')

/**
 * The Docker volume that keeps one bot's named cache: `maestrly-runner-<scope>-<name>`. Volume names allow
 * `[a-zA-Z0-9_.-]` only, so any other character becomes `_` and a short hash of the original pair is appended, which
 * keeps two different names from sharing a volume. The scope is a fixed-length key, so one scope's prefix never matches
 * another's.
 */
export function cacheVolumeName(scope: string, name: string): string {
  const safeScope = volumePart(scope)
  const safeName = volumePart(name)
  const base = `${VOLUME_PREFIX}${safeScope}-${safeName}`
  if (safeScope === scope && safeName === name) return base
  return `${base}-${createHash('sha256').update(`${scope}\0${name}`).digest('hex').slice(0, 8)}`
}

/** One `--mount` value: a CSV record, so a path with a comma or a quote stays one field. */
function mountOption(fields: Array<[string, string]>): string {
  return fields
    .map(([key, value]) => {
      const field = `${key}=${value}`
      return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field
    })
    .join(',')
}

const assertImage = (image: string): void => {
  if (!IMAGE_REF.test(image)) throw new JobRefused(`"${image.slice(0, 100)}" is not a valid image reference.`)
}

/** Where a named cache is mounted inside the container: its path under the job folder. */
function cacheTarget(folder: string, cache: RunnerExecutorJob['caches'][number]): string {
  const segments = cache.path.split('/').filter((segment) => segment && segment !== '.')
  if (!segments.length || segments.includes('..') || cache.path.startsWith('/') || cache.path.includes('\\'))
    throw new JobRefused(`The cache "${cache.name}" has a path outside the job folder.`)
  return path.posix.join(folder, ...segments)
}

/**
 * The arguments of `docker run` for a job. The job folder's assembled copy is mounted at the folder's own path, named
 * caches are volumes mounted at their paths, and the environment comes from `envFile`: values never appear in the
 * arguments, which any process of the computer can list. There is no `--privileged`, no Docker socket and no host
 * network. Throws when the job asks for what cannot be mounted or run safely.
 */
export function containerArgs(job: RunnerExecutorJob, options: ContainerArgsOptions): string[] {
  assertImage(options.image)
  const name = containerName(job.jobId)
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    name,
    '--label',
    `${JOB_LABEL}=${job.jobId}`,
    '--label',
    `${SCOPE_LABEL}=${job.scope}`,
    ...(options.owner ? ['--label', `${OWNER_LABEL}=${options.owner}`] : []),
    '--entrypoint',
    '/bin/sh',
    '--security-opt',
    'no-new-privileges',
    '--shm-size',
    '2g',
  ]
  if (options.cpus !== null) args.push('--cpus', String(options.cpus))
  if (options.memoryBytes !== null) args.push('--memory', String(Math.floor(options.memoryBytes)))
  if (options.gpu) args.push('--gpus', 'all')
  if (options.user) args.push('--user', `${options.user.uid}:${options.user.gid}`)
  args.push(
    '--env-file',
    options.envFile,
    '--mount',
    mountOption([
      ['type', 'bind'],
      ['source', job.workDir],
      ['target', job.folder],
    ]),
    '--mount',
    mountOption([
      ['type', 'bind'],
      ['source', options.homeDir],
      ['target', HOME_MOUNT],
    ])
  )
  for (const cache of job.caches)
    args.push(
      '--mount',
      mountOption([
        ['type', 'volume'],
        ['source', cacheVolumeName(job.scope, cache.name)],
        ['target', cacheTarget(job.folder, cache)],
      ])
    )
  args.push('-w', job.folder, options.image, '-c', job.command)
  return args
}

/**
 * The text of the job's `--env-file`: the runner's few variables, then the job's own, which win. The file format has
 * no quoting, so a value with a line break cannot be passed and the job is refused; Docker would split it in two.
 */
function envFileText(job: RunnerExecutorJob): string {
  const env: Record<string, string> = {
    MAESTRLY_JOB_ID: job.jobId,
    MAESTRLY_JOB_DIR: job.folder,
    HOME: HOME_MOUNT,
    LANG: 'C.UTF-8',
    ...job.env,
  }
  const lines: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) throw new JobRefused(`"${key}" is not a valid environment variable name.`)
    if (/[\r\n\0]/.test(value))
      throw new JobRefused(
        `The environment variable ${key} has a line break in its value, which a container job cannot receive. ` +
          'Encode the value (for example as base64) or put it in a file in the job folder.'
      )
    lines.push(`${key}=${value}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * `docker` with its own directories first on PATH, which is where its credential helpers sit. The rest of the app's
 * environment goes to the CLI (it reads `DOCKER_HOST`, its config folder and the like) but never into the container.
 */
function dockerEnvironment(docker: string): NodeJS.ProcessEnv {
  const base = process.env
  const key = Object.keys(base).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const dirs: string[] = []
  if (path.isAbsolute(docker)) {
    dirs.push(path.dirname(docker))
    try {
      dirs.push(path.dirname(realFs.realpathSync(docker)))
    } catch {
      // A broken link still runs from its own directory.
    }
  }
  const current = (base[key] ?? '').split(path.delimiter).filter(Boolean)
  return { ...base, [key]: [...new Set([...dirs, ...current])].join(path.delimiter) }
}

type DockerFailure = { code: 'executor_unavailable' | 'runner_disk_full'; message: string }

/** What a Docker error text means for the job: the disk is full, the daemon is not there, or Docker's own words. */
function describeDockerFailure(text: string, fallback: (reason: string) => string): DockerFailure {
  if (/no space left on device/i.test(text))
    return { code: 'runner_disk_full', message: 'This computer is out of disk space.' }
  if (/permission denied/i.test(text) && /docker\.sock|docker daemon|docker api/i.test(text))
    return { code: 'executor_unavailable', message: 'The runner user is not allowed to use Docker on this computer.' }
  if (daemonDown(text)) return { code: 'executor_unavailable', message: 'Docker is not running on this computer.' }
  return {
    code: 'executor_unavailable',
    message: fallback(reasonLine(text)?.replace(/^docker:\s*/, '') ?? 'no reason given'),
  }
}

const daemonDown = (text: string): boolean =>
  /cannot connect to the docker daemon|is the docker daemon running|error during connect|daemon is not running|docker daemon is not running|the system cannot find the file specified/i.test(
    text
  )

type Captured = {
  code: number | null
  stdout: string
  stderr: string
  aborted: boolean
  /** Set when the CLI could not be started at all. */
  spawnError?: string
}

/** Emits the complete non-empty lines of a text as its chunks arrive; `flush` emits the rest. */
function lineSplitter(onLine: (line: string) => void) {
  let pending = ''
  const emit = (line: string) => {
    if (line.trim()) onLine(line.trimEnd())
  }
  return {
    push(chunk: string) {
      pending += chunk
      const lines = pending.split(/\r\n|\n|\r/)
      pending = lines.pop() ?? ''
      for (const line of lines) emit(line)
    },
    flush() {
      emit(pending)
      pending = ''
    },
  }
}

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
  tb: 1000 ** 4,
  tib: 1024 ** 4,
}

/** Bytes of a size as Docker prints it ("1.5GiB", "12kB", "0B"); null for anything else. */
function parseDockerBytes(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*$/.exec(text)
  const unit = match ? BYTE_UNITS[match[2].toLowerCase()] : undefined
  return match && unit !== undefined ? Math.round(Number(match[1]) * unit) : null
}

/**
 * What `docker stats --no-stream --format '{{json .}}'` says of a container: `CPUPerc` ("123.45%", of one CPU),
 * `MemUsage` ("1.5GiB / 7.7GiB": the first number is what the container holds) and `PIDs`. Null when the line is not
 * that or CPU or memory is not a number, as for a container that is not running.
 */
export function parseDockerStats(output: string): Omit<RunnerExecutorUsage, 'cpuSeconds'> | null {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1)
  let stats: Record<string, unknown>
  try {
    stats = JSON.parse(line ?? '') as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof stats !== 'object' || stats === null) return null
  const cpu = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(String(stats.CPUPerc ?? ''))
  const memoryBytes = parseDockerBytes(String(stats.MemUsage ?? '').split('/')[0])
  if (!cpu || memoryBytes === null) return null
  const processes = Number.parseInt(String(stats.PIDs ?? ''), 10)
  return { cpuPercent: Number(cpu[1]), memoryBytes, processes: Number.isFinite(processes) ? processes : 0 }
}

/**
 * Runs a job's command in a Docker container on this computer: `docker run --rm --init` with `/bin/sh -c <command>` as
 * the entrypoint, from the job's image or else the bot environment image of the app's version, pulled on first use.
 * The job folder is mounted at the path it has in the bot environment, named caches are volumes, and the job's
 * environment travels in a private file, not in arguments. CPU and memory limits and the GPU come from the runner's
 * settings; the container has no privileges, no Docker socket and the default bridge network. On Linux it runs as the
 * runner user. A stop (timeout or cancel) runs `docker stop` and then `docker rm -f`. The containers carry the job id
 * as a label so a restart can remove those of jobs the runner no longer holds. While the container runs, `docker stats`
 * is asked every five seconds what it uses, one question at a time; an answer that does not come is skipped.
 */
export class ContainerExecutor implements RunnerExecutor {
  readonly kind = 'container' as const
  private readonly platform: NodeJS.Platform
  private readonly spawn: Spawn
  private readonly stopGraceSeconds: number
  private readonly statsIntervalMs: number

  constructor(private readonly options: ContainerExecutorOptions) {
    this.platform = options.platform ?? process.platform
    this.spawn = options.spawn ?? spawn
    this.stopGraceSeconds = Math.max(0, Math.trunc(options.stopGraceSeconds ?? STOP_GRACE_SECONDS))
    this.statsIntervalMs = Math.max(1, options.statsIntervalMs ?? STATS_INTERVAL_MS)
  }

  async run(job: RunnerExecutorJob): Promise<RunnerExecutorResult> {
    if (job.signal.aborted) return cancelledResult()
    const docker = this.options.docker()
    if (!docker) return failure('executor_unavailable', 'Docker is not installed on this computer.')
    const jobDir = path.dirname(job.workDir)
    const homeDir = path.join(jobDir, 'home')
    const envFile = path.join(jobDir, ENV_FILE)
    let image: string
    let args: string[]
    let envText: string
    try {
      image = job.image ?? this.options.defaultImage()
      assertImage(image)
      const limits = this.options.limits()
      args = containerArgs(job, {
        image,
        cpus: limits.cpus,
        memoryBytes: limits.memoryBytes,
        gpu: limits.gpu,
        user: this.runUser(),
        envFile,
        homeDir,
        owner: this.options.owner?.() ?? null,
      })
      envText = envFileText(job)
    } catch (error) {
      return failure(
        'executor_unavailable',
        error instanceof JobRefused ? error.message : `The job could not be prepared: ${(error as Error).message}`
      )
    }
    try {
      await realFs.promises.mkdir(homeDir, { recursive: true })
      await realFs.promises.rm(envFile, { force: true })
      await realFs.promises.writeFile(envFile, envText, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      await realFs.promises.rm(envFile, { force: true }).catch(() => undefined)
      if (isDiskFull(error)) return failure('runner_disk_full', 'This computer is out of disk space.')
      return failure('executor_unavailable', `The job could not be prepared: ${(error as Error).message}`)
    }
    try {
      if (job.signal.aborted) return cancelledResult()
      const unready = await this.ensureImage(job, docker, image)
      if (unready) return unready
      if (job.signal.aborted) return cancelledResult()
      await this.prepareVolumes(job, docker, image)
      return await this.runContainer(job, docker, args)
    } finally {
      await realFs.promises.rm(envFile, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Removes the containers of this runner's jobs (those with its `owner` label, when it has one) whose id is not in
   * `keep`; they outlived the app that started them.
   */
  async removeOrphans(keep: Set<string>): Promise<void> {
    const docker = this.options.docker()
    if (!docker) return
    const owner = this.options.owner?.()
    const listed = await this.capture(docker, [
      'ps',
      '-a',
      '--filter',
      `label=${JOB_LABEL}`,
      ...(owner ? ['--filter', `label=${OWNER_LABEL}=${owner}`] : []),
      '--format',
      `{{.ID}} {{.Label "${JOB_LABEL}"}}`,
    ])
    if (listed.code !== 0) return
    const orphans: string[] = []
    for (const line of listed.stdout.split(/\r?\n/)) {
      const [id, jobId] = line.trim().split(/\s+/)
      if (id && jobId && !keep.has(jobId)) orphans.push(id)
    }
    if (orphans.length) await this.capture(docker, ['rm', '-f', ...orphans])
  }

  /** Removes the Docker volumes that hold one bot's named caches. Best effort: a volume in use or a stopped daemon leaves them. */
  async removeScopeVolumes(scope: string): Promise<void> {
    const docker = this.options.docker()
    if (!docker) return
    const prefix = `${VOLUME_PREFIX}${volumePart(scope)}-`
    const listed = await this.capture(docker, ['volume', 'ls', '-q', '--filter', `name=${prefix}`])
    if (listed.code !== 0) return
    // The filter matches anywhere in a name: only the volumes that start with the prefix are this scope's.
    const volumes = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((name) => name.startsWith(prefix))
    if (volumes.length) await this.capture(docker, ['volume', 'rm', '-f', ...volumes])
  }

  private ownerLabel(): string[] {
    const owner = this.options.owner?.()
    return owner ? ['--label', `${OWNER_LABEL}=${owner}`] : []
  }

  private runUser(): { uid: number; gid: number } | null {
    if (this.platform !== 'linux') return null
    if (this.options.user) return this.options.user()
    return typeof process.getuid === 'function' && typeof process.getgid === 'function'
      ? { uid: process.getuid(), gid: process.getgid() }
      : null
  }

  /** Runs a short Docker command to its end and collects its output. */
  private capture(
    docker: string,
    args: string[],
    options: { signal?: AbortSignal; onLine?: (line: string) => void } = {}
  ): Promise<Captured> {
    return new Promise<Captured>((resolve) => {
      let child: ReturnType<Spawn>
      try {
        child = this.spawn(docker, args, {
          env: dockerEnvironment(docker),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        return resolve({ code: null, stdout: '', stderr: '', aborted: false, spawnError: (error as Error).message })
      }
      let stdout = ''
      let stderr = ''
      let aborted = false
      let settled = false
      const lines = options.onLine ? lineSplitter(options.onLine) : null
      const settle = (result: Captured) => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener('abort', onAbort)
        lines?.flush()
        resolve(result)
      }
      const onAbort = () => {
        aborted = true
        child.kill('SIGTERM')
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout = (stdout + chunk).slice(-OUTPUT_TAIL * 8)
        lines?.push(chunk)
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-OUTPUT_TAIL * 8)
        lines?.push(chunk)
      })
      child.once('error', (error) =>
        settle({ code: null, stdout, stderr, aborted, spawnError: error.message || 'the Docker CLI did not start' })
      )
      child.once('close', (code) => settle({ code, stdout, stderr, aborted }))
      if (options.signal?.aborted) onAbort()
    })
  }

  /** Makes sure the image is on this computer, pulling it on first use. Null when it is; else why the job cannot run. */
  private async ensureImage(
    job: RunnerExecutorJob,
    docker: string,
    image: string
  ): Promise<RunnerExecutorResult | null> {
    const found = await this.capture(docker, ['image', 'inspect', '--format', '{{.Id}}', image], {
      signal: job.signal,
    })
    if (found.aborted) return cancelledResult()
    if (found.spawnError) return failure('executor_unavailable', `Docker could not start: ${found.spawnError}`)
    if (found.code === 0) return null
    if (daemonDown(found.stderr) || /permission denied/i.test(found.stderr)) {
      const reason = describeDockerFailure(found.stderr, (line) => `Docker failed: ${line}`)
      return failure(reason.code, reason.message)
    }
    this.forward(job, Buffer.from(`[runner] Pulling the image ${image}\n`))
    const pulled = await this.capture(docker, ['pull', image], {
      signal: job.signal,
      onLine: (line) => this.forward(job, Buffer.from(`[pull] ${line}\n`)),
    })
    if (pulled.aborted) return cancelledResult()
    if (pulled.spawnError) return failure('executor_unavailable', `Docker could not start: ${pulled.spawnError}`)
    if (pulled.code === 0) return null
    const reason = describeDockerFailure(
      pulled.stderr || pulled.stdout,
      (line) => `The image ${image} could not be pulled: ${line}`
    )
    return failure(reason.code, reason.message)
  }

  /**
   * A new Docker volume belongs to root, and a job that runs as the runner user could not write in it. One short
   * container hands the cache volumes' top folders to that user. A failure is logged, not fatal: the job may not need
   * them, and the command's own error says what it could not write.
   */
  private async prepareVolumes(job: RunnerExecutorJob, docker: string, image: string): Promise<void> {
    const user = this.runUser()
    if (!user || !job.caches.length) return
    const args = [
      'run',
      '--rm',
      '--name',
      `${containerName(job.jobId)}-caches`,
      '--label',
      `${JOB_LABEL}=${job.jobId}`,
      '--label',
      `${SCOPE_LABEL}=${job.scope}`,
      ...this.ownerLabel(),
      '--network',
      'none',
      '--user',
      '0:0',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--security-opt',
      'no-new-privileges',
      '--entrypoint',
      'chown',
    ]
    const targets: string[] = []
    job.caches.forEach((cache, index) => {
      const target = `${CACHES_MOUNT}/${index}`
      targets.push(target)
      args.push(
        '--mount',
        mountOption([
          ['type', 'volume'],
          ['source', cacheVolumeName(job.scope, cache.name)],
          ['target', target],
        ])
      )
    })
    args.push(image, `${user.uid}:${user.gid}`, ...targets)
    const prepared = await this.capture(docker, args, { signal: job.signal })
    if (prepared.code !== 0 && !prepared.aborted)
      this.forward(
        job,
        Buffer.from(
          `[runner] The cache folders could not be prepared: ${lastLine(prepared.stderr || prepared.spawnError || '') ?? 'no reason given'}\n`
        )
      )
  }

  private forward(job: RunnerExecutorJob, chunk: Buffer): void {
    try {
      job.onOutput(chunk)
    } catch {
      // A consumer's failure does not stop the job.
    }
  }

  private runContainer(job: RunnerExecutorJob, docker: string, args: string[]): Promise<RunnerExecutorResult> {
    const name = containerName(job.jobId)
    return new Promise<RunnerExecutorResult>((resolve) => {
      if (job.signal.aborted) return resolve(cancelledResult())
      let child: ReturnType<Spawn>
      try {
        child = this.spawn(docker, args, {
          env: dockerEnvironment(docker),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        return resolve(failure('executor_unavailable', `The command could not start: ${(error as Error).message}`))
      }
      let timedOut = false
      let cancelled = false
      let stopFlow: Promise<void> | null = null
      let exited = false
      let settled = false
      let stderrTail = ''
      let drainTimer: NodeJS.Timeout | undefined
      const stopWatching = this.watchUsage(job, docker, name)
      const settle = (result: RunnerExecutorResult) => {
        if (settled) return
        settled = true
        stopWatching()
        clearTimeout(timeout)
        clearTimeout(drainTimer)
        job.signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const stop = () => {
        if (stopFlow) return
        stopFlow = this.stopContainer(docker, name, () => exited).then(() => {
          if (exited || settled) return
          // The client outlived its container: end it instead of waiting for a daemon that does not answer.
          drainTimer = setTimeout(() => {
            child.kill('SIGKILL')
            settle({ exitCode: null, timedOut, cancelled })
          }, DRAIN_MS)
        })
      }
      const timeout = setTimeout(
        () => {
          timedOut = true
          stop()
        },
        Math.min(MAX_TIMER_MS, Math.max(1, job.timeoutMs))
      )
      const onAbort = () => {
        cancelled = true
        stop()
      }
      job.signal.addEventListener('abort', onAbort, { once: true })
      child.stdout?.on('data', (chunk: Buffer) => this.forward(job, chunk))
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-OUTPUT_TAIL)
        this.forward(job, chunk)
      })
      child.once('error', (error) =>
        settle(failure('executor_unavailable', `The command could not start: ${error.message}`))
      )
      child.once('close', (code) => {
        exited = true
        if (stopFlow) {
          // The result waits for the container's removal. A stopped command ends by a signal: 128 + 9 or 15 is not a
          // code the command chose.
          const exitCode = code === 137 || code === 143 ? null : code
          void stopFlow.then(() => settle({ exitCode, timedOut, cancelled }))
          return
        }
        if (code === 125 && this.dockerRefused(stderrTail)) {
          const reason = describeDockerFailure(stderrTail, (line) => `The container could not start: ${line}`)
          return settle(failure(reason.code, this.scrub(job, reason.message)))
        }
        settle({ exitCode: code, timedOut, cancelled })
      })
    })
  }

  /**
   * Asks `docker stats` what the container uses every `statsIntervalMs` and passes it on, with the CPU time added up
   * from the percentages (an estimate). A question is asked only when the one before has been answered or has failed;
   * a failure (the container is not up yet, or already gone) is skipped. Answers the function that stops it.
   */
  private watchUsage(job: RunnerExecutorJob, docker: string, name: string): () => void {
    if (!job.onUsage) return () => undefined
    const onUsage = job.onUsage.bind(job)
    let stopped = false
    let asking = false
    let cpuSeconds = 0
    let counted = Date.now()
    const timer = setInterval(() => {
      if (asking || stopped) return
      asking = true
      void this.capture(docker, ['stats', '--no-stream', '--format', '{{json .}}', name], {
        signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
      })
        .then((answer) => {
          const usage = answer.code === 0 ? parseDockerStats(answer.stdout) : null
          if (!usage || stopped) return
          const at = Date.now()
          cpuSeconds += (usage.cpuPercent / 100) * ((at - counted) / 1000)
          counted = at
          try {
            onUsage({ ...usage, cpuSeconds })
          } catch {
            // A consumer's failure does not stop the job.
          }
        })
        .finally(() => {
          asking = false
        })
    }, this.statsIntervalMs)
    timer.unref?.()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  /** Whether the run's error output is Docker's own (the container never started) and not a command that exited 125. */
  private dockerRefused(stderr: string): boolean {
    const lines = stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
    return lines.some((line) => /^docker: /i.test(line) || /^See 'docker run --help'/.test(line))
  }

  /** Keeps this computer's folders out of what the bot reads. */
  private scrub(job: RunnerExecutorJob, message: string): string {
    return message.replaceAll(path.dirname(job.workDir), '<runner job folder>')
  }

  /**
   * `docker stop`, then `docker rm -f`. A stop that arrives before the container exists is retried until the `docker
   * run` client ends or the attempts run out, so a cancelled job never leaves a container that starts late.
   */
  private async stopContainer(docker: string, name: string, ended: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < STOP_ATTEMPTS && !ended(); attempt++) {
      const stopped = await this.capture(docker, ['stop', '-t', String(this.stopGraceSeconds), name])
      if (stopped.code === 0 || ended()) break
      await new Promise<void>((resolve) => setTimeout(resolve, STOP_RETRY_MS))
    }
    await this.capture(docker, ['rm', '-f', name])
  }
}

/** The bot environment image of an app version: the one the installer pulls for the bot server (`maestrly-bot-instance`). */
export function defaultRunnerImage(
  appVersion: string,
  options: { isPackaged?: boolean; env?: NodeJS.ProcessEnv } = {}
): string {
  return botServerImages({
    version: appVersion,
    isPackaged: options.isPackaged ?? true,
    env: options.env ?? process.env,
  }).bot
}

/** How a probe runs Docker: the CLI's output on success, a rejection (with `stderr` when it has one) otherwise. */
export type ContainerProbeExec = (file: string, args: string[]) => Promise<string>

const execDocker =
  (timeoutMs: number): ContainerProbeExec =>
  (file, args) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: dockerEnvironment(file) },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      )
    })

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text.trim())
  } catch {
    return null
  }
}

/**
 * Whether the Docker CLI is there and its daemon answers, and whether jobs may ask for the GPU. The GPU answer reads
 * the daemon's configuration and starts nothing: `--gpus` works when the NVIDIA runtime is registered (the NVIDIA
 * Container Toolkit's `nvidia-ctk runtime configure`, and Docker Desktop with the WSL2 NVIDIA driver) or when Docker
 * lists CDI devices from the `nvidia.com` vendor. Running `docker run --gpus all` against an image would be the surest
 * test, but it needs an image already on this computer or a pull, and it starts a container; a probe that is cheap and
 * leaves nothing behind is worth a computer that has only the toolkit's legacy hook, which reports no GPU. `message`
 * is Docker's own reason when the daemon does not answer.
 */
export async function probeContainerSupport(options: {
  docker: string | null
  exec?: ContainerProbeExec
  timeoutMs?: number
}): Promise<{ docker: 'missing' | 'stopped' | 'ready'; gpu: boolean; message: string | null }> {
  if (!options.docker) return { docker: 'missing', gpu: false, message: null }
  const docker = options.docker
  const exec = options.exec ?? execDocker(options.timeoutMs ?? PROBE_TIMEOUT_MS)
  let version: unknown
  try {
    version = parseJson(await exec(docker, ['info', '--format', '{{json .ServerVersion}}']))
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
    if (failed.code === 'ENOENT') return { docker: 'missing', gpu: false, message: null }
    const message = failed.killed
      ? 'Docker did not answer in time.'
      : (lastLine(failed.stderr ?? '') ?? lastLine(failed.message ?? ''))
    return { docker: 'stopped', gpu: false, message }
  }
  if (typeof version !== 'string' || !version) return { docker: 'stopped', gpu: false, message: null }
  const [runtimes, devices] = await Promise.all([
    exec(docker, ['info', '--format', '{{json .Runtimes}}']).catch(() => ''),
    exec(docker, ['info', '--format', '{{json .DiscoveredDevices}}']).catch(() => ''),
  ])
  const runtimeNames = parseJson(runtimes)
  const nvidiaRuntime =
    typeof runtimeNames === 'object' && runtimeNames !== null && Object.keys(runtimeNames).includes('nvidia')
  const discovered = parseJson(devices)
  const nvidiaDevices =
    Array.isArray(discovered) &&
    discovered.some(
      (device) =>
        typeof device === 'object' &&
        device !== null &&
        typeof (device as { ID?: unknown }).ID === 'string' &&
        (device as { ID: string }).ID.startsWith('nvidia.com/')
    )
  return { docker: 'ready', gpu: nvidiaRuntime || nvidiaDevices, message: null }
}
