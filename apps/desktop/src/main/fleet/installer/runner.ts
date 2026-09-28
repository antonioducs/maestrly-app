import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { InstallerError } from './errors'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}
export interface RunOptions {
  /** Written to the command's standard input, which is always closed. */
  input?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Receives each non-empty output line as it arrives, for progress. */
  onLine?: (line: string) => void
}

/**
 * Where the installer runs Docker: this computer's CLI, or a VPS over SSH. `docker` resolves with any exit code and
 * rejects only when the CLI cannot run (`docker-missing`) or the job is cancelled (`cancelled`).
 */
export interface CommandRunner {
  readonly kind: 'local' | 'remote'
  docker(args: string[], options?: RunOptions): Promise<RunResult>
  /** Writes a file only its owner can read, in a directory only its owner can open. */
  writeFile(path: string, content: string): Promise<void>
  readFile(path: string): Promise<string | null>
  join(...parts: string[]): string
}

/** Keeps the end of long outputs, such as image downloads, where the error is. */
const OUTPUT_MAX = 1_048_576
const KILL_AFTER_MS = 3_000

/**
 * The Docker CLI: an explicit one for tests, else the first on PATH, else where Docker Desktop, OrbStack, Rancher
 * Desktop, Homebrew or a Linux package install it. A GUI app often starts with a PATH that has none of them.
 */
export function findDockerCli(options: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  exists: (path: string) => boolean
}): string | null {
  const { env, platform, home, exists } = options
  const override = env.MAESTRLY_BOT_SERVER_DOCKER?.trim()
  if (override) return exists(override) ? override : null
  const windows = platform === 'win32'
  const join = windows ? path.win32.join : path.posix.join
  const name = windows ? 'docker.exe' : 'docker'
  const searchPath = (env.PATH ?? env.Path ?? '').split(windows ? ';' : ':').filter(Boolean)
  const known = windows
    ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin')]
    : [
        join(home, '.docker', 'bin'),
        join(home, '.orbstack', 'bin'),
        join(home, '.rd', 'bin'),
        '/Applications/Docker.app/Contents/Resources/bin',
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
      ]
  for (const dir of [...searchPath, ...known]) {
    const candidate = join(dir, name)
    if (exists(candidate)) return candidate
  }
  return null
}

/** The environment key that holds the search path (`Path` on Windows), or `PATH`. */
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

/** Emits complete lines to `onLine` as chunks arrive; `flush` emits the rest. */
function lineSplitter(onLine: ((line: string) => void) | undefined) {
  let pending = ''
  return {
    push(chunk: string) {
      if (!onLine) return
      pending += chunk
      const lines = pending.split(/\r\n|\n|\r/)
      pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLine(line.trimEnd())
    },
    flush() {
      if (onLine && pending.trim()) onLine(pending.trimEnd())
      pending = ''
    },
  }
}

export class LocalRunner implements CommandRunner {
  readonly kind = 'local' as const
  readonly dockerPath: string | null
  private readonly env: NodeJS.ProcessEnv

  constructor(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {}) {
    this.env = options.env ?? process.env
    this.dockerPath = findDockerCli({
      env: this.env,
      platform: options.platform ?? process.platform,
      home: options.home ?? os.homedir(),
      exists: existsSync,
    })
  }

  docker(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const docker = this.dockerPath
    if (!docker) return Promise.reject(new InstallerError('docker-missing'))
    if (options.signal?.aborted) return Promise.reject(new InstallerError('cancelled'))
    // Credential helpers (docker-credential-desktop, -osxkeychain) sit beside the CLI, or beside its link target.
    const dirs = [path.dirname(docker)]
    try {
      dirs.push(path.dirname(realpathSync(docker)))
    } catch {
      /* A broken link still runs from its own directory. */
    }
    const key = pathKey(this.env)
    const searchPath = [...new Set([...dirs, ...(this.env[key] ?? '').split(path.delimiter).filter(Boolean)])]
    return new Promise((resolve, reject) => {
      const child = spawn(docker, args, {
        env: { ...this.env, [key]: searchPath.join(path.delimiter) },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      const lines = lineSplitter(options.onLine)
      const stop = () => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS).unref()
      }
      const onAbort = () => {
        stop()
        finish(() => reject(new InstallerError('cancelled')))
      }
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true
            stop()
          }, options.timeoutMs)
        : null
      const finish = (settle: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        settle()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout = (stdout + chunk).slice(-OUTPUT_MAX)
        lines.push(chunk)
      })
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-OUTPUT_MAX)
        lines.push(chunk)
      })
      child.stdin.on('error', () => {
        /* The command may exit before reading its input. */
      })
      child.stdin.end(options.input ?? '')
      child.once('error', (error: NodeJS.ErrnoException) =>
        finish(() => reject(error.code === 'ENOENT' ? new InstallerError('docker-missing') : error))
      )
      child.once('close', (code) => {
        lines.flush()
        finish(() =>
          resolve(
            timedOut
              ? {
                  code: 124,
                  stdout,
                  stderr: `${stderr}\nTimed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} s`,
                }
              : { code: code ?? 1, stdout, stderr }
          )
        )
      })
    })
  }

  async writeFile(file: string, content: string): Promise<void> {
    const dir = path.dirname(file)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, file)
    await chmod(file, 0o600).catch(() => {})
  }

  async readFile(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  join(...parts: string[]): string {
    return path.join(...parts)
  }
}
