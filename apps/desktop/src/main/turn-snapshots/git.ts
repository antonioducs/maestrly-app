import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSpawnNotFound, retryWhenGitAppears } from '../git-command'
import { terminateTree } from '../project-setup/git-runner'

/**
 * The only way turn snapshots run Git. Every invocation starts from an empty environment: no system or global
 * configuration, no hooks, no fsmonitor, no line-ending or filter conversion, no pager, no prompts and no network.
 * Paths are passed literally and read back NUL-delimited. A shadow store is addressed with GIT_DIR, never through
 * discovery, so a command can never reach the user's repository by accident.
 */

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_STDOUT = 64 * 1024 * 1024
const MAX_STDERR = 64 * 1024

export type SnapshotGitErrorKind = 'unavailable' | 'timeout' | 'too-large' | 'failed'

export class SnapshotGitError extends Error {
  constructor(
    readonly kind: SnapshotGitErrorKind,
    message: string,
    readonly stderr = '',
    readonly exitCode: number | null = null
  ) {
    super(message)
    this.name = 'SnapshotGitError'
  }
}

export interface SnapshotGitResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

export interface SnapshotGitOptions {
  cwd: string
  /** The shadow store. Omitted only for commands that must not see one (`init`, reads of the user's repository). */
  gitDir?: string
  workTree?: string
  index?: string
  /**
   * The user's object directory, for commands that only read objects. Writes never get it: Git refreshes the
   * timestamp of an object it finds in an alternate instead of writing its own copy.
   */
  alternate?: string | null
  /** Extra `-c` entries, for example the user's excludes file. */
  config?: readonly string[]
  input?: string | Buffer
  timeoutMs?: number
  maxStdoutBytes?: number
  signal?: AbortSignal
  /** Exit codes that are answers rather than failures, such as 1 for `config --get` without a value. */
  okCodes?: readonly number[]
  /** Run with the user's own environment and configuration (reads of the user's settings only). */
  userEnvironment?: boolean
}

let supportDir: string | null = null
/**
 * An empty hooks directory, an empty template for `git init` (no sample hooks, no default `info/exclude`) and an
 * empty file for configuration and attributes; `/dev/null` does not exist on Windows.
 */
function support(): { hooks: string; empty: string; template: string } {
  if (!supportDir || !existsSync(supportDir)) supportDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-snapshot-git-'))
  const hooks = path.join(supportDir, 'hooks')
  const template = path.join(supportDir, 'template')
  const empty = path.join(supportDir, 'empty')
  mkdirSync(hooks, { recursive: true })
  mkdirSync(template, { recursive: true })
  if (!existsSync(empty)) writeFileSync(empty, '')
  return { hooks, empty, template }
}

export function emptyTemplateDir(): string {
  return support().template
}

const KEEP_ENV = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'XDG_CONFIG_HOME',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'TMPDIR',
  'TEMP',
  'TMP',
]

export function snapshotGitConfig(hooks: string, empty: string): string[] {
  return [
    `core.hooksPath=${hooks}`,
    'core.fsmonitor=false',
    'core.autocrlf=false',
    'core.safecrlf=false',
    'core.longpaths=true',
    'core.quotepath=false',
    'core.untrackedCache=false',
    'core.splitIndex=false',
    `core.attributesFile=${empty}`,
    'core.sparseCheckout=false',
    'core.logAllRefUpdates=false',
    'index.sparse=false',
    'feature.manyFiles=false',
    'gc.auto=0',
    'maintenance.auto=false',
    'safe.directory=*',
    'submodule.recurse=false',
    'diff.renames=false',
    'diff.external=',
    'credential.helper=',
    'protocol.allow=never',
  ]
}

function snapshotEnv(opts: SnapshotGitOptions, empty: string): NodeJS.ProcessEnv {
  if (opts.userEnvironment) {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
  }
  const env: NodeJS.ProcessEnv = {}
  for (const key of KEEP_ENV) if (process.env[key] !== undefined) env[key] = process.env[key]
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: empty,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
    ...(opts.gitDir ? { GIT_DIR: opts.gitDir } : {}),
    ...(opts.workTree ? { GIT_WORK_TREE: opts.workTree } : {}),
    ...(opts.index ? { GIT_INDEX_FILE: opts.index } : {}),
    ...(opts.alternate ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: opts.alternate } : {}),
  }
}

function spawnOnce(args: readonly string[], opts: SnapshotGitOptions): Promise<SnapshotGitResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new SnapshotGitError('timeout', 'Snapshot Git command was cancelled'))
    const { hooks, empty } = support()
    const fullArgs = opts.userEnvironment
      ? [...(opts.config ?? []).flatMap((entry) => ['-c', entry]), ...args]
      : [...[...snapshotGitConfig(hooks, empty), ...(opts.config ?? [])].flatMap((entry) => ['-c', entry]), ...args]
    const child = spawn('git', fullArgs, {
      cwd: opts.cwd,
      env: snapshotEnv(opts, empty),
      shell: false,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const chunks: Buffer[] = []
    const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const stop = (error: SnapshotGitError) => {
      void terminateTree(child).finally(() => finish(() => reject(error)))
    }
    const onAbort = () => stop(new SnapshotGitError('timeout', 'Snapshot Git command was cancelled'))
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(
      () => stop(new SnapshotGitError('timeout', `git ${args[0] ?? ''} timed out`)),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    )
    timer.unref()
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxStdout)
        return stop(new SnapshotGitError('too-large', `git ${args[0] ?? ''} output too large`))
      chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR)
    })
    child.stdin?.on('error', () => undefined)
    // A missing executable rejects with the raw error so retryWhenGitAppears can recognize it.
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code) => finish(() => resolve({ code, stdout: Buffer.concat(chunks), stderr })))
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

/** Runs one snapshot Git command; a non-zero exit outside `okCodes` rejects with `SnapshotGitError('failed')`. */
export async function snapshotGit(args: readonly string[], opts: SnapshotGitOptions): Promise<SnapshotGitResult> {
  let result: SnapshotGitResult
  try {
    result = await retryWhenGitAppears(() => spawnOnce(args, opts))
  } catch (error) {
    if (error instanceof SnapshotGitError) throw error
    if (isSpawnNotFound(error)) throw new SnapshotGitError('unavailable', 'Git is not installed or not on PATH')
    throw new SnapshotGitError('failed', error instanceof Error ? error.message : String(error))
  }
  if (result.code !== 0 && !(result.code !== null && opts.okCodes?.includes(result.code))) {
    throw new SnapshotGitError(
      'failed',
      result.stderr.trim() || `git ${args[0] ?? ''} exited with ${result.code}`,
      result.stderr,
      result.code
    )
  }
  return result
}

/** Splits NUL-delimited output, dropping the empty record after the final terminator. */
export function nulRecords(output: Buffer | string): string[] {
  const text = typeof output === 'string' ? output : output.toString('utf8')
  if (!text) return []
  const records = text.split('\0')
  if (records[records.length - 1] === '') records.pop()
  return records
}

let gitAvailable: { value: boolean; at: number } | null = null
/** Whether Git can start here; a miss is rechecked after a minute, so installing Git needs no restart. */
export async function snapshotGitAvailable(): Promise<boolean> {
  if (gitAvailable && (gitAvailable.value || Date.now() - gitAvailable.at < 60_000)) return gitAvailable.value
  try {
    await snapshotGit(['--version'], { cwd: os.tmpdir(), timeoutMs: 10_000 })
    gitAvailable = { value: true, at: Date.now() }
  } catch {
    gitAvailable = { value: false, at: Date.now() }
  }
  return gitAvailable.value
}

export function resetSnapshotGitAvailabilityForTests(): void {
  gitAvailable = null
}
