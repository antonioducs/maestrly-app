import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PluginSourceErrorCode } from '../../shared/plugins'
import { retryWhenGitAppears } from '../git-command'
import { createAskpassDenyScript, terminateTree } from '../project-setup/git-runner'
import { PLUGIN_LIMITS } from './limits'
import { normalizeGitUrl } from './marketplace'
import type { TreeEntry, TreeEntryMode } from './package-tree'
import { isSafeTreePath } from './paths'

/**
 * Downloads plugin sources with the system `git`, never with credentials: partial clones (`--filter=blob:none`,
 * depth 1) plus sparse checkouts, so only the files Maestrly reads are materialized. Every invocation ignores the
 * user's and the system's Git configuration, hooks, credential helpers, submodules and every protocol but HTTPS.
 */

const MAX_STDOUT_BYTES = 32 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const REF = /^[A-Za-z0-9._/@+-]{1,255}$/
const SHA = /^[0-9a-f]{40}$/

export class PluginGitError extends Error {
  constructor(
    readonly code: PluginSourceErrorCode,
    detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'PluginGitError'
  }
}

export interface SpawnGitOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs: number
  input?: string
}
export interface SpawnGitResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

/** Runs one `git` process without a shell; rejects with `PluginGitError` on spawn failure, timeout or abort. */
export function spawnHardenedGit(args: readonly string[], opts: SpawnGitOptions): Promise<SpawnGitResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new PluginGitError('timeout', 'canceled'))
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const chunks: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    let overflow = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const stop = (error: PluginGitError) => {
      void terminateTree(child).finally(() => finish(() => reject(error)))
    }
    const onAbort = () => stop(new PluginGitError('timeout', 'canceled'))
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => stop(new PluginGitError('timeout')), opts.timeoutMs)
    timer.unref()
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!overflow) {
          overflow = true
          stop(new PluginGitError('too-large', 'git output exceeds the limit'))
        }
        return
      }
      chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES)
    })
    child.once('error', (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(new PluginGitError(error.code === 'ENOENT' ? 'git-unavailable' : 'invalid-repository', error.message))
      )
    )
    child.once('close', (code) => finish(() => resolve({ code, stdout: Buffer.concat(chunks), stderr })))
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

export type SpawnGit = typeof spawnHardenedGit

let supportDir: string | null = null
/** An empty hooks directory and an empty config file, shared by every invocation of this process. */
function gitSupport(): { hooksDir: string; emptyConfig: string } {
  if (!supportDir || !existsSync(supportDir)) supportDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-plugin-git-'))
  const hooksDir = path.join(supportDir, 'hooks')
  const emptyConfig = path.join(supportDir, 'empty.gitconfig')
  mkdirSync(hooksDir, { recursive: true })
  if (!existsSync(emptyConfig)) writeFileSync(emptyConfig, '')
  return { hooksDir, emptyConfig }
}

export function hardenedGitArgs(args: readonly string[], hooksDir: string, allowFile = false): string[] {
  const config = [
    'credential.helper=',
    'credential.interactive=never',
    `core.hooksPath=${hooksDir}`,
    'core.symlinks=false',
    'core.fsmonitor=false',
    'core.askPass=',
    'protocol.allow=never',
    'protocol.https.allow=always',
    ...(allowFile ? ['protocol.file.allow=always'] : []),
    'submodule.recurse=false',
    'fetch.recurseSubmodules=false',
    'advice.detachedHead=false',
    'gc.auto=0',
    'maintenance.auto=false',
  ]
  return [...config.flatMap((entry) => ['-c', entry]), ...args]
}

export function hardenedGitEnv(askpass: string, emptyConfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  // Keep only what Git needs to run and to reach the network; drop every GIT_* override of the parent.
  const keep = [
    ...[
      'PATH',
      'Path',
      'PATHEXT',
      'HOME',
      'USERPROFILE',
      'SystemRoot',
      'SYSTEMROOT',
      'ComSpec',
      'TMPDIR',
      'TEMP',
      'TMP',
    ],
    ...['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy'],
    ...['SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH'],
  ]
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key]
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_ASKPASS: askpass,
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    GIT_LFS_SKIP_SMUDGE: '1',
    LC_ALL: 'C',
  }
}

export interface GitSourceOptions {
  allowFileRoot?: string | null
  timeoutMs?: number
  spawnGit?: SpawnGit
}

function classify(stderr: string): PluginSourceErrorCode {
  const text = stderr.toLowerCase()
  if (/could not resolve host|failed to connect|network is unreachable|connection (timed out|refused|reset)/.test(text))
    return 'network'
  if (/authentication failed|terminal prompts disabled|could not read username|403|401/.test(text))
    return 'auth-required'
  if (/not found|does not appear to be a git repository|couldn't find remote ref|no such file/.test(text))
    return 'not-found'
  return 'invalid-repository'
}

const MODES: Record<string, TreeEntryMode> = {
  '100644': 'file',
  '100664': 'file',
  '100755': 'executable',
  '120000': 'symlink',
  '160000': 'submodule',
}

export class PluginGitSource {
  private readonly allowFileRoot: string | null
  private readonly timeoutMs: number
  private readonly spawnGit: SpawnGit

  constructor(opts: GitSourceOptions = {}) {
    // Local `file:` sources exist only for end-to-end tests: the variable is ignored outside AGENTS_E2E=1.
    const e2eRoot = process.env.AGENTS_E2E === '1' ? process.env.MAESTRLY_E2E_PLUGIN_GIT_ROOT?.trim() || null : null
    const root = opts.allowFileRoot === undefined ? e2eRoot : opts.allowFileRoot
    this.allowFileRoot = root ? path.resolve(root) : null
    this.timeoutMs = opts.timeoutMs ?? PLUGIN_LIMITS.gitTimeoutMs
    this.spawnGit = opts.spawnGit ?? spawnHardenedGit
  }

  /** Canonical URL, or throws `invalid-url`. `file:` URLs are accepted only under the configured test root. */
  checkUrl(url: string): string {
    if (typeof url === 'string' && url.startsWith('file:') && this.allowFileRoot) {
      let target: string
      try {
        target = path.resolve(fileURLToPath(url))
      } catch {
        throw new PluginGitError('invalid-url')
      }
      const inside = (root: string, p: string) => {
        const rel = path.relative(root, p)
        return !rel.startsWith('..') && !path.isAbsolute(rel)
      }
      if (!inside(this.allowFileRoot, target)) throw new PluginGitError('invalid-url')
      if (existsSync(target) && !inside(realpathSync(this.allowFileRoot), realpathSync(target)))
        throw new PluginGitError('invalid-url')
      return pathToFileURL(target).href
    }
    const canonical = normalizeGitUrl(url)
    if (!canonical || !canonical.startsWith('https://')) throw new PluginGitError('invalid-url')
    return canonical
  }

  private async run(
    cwd: string,
    args: string[],
    opts: { signal?: AbortSignal; input?: string; allowFailure?: boolean } = {}
  ): Promise<SpawnGitResult> {
    const { hooksDir, emptyConfig } = gitSupport()
    const askpass = await createAskpassDenyScript()
    try {
      // The environment is rebuilt for the retry so it carries the PATH refreshGitPath just extended; the variables
      // it keeps stay the same. Git missing never started a process, so the retry has no side effects.
      const result = await retryWhenGitAppears(
        () =>
          this.spawnGit(hardenedGitArgs(args, hooksDir, !!this.allowFileRoot), {
            cwd,
            env: hardenedGitEnv(askpass.path, emptyConfig),
            signal: opts.signal,
            timeoutMs: this.timeoutMs,
            input: opts.input,
          }),
        (error) => error instanceof PluginGitError && error.code === 'git-unavailable' && !opts.signal?.aborted
      )
      if (result.code !== 0 && !opts.allowFailure)
        throw new PluginGitError(classify(result.stderr), result.stderr.trim())
      return result
    } finally {
      await askpass.cleanup().catch(() => undefined)
    }
  }

  async gitVersion(): Promise<string | null> {
    try {
      const result = await this.run(os.tmpdir(), ['--version'])
      return /git version (\S+)/.exec(result.stdout.toString('utf8'))?.[1] ?? null
    } catch {
      return null
    }
  }

  /** init (if needed) + fetch --depth 1 --filter=blob:none; returns the fetched commit. */
  async fetch(
    dir: string,
    input: { url: string; ref: string | null; sha: string | null },
    signal?: AbortSignal
  ): Promise<string> {
    const url = this.checkUrl(input.url)
    if (input.sha !== null && !SHA.test(input.sha)) throw new PluginGitError('invalid-url', 'invalid commit')
    if (input.ref !== null && (!REF.test(input.ref) || input.ref.startsWith('-') || input.ref.includes('..')))
      throw new PluginGitError('invalid-url', 'invalid ref')
    await fsp.mkdir(dir, { recursive: true })
    if (!existsSync(path.join(dir, '.git'))) await this.run(dir, ['init', '-q'], { signal })
    const remote = await this.run(dir, ['remote', 'get-url', 'origin'], { signal, allowFailure: true })
    if (remote.code !== 0) await this.run(dir, ['remote', 'add', 'origin', url], { signal })
    else if (remote.stdout.toString('utf8').trim() !== url)
      await this.run(dir, ['remote', 'set-url', 'origin', url], { signal })
    const refspec = input.sha ?? input.ref ?? 'HEAD'
    await this.run(
      dir,
      ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', '--no-recurse-submodules', 'origin', refspec],
      { signal }
    )
    const head = (await this.run(dir, ['rev-parse', 'FETCH_HEAD'], { signal })).stdout.toString('utf8').trim()
    if (!SHA.test(head)) throw new PluginGitError('invalid-repository', 'unexpected FETCH_HEAD')
    if (input.sha && head !== input.sha) throw new PluginGitError('not-found', 'pinned commit not found')
    return head
  }

  /** `ls-tree -r` of a commit (optionally under a prefix); paths that are not safe are dropped. */
  async listTree(dir: string, commit: string, prefix?: string): Promise<TreeEntry[]> {
    if (!SHA.test(commit)) throw new PluginGitError('invalid-repository', 'invalid commit')
    if (prefix && !isSafeTreePath(prefix)) return []
    const args = ['ls-tree', '-r', '-z', '--full-tree', commit, ...(prefix ? ['--', prefix] : [])]
    const out = (await this.run(dir, args)).stdout.toString('utf8')
    const entries: TreeEntry[] = []
    for (const record of out.split('\0')) {
      if (!record) continue
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const [mode] = record.slice(0, tab).split(' ')
      const entryPath = record.slice(tab + 1)
      const kind = MODES[mode]
      if (!kind || !isSafeTreePath(entryPath)) continue
      if (entries.length >= PLUGIN_LIMITS.treeEntries) throw new PluginGitError('too-large', 'too many files')
      entries.push({ path: entryPath, mode: kind })
    }
    return entries
  }

  /** Tree object id of `path` at `commit` (the root tree for `''`), or null. */
  async treeOid(dir: string, commit: string, treePath: string): Promise<string | null> {
    if (!SHA.test(commit) || (treePath && !isSafeTreePath(treePath))) return null
    const spec = treePath ? `${commit}:${treePath}` : `${commit}^{tree}`
    const result = await this.run(dir, ['rev-parse', '--verify', '-q', spec], { allowFailure: true })
    const oid = result.stdout.toString('utf8').trim()
    return result.code === 0 && /^[0-9a-f]{40,64}$/.test(oid) ? oid : null
  }

  /** sparse-checkout (non-cone) of `patterns` at `commit`; materializes only matching files. */
  async checkout(dir: string, commit: string, patterns: readonly string[], signal?: AbortSignal): Promise<void> {
    if (!SHA.test(commit)) throw new PluginGitError('invalid-repository', 'invalid commit')
    await this.run(dir, ['sparse-checkout', 'set', '--no-cone', '--stdin'], {
      signal,
      input: `${patterns.join('\n')}\n`,
    })
    await this.run(dir, ['checkout', '-q', '--force', '--detach', commit], { signal })
    await this.run(dir, ['sparse-checkout', 'reapply'], { signal })
  }
}

/** Escapes a tree path for a gitignore-style sparse pattern. */
export function sparsePattern(treePath: string, suffix = ''): string {
  const escaped = treePath.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`)
  return `/${escaped}${suffix}`
}
