import { accessSync, constants, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { app } from 'electron'
import { findOnPath } from '../../platform'

/**
 * Official `@openai/codex` 0.153.4 package layout. The main package declares optional per-platform aliases (e.g.
 * `@openai/codex-darwin-arm64`). Each alias contains a `vendor/<target>/` tree that must remain complete: besides
 * the executable, it carries `codex-path/` and `codex-resources/`, used by the native runtime.
 */
export interface CodexRuntimeTarget {
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  targetTriple: string
  optionalPackage: string
  executableName: 'codex' | 'codex.exe'
}

const TARGETS: Readonly<Record<string, CodexRuntimeTarget>> = {
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    targetTriple: 'aarch64-apple-darwin',
    optionalPackage: '@openai/codex-darwin-arm64',
    executableName: 'codex',
  },
  'darwin-x64': {
    platform: 'darwin',
    arch: 'x64',
    targetTriple: 'x86_64-apple-darwin',
    optionalPackage: '@openai/codex-darwin-x64',
    executableName: 'codex',
  },
  'linux-arm64': {
    platform: 'linux',
    arch: 'arm64',
    targetTriple: 'aarch64-unknown-linux-musl',
    optionalPackage: '@openai/codex-linux-arm64',
    executableName: 'codex',
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    targetTriple: 'x86_64-unknown-linux-musl',
    optionalPackage: '@openai/codex-linux-x64',
    executableName: 'codex',
  },
  'win32-arm64': {
    platform: 'win32',
    arch: 'arm64',
    targetTriple: 'aarch64-pc-windows-msvc',
    optionalPackage: '@openai/codex-win32-arm64',
    executableName: 'codex.exe',
  },
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    targetTriple: 'x86_64-pc-windows-msvc',
    optionalPackage: '@openai/codex-win32-x64',
    executableName: 'codex.exe',
  },
}

export type CodexRuntimeSource = 'managed' | 'materialized' | 'node-modules' | 'path'

export interface CodexRuntimeResolution {
  executablePath: string
  source: CodexRuntimeSource
  target: CodexRuntimeTarget
  /**
   * Pinned version read from `codex-package.json` (sibling of `bin/` in the official layout). `null` when absent,
   * which occurs only with the development PATH CLI. Artifacts written to CODEX_HOME by ANOTHER runtime version
   * may be unreadable here, so consumers must know which runtime is in charge.
   */
  version: string | null
}

type ResolvePackageJson = (packageName: string, fromPackageJson?: string) => string | null

export interface CodexRuntimeResolverDependencies {
  /** Check that the path is a real executable, not merely an entry inside ASAR. */
  isExecutable: (candidate: string, platform: NodeJS.Platform) => boolean
  /** Resolve package.json; `fromPackageJson` covers dependencies kept nested by the package manager. */
  resolvePackageJson: ResolvePackageJson
  /** Development fallback of last resort. Never consulted by the packaged app. */
  findOnPath: (binaryName: string, platform: NodeJS.Platform) => string | null
  /** Read the version published beside the executable; `null` when absent from the layout. */
  readRuntimeVersion: (executablePath: string) => string | null
}

export interface ResolveCodexRuntimeOptions {
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  isPackaged?: boolean
  resourcesPath?: string
  /** Development app root; may contain resources/codex prepared explicitly. */
  appPath?: string
  /** Verified ready installation root from RuntimeAssetService. Required in production. */
  managedAssetPath?: string
  dependencies?: Partial<CodexRuntimeResolverDependencies>
}

export class CodexRuntimeNotFoundError extends Error {
  readonly code = 'CODEX_RUNTIME_NOT_FOUND'

  constructor(
    message: string,
    readonly target: CodexRuntimeTarget,
    readonly checkedPaths: readonly string[]
  ) {
    super(message)
    this.name = 'CodexRuntimeNotFoundError'
  }
}

/** Map only the six targets officially published by the Codex package. */
export function codexRuntimeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): CodexRuntimeTarget {
  const target = TARGETS[`${platform}-${arch}`]
  if (target) return target

  throw new Error(
    `Codex Subscription does not support ${platform}/${arch}. Supported targets: ` + Object.keys(TARGETS).sort().join(', ')
  )
}

const moduleRequire = createRequire(import.meta.url)

function defaultResolvePackageJson(packageName: string, fromPackageJson?: string): string | null {
  try {
    const resolver = fromPackageJson ? createRequire(fromPackageJson) : moduleRequire
    return resolver.resolve(`${packageName}/package.json`)
  } catch {
    return null
  }
}

function defaultIsExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    // Windows does not expose useful X_OK semantics; existence/readability suffices for an .exe.
    accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `<root>/bin/codex` -> `<root>/codex-package.json`, the manifest published by the official package itself. */
function defaultReadRuntimeVersion(executablePath: string): string | null {
  try {
    const manifestPath = path.join(path.dirname(path.dirname(executablePath)), 'codex-package.json')
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const version = (manifest as { version?: unknown } | null)?.version
    return typeof version === 'string' && version.trim() ? version.trim() : null
  } catch {
    // Development PATH CLI, old layout, or unreadable manifest: unknown version is valid state.
    return null
  }
}

const DEFAULT_DEPENDENCIES: CodexRuntimeResolverDependencies = {
  isExecutable: defaultIsExecutable,
  resolvePackageJson: defaultResolvePackageJson,
  findOnPath,
  readRuntimeVersion: defaultReadRuntimeVersion,
}

function nativeExecutable(packageRoot: string, target: CodexRuntimeTarget): string {
  return path.join(packageRoot, 'vendor', target.targetTriple, 'bin', target.executableName)
}

/**
 * An executable inside `app.asar` is not a real file that `spawn` can launch. With `asarUnpack`, Node's resolved
 * path still points into ASAR; explicitly convert it to the physical `app.asar.unpacked` tree.
 */
function physicalAsarPath(candidate: string): string {
  return candidate.replace(/([/\\]app\.asar)([/\\])/, '$1.unpacked$2')
}

function tryPackageRuntime(
  target: CodexRuntimeTarget,
  deps: CodexRuntimeResolverDependencies,
  checkedPaths: string[]
): string | null {
  const mainPackageJson = deps.resolvePackageJson('@openai/codex')
  const optionalPackageJson =
    deps.resolvePackageJson(target.optionalPackage) ??
    (mainPackageJson ? deps.resolvePackageJson(target.optionalPackage, mainPackageJson) : null)

  if (optionalPackageJson) {
    const candidate = physicalAsarPath(nativeExecutable(path.dirname(optionalPackageJson), target))
    checkedPaths.push(candidate)
    if (deps.isExecutable(candidate, target.platform)) return candidate
  }

  if (!mainPackageJson) return null

  // npm usually flattens the optional alias; global/pnpm installations may keep it
  // under the main package's node_modules. The explicit probe also covers
  // this layout without depending on the package manager's algorithm.
  const nestedPackageRoot = path.join(
    path.dirname(mainPackageJson),
    'node_modules',
    ...target.optionalPackage.split('/')
  )
  const nestedCandidate = physicalAsarPath(nativeExecutable(nestedPackageRoot, target))
  if (!checkedPaths.includes(nestedCandidate)) {
    checkedPaths.push(nestedCandidate)
    if (deps.isExecutable(nestedCandidate, target.platform)) return nestedCandidate
  }

  // Defensive compatibility with older releases that shipped vendor/
  // directly in the main package.
  const mainCandidate = physicalAsarPath(nativeExecutable(path.dirname(mainPackageJson), target))
  if (!checkedPaths.includes(mainCandidate)) {
    checkedPaths.push(mainCandidate)
    if (deps.isExecutable(mainCandidate, target.platform)) return mainCandidate
  }

  return null
}

function notFoundMessage(
  target: CodexRuntimeTarget,
  isPackaged: boolean,
  managedPath: string,
  checkedPaths: readonly string[]
): string {
  const checked = checkedPaths.length > 0 ? ` Checked paths: ${checkedPaths.join(', ')}.` : ''
  if (isPackaged) {
    return (
      `The official Codex runtime (${target.platform}/${target.arch}) was not found or is not executable. ` +
      `Install or repair the Codex component from the provider setup. ` +
      `The managed executable expected is ${managedPath}. The packaged app does not use Codex from PATH or node_modules.` +
      checked
    )
  }

  return (
    `The official Codex runtime (${target.platform}/${target.arch}) was not found or is not executable. ` +
    `Run npm install without --omit=optional to install @openai/codex and ${target.optionalPackage}, ` +
    `or install the official codex CLI on PATH for development.` +
    checked
  )
}

/**
 * Resolve the runtime that starts `codex app-server`. Deliberate order: (1) packaged app: verified ready managed
 * installation in userData; (2) development: materialized runtime or official npm package; (3) development only:
 * `codex` on PATH. Production never silently inherits a user CLI, which would make version/protocol unpredictable
 * and break the pinned-runtime guarantee.
 */
export function resolveCodexRuntime(options: ResolveCodexRuntimeOptions = {}): CodexRuntimeResolution {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const target = codexRuntimeTarget(platform, arch)
  const isPackaged = options.isPackaged ?? app.isPackaged
  const appPath = options.appPath ?? app.getAppPath()
  const deps: CodexRuntimeResolverDependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
  const checkedPaths: string[] = []

  const resolution = (executablePath: string, source: CodexRuntimeSource): CodexRuntimeResolution => ({
    executablePath,
    source,
    target,
    version: deps.readRuntimeVersion(executablePath),
  })

  const managedPath = options.managedAssetPath
    ? path.join(options.managedAssetPath, 'bin', target.executableName)
    : path.join('<managed-codex-runtime>', 'bin', target.executableName)
  if (isPackaged) {
    checkedPaths.push(managedPath)
    if (options.managedAssetPath && deps.isExecutable(managedPath, platform)) {
      return resolution(managedPath, 'managed')
    }
    throw new CodexRuntimeNotFoundError(notFoundMessage(target, true, managedPath, checkedPaths), target, checkedPaths)
  }

  if (!isPackaged) {
    const materializedPath = path.join(
      appPath,
      'resources',
      'codex',
      `${platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform}-${arch}`,
      target.targetTriple,
      'bin',
      target.executableName
    )
    checkedPaths.push(materializedPath)
    if (deps.isExecutable(materializedPath, platform)) {
      return resolution(materializedPath, 'materialized')
    }
  }

  const packageRuntime = tryPackageRuntime(target, deps, checkedPaths)
  if (packageRuntime) return resolution(packageRuntime, 'node-modules')

  if (!isPackaged) {
    const pathRuntime = deps.findOnPath('codex', platform)
    if (pathRuntime) return resolution(pathRuntime, 'path')
  }

  throw new CodexRuntimeNotFoundError(
    notFoundMessage(target, isPackaged, managedPath, checkedPaths),
    target,
    checkedPaths
  )
}
