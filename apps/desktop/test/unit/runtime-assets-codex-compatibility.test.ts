import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexAppServerClient, CodexAppServerConnectOptions } from '../../src/main/chat/codex-subscription/client'
import {
  CodexCompatibilityError,
  validateCodexRuntime,
  type CodexExecFile,
} from '../../src/main/runtime-assets/codex-compatibility'
import {
  CODEX_TARGET_LAYOUT,
  createCodexTarget,
  hostRuntimeTarget,
  type RuntimeAssetDefinition,
  type RuntimeTargetId,
} from '../../src/main/runtime-assets/registry'

const TARGET: RuntimeTargetId = 'linux-x64'
let root: string
let installation: string
let tempRoot: string

function definition(version = '1.2.3', target: RuntimeTargetId = TARGET): RuntimeAssetDefinition {
  return {
    id: 'codex-runtime',
    version,
    targets: {
      [target]: createCodexTarget(target, version, {
        sha512Base64: `${'A'.repeat(86)}==`,
        downloadBytes: 1,
        maxDownloadBytes: 1,
        unpackedBytes: 1,
      }),
    },
  }
}

async function writeManifest(version = '1.2.3', overrides: Record<string, unknown> = {}): Promise<void> {
  await mkdir(path.join(installation, 'bin'), { recursive: true })
  await writeFile(
    path.join(installation, 'codex-package.json'),
    JSON.stringify({
      layoutVersion: 1,
      version,
      target: CODEX_TARGET_LAYOUT[TARGET].triple,
      variant: 'codex',
      entrypoint: 'bin/codex',
      ...overrides,
    })
  )
}

const bundledCatalog = JSON.stringify({
  models: [
    { slug: 'gpt-test', multi_agent_version: 'v2', context_window: 1000 },
    { slug: 'gpt-legacy', multi_agent_version: null },
  ],
})

function execFixture(overrides: Partial<Record<string, string | Error>> = {}): ReturnType<typeof vi.fn<CodexExecFile>> {
  return vi.fn<CodexExecFile>(async (_file, args) => {
    const key = args[0] === '--version' ? 'version' : args[1] === 'models' ? 'models' : 'prompt'
    const value = overrides[key] ?? { version: 'codex-cli 1.2.3', models: bundledCatalog, prompt: '[]' }[key]
    if (value instanceof Error) throw value
    return { stdout: value ?? '', stderr: '' }
  })
}

function fakeClient(responses: { models?: unknown; thread?: unknown } = {}) {
  const close = vi.fn(async () => undefined)
  const client = {
    request: vi.fn(
      async (_method: string, _params?: unknown, _options?: unknown) =>
        responses.models ?? { data: [{ id: 'gpt-test' }], nextCursor: null }
    ),
    startThread: vi.fn(
      async (_params: unknown, _options?: unknown) => responses.thread ?? { thread: { id: 'thread-1' } }
    ),
    deleteThread: vi.fn(async (_params: unknown, _options?: unknown) => ({})),
    close,
  }
  return client as typeof client & CodexAppServerClient
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codex-compat-'))
  installation = path.join(root, 'install')
  tempRoot = path.join(root, 'tmp')
  await mkdir(tempRoot, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('validateCodexRuntime', () => {
  it('passes the production contract with an isolated profile and cleans it up', async () => {
    await writeManifest()
    const exec = execFixture()
    const client = fakeClient()
    let connectOptions: CodexAppServerConnectOptions | undefined
    await validateCodexRuntime(installation, definition(), new AbortController().signal, {
      target: TARGET,
      execFile: exec,
      connect: async (options) => {
        connectOptions = options
        return client
      },
      tempRoot,
    })

    const binary = path.join(installation, 'bin', 'codex')
    expect(exec.mock.calls.map(([file, args]) => [file, args.slice(0, 2)])).toEqual([
      [binary, ['--version']],
      [binary, ['debug', 'models']],
      [binary, ['debug', 'prompt-input']],
    ])
    const promptArgs = exec.mock.calls[2][1]
    expect(promptArgs).toContain('model=gpt-test')
    expect(promptArgs.some((arg) => arg.startsWith('model_catalog_json='))).toBe(true)
    const env = exec.mock.calls[0][2].env
    expect(env.CODEX_HOME).toContain(path.join(tempRoot, 'maestrly-codex-validate-'))
    expect(Object.keys(env).some((name) => /^(OPENAI_|AZURE_OPENAI_)/i.test(name))).toBe(false)

    expect(connectOptions?.binaryArgs?.slice(0, 5)).toEqual([
      'app-server',
      '--disable',
      'multi_agent',
      '--disable',
      'multi_agent_v2',
    ])
    expect(connectOptions?.binaryArgs?.at(-1)).toMatch(/^model_catalog_json=.*maestrly-model-catalog\.json$/)
    expect(connectOptions?.unsetEnvPrefixes).toEqual(['CODEX_', 'OPENAI_', 'AZURE_OPENAI_'])
    expect(client.request).toHaveBeenCalledWith('model/list', { limit: 100, includeHidden: false }, expect.anything())
    expect(client.startThread.mock.calls[0][0]).toMatchObject({
      ephemeral: true,
      dynamicTools: [{ type: 'namespace', tools: [{ deferLoading: true }] }],
    })
    expect(client.deleteThread).toHaveBeenCalledWith({ threadId: 'thread-1' }, expect.anything())
    expect(client.close).toHaveBeenCalled()
    expect(await readdir(tempRoot)).toEqual([])
  })

  it.each([
    ['version', { version: '9.9.9' }],
    ['target', { target: 'other-triple' }],
    ['entrypoint', { entrypoint: 'bin/other' }],
    ['layout', { layoutVersion: 2 }],
  ])('rejects a native manifest with a divergent %s', async (_name, overrides) => {
    await writeManifest('1.2.3', overrides)
    const exec = execFixture()
    await expect(
      validateCodexRuntime(installation, definition(), new AbortController().signal, {
        target: TARGET,
        execFile: exec,
        connect: async () => fakeClient(),
        tempRoot,
      })
    ).rejects.toThrow(/Native manifest/)
    expect(exec).not.toHaveBeenCalled()
  })

  it('rejects an executable that reports another version', async () => {
    await writeManifest()
    await expect(
      validateCodexRuntime(installation, definition(), new AbortController().signal, {
        target: TARGET,
        execFile: execFixture({ version: 'codex-cli 1.2.4' }),
        connect: async () => fakeClient(),
        tempRoot,
      })
    ).rejects.toThrow(/reports "codex-cli 1.2.4"/)
    expect(await readdir(tempRoot)).toEqual([])
  })

  it('rejects a catalog that still exposes native sub-agent tools', async () => {
    await writeManifest()
    await expect(
      validateCodexRuntime(installation, definition(), new AbortController().signal, {
        target: TARGET,
        execFile: execFixture({ prompt: '[{"name":"spawn_agent"}]' }),
        connect: async () => fakeClient(),
        tempRoot,
      })
    ).rejects.toThrow(/spawn_agent/)
  })

  it('rejects an empty bundled catalog', async () => {
    await writeManifest()
    await expect(
      validateCodexRuntime(installation, definition(), new AbortController().signal, {
        target: TARGET,
        execFile: execFixture({ models: '{"models":[]}' }),
        connect: async () => fakeClient(),
        tempRoot,
      })
    ).rejects.toThrow(/catalog/i)
  })

  it.each([
    ['model/list', { models: { data: 'invalid' } }, /model\/list/],
    ['thread/start', { thread: { thread: {} } }, /thread id/],
  ])('rejects incompatible %s responses and closes the app-server', async (_name, responses, pattern) => {
    await writeManifest()
    const client = fakeClient(responses)
    await expect(
      validateCodexRuntime(installation, definition(), new AbortController().signal, {
        target: TARGET,
        execFile: execFixture(),
        connect: async () => client,
        tempRoot,
      })
    ).rejects.toThrow(pattern)
    expect(client.close).toHaveBeenCalled()
    expect(await readdir(tempRoot)).toEqual([])
  })

  it('rejects an app-server that fails its handshake', async () => {
    await writeManifest()
    await expect(
      validateCodexRuntime(installation, definition(), new AbortController().signal, {
        target: TARGET,
        execFile: execFixture(),
        connect: async () => {
          throw new Error('exited with code 1')
        },
        tempRoot,
      })
    ).rejects.toThrow(/App-server handshake failed: exited with code 1/)
  })

  it('bounds the duration of a hung executable', async () => {
    await writeManifest()
    const hung: CodexExecFile = (_file, _args, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      )
    await expect(
      validateCodexRuntime(installation, definition(), new AbortController().signal, {
        target: TARGET,
        execFile: hung,
        connect: async () => fakeClient(),
        tempRoot,
        timeoutMs: 30,
      })
    ).rejects.toThrow(/timed out/)
    expect(await readdir(tempRoot)).toEqual([])
  })

  it('propagates cancellation and removes the temporary profile', async () => {
    await writeManifest()
    const controller = new AbortController()
    const exec = vi.fn<CodexExecFile>(async (_file, _args, options) => {
      controller.abort(new Error('user cancelled'))
      throw options.signal.reason
    })
    await expect(
      validateCodexRuntime(installation, definition(), controller.signal, {
        target: TARGET,
        execFile: exec,
        connect: async () => fakeClient(),
        tempRoot,
      })
    ).rejects.toThrow('user cancelled')
    expect(await readdir(tempRoot)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects synthetic executables that cannot start or misreport', async () => {
    await writeManifest()
    const binary = path.join(installation, 'bin', 'codex')
    await writeFile(binary, '#!/bin/sh\necho "codex-cli 0.0.1"\n')
    // Not executable: spawn fails before the version check can pass.
    await expect(
      validateCodexRuntime(installation, definition(), new AbortController().signal, { target: TARGET, tempRoot })
    ).rejects.toBeInstanceOf(CodexCompatibilityError)

    await chmod(binary, 0o755)
    await expect(
      validateCodexRuntime(installation, definition(), new AbortController().signal, { target: TARGET, tempRoot })
    ).rejects.toThrow(/reports "codex-cli 0.0.1"/)
    expect(await readdir(tempRoot)).toEqual([])
  })
})

/** Official artifact installed by the @openai/codex optionalDependency; no credentials or model turns. */
const officialRuntime = (() => {
  try {
    const target = hostRuntimeTarget()
    const packageName = `@openai/codex-${CODEX_TARGET_LAYOUT[target].suffix}`
    const packageJson = createRequire(import.meta.url).resolve(`${packageName}/package.json`)
    const vendor = path.join(path.dirname(packageJson), 'vendor', CODEX_TARGET_LAYOUT[target].triple)
    const manifest = JSON.parse(readFileSync(path.join(vendor, 'codex-package.json'), 'utf8')) as { version: string }
    return existsSync(vendor) ? { target, vendor, version: manifest.version } : null
  } catch {
    return null
  }
})()

describe.skipIf(!officialRuntime)('validateCodexRuntime with the official runtime', () => {
  it('accepts the installed official Codex release', async () => {
    const runtime = officialRuntime!
    await validateCodexRuntime(
      runtime.vendor,
      definition(runtime.version, runtime.target),
      new AbortController().signal,
      {
        target: runtime.target,
        tempRoot,
      }
    )
    expect(await readdir(tempRoot)).toEqual([])
  }, 120_000)
})
