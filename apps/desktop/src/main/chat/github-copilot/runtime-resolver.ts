import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { app } from 'electron'
import { findOnPath } from '../../platform'

interface GithubCopilotRuntimeTarget {
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  materializedId: string
  optionalPackage: string
  executableName: 'copilot' | 'copilot.exe'
}

const TARGETS: Readonly<Record<string, GithubCopilotRuntimeTarget>> = {
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    materializedId: 'mac-arm64',
    optionalPackage: '@github/copilot-darwin-arm64',
    executableName: 'copilot',
  },
  'darwin-x64': {
    platform: 'darwin',
    arch: 'x64',
    materializedId: 'mac-x64',
    optionalPackage: '@github/copilot-darwin-x64',
    executableName: 'copilot',
  },
  'linux-arm64': {
    platform: 'linux',
    arch: 'arm64',
    materializedId: 'linux-arm64',
    optionalPackage: '@github/copilot-linux-arm64',
    executableName: 'copilot',
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    materializedId: 'linux-x64',
    optionalPackage: '@github/copilot-linux-x64',
    executableName: 'copilot',
  },
  'win32-arm64': {
    platform: 'win32',
    arch: 'arm64',
    materializedId: 'win-arm64',
    optionalPackage: '@github/copilot-win32-arm64',
    executableName: 'copilot.exe',
  },
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    materializedId: 'win-x64',
    optionalPackage: '@github/copilot-win32-x64',
    executableName: 'copilot.exe',
  },
}

export type GithubCopilotRuntimeSource = 'managed' | 'materialized' | 'node-modules' | 'path'

export interface GithubCopilotRuntimeResolution {
  executablePath: string
  source: GithubCopilotRuntimeSource
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
}

type ResolvePackageEntry = (packageName: string, fromEntry?: string) => string | null

export interface GithubCopilotRuntimeResolverDependencies {
  isExecutable: (candidate: string, platform: NodeJS.Platform) => boolean
  resolvePackageEntry: ResolvePackageEntry
  findOnPath: (binaryName: string, platform: NodeJS.Platform) => string | null
}

export interface ResolveGithubCopilotRuntimeOptions {
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  isPackaged?: boolean
  resourcesPath?: string
  /** Development app root; may contain resources/github-copilot prepared explicitly. */
  appPath?: string
  /** Verified ready installation root from RuntimeAssetService. Required in production. */
  managedAssetPath?: string
  dependencies?: Partial<GithubCopilotRuntimeResolverDependencies>
}

export class GithubCopilotRuntimeNotFoundError extends Error {
  readonly code = 'GITHUB_COPILOT_RUNTIME_NOT_FOUND'

  constructor(
    message: string,
    readonly platform: NodeJS.Platform,
    readonly arch: NodeJS.Architecture,
    readonly checkedPaths: readonly string[]
  ) {
    super(message)
    this.name = 'GithubCopilotRuntimeNotFoundError'
  }
}

function githubCopilotRuntimeTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): GithubCopilotRuntimeTarget {
  const target = TARGETS[`${platform}-${arch}`]
  if (target) return target

  throw new Error(
    `GitHub Copilot Subscription does not support ${platform}/${arch}. Supported targets: ` +
      Object.keys(TARGETS).sort().join(', ')
  )
}

const moduleRequire = createRequire(import.meta.url)

function defaultResolvePackageEntry(packageName: string, fromEntry?: string): string | null {
  try {
    const resolver = fromEntry ? createRequire(fromEntry) : moduleRequire
    return resolver.resolve(packageName)
  } catch {
    return null
  }
}

function defaultIsExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

const DEFAULT_DEPENDENCIES: GithubCopilotRuntimeResolverDependencies = {
  isExecutable: defaultIsExecutable,
  resolvePackageEntry: defaultResolvePackageEntry,
  findOnPath,
}

function resolveNodeModulesRuntime(
  target: GithubCopilotRuntimeTarget,
  deps: GithubCopilotRuntimeResolverDependencies,
  checkedPaths: string[]
): string | null {
  // Platform packages export `.` directly to copilot[.exe].
  // Try npm's flat layout first, then resolution relative to the SDK.
  const sdkEntry = deps.resolvePackageEntry('@github/copilot-sdk')
  const candidate =
    deps.resolvePackageEntry(target.optionalPackage) ??
    (sdkEntry ? deps.resolvePackageEntry(target.optionalPackage, sdkEntry) : null)
  if (!candidate) return null

  checkedPaths.push(candidate)
  return deps.isExecutable(candidate, target.platform) ? candidate : null
}

function notFoundMessage(
  target: GithubCopilotRuntimeTarget,
  isPackaged: boolean,
  managedPath: string,
  checkedPaths: readonly string[]
): string {
  const checked = checkedPaths.length > 0 ? ` Checked paths: ${checkedPaths.join(', ')}.` : ''
  if (isPackaged) {
    return (
      `The official GitHub Copilot runtime (${target.platform}/${target.arch}) was not found or is not executable. ` +
      `Install or repair the GitHub Copilot component from the provider setup. ` +
      `The managed executable expected is ${managedPath}; the packaged app does not use Copilot from PATH or node_modules.` +
      checked
    )
  }

  return (
    `The official GitHub Copilot runtime (${target.platform}/${target.arch}) was not found or is not executable. ` +
    `Run npm install without --omit=optional to install ${target.optionalPackage}, ` +
    `or install the official copilot CLI on PATH for development.` +
    checked
  )
}

/**
 * Resolve the official executable used by the SDK in `RuntimeConnection.forStdio`. Production accepts only the
 * ready managed installation in userData; development may also use the materialized runtime, optional npm package,
 * or PATH.
 */
export function resolveGithubCopilotRuntime(
  options: ResolveGithubCopilotRuntimeOptions = {}
): GithubCopilotRuntimeResolution {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const target = githubCopilotRuntimeTarget(platform, arch)
  const isPackaged = options.isPackaged ?? app.isPackaged
  const appPath = options.appPath ?? app.getAppPath()
  const deps: GithubCopilotRuntimeResolverDependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
  const checkedPaths: string[] = []

  const managedPath = options.managedAssetPath
    ? path.join(options.managedAssetPath, target.executableName)
    : path.join('<managed-github-copilot-runtime>', target.executableName)
  if (isPackaged) {
    checkedPaths.push(managedPath)
    if (options.managedAssetPath && deps.isExecutable(managedPath, platform)) {
      return { executablePath: managedPath, source: 'managed', platform, arch }
    }
    throw new GithubCopilotRuntimeNotFoundError(
      notFoundMessage(target, true, managedPath, checkedPaths), platform, arch, checkedPaths
    )
  }

  if (!isPackaged) {
    const materializedPath = path.join(
      appPath,
      'resources',
      'github-copilot',
      target.materializedId,
      'package',
      target.executableName
    )
    checkedPaths.push(materializedPath)
    if (deps.isExecutable(materializedPath, platform)) {
      return { executablePath: materializedPath, source: 'materialized', platform, arch }
    }

    const packageRuntime = resolveNodeModulesRuntime(target, deps, checkedPaths)
    if (packageRuntime) {
      return { executablePath: packageRuntime, source: 'node-modules', platform, arch }
    }

    const pathRuntime = deps.findOnPath('copilot', platform)
    if (pathRuntime) return { executablePath: pathRuntime, source: 'path', platform, arch }
  }

  throw new GithubCopilotRuntimeNotFoundError(
    notFoundMessage(target, isPackaged, managedPath, checkedPaths),
    platform,
    arch,
    checkedPaths
  )
}
