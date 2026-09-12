import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  codexRuntimeTarget,
  CodexRuntimeNotFoundError,
  resolveCodexRuntime,
  type CodexRuntimeResolverDependencies,
} from '../../src/main/chat/codex-subscription/runtime-resolver'

interface HarnessOptions {
  executable?: string[]
  packages?: Record<string, string>
  pathRuntime?: string | null
  versions?: Record<string, string>
}

function harness(options: HarnessOptions = {}): CodexRuntimeResolverDependencies {
  const executable = new Set(options.executable ?? [])
  return {
    isExecutable: vi.fn((candidate) => executable.has(candidate)),
    resolvePackageJson: vi.fn((packageName, fromPackageJson) => {
      const fromKey = fromPackageJson ? `${packageName}|${fromPackageJson}` : packageName
      return options.packages?.[fromKey] ?? null
    }),
    findOnPath: vi.fn(() => options.pathRuntime ?? null),
    readRuntimeVersion: vi.fn((executablePath) => options.versions?.[executablePath] ?? null),
  }
}

describe('codexRuntimeTarget', () => {
  it.each([
    ['darwin', 'arm64', 'aarch64-apple-darwin', '@openai/codex-darwin-arm64', 'codex'],
    ['darwin', 'x64', 'x86_64-apple-darwin', '@openai/codex-darwin-x64', 'codex'],
    ['linux', 'arm64', 'aarch64-unknown-linux-musl', '@openai/codex-linux-arm64', 'codex'],
    ['linux', 'x64', 'x86_64-unknown-linux-musl', '@openai/codex-linux-x64', 'codex'],
    ['win32', 'arm64', 'aarch64-pc-windows-msvc', '@openai/codex-win32-arm64', 'codex.exe'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc', '@openai/codex-win32-x64', 'codex.exe'],
  ] as const)('maps %s/%s to the official package and target', (platform, arch, triple, pkg, executable) => {
    expect(codexRuntimeTarget(platform, arch)).toMatchObject({
      targetTriple: triple,
      optionalPackage: pkg,
      executableName: executable,
    })
  })

  it('fails early for unsupported runtime targets', () => {
    expect(() => codexRuntimeTarget('freebsd', 'x64')).toThrow(/does not support freebsd\/x64.*darwin-arm64.*win32-x64/)
    expect(() => codexRuntimeTarget('linux', 'ia32')).toThrow(/does not support linux\/ia32/)
  })
})

describe('resolveCodexRuntime', () => {
  it('uses only managed packaged assets without npm or PATH', () => {
    const root = '/user-data/runtime-assets/codex-runtime/versions/0.149.1-mac-arm64'
    const managed = path.join(root, 'bin', 'codex')
    const dependencies = harness({ executable: [managed], pathRuntime: '/usr/local/bin/codex' })

    const result = resolveCodexRuntime({
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      managedAssetPath: root,
      dependencies,
    })

    expect(result).toMatchObject({ executablePath: managed, source: 'managed' })
    expect(dependencies.resolvePackageJson).not.toHaveBeenCalled()
    expect(dependencies.findOnPath).not.toHaveBeenCalled()
  })

  it('reports pinned executable versions and tolerates unknown versions', () => {
    // Consumers of CODEX_HOME artifacts must identify the active runtime version;
    // user CLI installations may have written the same directory with newer schemas.
    const root = '/user-data/runtime-assets/codex-runtime/versions/0.149.1-mac-arm64'
    const managed = path.join(root, 'bin', 'codex')
    const options = {
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      managedAssetPath: root,
    } as const

    expect(
      resolveCodexRuntime({
        ...options,
        dependencies: harness({ executable: [managed], versions: { [managed]: '0.149.1' } }),
      }).version
    ).toBe('0.149.1')

    // Development PATH runtimes without package metadata may legitimately have unknown versions.
    expect(resolveCodexRuntime({ ...options, dependencies: harness({ executable: [managed] }) }).version).toBeNull()
  })

  it('prefers official optional native packages over development PATH', () => {
    const packageJson = '/repo/node_modules/@openai/codex-linux-x64/package.json'
    const native = path.join(
      '/repo/node_modules/@openai/codex-linux-x64',
      'vendor',
      'x86_64-unknown-linux-musl',
      'bin',
      'codex'
    )
    const dependencies = harness({
      packages: { '@openai/codex-linux-x64': packageJson },
      executable: [native],
      pathRuntime: '/usr/local/bin/codex',
    })

    const result = resolveCodexRuntime({
      platform: 'linux',
      arch: 'x64',
      isPackaged: false,
      resourcesPath: '/unused',
      appPath: '/repo-without-materialized-runtime',
      dependencies,
    })

    expect(result).toMatchObject({ executablePath: native, source: 'node-modules' })
    expect(dependencies.findOnPath).not.toHaveBeenCalled()
  })

  it('prefers materialized pinned development runtimes', () => {
    const materialized = path.join(
      '/repo',
      'resources',
      'codex',
      'linux-x64',
      'x86_64-unknown-linux-musl',
      'bin',
      'codex'
    )
    const dependencies = harness({ executable: [materialized], pathRuntime: '/usr/local/bin/codex' })

    expect(
      resolveCodexRuntime({
        platform: 'linux',
        arch: 'x64',
        isPackaged: false,
        resourcesPath: '/unused',
        appPath: '/repo',
        dependencies,
      })
    ).toMatchObject({ executablePath: materialized, source: 'materialized' })
    expect(dependencies.resolvePackageJson).not.toHaveBeenCalled()
    expect(dependencies.findOnPath).not.toHaveBeenCalled()
  })

  it('resolves nested optional aliases from package metadata', () => {
    const main = '/global/node_modules/@openai/codex/package.json'
    const optional = '/global/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/package.json'
    const native = path.join(path.dirname(optional), 'vendor', 'aarch64-apple-darwin', 'bin', 'codex')
    const dependencies = harness({
      packages: {
        '@openai/codex': main,
        [`@openai/codex-darwin-arm64|${main}`]: optional,
      },
      executable: [native],
    })

    expect(
      resolveCodexRuntime({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: false,
        resourcesPath: '/unused',
        appPath: '/repo-without-materialized-runtime',
        dependencies,
      })
    ).toMatchObject({ executablePath: native, source: 'node-modules' })
  })

  it('maps unpacked asar packages to physical paths', () => {
    const optional = '/opt/Maestrly/resources/app.asar/node_modules/@openai/codex-win32-x64/package.json'
    const native = path.join(
      '/opt/Maestrly/resources/app.asar.unpacked/node_modules/@openai/codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe'
    )
    const dependencies = harness({
      packages: { '@openai/codex-win32-x64': optional },
      executable: [native],
    })

    const result = resolveCodexRuntime({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      resourcesPath: 'C:\\Maestrly\\resources',
      dependencies,
    })

    expect(result).toMatchObject({ executablePath: native, source: 'node-modules' })
  })

  it('uses PATH only as a development fallback', () => {
    const dependencies = harness({ pathRuntime: '/opt/homebrew/bin/codex' })

    expect(
      resolveCodexRuntime({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: false,
        resourcesPath: '/unused',
        appPath: '/repo-without-materialized-runtime',
        dependencies,
      })
    ).toMatchObject({ executablePath: '/opt/homebrew/bin/codex', source: 'path' })
    expect(dependencies.findOnPath).toHaveBeenCalledWith('codex', 'darwin')
  })

  it('avoids packaged PATH inheritance and reports searched paths', () => {
    const dependencies = harness({ pathRuntime: '/usr/local/bin/codex' })

    let error: unknown
    try {
      resolveCodexRuntime({
        platform: 'linux',
        arch: 'arm64',
        isPackaged: true,
        resourcesPath: '/opt/Maestrly/resources',
        dependencies,
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(CodexRuntimeNotFoundError)
    expect(error).toMatchObject({ code: 'CODEX_RUNTIME_NOT_FOUND' })
    expect((error as Error).message).toMatch(/Install or repair the Codex component/)
    expect((error as Error).message).toContain(path.join('<managed-codex-runtime>', 'bin', 'codex'))
    expect((error as Error).message).toMatch(/does not use Codex from PATH or node_modules/)
    expect(dependencies.findOnPath).not.toHaveBeenCalled()
  })

  it('explains optional dependency installation for missing development runtimes', () => {
    const dependencies = harness()

    expect(() =>
      resolveCodexRuntime({
        platform: 'win32',
        arch: 'arm64',
        isPackaged: false,
        resourcesPath: 'C:\\unused',
        appPath: 'C:\\repo-without-materialized-runtime',
        dependencies,
      })
    ).toThrow(/npm install without --omit=optional.*@openai\/codex-win32-arm64.*PATH/)
  })
})
