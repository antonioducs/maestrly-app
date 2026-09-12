/**
 * Restricted runtime for local web previews.
 *
 * The caller selects only an opaque ID discovered here.
 * `cwd`, executable, and argv stay in this module's private registry and never come from the model.
 */
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { type Dirent, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { killProcessTree } from '../../platform'
import { buildRedactor } from '../../pii-scrub'

const DEFAULT_STARTUP_TIMEOUT_MS = 25_000
const DEFAULT_REACHABILITY_TIMEOUT_MS = 1_500
const PREVIEW_READINESS_STABILITY_MS = 150
const PREVIEW_TERMINATION_TIMEOUT_MS = 5_000
const DEFAULT_MAX_OUTPUT_CHARS = 24_000
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_WORKSPACE_DEPTH = 8
const MAX_WORKSPACE_DIRECTORIES = 512
const MAX_WORKSPACE_ENTRIES = 8_192
const MAX_WORKSPACE_MANIFESTS = 256
const MAX_WORKSPACE_PATTERNS = 128
const MAX_WORKSPACE_PATTERN_LENGTH = 256
const MAX_PNPM_WORKSPACE_BYTES = 64 * 1024
const MAX_PENDING_URLS = 32
const MAX_STARTUP_DIAGNOSTIC_CHARS = 4_000
const MAX_STARTUP_ERROR_MESSAGE_CHARS = 6_000
const MAX_STARTUP_ERROR_DEPTH = 3
const MAX_AGGREGATE_ERRORS = 4
const MAX_CONFIGURED_OUTPUT_CHARS = 100_000
const MAX_CONFIGURED_STARTUP_TIMEOUT_MS = 10 * 60 * 1000
const MAX_CONFIGURED_REACHABILITY_TIMEOUT_MS = 10_000
const REGISTRY_TTL_MS = 10 * 60 * 1000
const MAX_REGISTRY_ENTRIES = 512

/**
 * The preview process executes repository-controlled frontend code. Keep its environment deliberately small:
 * package-manager/runtime plumbing is allowed, while credentials, provider configuration, and arbitrary parent
 * variables are not. Frontend-prefixed variables are the explicit public-build contract of the supported tools.
 */
const PREVIEW_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'ProgramFiles(x86)',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'TERM',
  'COLORTERM',
  'CI',
  'NODE_ENV',
  'PORT',
  'PUBLIC_URL',
  'HTTPS',
])
const PREVIEW_FRONTEND_ENV_PREFIXES = [
  'VITE_',
  'NEXT_PUBLIC_',
  'REACT_APP_',
  'PUBLIC_',
  'NUXT_PUBLIC_',
  'GATSBY_',
  'ASTRO_PUBLIC_',
  'NG_APP_',
] as const

const WINDOWS_PREVIEW_ENV_KEYS: Record<string, string> = {
  PATH: 'PATH',
  PATHEXT: 'PATHEXT',
  HOME: 'HOME',
  USER: 'USER',
  USERPROFILE: 'USERPROFILE',
  TMPDIR: 'TMPDIR',
  TMP: 'TMP',
  TEMP: 'TEMP',
  SYSTEMROOT: 'SystemRoot',
  WINDIR: 'WINDIR',
  COMSPEC: 'ComSpec',
  APPDATA: 'APPDATA',
  LOCALAPPDATA: 'LOCALAPPDATA',
  PROGRAMDATA: 'ProgramData',
  PROGRAMFILES: 'ProgramFiles',
  'PROGRAMFILES(X86)': 'ProgramFiles(x86)',
}

const WINDOWS_PREVIEW_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD']

function previewPathExt(value: string | undefined): string {
  const allowed = new Set(
    (value ?? '')
      .split(';')
      .map((extension) => extension.trim().toUpperCase())
      .filter((extension) => WINDOWS_PREVIEW_PATHEXT.includes(extension))
  )
  return WINDOWS_PREVIEW_PATHEXT.filter((extension) => allowed.has(extension)).join(';') || WINDOWS_PREVIEW_PATHEXT.join(';')
}

function previewEnvironment(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue
    const upperName = name.toUpperCase()
    const canonicalName = platform === 'win32' ? WINDOWS_PREVIEW_ENV_KEYS[upperName] : name
    const allowed =
      PREVIEW_ENV_KEYS.has(name) ||
      PREVIEW_FRONTEND_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
      (platform === 'win32' && WINDOWS_PREVIEW_ENV_KEYS[upperName] !== undefined)
    if (!allowed) continue
    environment[canonicalName ?? name] = value
  }
  if (platform === 'win32') environment.PATHEXT = previewPathExt(environment.PATHEXT)
  return { ...environment, BROWSER: 'none', HOST: '127.0.0.1' }
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface PreviewTarget {
  /** Token with no semantics; only this runtime can resolve it. */
  id: string
  label: string
  description: string
  repo: 'repository'
  /** Sanitized path relative to the authorized root, never an absolute host path. */
  cwd: string
  managed: true
  packageManager: PackageManager
  script: string
}

export type PreviewSelection = { targetId: string }

export interface PreparedPreview {
  /** Opaque, single-use token for the managed preview. */
  id: string
  managed: true
}

export interface PreviewHandle {
  url: string
  managed: true
  /** Main-process-only diagnostics retained while the managed server is alive. */
  diagnosticOutput?(): string
  /** Main-process-only lifecycle signal used to keep browser bootstrap coupled to the server. */
  waitForExit?(): Promise<PreviewStartupError>
  running?(): boolean
  dispose(): Promise<void>
}

export interface PreviewRuntimeOptions {
  signal?: AbortSignal
  startupTimeoutMs?: number
  reachabilityTimeoutMs?: number
  maxOutputChars?: number
  dependencies?: PreviewRuntimeDependencies
}

export interface PreviewRuntimeDependencies {
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess
  killProcessTree?: (pid: number) => void | Promise<void>
  reachable?: (url: string, signal?: AbortSignal, timeoutMs?: number) => Promise<boolean | string>
  randomId?: () => string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

interface PackageManifest {
  name?: unknown
  packageManager?: unknown
  scripts?: unknown
  workspaces?: unknown
}

interface WorkspacePattern {
  pattern: string
  negated: boolean
}

interface WorkspaceGlob {
  segments: string[]
  segmentMatchers: Array<RegExp | null>
}

interface InternalTarget {
  root: string
  cwd: string
  manifestPath: string
  script: string
  scriptCommand: string
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  fallbackUrl?: string
  createdAt: number
}

interface InternalPreparation {
  root: string
  target: InternalTarget
  createdAt: number
}

const targets = new Map<string, InternalTarget>()
const preparations = new Map<string, InternalPreparation>()

function opaqueId(dependencies?: PreviewRuntimeDependencies): string {
  return (dependencies?.randomId ?? randomUUID)()
}

function pruneRegistry(now = Date.now()): void {
  for (const [id, value] of targets) if (now - value.createdAt > REGISTRY_TTL_MS) targets.delete(id)
  for (const [id, value] of preparations) if (now - value.createdAt > REGISTRY_TTL_MS) preparations.delete(id)
  while (targets.size > MAX_REGISTRY_ENTRIES) targets.delete(targets.keys().next().value as string)
  while (preparations.size > MAX_REGISTRY_ENTRIES) preparations.delete(preparations.keys().next().value as string)
}

/** Return the canonical URL only for strict loopback HTTP. */
export function normalizeLoopbackPreviewUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2_048 || raw.trim() !== raw) return null
  // Check lexically before `URL`: the parser normalizes forms such as 127.1/2130706433 to
  // 127.0.0.1, but policy accepts only the three explicitly written authorities.
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(raw)) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password) return null
  const hostname = parsed.hostname.toLowerCase()
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') return null
  if (parsed.port) {
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  }
  parsed.hash = ''
  return parsed.toString()
}

export function isLoopbackPreviewUrl(raw: string): boolean {
  return normalizeLoopbackPreviewUrl(raw) !== null
}

function canonicalDirectory(cwd: string): string {
  if (!path.isAbsolute(cwd)) throw new Error('Preview cwd must be an absolute path.')
  const canonical = realpathSync(cwd)
  if (!statSync(canonical).isDirectory()) throw new Error('Preview cwd must be a directory.')
  return canonical
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function readManifest(manifestPath: string, root: string): PackageManifest | null {
  try {
    const info = lstatSync(manifestPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return null
    const canonical = realpathSync(manifestPath)
    if (!isInside(root, canonical)) return null
    const value = JSON.parse(readFileSync(canonical, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as PackageManifest) : null
  } catch {
    return null
  }
}

function normalizeWorkspacePattern(value: string): WorkspacePattern | null {
  if (value.length === 0 || value.length > MAX_WORKSPACE_PATTERN_LENGTH) return null
  const negated = value.startsWith('!')
  const rawPattern = negated ? value.slice(1) : value
  const pattern = rawPattern.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (
    pattern === '' ||
    pattern === '..' ||
    pattern.startsWith('../') ||
    path.posix.isAbsolute(pattern) ||
    /^[A-Za-z]:\//.test(pattern) ||
    pattern.split('/').some((segment) => segment === '..' || segment === '') ||
    pattern.includes('\0')
  ) {
    return null
  }
  return { pattern, negated }
}

function workspacePatterns(manifest: PackageManifest): WorkspacePattern[] {
  const raw = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces && typeof manifest.workspaces === 'object' && 'packages' in manifest.workspaces
      ? (manifest.workspaces as { packages?: unknown }).packages
      : []
  if (!Array.isArray(raw)) return []
  return raw
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeWorkspacePattern)
    .filter((value): value is WorkspacePattern => value !== null)
}

function stripYamlComment(value: string): string {
  let quote: "'" | '"' | null = null
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote === "'") {
      if (character === "'" && value[index + 1] === "'") {
        index += 1
      } else if (character === "'") {
        quote = null
      }
      continue
    }
    if (quote === '"') {
      if (character === '\\') index += 1
      else if (character === '"') quote = null
      continue
    }
    if (character === "'" || character === '"') quote = character
    else if (character === '#' && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index)
  }
  return value
}

function parseYamlScalar(value: string): string | null {
  const trimmed = stripYamlComment(value).trim()
  if (trimmed === '') return null
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) return null
    const inner = trimmed.slice(1, -1).replaceAll("''", "'")
    return inner.includes('\\') ? null : inner
  }
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) return null
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }
  // YAML aliases, tags, collections, block scalars, and directives are deliberately unsupported.
  if (
    ['*', '[', ']', '{', '}', '!', '&', '|', '>', '@', '`'].some((character) => trimmed.startsWith(character)) ||
    /\s[|>{]/.test(trimmed)
  )
    return null
  return trimmed
}

function parsePnpmWorkspaceFlowSequence(value: string): string[] | null {
  const trimmed = stripYamlComment(value).trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
  const content = trimmed.slice(1, -1).trim()
  if (content === '') return []
  const values: string[] = []
  let start = 0
  let quote: "'" | '"' | null = null
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (quote === "'") {
      if (character === "'" && content[index + 1] === "'") index += 1
      else if (character === "'") quote = null
    } else if (quote === '"') {
      if (character === '\\') index += 1
      else if (character === '"') quote = null
    } else if (character === "'" || character === '"') quote = character
    else if (character === ',') {
      const parsed = parseYamlScalar(content.slice(start, index))
      if (parsed === null) return null
      values.push(parsed)
      start = index + 1
    }
  }
  if (quote !== null) return null
  const parsed = parseYamlScalar(content.slice(start))
  if (parsed === null) return null
  values.push(parsed)
  return values
}

function pnpmWorkspacePatterns(root: string): WorkspacePattern[] {
  const configPath = path.join(root, 'pnpm-workspace.yaml')
  try {
    const info = lstatSync(configPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PNPM_WORKSPACE_BYTES) return []
    const canonical = realpathSync(configPath)
    if (!isInside(root, canonical)) return []
    const lines = readFileSync(canonical, 'utf8').split(/\r?\n/)
    const values: string[] = []
    let inPackages = false
    let listIndent: number | null = null
    for (const line of lines) {
      if (line.includes('\t')) return []
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const indent = line.length - line.trimStart().length
      if (!inPackages) {
        if (indent !== 0) continue
        if (trimmed === '---' || trimmed === '...') return []
        const packages = trimmed.match(/^packages\s*:\s*(.*)$/)
        if (!packages) continue
        const inline = packages[1]
        if (inline.trim() === '') {
          inPackages = true
          continue
        }
        const flowValues = parsePnpmWorkspaceFlowSequence(inline)
        if (!flowValues) return []
        values.push(...flowValues)
        break
      }
      if (indent === 0) break
      if (listIndent === null) listIndent = indent
      if (indent !== listIndent || !trimmed.startsWith('-')) return []
      const item = trimmed.slice(1)
      if (item !== '' && !/^\s/.test(item)) return []
      const value = parseYamlScalar(item)
      if (value === null) return []
      values.push(value)
    }
    return values
      .map(normalizeWorkspacePattern)
      .filter((value): value is WorkspacePattern => value !== null)
      .slice(0, MAX_WORKSPACE_PATTERNS)
  } catch {
    return []
  }
}

function mergedWorkspacePatterns(root: string, rootManifest: PackageManifest): WorkspacePattern[] {
  const merged: WorkspacePattern[] = []
  const seen = new Set<string>()
  for (const value of [...workspacePatterns(rootManifest), ...pnpmWorkspacePatterns(root)]) {
    const key = `${value.negated ? '!' : ''}${value.pattern}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(value)
    if (merged.length >= MAX_WORKSPACE_PATTERNS) break
  }
  return merged
}

function workspaceGlob(pattern: string): WorkspaceGlob | null {
  if (['?', '[', ']', '{', '}'].some((character) => pattern.includes(character))) return null
  const segments = pattern.split('/')
  if (segments.some((segment) => segment === '')) return null
  return {
    segments,
    segmentMatchers: segments.map((segment) => {
      if (segment === '**') return null
      const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')
      return new RegExp(`^${escaped}$`)
    }),
  }
}

function globStates(glob: WorkspaceGlob, relative: string[]): Set<number> {
  const closure = (states: Set<number>): Set<number> => {
    const result = new Set(states)
    let changed = true
    while (changed) {
      changed = false
      for (const state of result) {
        if (glob.segments[state] !== '**' || result.has(state + 1)) continue
        result.add(state + 1)
        changed = true
      }
    }
    return result
  }
  let states = closure(new Set([0]))
  for (const segment of relative) {
    const next = new Set<number>()
    for (const state of states) {
      if (state >= glob.segments.length) continue
      if (glob.segments[state] === '**') next.add(state)
      else if (glob.segmentMatchers[state]?.test(segment)) next.add(state + 1)
    }
    states = closure(next)
    if (states.size === 0) break
  }
  return states
}

function globMatches(glob: WorkspaceGlob, relative: string[]): boolean {
  return globStates(glob, relative).has(glob.segments.length)
}

function globCanDescend(glob: WorkspaceGlob, relative: string[]): boolean {
  return [...globStates(glob, relative)].some((state) => state < glob.segments.length)
}

function globCanMatchOrDescend(glob: WorkspaceGlob, relative: string[]): boolean {
  return globStates(glob, relative).size > 0
}

const SKIPPED_WORKSPACE_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  'build',
  'cache',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
])

function shouldSkipWorkspaceDirectory(entry: Dirent): boolean {
  return entry.name.startsWith('.') || SKIPPED_WORKSPACE_DIRECTORY_NAMES.has(entry.name.toLowerCase())
}

function workspaceManifestPaths(root: string, rootManifest: PackageManifest): string[] {
  const workspacePatterns = mergedWorkspacePatterns(root, rootManifest)
  const positive = workspacePatterns
    .filter((value) => !value.negated)
    .map((value) => workspaceGlob(value.pattern))
    .filter((value): value is WorkspaceGlob => value !== null)
  const negative = workspacePatterns
    .filter((value) => value.negated)
    .map((value) => workspaceGlob(value.pattern))
    .filter((value): value is WorkspaceGlob => value !== null)
  if (positive.length === 0) return []
  const manifests: string[] = []
  const visitedDirectories = new Set<string>([root])
  let directoryCount = 0
  let entryCount = 0
  const visit = (directory: string, relative: string[], depth: number) => {
    if (
      depth > MAX_WORKSPACE_DEPTH ||
      directoryCount >= MAX_WORKSPACE_DIRECTORIES ||
      entryCount >= MAX_WORKSPACE_ENTRIES ||
      manifests.length >= MAX_WORKSPACE_MANIFESTS
    )
      return
    directoryCount += 1
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entryCount >= MAX_WORKSPACE_ENTRIES || manifests.length >= MAX_WORKSPACE_MANIFESTS) return
      entryCount += 1
      if (!entry.isDirectory() || entry.isSymbolicLink() || shouldSkipWorkspaceDirectory(entry)) continue
      const childRelative = [...relative, entry.name]
      if (!positive.some((pattern) => globCanMatchOrDescend(pattern, childRelative))) continue
      const child = path.join(directory, entry.name)
      let canonical: string
      try {
        canonical = realpathSync(child)
      } catch {
        continue
      }
      if (!isInside(root, canonical) || visitedDirectories.has(canonical)) continue
      visitedDirectories.add(canonical)
      if (
        positive.some((pattern) => globMatches(pattern, childRelative)) &&
        !negative.some((pattern) => globMatches(pattern, childRelative))
      ) {
        manifests.push(path.join(canonical, 'package.json'))
      }
      if (positive.some((pattern) => globCanDescend(pattern, childRelative))) visit(canonical, childRelative, depth + 1)
    }
  }
  visit(root, [], 0)
  return manifests
}

function managerFromPackageManager(value: unknown): PackageManager | null {
  if (typeof value !== 'string') return null
  const name = value.split('@', 1)[0]
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : null
}

function lockfileManager(directory: string): PackageManager | null {
  const found: PackageManager[] = []
  if (
    existsSync(path.join(directory, 'package-lock.json')) ||
    existsSync(path.join(directory, 'npm-shrinkwrap.json'))
  ) {
    found.push('npm')
  }
  if (existsSync(path.join(directory, 'pnpm-lock.yaml'))) found.push('pnpm')
  if (existsSync(path.join(directory, 'yarn.lock'))) found.push('yarn')
  if (existsSync(path.join(directory, 'bun.lock')) || existsSync(path.join(directory, 'bun.lockb'))) found.push('bun')
  return found.length === 1 ? found[0] : null
}

function packageManagerFor(
  packageDirectory: string,
  manifest: PackageManifest,
  root: string,
  rootManifest: PackageManifest
): PackageManager | null {
  return (
    managerFromPackageManager(manifest.packageManager) ??
    managerFromPackageManager(rootManifest.packageManager) ??
    lockfileManager(packageDirectory) ??
    lockfileManager(root)
  )
}

type FrontendKind = 'vite' | 'next' | 'react-scripts' | 'astro' | 'nuxt' | 'angular' | 'webpack' | 'gatsby'

function frontendKind(command: string): FrontendKind | null {
  // Reject shell composition. The package manager still runs the script, but it must be a direct
  // frontend invocation (with optional assignments/cross-env), not an arbitrary line containing
  // a framework name somewhere.
  if (/[;&|<>\n\r`]/.test(command) || command.includes('$(')) return null
  const tokens = command.trim().split(/\s+/)
  if (tokens[0] === 'cross-env' || tokens[0] === 'cross-env-shell') tokens.shift()
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift()
  if (tokens[0] === 'npx') tokens.shift()
  const executable = tokens[0]
  const mode = tokens[1]
  if (
    executable === 'vite' &&
    (!mode || mode.startsWith('-') || mode === 'dev' || mode === 'serve' || mode === 'preview')
  ) {
    return 'vite'
  }
  if (executable === 'next' && (mode === 'dev' || mode === 'start')) return 'next'
  if (executable === 'react-scripts' && mode === 'start') return 'react-scripts'
  if (executable === 'astro' && (mode === 'dev' || mode === 'preview')) return 'astro'
  if ((executable === 'nuxt' || executable === 'nuxi') && (mode === 'dev' || mode === 'preview')) return 'nuxt'
  if (executable === 'ng' && mode === 'serve') return 'angular'
  if ((executable === 'webpack' && mode === 'serve') || executable === 'webpack-dev-server') return 'webpack'
  if (executable === 'gatsby' && mode === 'develop') return 'gatsby'
  return null
}

function allowedScriptName(name: string): boolean {
  return (
    /^(?:dev|start|preview)$/.test(name) ||
    /^(?:(?:dev|start|preview):(web|frontend)|(web|frontend):(dev|start|preview))$/.test(name)
  )
}

function hasUnsafeHost(command: string): boolean {
  const hosts = [...command.matchAll(/(?:^|\s)--host(?:name)?(?:=|\s+)([^\s]+)/gi)].map((match) => match[1])
  if (/(?:^|\s)--host(?:name)?(?:\s|$)/i.test(command) && hosts.length === 0) return true
  if (/(?:^|\s)HOST=(?!localhost(?:\s|$)|127\.0\.0\.1(?:\s|$)|\[::1\](?:\s|$))[^\s]+/i.test(command)) return true
  return hosts.some((host) => {
    const normalized = host.replace(/^['"]|['"]$/g, '').toLowerCase()
    return normalized !== 'localhost' && normalized !== '127.0.0.1' && normalized !== '::1' && normalized !== '[::1]'
  })
}

function explicitPort(command: string): number | null {
  const raw = command.match(/(?:^|\s)(?:--port|-p)(?:=|\s+)(\d{1,5})(?:\s|$)/)?.[1]
  const port = raw ? Number(raw) : 0
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null
}

function frameworkArgs(kind: FrontendKind): string[] {
  if (kind === 'next') return ['--hostname', '127.0.0.1']
  if (kind === 'react-scripts') return []
  return ['--host', '127.0.0.1']
}

function managerCommand(
  manager: PackageManager,
  script: string,
  extraArgs: string[]
): { file: string; args: string[] } {
  const args = ['run', script]
  if (extraArgs.length > 0) args.push('--', ...extraArgs)
  return { file: manager, args }
}

function executableOnPath(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : ['']
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

type WindowsManagerEntrypoint = { file: string; argsPrefix?: string[] }

/**
 * Windows shims are batch files and cannot be passed to spawn with shell:false. Resolve only the known
 * JavaScript entrypoints shipped by the supported manager/Corepack layouts; never interpret the shim text.
 */
function verifiedWindowsManagerEntrypoint(manager: PackageManager, executable: string): WindowsManagerEntrypoint | null {
  const roots = [path.dirname(executable), path.dirname(path.dirname(executable))]
  const relativeEntrypoints: Partial<Record<PackageManager, string[]>> = {
    npm: ['npm/bin/npm-cli.js'],
    pnpm: ['pnpm/bin/pnpm.cjs', 'pnpm/bin/pnpm.js'],
    yarn: ['yarn/bin/yarn.js', 'yarn/bin/yarn-cli.js'],
  }
  const candidates: Array<WindowsManagerEntrypoint & { candidate: string }> = []
  for (const root of roots) {
    for (const relative of relativeEntrypoints[manager] ?? []) {
      candidates.push({ candidate: path.join(root, 'node_modules', relative), file: '' })
    }
    // Corepack's manager-specific launchers preserve the same shell-free argv contract.
    if (manager === 'pnpm' || manager === 'yarn') {
      candidates.push({ candidate: path.join(root, 'node_modules', 'corepack', 'dist', `${manager}.js`), file: '' })
    }
  }
  for (const { candidate } of candidates) {
    try {
      const info = lstatSync(candidate)
      if (!info.isFile() || !/\.(?:cjs|js)$/i.test(candidate)) continue
      return { file: candidate }
    } catch {
      /* manager not installed in this known layout */
    }
  }
  return null
}

function windowsSafeCommand(
  file: string,
  args: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): { file: string; args: string[] } | null {
  if (platform !== 'win32') return { file, args }
  const executable = executableOnPath(file, platform, env)
  if (!executable) return null
  if (!/\.(?:cmd|bat)$/i.test(executable)) return { file: executable, args }
  const entrypoint = verifiedWindowsManagerEntrypoint(file as PackageManager, executable)
  if (entrypoint) return { file: process.execPath, args: [...(entrypoint.argsPrefix ?? []), entrypoint.file, ...args] }
  if (file !== 'npm') return null
  const npmExecutable = executable
  const candidates = [
    env.npm_execpath,
    npmExecutable && path.join(path.dirname(npmExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    npmExecutable && path.join(path.dirname(npmExecutable), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate): candidate is string => !!candidate)
  const npmCli = candidates.find((candidate) => /\.[cm]?js$/i.test(candidate) && existsSync(candidate))
  return npmCli ? { file: process.execPath, args: [npmCli, ...args] } : null
}

/** Discover only recognized frontend scripts in the root package and declared workspaces. */
export function discoverPreviewTargets(cwd: string, options: PreviewRuntimeOptions = {}): PreviewTarget[] {
  pruneRegistry()
  const root = canonicalDirectory(cwd)
  const rootManifestPath = path.join(root, 'package.json')
  const rootManifest = readManifest(rootManifestPath, root)
  if (!rootManifest) return []
  const manifestPaths = [rootManifestPath, ...workspaceManifestPaths(root, rootManifest)]
  const found: PreviewTarget[] = []
  const seen = new Set<string>()
  for (const manifestPath of manifestPaths) {
    const manifest = readManifest(manifestPath, root)
    if (!manifest) continue
    const packageDirectory = path.dirname(realpathSync(manifestPath))
    if (!isInside(root, packageDirectory) || seen.has(packageDirectory)) continue
    seen.add(packageDirectory)
    const manager = packageManagerFor(packageDirectory, manifest, root, rootManifest)
    if (!manager || !manifest.scripts || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts))
      continue
    for (const [script, rawCommand] of Object.entries(manifest.scripts)) {
      if (!allowedScriptName(script) || typeof rawCommand !== 'string' || hasUnsafeHost(rawCommand)) continue
      const kind = frontendKind(rawCommand)
      if (!kind) continue
      const command = managerCommand(manager, script, frameworkArgs(kind))
      const platform = options.dependencies?.platform ?? process.platform
      const env = previewEnvironment(options.dependencies?.env ?? process.env, platform)
      const safeCommand = windowsSafeCommand(command.file, command.args, platform, env)
      if (!safeCommand) continue
      const id = opaqueId(options.dependencies)
      const port = explicitPort(rawCommand)
      targets.set(id, {
        root,
        cwd: packageDirectory,
        manifestPath: realpathSync(manifestPath),
        script,
        scriptCommand: rawCommand,
        file: safeCommand.file,
        args: safeCommand.args,
        env,
        ...(port ? { fallbackUrl: `http://127.0.0.1:${port}/` } : {}),
        createdAt: Date.now(),
      })
      const packageName =
        typeof manifest.name === 'string' && manifest.name ? manifest.name : path.basename(packageDirectory)
      found.push({
        id,
        label: `${packageName} — ${script}`,
        description: `${kind} via ${manager}`,
        repo: 'repository',
        cwd: path.relative(root, packageDirectory).split(path.sep).join('/') || '.',
        managed: true,
        packageManager: manager,
        script,
      })
    }
  }
  return found.sort((left, right) => left.label.localeCompare(right.label))
}

async function defaultReachable(
  url: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_REACHABILITY_TIMEOUT_MS
): Promise<false | string> {
  const current = normalizeLoopbackPreviewUrl(url)
  if (!current || signal?.aborted) return false
  const response = await new Promise<{ status: number; location?: string } | null>((resolve) => {
    let settled = false
    const finish = (value: { status: number; location?: string } | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const req = request(current, { method: 'GET' }, (incoming) => {
      // A socket accepting a request is insufficient readiness: wait until the document response
      // completes so a server that closes mid-response cannot win the startup race with Chromium.
      incoming.on('end', () =>
        finish({
          status: incoming.statusCode ?? 0,
          ...(typeof incoming.headers.location === 'string' ? { location: incoming.headers.location } : {}),
        })
      )
      incoming.on('aborted', () => finish(null))
      incoming.on('error', () => finish(null))
      incoming.resume()
    })
    const onAbort = () => {
      req.destroy()
      finish(null)
    }
    const timer = setTimeout(() => {
      req.destroy()
      finish(null)
    }, timeoutMs)
    timer.unref?.()
    req.on('error', () => finish(null))
    signal?.addEventListener('abort', onAbort, { once: true })
    req.end()
  })
  if (!response) return false
  if (response.status >= 300 && response.status < 400 && response.location) {
    try {
      // Readiness proves that the server can complete a document response; it must not require the
      // entire redirect chain to become healthy. Broken applications (and locale middleware loops)
      // are precisely valid Visual Review targets. Use the first safe loopback redirect only to align
      // Chromium's frozen origin with canonical localhost/127.0.0.1 redirects.
      return normalizeLoopbackPreviewUrl(new URL(response.location, current).toString()) ?? current
    } catch {
      return current
    }
  }
  return current
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(1, Math.floor(value)))
    : fallback
}

function validateTargetStillAuthorized(target: InternalTarget): void {
  let currentRoot: string
  let currentCwd: string
  try {
    currentRoot = realpathSync(target.root)
    currentCwd = realpathSync(target.cwd)
  } catch {
    throw new Error('Preview target cwd no longer exists.')
  }
  if (currentRoot !== target.root || currentCwd !== target.cwd || !isInside(currentRoot, currentCwd)) {
    throw new Error('Preview target cwd changed or escaped the authorized cwd.')
  }
  const manifest = readManifest(target.manifestPath, currentRoot)
  const scripts = manifest?.scripts
  const currentCommand =
    scripts && typeof scripts === 'object' && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>)[target.script]
      : null
  if (currentCommand !== target.scriptCommand) throw new Error('Preview target changed; run discovery again.')
}

/** Validate the selection and convert it to an opaque token; this step never spawns a process. */
export async function preparePreview(
  cwd: string,
  selection: PreviewSelection,
  options: PreviewRuntimeOptions = {}
): Promise<PreparedPreview> {
  pruneRegistry()
  const root = canonicalDirectory(cwd)
  const id = opaqueId(options.dependencies)
  if (typeof selection.targetId === 'string') {
    const target = targets.get(selection.targetId)
    if (!target || target.root !== root) throw new Error('Unknown or expired preview target.')
    targets.delete(selection.targetId)
    preparations.set(id, { root, target, createdAt: Date.now() })
    return { id, managed: true }
  }
  throw new Error('preview_id must be an opaque ID returned by discover_frontend_previews.')
}

function announcedUrls(text: string): string[] {
  const matches =
    text.match(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s'"<>\x1b]*)?(?=\s|\x1b|['"<>])/gi) ??
    []
  return [...new Set(matches.map(normalizeLoopbackPreviewUrl).filter((value): value is string => value !== null))]
}

export class PreviewStartupError extends Error {
  readonly output: string
  readonly timedOut: boolean
  readonly aborted: boolean

  constructor(message: string, output: string, timedOut = false, aborted = false) {
    super(message)
    this.name = 'PreviewStartupError'
    this.output = output
    this.timedOut = timedOut
    this.aborted = aborted
  }
}

function stripTerminalControls(value: string): string {
  let result = ''
  let state: 'text' | 'escape' | 'csi' | 'osc' | 'osc-escape' = 'text'
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (state === 'csi') {
      if (code >= 64 && code <= 126) state = 'text'
      continue
    }
    if (state === 'osc') {
      if (code === 7) state = 'text'
      else if (code === 27) state = 'osc-escape'
      continue
    }
    if (state === 'osc-escape') {
      state = char === '\\' ? 'text' : 'osc'
      continue
    }
    if (state === 'escape') {
      state = char === '[' ? 'csi' : char === ']' ? 'osc' : 'text'
      continue
    }
    if (code === 27) {
      state = 'escape'
      continue
    }
    if (code === 9 || code === 10 || code >= 32) result += char
  }
  return result
}

function sanitizeStartupDiagnostic(value: string, cwd: string): string {
  const redact = buildRedactor({
    paths: [
      { value: cwd, placeholder: '<workspace>' },
      { value: homedir(), placeholder: '<home>' },
    ],
  })
  const sanitized = redact(stripTerminalControls(value))
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/g,
      '$1$2***'
    )
    .trim()
  if (sanitized.length <= MAX_STARTUP_DIAGNOSTIC_CHARS) return sanitized
  return `… [diagnostic truncated]\n${sanitized.slice(-MAX_STARTUP_DIAGNOSTIC_CHARS)}`
}

function startupErrorParts(error: unknown, cwd: string, depth: number, seen: Set<unknown>): string[] {
  if (depth > MAX_STARTUP_ERROR_DEPTH || seen.has(error)) return []
  if (error && (typeof error === 'object' || typeof error === 'function')) seen.add(error)

  const parts: string[] = []
  if (error instanceof Error) {
    const message = sanitizeStartupDiagnostic(error.message || error.name, cwd)
    if (message) parts.push(message)
    if (error instanceof PreviewStartupError && error.output.trim()) {
      const output = sanitizeStartupDiagnostic(error.output, cwd)
      if (output) parts.push(`Process output (tail):\n${output}`)
    }
    if (error instanceof AggregateError) {
      for (const nested of error.errors.slice(0, MAX_AGGREGATE_ERRORS)) {
        parts.push(...startupErrorParts(nested, cwd, depth + 1, seen))
      }
    }
    const cause = (error as Error & { cause?: unknown }).cause
    if (cause !== undefined) parts.push(...startupErrorParts(cause, cwd, depth + 1, seen))
  } else if (typeof error === 'string') {
    const message = sanitizeStartupDiagnostic(error, cwd)
    if (message) parts.push(message)
  } else if (error !== undefined && error !== null) {
    const message = sanitizeStartupDiagnostic(String(error), cwd)
    if (message) parts.push(message)
  }
  return parts
}

/** Bounded, redacted startup diagnostics safe to return through the companion tool. */
export function previewStartupErrorMessage(error: unknown, cwd: string): string {
  const parts = [...new Set(startupErrorParts(error, cwd, 0, new Set()))]
  const message = parts.length > 0 ? parts.join('\nCaused by: ') : 'Unknown visual review startup failure.'
  if (message.length <= MAX_STARTUP_ERROR_MESSAGE_CHARS) return message
  const marker = '\n… [startup diagnostic truncated] …\n'
  const headLength = 1_500
  return `${message.slice(0, headLength)}${marker}${message.slice(
    -(MAX_STARTUP_ERROR_MESSAGE_CHARS - headLength - marker.length)
  )}`
}

/** Start a managed target prepared from a locally discovered ID. */
export async function startPreview(
  prepared: PreparedPreview,
  options: PreviewRuntimeOptions = {}
): Promise<PreviewHandle> {
  pruneRegistry()
  const preparation = preparations.get(prepared.id)
  if (!preparation || prepared.managed !== true) throw new Error('Unknown or expired prepared preview.')
  preparations.delete(prepared.id)
  const reachable = options.dependencies?.reachable ?? defaultReachable
  const reachabilityTimeout = boundedInteger(
    options.reachabilityTimeoutMs,
    DEFAULT_REACHABILITY_TIMEOUT_MS,
    MAX_CONFIGURED_REACHABILITY_TIMEOUT_MS
  )
  if (options.signal?.aborted) throw new PreviewStartupError('Preview startup aborted.', '', false, true)
  const target = preparation.target
  validateTargetStillAuthorized(target)
  const spawnImpl = options.dependencies?.spawn ?? spawn
  const terminateTree = options.dependencies?.killProcessTree ?? killProcessTree
  const platform = options.dependencies?.platform ?? process.platform
  const maxOutput = boundedInteger(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, MAX_CONFIGURED_OUTPUT_CHARS)
  const timeoutMs = boundedInteger(
    options.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
    MAX_CONFIGURED_STARTUP_TIMEOUT_MS
  )

  return new Promise((resolve, reject) => {
    let output = ''
    let totalChars = 0
    let settled = false
    let disposed = false
    let checking = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const pendingUrls = new Set<string>()
    const successfulProbes = new Map<string, { url: string; at: number }>()
    const append = (chunk: unknown) => {
      const value = String(chunk)
      totalChars += value.length
      output = `${output}${value}`.slice(-maxOutput)
      // Streams can split URLs across chunks; the bounded tail also serves as a parsing buffer.
      for (const url of announcedUrls(output)) {
        pendingUrls.add(url)
        while (pendingUrls.size > MAX_PENDING_URLS) pendingUrls.delete(pendingUrls.values().next().value as string)
      }
      void checkUrls()
    }
    const boundedOutput = () => {
      const omitted = Math.max(0, totalChars - output.length)
      return omitted > 0 ? `… [output truncated: ${omitted} chars omitted]\n${output}` : output
    }
    let proc: ChildProcess
    try {
      proc = spawnImpl(target.file, [...target.args], {
        cwd: target.cwd,
        env: target.env,
        shell: false,
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(
        new PreviewStartupError(
          `Failed to start preview: ${error instanceof Error ? error.message : String(error)}`,
          ''
        )
      )
      return
    }
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', append)
    proc.stderr?.on('data', append)

    let childClosed = false
    let childErrored = false
    let processExitError: PreviewStartupError | null = null
    let resolveProcessExit!: (error: PreviewStartupError) => void
    const processExit = new Promise<PreviewStartupError>((resolve) => {
      resolveProcessExit = resolve
    })
    const reportProcessExit = (error: PreviewStartupError) => {
      if (processExitError) return
      processExitError = error
      resolveProcessExit(error)
    }
    let closeWait: Promise<void> | null = null
    let finishCloseWait: (() => void) | null = null

    const cleanupProcessListeners = () => {
      proc.removeListener('close', onClose)
      proc.removeListener('error', onError)
      proc.stdout?.removeListener('data', append)
      proc.stderr?.removeListener('data', append)
    }
    const onClose = (code: number | null) => {
      childClosed = true
      finishCloseWait?.()
      cleanupProcessListeners()
      const error = new PreviewStartupError(
        `Preview exited ${settled ? 'after reaching readiness' : 'before announcing a stable reachable URL'} (code ${code ?? 'null'}).`,
        boundedOutput()
      )
      reportProcessExit(error)
      if (!settled) void fail(error)
    }
    const onError = (error: Error) => {
      childErrored = true
      // A spawn error without a pid means there is no child whose stdio can still be pending.
      if (!proc.pid) {
        childClosed = true
        finishCloseWait?.()
        cleanupProcessListeners()
      }
      const startupError = new PreviewStartupError(`Failed to start preview: ${error.message}`, boundedOutput())
      reportProcessExit(startupError)
      if (!settled) void fail(startupError)
    }
    const waitForChildClose = (): Promise<void> => {
      if (childClosed || (childErrored && !proc.pid)) return Promise.resolve()
      if (closeWait) return closeWait
      closeWait = new Promise<void>((resolve) => {
        let finished = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = () => {
          if (finished) return
          finished = true
          if (timer) clearTimeout(timer)
          if (finishCloseWait === finish) finishCloseWait = null
          // If close never arrives, remove the waiter's listeners at the bounded fallback.
          if (!childClosed) cleanupProcessListeners()
          resolve()
        }
        finishCloseWait = finish
        timer = setTimeout(finish, PREVIEW_TERMINATION_TIMEOUT_MS)
        timer.unref?.()
        if (childClosed || (childErrored && !proc.pid)) finish()
      })
      return closeWait
    }

    proc.on('close', onClose)
    proc.on('error', onError)

    let termination: Promise<void> | null = null
    const terminate = (): Promise<void> => {
      if (termination) return termination
      if (disposed) return Promise.resolve()
      disposed = true
      const childClose = waitForChildClose()
      let kill: Promise<void> = Promise.resolve()
      try {
        if (!childClosed && proc.pid) kill = Promise.resolve(terminateTree(proc.pid)).catch(() => undefined)
      } catch {
        kill = Promise.resolve()
      }
      termination = Promise.all([kill, childClose]).then(() => {
        cleanupProcessListeners()
      })
      return termination
    }
    const cleanupStartup = () => {
      clearTimeout(timer)
      if (retryTimer) clearTimeout(retryTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const fail = async (error: PreviewStartupError) => {
      if (settled) return
      settled = true
      cleanupStartup()
      await terminate()
      reject(error)
    }
    const succeed = (url: string) => {
      if (settled) return
      settled = true
      cleanupStartup()
      const onLifecycleAbort = () => terminate()
      options.signal?.addEventListener('abort', onLifecycleAbort, { once: true })
      resolve({
        url,
        managed: true,
        diagnosticOutput: boundedOutput,
        waitForExit: () => processExit,
        running: () => !disposed && !childClosed && !childErrored,
        dispose: async () => {
          options.signal?.removeEventListener('abort', onLifecycleAbort)
          await terminate()
        },
      })
    }
    const scheduleCheck = () => {
      if (settled || retryTimer || pendingUrls.size === 0) return
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void checkUrls()
      }, PREVIEW_READINESS_STABILITY_MS)
      retryTimer.unref?.()
    }
    async function checkUrls(): Promise<void> {
      if (checking || settled) return
      checking = true
      try {
        // Probe one snapshot per pass. Failed candidates remain eligible: framework banners are
        // commonly printed before the first compilation has produced a complete HTTP response.
        const candidates = [...pendingUrls]
        pendingUrls.clear()
        for (const url of candidates) {
          if (settled) break
          const result = await reachable(url, options.signal, reachabilityTimeout)
          const readyUrl = typeof result === 'string' ? normalizeLoopbackPreviewUrl(result) : result ? url : null
          if (readyUrl && !childClosed) {
            const previous = successfulProbes.get(url)
            if (
              previous?.url === readyUrl &&
              Date.now() - previous.at >= PREVIEW_READINESS_STABILITY_MS
            ) {
              succeed(readyUrl)
              break
            }
            successfulProbes.set(url, { url: readyUrl, at: Date.now() })
          } else {
            successfulProbes.delete(url)
          }
          pendingUrls.add(url)
        }
      } finally {
        checking = false
        scheduleCheck()
      }
    }
    const onAbort = () => {
      void fail(new PreviewStartupError('Preview startup aborted.', boundedOutput(), false, true))
    }
    const timer = setTimeout(() => {
      const tryFallback = async () => {
        if (target.fallbackUrl) {
          const first = await reachable(target.fallbackUrl, options.signal, reachabilityTimeout)
          const firstUrl =
            typeof first === 'string' ? normalizeLoopbackPreviewUrl(first) : first ? target.fallbackUrl : null
          if (firstUrl && !childClosed && !options.signal?.aborted) {
            await new Promise<void>((resolve) => {
              const stabilityTimer = setTimeout(resolve, PREVIEW_READINESS_STABILITY_MS)
              stabilityTimer.unref?.()
            })
            const second = await reachable(target.fallbackUrl, options.signal, reachabilityTimeout)
            const secondUrl =
              typeof second === 'string' ? normalizeLoopbackPreviewUrl(second) : second ? target.fallbackUrl : null
            if (secondUrl === firstUrl && !childClosed && !options.signal?.aborted) {
              succeed(firstUrl)
              return
            }
          }
        }
        void fail(new PreviewStartupError('Preview startup timed out.', boundedOutput(), true))
      }
      void tryFallback()
    }, timeoutMs)
    timer.unref?.()
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Integration shortcut that still preserves the prepare/start separation. */
export async function prepareAndStartPreview(
  cwd: string,
  selection: PreviewSelection,
  options: PreviewRuntimeOptions = {}
): Promise<PreviewHandle> {
  const prepared = await preparePreview(cwd, selection, options)
  return startPreview(prepared, options)
}
