import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverPreviewTargets,
  isLoopbackPreviewUrl,
  normalizeLoopbackPreviewUrl,
  preparePreview,
  previewStartupErrorMessage,
  PreviewStartupError,
  startPreview,
  prepareAndStartPreview,
  type PreviewRuntimeDependencies,
} from '../../src/main/chat/chatgpt-web/preview-runtime'

const temporaryDirectories: string[] = []

// Discovery fixtures describe POSIX launch plans; Windows shim resolution has dedicated cases below.
const discoveryDependencies: PreviewRuntimeDependencies = { platform: 'linux' }

function temporaryProject(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'chatweb-preview-'))
  temporaryDirectories.push(directory)
  return directory
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value))
}

function ids(...values: string[]): () => string {
  let index = 0
  return () => values[index++] ?? `generated-${index}`
}

function fakeProcess(pid = 4242): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
  const emitter = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough }
  Object.assign(emitter, { pid, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() })
  return emitter
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('preview URL loopback policy', () => {
  it('accepts only plain HTTP on exact loopback hosts and valid ports', () => {
    expect(normalizeLoopbackPreviewUrl('http://localhost:5173/app#hash')).toBe('http://localhost:5173/app')
    expect(normalizeLoopbackPreviewUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/')
    expect(normalizeLoopbackPreviewUrl('http://[::1]:4321/')).toBe('http://[::1]:4321/')
    expect(isLoopbackPreviewUrl('http://localhost/')).toBe(true)

    for (const url of [
      'https://localhost:5173/',
      'http://0.0.0.0:5173/',
      'http://192.168.1.10:5173/',
      'http://example.com/',
      'http://localhost.evil.test:5173/',
      'http://localhost.:5173/',
      'http://127.1:5173/',
      'http://2130706433:5173/',
      'http://user:pass@localhost:5173/',
      'http://localhost:65536/',
      'file:///tmp/index.html',
      'data:text/html,hello',
      'javascript:alert(1)',
    ]) {
      expect(normalizeLoopbackPreviewUrl(url), url).toBeNull()
    }
  })
})

describe('preview discovery', () => {
  it('discovers recognized frontend scripts in root/workspaces without exposing cwd or argv', () => {
    const root = temporaryProject()
    mkdirSync(path.join(root, 'packages', 'web'), { recursive: true })
    mkdirSync(path.join(root, 'packages', 'api'), { recursive: true })
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), {
      name: 'root-app',
      workspaces: ['packages/*'],
      scripts: {
        dev: 'node server.js',
        preview: 'vite preview --port 5180',
        arbitrary: 'vite',
        'web:start': 'next start --hostname 0.0.0.0',
      },
    })
    writeJson(path.join(root, 'packages', 'web', 'package.json'), {
      name: '@app/web',
      scripts: { 'frontend:dev': 'next dev' },
    })
    writeJson(path.join(root, 'packages', 'api', 'package.json'), {
      name: '@app/api',
      scripts: { start: 'node api.js' },
    })

    const discovered = discoverPreviewTargets(root, { dependencies: { randomId: ids('opaque-a', 'opaque-b') } })
    expect(discovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'opaque-b', label: '@app/web — frontend:dev', script: 'frontend:dev' }),
        expect.objectContaining({ id: 'opaque-a', label: 'root-app — preview', script: 'preview' }),
      ])
    )
    expect(discovered).toHaveLength(2)
    expect(JSON.stringify(discovered)).not.toContain(root)
    expect(JSON.stringify(discovered)).not.toContain('run')
    expect(discovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repo: 'repository', cwd: '.' }),
        expect.objectContaining({ repo: 'repository', cwd: 'packages/web' }),
      ])
    )
    expect(
      discovered.every((target) => !path.isAbsolute(target.cwd) && !('command' in target) && !('args' in target))
    ).toBe(true)
  })

  it('does not follow a symlinked workspace outside the authorized cwd', () => {
    const root = temporaryProject()
    const outside = temporaryProject()
    mkdirSync(path.join(root, 'packages'), { recursive: true })
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '')
    writeJson(path.join(root, 'package.json'), { workspaces: ['packages/*'] })
    writeJson(path.join(outside, 'package.json'), { scripts: { dev: 'vite' } })
    symlinkSync(outside, path.join(root, 'packages', 'escaped'), 'dir')

    expect(discoverPreviewTargets(root, { dependencies: discoveryDependencies })).toEqual([])
  })

  it('discovers pnpm workspaces declared only in pnpm-workspace.yaml and applies exclusions', () => {
    const root = temporaryProject()
    for (const packageName of ['web', 'ignored']) mkdirSync(path.join(root, 'apps', packageName), { recursive: true })
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '')
    writeJson(path.join(root, 'package.json'), { name: 'pnpm-root' })
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - '!apps/ignored'\n")
    writeJson(path.join(root, 'apps', 'web', 'package.json'), {
      name: '@app/web',
      scripts: { dev: 'vite' },
    })
    writeJson(path.join(root, 'apps', 'ignored', 'package.json'), {
      name: '@app/ignored',
      scripts: { dev: 'vite' },
    })

    expect(discoverPreviewTargets(root, { dependencies: discoveryDependencies })).toEqual([
      expect.objectContaining({ cwd: 'apps/web', label: '@app/web — dev', packageManager: 'pnpm' }),
    ])
  })

  it('merges package.json and pnpm workspace globs in stable order', () => {
    const root = temporaryProject()
    mkdirSync(path.join(root, 'apps', 'web'), { recursive: true })
    mkdirSync(path.join(root, 'packages', 'legacy'), { recursive: true })
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '')
    writeJson(path.join(root, 'package.json'), { workspaces: ['packages/*'] })
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
    writeJson(path.join(root, 'apps', 'web', 'package.json'), { name: '@app/web', scripts: { dev: 'vite' } })
    writeJson(path.join(root, 'packages', 'legacy', 'package.json'), {
      name: '@app/legacy',
      scripts: { dev: 'vite' },
    })

    expect(discoverPreviewTargets(root, { dependencies: discoveryDependencies }).map(({ cwd }) => cwd)).toEqual([
      'packages/legacy',
      'apps/web',
    ])
  })

  it('prunes a large unrelated subtree before it can consume discovery work', () => {
    const root = temporaryProject()
    mkdirSync(path.join(root, 'apps', 'web'), { recursive: true })
    mkdirSync(path.join(root, 'unrelated'), { recursive: true })
    for (let index = 0; index < 300; index += 1) mkdirSync(path.join(root, 'unrelated', `tree-${index}`))
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { workspaces: ['apps/*'] })
    writeJson(path.join(root, 'apps', 'web', 'package.json'), { scripts: { dev: 'vite' } })

    const discovered = discoverPreviewTargets(root)

    expect(discovered).toEqual([expect.objectContaining({ cwd: 'apps/web' })])
  })

  it('returns a deterministic bounded subset when a workspace contains too many packages', () => {
    const root = temporaryProject()
    mkdirSync(path.join(root, 'packages'), { recursive: true })
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { workspaces: ['packages/*'] })
    for (let index = 0; index < 600; index += 1) {
      const packageDirectory = path.join(root, 'packages', `package-${String(index).padStart(4, '0')}`)
      mkdirSync(packageDirectory)
      writeJson(path.join(packageDirectory, 'package.json'), { scripts: { dev: 'vite' } })
    }

    const first = discoverPreviewTargets(root)
    const second = discoverPreviewTargets(root)

    expect(first).toHaveLength(256)
    expect(second.map(({ cwd, label }) => ({ cwd, label }))).toEqual(first.map(({ cwd, label }) => ({ cwd, label })))
  })

  it('rejects forged, expired, and cross-cwd target IDs', async () => {
    const root = temporaryProject()
    const other = temporaryProject()
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { scripts: { dev: 'vite' } })
    const [target] = discoverPreviewTargets(root, { dependencies: { randomId: ids('real-target') } })

    await expect(preparePreview(root, { targetId: 'forged' })).rejects.toThrow('Unknown or expired')
    await expect(preparePreview(other, { targetId: target.id })).rejects.toThrow('Unknown or expired')
  })

  it('revalidates the manifest after preparation instead of running a changed script', async () => {
    const root = temporaryProject()
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { scripts: { dev: 'vite' } })
    const dependencies: PreviewRuntimeDependencies = {
      spawn: vi.fn(),
      randomId: ids('stale-target', 'stale-prepared'),
    }
    const [target] = discoverPreviewTargets(root, { dependencies })
    const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
    writeJson(path.join(root, 'package.json'), { scripts: { dev: 'node changed.js' } })

    await expect(startPreview(prepared, { dependencies })).rejects.toThrow('changed; run discovery again')
    expect(dependencies.spawn).not.toHaveBeenCalled()
  })

  it('revalidates workspace realpaths before spawning to close symlink TOCTOU escapes', async () => {
    const root = temporaryProject()
    const outside = temporaryProject()
    const workspace = path.join(root, 'packages', 'web')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { workspaces: ['packages/*'] })
    writeJson(path.join(workspace, 'package.json'), { scripts: { dev: 'vite' } })
    writeJson(path.join(outside, 'package.json'), { scripts: { dev: 'vite' } })
    const dependencies: PreviewRuntimeDependencies = {
      spawn: vi.fn(),
      randomId: ids('workspace-target', 'workspace-prepared'),
    }
    const [target] = discoverPreviewTargets(root, { dependencies })
    const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
    rmSync(workspace, { recursive: true })
    symlinkSync(outside, workspace, 'dir')

    await expect(startPreview(prepared, { dependencies })).rejects.toThrow('escaped the authorized cwd')
    expect(dependencies.spawn).not.toHaveBeenCalled()
  })
})

describe('preview preparation and startup', () => {
  it('starts and tears down the real visual smoke fixture without a shell', async () => {
    const fixture = fileURLToPath(new URL('../fixtures/chatgpt-web-visual-preview', import.meta.url))
    const [target] = discoverPreviewTargets(fixture)
    expect(target).toMatchObject({ repo: 'repository', cwd: '.', script: 'dev' })
    const handle = await prepareAndStartPreview(fixture, { targetId: target.id }, { startupTimeoutMs: 15_000 })
    expect(handle.managed).toBe(true)
    expect(await fetch(handle.url).then((response) => response.text())).toContain('Visual Review smoke')
    await handle.dispose()
    await vi.waitFor(
      async () => {
        await expect(fetch(handle.url)).rejects.toThrow()
      },
      { timeout: 5_000, interval: 100 }
    )
  }, 25_000)

  it('rejects raw target_url and never probes an undiscovered target', async () => {
    const root = temporaryProject()
    const spawn = vi.fn()
    const reachable = vi.fn(async () => true)
    const dependencies: PreviewRuntimeDependencies = { spawn, reachable, randomId: ids('url-prepared') }
    await expect(
      preparePreview(root, { targetUrl: 'http://127.0.0.1:8080/app' } as never, { dependencies })
    ).rejects.toThrow('preview_id must be an opaque ID')
    expect(reachable).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('spawns with shell:false, detects a split announced URL, and tears down the process tree', async () => {
    const root = temporaryProject()
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { scripts: { dev: 'vite' } })
    const proc = fakeProcess()
    const spawn = vi.fn(() => proc)
    const kill = vi.fn()
    const reachable = vi.fn(async (url: string) => url === 'http://localhost:5173/')
    const dependencies: PreviewRuntimeDependencies = {
      platform: 'linux',
      spawn,
      killProcessTree: kill,
      reachable,
      env: {
        PATH: process.env.PATH ?? '',
        VITE_PUBLIC_FLAG: 'kept',
        PREVIEW_SECRET: 'must-not-reach-the-child',
        NODE_OPTIONS: '--require=secret-loader.js',
      },
      randomId: ids('managed-target', 'managed-prepared'),
    }
    const [target] = discoverPreviewTargets(root, { dependencies })
    const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
    const starting = startPreview(prepared, { dependencies, startupTimeoutMs: 1_000 })
    proc.stdout.write('Local: http://local')
    proc.stdout.write('host:5173/\n')
    const handle = await starting

    expect(spawn).toHaveBeenCalledWith(
      'npm',
      ['run', 'dev', '--', '--host', '127.0.0.1'],
      expect.objectContaining({ cwd: realpathSync(root), shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    )
    const spawnOptions = (spawn.mock.calls[0] as unknown as [unknown, unknown, { env: NodeJS.ProcessEnv }])[2]
    expect(spawnOptions.env).toMatchObject({
      PATH: process.env.PATH ?? '',
      VITE_PUBLIC_FLAG: 'kept',
      BROWSER: 'none',
      HOST: '127.0.0.1',
    })
    expect(spawnOptions.env).not.toHaveProperty('PREVIEW_SECRET')
    expect(spawnOptions.env).not.toHaveProperty('NODE_OPTIONS')
    expect(handle).toMatchObject({ url: 'http://localhost:5173/', managed: true })
    const disposing = handle.dispose()
    proc.emit('close', null)
    await disposing
    await handle.dispose()
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(4242)
  })

  it('retries an announced URL and requires stable reachability before resolving', async () => {
    vi.useFakeTimers()
    try {
      const root = temporaryProject()
      writeFileSync(path.join(root, 'package-lock.json'), '{}')
      writeJson(path.join(root, 'package.json'), { scripts: { dev: 'vite' } })
      const proc = fakeProcess(4545)
      const reachable = vi.fn<(url: string) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true)
      const dependencies: PreviewRuntimeDependencies = {
        spawn: () => proc,
        killProcessTree: () => {
          proc.emit('close', null)
        },
        reachable,
        randomId: ids('retry-target', 'retry-prepared'),
      }
      const [target] = discoverPreviewTargets(root, { dependencies })
      const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
      const starting = startPreview(prepared, { dependencies, startupTimeoutMs: 2_000 })
      proc.stdout.write('Local: http://127.0.0.1:5173/\n')
      await vi.advanceTimersByTimeAsync(300)
      const handle = await starting

      expect(reachable).toHaveBeenCalledTimes(3)
      expect(handle.running?.()).toBe(true)
      await handle.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for complete HTTP responses and starts the browser at the first loopback redirect URL', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(302, { location: '/ready' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<h1>ready</h1>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const root = temporaryProject()
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { scripts: { dev: 'vite' } })
    const proc = fakeProcess(4595)
    const dependencies: PreviewRuntimeDependencies = {
      spawn: () => proc,
      killProcessTree: () => {
        proc.emit('close', null)
      },
      randomId: ids('redirect-target', 'redirect-prepared'),
    }
    let handle: Awaited<ReturnType<typeof startPreview>> | undefined
    try {
      const [target] = discoverPreviewTargets(root, { dependencies })
      const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
      const starting = startPreview(prepared, { dependencies, startupTimeoutMs: 2_000 })
      proc.stdout.write(`Local: http://127.0.0.1:${port}/\n`)
      handle = await starting

      expect(handle.url).toBe(`http://127.0.0.1:${port}/ready`)
    } finally {
      await handle?.dispose()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  it('treats a complete self-redirecting locale response as ready instead of timing out', async () => {
    let redirectUrl = ''
    const server = createServer((_request, response) => {
      response.writeHead(307, {
        location: redirectUrl,
        'set-cookie': 'NEXT_LOCALE=en; Path=/; SameSite=lax',
      })
      response.end('redirecting')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    redirectUrl = `http://localhost:${port}/`
    const root = temporaryProject()
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { scripts: { dev: 'next dev' } })
    const proc = fakeProcess(4597)
    const dependencies: PreviewRuntimeDependencies = {
      spawn: () => proc,
      killProcessTree: () => {
        proc.emit('close', null)
      },
      randomId: ids('locale-loop-target', 'locale-loop-prepared'),
    }
    let handle: Awaited<ReturnType<typeof startPreview>> | undefined
    try {
      const [target] = discoverPreviewTargets(root, { dependencies })
      const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
      const starting = startPreview(prepared, { dependencies, startupTimeoutMs: 2_000 })
      proc.stdout.write(`Local: http://127.0.0.1:${port}/\n`)
      handle = await starting

      expect(handle.url).toBe(redirectUrl)
    } finally {
      await handle?.dispose()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  it('applies redirect canonicalization and stability checks to an explicit-port fallback', async () => {
    const root = temporaryProject()
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { scripts: { dev: 'vite --port 5188' } })
    const proc = fakeProcess(4596)
    const reachable = vi.fn(async () => 'http://localhost:5188/ready')
    const dependencies: PreviewRuntimeDependencies = {
      spawn: () => proc,
      killProcessTree: () => {
        proc.emit('close', null)
      },
      reachable,
      randomId: ids('fallback-target', 'fallback-prepared'),
    }
    const [target] = discoverPreviewTargets(root, { dependencies })
    const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
    const handle = await startPreview(prepared, { dependencies, startupTimeoutMs: 10 })

    expect(reachable).toHaveBeenCalledTimes(2)
    expect(handle.url).toBe('http://localhost:5188/ready')
    await handle.dispose()
  })

  it('retains bounded process diagnostics and reports an exit after readiness', async () => {
    const root = temporaryProject()
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { scripts: { dev: 'vite' } })
    const proc = fakeProcess(4646)
    const dependencies: PreviewRuntimeDependencies = {
      spawn: () => proc,
      killProcessTree: vi.fn(),
      reachable: async () => true,
      randomId: ids('exit-target', 'exit-prepared'),
    }
    const [target] = discoverPreviewTargets(root, { dependencies })
    const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
    const starting = startPreview(prepared, { dependencies, startupTimeoutMs: 2_000 })
    proc.stdout.write('http://127.0.0.1:5173/\n')
    const handle = await starting
    proc.stderr.write('fatal: preview crashed\n')
    proc.emit('close', 1)

    await expect(handle.waitForExit?.()).resolves.toMatchObject({
      message: expect.stringContaining('after reaching readiness (code 1)'),
      output: expect.stringContaining('fatal: preview crashed'),
    })
    expect(handle.running?.()).toBe(false)
    expect(handle.diagnosticOutput?.()).toContain('fatal: preview crashed')
    await handle.dispose()
  })

  it('uses npm-cli.js through Node on Windows without opening a shell', async () => {
    const root = temporaryProject()
    const bin = path.join(root, 'fake-bin')
    const npmCli = path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    mkdirSync(path.dirname(npmCli), { recursive: true })
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeFileSync(path.join(bin, 'npm.CMD'), '')
    writeFileSync(npmCli, '')
    writeJson(path.join(root, 'package.json'), { scripts: { dev: 'vite' } })
    const proc = fakeProcess(4343)
    const spawn = vi.fn(() => proc)
    const dependencies: PreviewRuntimeDependencies = {
      spawn,
      killProcessTree: vi.fn(),
      reachable: async (url) => url === 'http://127.0.0.1:5173/',
      platform: 'win32',
      env: {
        PATH: bin,
        PATHEXT: '.JS;.CMD',
        VITE_PUBLIC_FLAG: 'kept',
        PREVIEW_SECRET: 'must-not-reach-the-child',
        NODE_OPTIONS: '--require=secret-loader.js',
        npm_execpath: path.join(bin, 'untrusted-npm-cli.js'),
      },
      randomId: ids('windows-target', 'windows-prepared'),
    }
    const [target] = discoverPreviewTargets(root, { dependencies })
    const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
    const starting = startPreview(prepared, { dependencies, startupTimeoutMs: 1_000 })
    proc.stdout.write('http://127.0.0.1:5173/\n')
    const handle = await starting

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'run', 'dev', '--', '--host', '127.0.0.1'],
      expect.objectContaining({ shell: false, detached: false })
    )
    const spawnOptions = (spawn.mock.calls[0] as unknown as [unknown, unknown, { env: NodeJS.ProcessEnv }])[2]
    expect(spawnOptions.env).toMatchObject({
      PATH: bin,
      PATHEXT: '.CMD',
      VITE_PUBLIC_FLAG: 'kept',
      BROWSER: 'none',
      HOST: '127.0.0.1',
    })
    expect(spawnOptions.env).not.toHaveProperty('PREVIEW_SECRET')
    expect(spawnOptions.env).not.toHaveProperty('NODE_OPTIONS')
    expect(spawnOptions.env).not.toHaveProperty('npm_execpath')
    const disposing = handle.dispose()
    proc.emit('close', null)
    await disposing
  })

  it('waits for process-tree termination before resolving dispose', async () => {
    const root = temporaryProject()
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { scripts: { dev: 'vite' } })
    const proc = fakeProcess(6363)
    const kill = vi.fn<() => Promise<void>>()
    let release!: () => void
    kill.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    const dependencies: PreviewRuntimeDependencies = {
      spawn: () => proc,
      killProcessTree: kill,
      reachable: async (url) => url === 'http://127.0.0.1:5173/',
      randomId: ids('delayed-target', 'delayed-prepared'),
    }
    const [target] = discoverPreviewTargets(root, { dependencies })
    const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
    const starting = startPreview(prepared, { dependencies, startupTimeoutMs: 1_000 })
    proc.stdout.write('http://127.0.0.1:5173/\n')
    const handle = await starting

    let disposed = false
    const disposing = handle.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await Promise.resolve()
    expect(disposed).toBe(false)
    proc.emit('close', null)
    await disposing
    expect(disposed).toBe(true)
    expect(proc.listenerCount('close')).toBe(0)
    expect(proc.listenerCount('error')).toBe(0)
    expect(proc.stdout.listenerCount('data')).toBe(0)
    expect(proc.stderr.listenerCount('data')).toBe(0)
  })

  it('resolves pnpm/yarn .cmd shims through verified manager entrypoints on Windows', async () => {
    for (const [manager, entrypoint] of [
      ['pnpm', 'pnpm/bin/pnpm.cjs'],
      ['yarn', 'yarn/bin/yarn.js'],
    ] as const) {
      const root = temporaryProject()
      const bin = path.join(root, 'fake-bin')
      const managerEntrypoint = path.join(bin, 'node_modules', entrypoint)
      mkdirSync(path.dirname(managerEntrypoint), { recursive: true })
      writeFileSync(path.join(bin, `${manager}.CMD`), '')
      writeFileSync(managerEntrypoint, '')
      writeFileSync(path.join(root, manager === 'pnpm' ? 'pnpm-lock.yaml' : 'yarn.lock'), '')
      writeJson(path.join(root, 'package.json'), { scripts: { dev: 'vite' } })

      const proc = fakeProcess(manager === 'pnpm' ? 7171 : 7272)
      const spawn = vi.fn(() => proc)
      const dependencies: PreviewRuntimeDependencies = {
        spawn,
        killProcessTree: vi.fn(),
        reachable: async (url) => url === 'http://127.0.0.1:5173/',
        platform: 'win32',
        env: { PATH: bin, PATHEXT: '.CMD' },
        randomId: ids(`${manager}-target`, `${manager}-prepared`),
      }
      const [target] = discoverPreviewTargets(root, { dependencies })
      expect(target).toMatchObject({ packageManager: manager, script: 'dev' })
      const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
      const starting = startPreview(prepared, { dependencies, startupTimeoutMs: 1_000 })
      proc.stdout.write('http://127.0.0.1:5173/\n')
      const handle = await starting

      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        [managerEntrypoint, 'run', 'dev', '--', '--host', '127.0.0.1'],
        expect.objectContaining({ shell: false, detached: false })
      )
      const disposing = handle.dispose()
      proc.emit('close', null)
      await disposing
    }
  })

  it('keeps bun shell-free: accepts bun.exe and rejects bun.cmd without a known entrypoint', () => {
    const executableProject = temporaryProject()
    const executableBin = path.join(executableProject, 'fake-bin')
    mkdirSync(executableBin, { recursive: true })
    writeFileSync(path.join(executableBin, 'bun.EXE'), '')
    writeFileSync(path.join(executableProject, 'bun.lock'), '')
    writeJson(path.join(executableProject, 'package.json'), { scripts: { dev: 'vite' } })
    const executableTargets = discoverPreviewTargets(executableProject, {
      dependencies: { platform: 'win32', env: { PATH: executableBin, PATHEXT: '.EXE;.CMD' } },
    })
    expect(executableTargets).toHaveLength(1)
    expect(executableTargets[0]).toMatchObject({ packageManager: 'bun' })

    const shimOnlyProject = temporaryProject()
    const shimOnlyBin = path.join(shimOnlyProject, 'fake-bin')
    mkdirSync(shimOnlyBin, { recursive: true })
    writeFileSync(path.join(shimOnlyBin, 'bun.CMD'), '')
    writeFileSync(path.join(shimOnlyProject, 'bun.lock'), '')
    writeJson(path.join(shimOnlyProject, 'package.json'), { scripts: { dev: 'vite' } })
    expect(
      discoverPreviewTargets(shimOnlyProject, {
        dependencies: { platform: 'win32', env: { PATH: shimOnlyBin, PATHEXT: '.CMD' } },
      })
    ).toEqual([])
  })

  it('bounds startup output and tears down on timeout', async () => {
    const root = temporaryProject()
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { scripts: { preview: 'vite preview' } })
    const proc = fakeProcess(5151)
    const kill = vi.fn(() => {
      proc.emit('close', null)
    })
    const dependencies: PreviewRuntimeDependencies = {
      spawn: () => proc,
      killProcessTree: kill,
      reachable: async () => false,
      randomId: ids('timeout-target', 'timeout-prepared'),
    }
    const [target] = discoverPreviewTargets(root, { dependencies })
    const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
    const starting = startPreview(prepared, { dependencies, startupTimeoutMs: 10, maxOutputChars: 16 })
    proc.stderr.write(`BEGIN-${'x'.repeat(80)}-TAIL`)

    const error = await starting.catch((value: unknown) => value)
    expect(error).toBeInstanceOf(PreviewStartupError)
    expect(error).toMatchObject({ timedOut: true, aborted: false })
    expect((error as PreviewStartupError).output).toContain('-TAIL')
    expect((error as PreviewStartupError).output).not.toContain('BEGIN')
    expect(kill).toHaveBeenCalledWith(5151)
  })

  it('tears down and reports abort during startup', async () => {
    const root = temporaryProject()
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeJson(path.join(root, 'package.json'), { scripts: { dev: 'vite' } })
    const proc = fakeProcess(6161)
    const kill = vi.fn(() => {
      proc.emit('close', null)
    })
    const controller = new AbortController()
    const dependencies: PreviewRuntimeDependencies = {
      spawn: () => proc,
      killProcessTree: kill,
      reachable: async () => false,
      randomId: ids('abort-target', 'abort-prepared'),
    }
    const [target] = discoverPreviewTargets(root, { dependencies })
    const prepared = await preparePreview(root, { targetId: target.id }, { dependencies })
    const starting = startPreview(prepared, { dependencies, signal: controller.signal, startupTimeoutMs: 1_000 })
    controller.abort()

    await expect(starting).rejects.toMatchObject({ aborted: true, timedOut: false })
    expect(kill).toHaveBeenCalledWith(6161)
  })

  it('returns bounded redacted output and nested causes in startup diagnostics', () => {
    const root = temporaryProject()
    const error = new AggregateError(
      [
        new PreviewStartupError(
          `Preview failed in ${root}.`,
          `${'old-output\n'.repeat(600)}Authorization: Bearer secret-token-123\nVITE_API_KEY=super-secret-value\nTAIL`
        ),
        new Error('CDP attach failed'),
      ],
      'Visual bootstrap failed'
    )

    const diagnostic = previewStartupErrorMessage(error, root)
    expect(diagnostic).toContain('Visual bootstrap failed')
    expect(diagnostic).toContain('Preview failed in <workspace>.')
    expect(diagnostic).toContain('Process output (tail):')
    expect(diagnostic).toContain('CDP attach failed')
    expect(diagnostic).toContain('TAIL')
    expect(diagnostic).toContain('[diagnostic truncated]')
    expect(diagnostic).not.toContain(root)
    expect(diagnostic).not.toContain('secret-token-123')
    expect(diagnostic).not.toContain('super-secret-value')
    expect(diagnostic.length).toBeLessThanOrEqual(6_000)
  })
})
