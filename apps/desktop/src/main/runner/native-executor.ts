import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { realFs } from '../real-fs'
import { errnoOf, isDiskFull } from './errors'
import { RUNNER_SCRATCH_DIR, type RunnerExecutor, type RunnerExecutorJob, type RunnerExecutorResult } from './executor'
import { loginShellPath } from './login-path'
import { JobProcesses } from './process-tree'

const NICENESS = 10
const NICE = '/usr/bin/nice'
const KILL_GRACE_MS = 10_000
/** After the shell ends, how long its output may still take to arrive before the run is declared over. */
const DRAIN_MS = 5_000
/** How long the run waits, once everything was killed, for the last process of the job to be gone. */
const GONE_WAIT_MS = 5_000
/** How often the job's processes are sampled, and how often what they use is reported, at most. */
const SAMPLE_MS = 1_000
const REPORT_MS = 1_500
const MAX_TIMER_MS = 2 ** 31 - 1

export interface NativeExecutorOptions {
  /** The PATH jobs get: the user's login shell's, by default. */
  loginPath?: () => Promise<string>
  /** How long a stopped command has to end after SIGTERM before its processes get SIGKILL. */
  killGraceMs?: number
  platform?: NodeJS.Platform
}

/** A named cache cannot be placed in the job folder; the message tells the bot why. */
class CacheConflict extends Error {}

/** How much niceness to add to reach `NICENESS`, given what this process already has. */
function niceIncrement(): number {
  try {
    return Math.min(19, Math.max(0, NICENESS - os.getPriority()))
  } catch {
    return NICENESS
  }
}

/**
 * The arguments of `/bin/sh` that run the command. At niceness 10 from the first instruction: `nice` raises it and
 * replaces itself with the shell that runs the command, so no process of the job ever starts without it. Setting it
 * from here afterwards would lose a race against a command that forks at once.
 */
function shellArguments(command: string): string[] {
  const increment = niceIncrement()
  if (increment > 0 && existsSync(NICE)) return ['-c', `exec ${NICE} -n ${increment} /bin/sh -c "$1"`, 'sh', command]
  return ['-c', command]
}

const failure = (code: 'executor_unavailable' | 'runner_disk_full', message: string): RunnerExecutorResult => ({
  exitCode: null,
  timedOut: false,
  cancelled: false,
  error: { code, message },
})

/**
 * Runs a job's command with `/bin/sh -c` in its folder, as the signed-in user, in its own process group at niceness 10.
 * The command's environment is built here and holds only `PATH` (the login shell's), `HOME`, `LANG`, `TMPDIR` inside the
 * folder, `MAESTRLY_JOB_ID`, `MAESTRLY_JOB_DIR` and the job's own variables: nothing of the app's reaches it. Named
 * caches are links in the folder to the runner's cache folders. A stop (timeout or cancel) sends SIGTERM to every
 * process of the job, those that started a group or session of their own included (see `JobProcesses`), and SIGKILL
 * after a grace; whatever the command left running is killed when it ends, and the run ends only once none is alive.
 * While it runs, what its processes use is sampled every second and reported. macOS and Linux only.
 */
export class NativeExecutor implements RunnerExecutor {
  readonly kind = 'native' as const
  private readonly loginPath: () => Promise<string>
  private readonly killGraceMs: number
  private readonly platform: NodeJS.Platform

  constructor(options: NativeExecutorOptions = {}) {
    this.loginPath = options.loginPath ?? loginShellPath
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS
    this.platform = options.platform ?? process.platform
  }

  async run(job: RunnerExecutorJob): Promise<RunnerExecutorResult> {
    if (this.platform === 'win32')
      return failure('executor_unavailable', 'Native jobs run on macOS and Linux only on this computer.')
    if (job.signal.aborted) return { exitCode: null, timedOut: false, cancelled: true }
    let env: Record<string, string>
    try {
      const tmp = path.join(job.workDir, RUNNER_SCRATCH_DIR)
      await realFs.promises.mkdir(tmp, { recursive: true })
      for (const cache of job.caches) await this.linkCache(job.workDir, cache)
      env = {
        PATH: await this.loginPath().catch(() => process.env.PATH ?? '/usr/bin:/bin'),
        HOME: os.homedir(),
        LANG: process.env.LANG || 'en_US.UTF-8',
        TMPDIR: tmp,
        MAESTRLY_JOB_ID: job.jobId,
        MAESTRLY_JOB_DIR: job.workDir,
        ...job.env,
      }
    } catch (error) {
      if (error instanceof CacheConflict) return failure('executor_unavailable', error.message)
      if (isDiskFull(error)) return failure('runner_disk_full', 'This computer is out of disk space.')
      return failure('executor_unavailable', `The job could not be prepared: ${(error as Error).message}`)
    }
    return this.spawnCommand(job, env)
  }

  /** Makes `<workDir>/<cache.path>` a link to the cache folder, replacing an empty folder or a link that is there. */
  private async linkCache(workDir: string, cache: RunnerExecutorJob['caches'][number]): Promise<void> {
    const segments = cache.path.split('/').filter((segment) => segment && segment !== '.')
    if (!segments.length || segments.includes('..') || cache.path.startsWith('/') || cache.path.includes('\\'))
      throw new CacheConflict(`The cache "${cache.name}" has a path outside the job folder.`)
    await realFs.promises.mkdir(cache.dir, { recursive: true })
    // No folder on the way to the link may itself be a link: creating the link would go through it.
    let current = workDir
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment)
      const info = await realFs.promises.lstat(current).catch(() => null)
      if (!info) break
      if (!info.isDirectory()) throw new CacheConflict(`The cache "${cache.name}" cannot be placed at ${cache.path}.`)
    }
    const location = path.join(workDir, ...segments)
    await realFs.promises.mkdir(path.dirname(location), { recursive: true })
    const existing = await realFs.promises.lstat(location).catch((error: unknown) => {
      if (errnoOf(error) === 'ENOENT') return null
      throw error
    })
    if (existing?.isSymbolicLink()) await realFs.promises.unlink(location)
    else if (existing?.isDirectory()) {
      if ((await realFs.promises.readdir(location)).length)
        throw new CacheConflict(
          `The cache "${cache.name}" cannot be placed at ${cache.path}: the job's inputs already have files there.`
        )
      await realFs.promises.rmdir(location)
    } else if (existing)
      throw new CacheConflict(`The cache "${cache.name}" cannot be placed at ${cache.path}: a file is there.`)
    await realFs.promises.symlink(cache.dir, location, 'dir')
  }

  private spawnCommand(job: RunnerExecutorJob, env: Record<string, string>): Promise<RunnerExecutorResult> {
    return new Promise<RunnerExecutorResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn('/bin/sh', shellArguments(job.command), {
          cwd: job.workDir,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        return resolve(failure('executor_unavailable', `The command could not start: ${(error as Error).message}`))
      }
      const tree =
        child.pid === undefined
          ? null
          : new JobProcesses({
              rootPid: child.pid,
              jobId: job.jobId,
              parentPid: process.pid,
              platform: this.platform,
            })
      let timedOut = false
      let cancelled = false
      let stopping = false
      let exitCode: number | null = null
      let ending = false
      let settled = false
      let samples = 0
      let reportedAt = 0
      let sampling = false
      let killTimer: NodeJS.Timeout | undefined
      let drainTimer: NodeJS.Timeout | undefined
      let sampler: NodeJS.Timeout | undefined
      const sample = async (final = false) => {
        if (!tree || (sampling && !final)) return
        sampling = true
        try {
          const usage = await tree.sample()
          samples++
          const at = Date.now()
          // The first sample has no CPU interval behind it.
          if (job.onUsage && !settled && samples > 1 && (final || at - reportedAt >= REPORT_MS)) {
            reportedAt = at
            try {
              job.onUsage(usage)
            } catch {
              // A consumer's failure does not stop the command.
            }
          }
        } catch {
          // The process table could not be read this time.
        } finally {
          sampling = false
        }
      }
      const stop = () => {
        if (stopping) return
        stopping = true
        // One last look before the processes go.
        void sample(true).then(() => tree?.signal('SIGTERM'))
        killTimer = setTimeout(() => void tree?.signal('SIGKILL'), this.killGraceMs)
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
      const settle = (result: RunnerExecutorResult) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearTimeout(killTimer)
        clearTimeout(drainTimer)
        clearInterval(sampler)
        job.signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      /** The run is over once nothing of the job is alive: the job's folder is deleted next. */
      const end = async (result: RunnerExecutorResult) => {
        if (ending) return
        ending = true
        clearTimeout(timeout)
        clearTimeout(killTimer)
        clearTimeout(drainTimer)
        clearInterval(sampler)
        if (tree) await tree.killUntilGone(GONE_WAIT_MS)
        settle(result)
      }
      const forward = (chunk: Buffer) => {
        try {
          job.onOutput(chunk)
        } catch {
          // A consumer's failure does not stop the command.
        }
      }
      child.stdout?.on('data', forward)
      child.stderr?.on('data', forward)
      child.once(
        'error',
        (error) => void end(failure('executor_unavailable', `The command could not start: ${error.message}`))
      )
      child.once('exit', (code) => {
        exitCode = code
        // A job ends with its command: what it left running goes too, which also closes the pipes it held open.
        void tree?.signal('SIGKILL')
        drainTimer = setTimeout(() => void end({ exitCode, timedOut, cancelled }), DRAIN_MS)
      })
      child.once('close', (code) => void end({ exitCode: code ?? exitCode, timedOut, cancelled }))
      if (tree) {
        void sample()
        sampler = setInterval(() => void sample(), SAMPLE_MS)
        sampler.unref?.()
      }
      if (child.pid !== undefined && niceIncrement() > 0 && !existsSync(NICE)) {
        // Without nice(1) the shell is slowed down after it started: a command that forks at once escapes it.
        try {
          os.setPriority(child.pid, NICENESS)
        } catch {
          // Niceness is a courtesy: a computer that refuses it still runs the job.
        }
      }
    })
  }
}
