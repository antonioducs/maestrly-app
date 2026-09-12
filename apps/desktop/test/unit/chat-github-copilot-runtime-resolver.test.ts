import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  GithubCopilotRuntimeNotFoundError,
  resolveGithubCopilotRuntime,
  type GithubCopilotRuntimeResolverDependencies,
} from '../../src/main/chat/github-copilot/runtime-resolver'

interface HarnessOptions {
  executable?: string[]
  packages?: Record<string, string>
  pathRuntime?: string | null
}

function harness(options: HarnessOptions = {}): GithubCopilotRuntimeResolverDependencies {
  const executable = new Set(options.executable ?? [])
  return {
    isExecutable: vi.fn((candidate) => executable.has(candidate)),
    resolvePackageEntry: vi.fn((packageName, fromEntry) => {
      const key = fromEntry ? `${packageName}|${fromEntry}` : packageName
      return options.packages?.[key] ?? null
    }),
    findOnPath: vi.fn(() => options.pathRuntime ?? null),
  }
}

describe('resolveGithubCopilotRuntime', () => {
  it('uses only the managed asset in the packaged app', () => {
    const root = '/user-data/runtime-assets/github-copilot-runtime/versions/1.0.71-mac-arm64'
    const managed = path.join(root, 'copilot')
    const dependencies = harness({ executable: [managed], pathRuntime: '/usr/local/bin/copilot' })

    const result = resolveGithubCopilotRuntime({
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      managedAssetPath: root,
      dependencies,
    })

    expect(result).toEqual({
      executablePath: managed,
      source: 'managed',
      platform: 'darwin',
      arch: 'arm64',
    })
    expect(dependencies.resolvePackageEntry).not.toHaveBeenCalled()
    expect(dependencies.findOnPath).not.toHaveBeenCalled()
  })

  it.each([
    ['darwin', 'x64', 'mac-x64', 'copilot'],
    ['linux', 'arm64', 'linux-arm64', 'copilot'],
    ['linux', 'x64', 'linux-x64', 'copilot'],
    ['win32', 'arm64', 'win-arm64', 'copilot.exe'],
    ['win32', 'x64', 'win-x64', 'copilot.exe'],
  ] as const)('resolves the materialized runtime for %s/%s', (platform, arch, targetId, executableName) => {
    const materialized = path.join('/repo', 'resources', 'github-copilot', targetId, 'package', executableName)
    const dependencies = harness({ executable: [materialized] })

    expect(
      resolveGithubCopilotRuntime({
        platform,
        arch,
        isPackaged: false,
        resourcesPath: '/unused',
        appPath: '/repo',
        dependencies,
      })
    ).toMatchObject({ executablePath: materialized, source: 'materialized', platform, arch })
  })

  it('resolves the official npm package executable before PATH in development', () => {
    const sdkEntry = '/repo/node_modules/@github/copilot-sdk/dist/cjs/index.js'
    const native = '/repo/node_modules/@github/copilot-linux-x64/copilot'
    const dependencies = harness({
      packages: {
        '@github/copilot-sdk': sdkEntry,
        [`@github/copilot-linux-x64|${sdkEntry}`]: native,
      },
      executable: [native],
      pathRuntime: '/usr/local/bin/copilot',
    })

    expect(
      resolveGithubCopilotRuntime({
        platform: 'linux',
        arch: 'x64',
        isPackaged: false,
        resourcesPath: '/unused',
        appPath: '/repo-without-materialized-runtime',
        dependencies,
      })
    ).toMatchObject({ executablePath: native, source: 'node-modules' })
    expect(dependencies.findOnPath).not.toHaveBeenCalled()
  })

  it('uses PATH as a last resort only in development', () => {
    const dependencies = harness({ pathRuntime: '/opt/homebrew/bin/copilot' })

    expect(
      resolveGithubCopilotRuntime({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: false,
        resourcesPath: '/unused',
        appPath: '/repo-without-materialized-runtime',
        dependencies,
      })
    ).toMatchObject({ executablePath: '/opt/homebrew/bin/copilot', source: 'path' })
  })

  it('does not inherit PATH in the packaged app and returns an actionable error', () => {
    const dependencies = harness({ pathRuntime: '/usr/local/bin/copilot' })

    expect(() =>
      resolveGithubCopilotRuntime({
        platform: 'win32',
        arch: 'x64',
        isPackaged: true,
        resourcesPath: 'C:\\Maestrly\\resources',
        dependencies,
      })
    ).toThrow(GithubCopilotRuntimeNotFoundError)

    expect(() =>
      resolveGithubCopilotRuntime({
        platform: 'win32',
        arch: 'x64',
        isPackaged: true,
        resourcesPath: 'C:\\Maestrly\\resources',
        dependencies,
      })
    ).toThrow(/Install or repair the GitHub Copilot component.*does not use Copilot from PATH or node_modules/)
    expect(dependencies.findOnPath).not.toHaveBeenCalled()
  })

  it('fails early when the platform has no official package supported by packaging', () => {
    const dependencies = harness()
    expect(() =>
      resolveGithubCopilotRuntime({
        platform: 'freebsd',
        arch: 'x64',
        isPackaged: false,
        resourcesPath: '/unused',
        appPath: '/repo',
        dependencies,
      })
    ).toThrow(/does not support freebsd\/x64.*darwin-arm64.*win32-x64/)
  })
})
