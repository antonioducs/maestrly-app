import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ensureLocalMlDependencies,
  installLocalMlDependencies,
  npmCliCandidates,
  resolveNpmCli,
} from '../../../../scripts/local-ml-npm.mjs'

describe('local-ML npm installer', () => {
  it('resolves the npm CLI JS on Windows without selecting npm.cmd', () => {
    const execPath = 'C:\\Program Files\\nodejs\\node.exe'
    const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    const resolved = resolveNpmCli({
      platform: 'win32',
      execPath,
      npmExecPath: 'C:\\Program Files\\nodejs\\npm.cmd',
      exists: (candidate) => candidate === npmCli,
    })

    expect(resolved).toBe(npmCli)
    expect(
      npmCliCandidates({ platform: 'win32', execPath, npmExecPath: 'C:\\Program Files\\nodejs\\npm.cmd' })
    ).not.toContain('C:\\Program Files\\nodejs\\npm.cmd')
  })

  it('invokes the resolved CLI through Node with the local package cwd', () => {
    const spawn = vi.fn(() => ({ status: 0, error: undefined }))
    const npmCli = '/node/lib/node_modules/npm/bin/npm-cli.js'

    installLocalMlDependencies({
      cwd: '/work/runtime-assets/local-ml',
      sourcePackage: '/work/runtime-assets/local-ml/node_modules/@xenova/transformers/package.json',
      targetPlatform: 'win32',
      targetArch: 'x64',
      resolveNpm: () => npmCli,
      exists: () => true,
      spawn,
    })

    expect(spawn).toHaveBeenCalledWith(process.execPath, [npmCli, 'ci', '--omit=dev'], {
      cwd: '/work/runtime-assets/local-ml',
      env: expect.objectContaining({
        npm_config_platform: 'win32',
        npm_config_arch: 'x64',
        npm_config_os: 'win32',
        npm_config_cpu: 'x64',
      }),
      stdio: 'inherit',
      shell: false,
    })
  })

  it('fails closed with both spawn error and status diagnostics', () => {
    const spawn = vi.fn(() => ({ status: 1, error: Object.assign(new Error('npm unavailable'), { name: 'ENOENT' }) }))

    expect(() =>
      installLocalMlDependencies({
        cwd: '/work/runtime-assets/local-ml',
        sourcePackage: '/work/runtime-assets/local-ml/node_modules/@xenova/transformers/package.json',
        resolveNpm: () => '/node/lib/node_modules/npm/bin/npm-cli.js',
        exists: () => false,
        spawn,
      })
    ).toThrow(/spawn error=ENOENT: npm unavailable; status=1; source package=missing/)
  })

  it.each([
    ['another install target', JSON.stringify({ schema: 2, installTarget: 'mac-arm64', lockfileSha256: 'current' })],
    ['a stale lockfile', JSON.stringify({ schema: 2, installTarget: 'linux-x64', lockfileSha256: 'stale' })],
  ])('reinstalls when the cache is marked with %s', (_reason, stamp) => {
    const spawn = vi.fn(() => ({ status: 0, error: undefined }))
    const remove = vi.fn()
    const writeFile = vi.fn()
    const files = new Map([
      ['/work/runtime-assets/local-ml/node_modules/@xenova/transformers/package.json', '{}'],
      ['/work/runtime-assets/local-ml/package-lock.json', 'current lock'],
      ['/work/runtime-assets/local-ml/node_modules/.local-ml-install.json', stamp],
    ])

    ensureLocalMlDependencies({
      cwd: '/work/runtime-assets/local-ml',
      sourcePackage: '/work/runtime-assets/local-ml/node_modules/@xenova/transformers/package.json',
      installTarget: 'linux-x64',
      targetPlatform: 'linux',
      targetArch: 'x64',
      stampPath: '/work/runtime-assets/local-ml/node_modules/.local-ml-install.json',
      lockfilePath: '/work/runtime-assets/local-ml/package-lock.json',
      resolveNpm: () => '/node/lib/node_modules/npm/bin/npm-cli.js',
      exists: (file: string) => files.has(file),
      readFile: (file: string) =>
        files.get(file) ??
        (() => {
          throw new Error('missing')
        })(),
      remove,
      writeFile,
      spawn,
    })

    expect(remove).toHaveBeenCalledWith(path.join('/work/runtime-assets/local-ml', 'node_modules'), {
      recursive: true,
      force: true,
    })
    expect(spawn).toHaveBeenCalledOnce()
    expect(writeFile).toHaveBeenCalledWith(
      '/work/runtime-assets/local-ml/node_modules/.local-ml-install.json',
      expect.stringContaining('"installTarget":"linux-x64"')
    )
  })

  it('reuses a closure only when target and lockfile stamp match', () => {
    const spawn = vi.fn()
    const remove = vi.fn()
    const lockfile = 'current lock'
    const lockHash = createHash('sha256').update(lockfile).digest('hex')
    const files = new Map([
      ['/work/runtime-assets/local-ml/node_modules/@xenova/transformers/package.json', '{}'],
      ['/work/runtime-assets/local-ml/package-lock.json', lockfile],
      [
        '/work/runtime-assets/local-ml/node_modules/.local-ml-install.json',
        JSON.stringify({ schema: 2, installTarget: 'linux-x64', lockfileSha256: lockHash }),
      ],
    ])

    ensureLocalMlDependencies({
      cwd: '/work/runtime-assets/local-ml',
      sourcePackage: '/work/runtime-assets/local-ml/node_modules/@xenova/transformers/package.json',
      installTarget: 'linux-x64',
      resolveNpm: () => '/node/lib/node_modules/npm/bin/npm-cli.js',
      exists: (file: string) => files.has(file.replaceAll('\\', '/')),
      readFile: (file: string) =>
        files.get(file.replaceAll('\\', '/')) ??
        (() => {
          throw new Error('missing')
        })(),
      remove,
      spawn,
    })

    expect(remove).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})
