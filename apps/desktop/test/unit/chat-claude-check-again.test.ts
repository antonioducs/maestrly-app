import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  /** Claude Code executables that exist; every other `claude` path is missing. */
  installed: new Set<string>(),
  whichBin: vi.fn((_bin: string): string | null => null),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const accessSync = (file: Parameters<typeof actual.accessSync>[0], mode?: number) => {
    if (!/^claude(\.exe|\.cmd|\.bat)?$/.test(path.basename(String(file)))) return actual.accessSync(file, mode)
    if (!fake.installed.has(String(file))) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
  }
  return { ...actual, default: { ...actual, accessSync }, accessSync }
})
vi.mock('../../src/main/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/platform')>()),
  whichBin: fake.whichBin,
}))
vi.mock('../../src/main/chat/model-meta', () => ({
  listCatalogProviderModelIds: vi.fn(async () => []),
}))
vi.mock('../../src/main/store', () => ({
  getAppSetting: vi.fn(() => null),
  setAppSetting: vi.fn(),
}))

import { clearClaudeCache, resolveClaude } from '../../src/main/chat/claude-agent-sdk/resolve-claude'
import {
  ClaudeSubscriptionManager,
  type ClaudeSubscriptionManagerDependencies,
} from '../../src/main/chat/claude-agent-sdk/manager'

const HOME = path.resolve('/home/claude-check-again')
/** Where the official installer puts Claude Code: `~/.local/bin`, `%USERPROFILE%\.local\bin` on Windows. */
const INSTALLED =
  process.platform === 'win32'
    ? path.win32.join(HOME, '.local', 'bin', 'claude.exe')
    : path.posix.join(HOME, '.local', 'bin', 'claude')
const PROFILE = path.join('/tmp/maestrly-check-again', 'claude-agent-sdk')

beforeEach(() => {
  vi.stubEnv('HOME', HOME)
  vi.stubEnv('USERPROFILE', HOME)
  fake.installed.clear()
  fake.whichBin.mockReset().mockReturnValue(null)
  clearClaudeCache()
})
afterEach(() => {
  vi.unstubAllEnvs()
  clearClaudeCache()
})

describe('Claude Code resolution', () => {
  it('never remembers the bare fallback, so Claude Code installed later is found', () => {
    expect(resolveClaude()).toBe('claude')
    expect(resolveClaude()).toBe('claude')
    // Each miss looks again instead of answering from a cache.
    expect(fake.whichBin).toHaveBeenCalledTimes(2)

    fake.installed.add(INSTALLED)
    expect(resolveClaude()).toBe(INSTALLED)
  })

  it('remembers an executable it found until the cache is cleared', () => {
    fake.installed.add(INSTALLED)
    expect(resolveClaude()).toBe(INSTALLED)
    fake.installed.delete(INSTALLED)
    expect(resolveClaude()).toBe(INSTALLED)

    clearClaudeCache()
    expect(resolveClaude()).toBe('claude')
  })

  it('remembers an absolute PATH lookup, never a relative answer', () => {
    fake.whichBin.mockReturnValue('claude')
    expect(resolveClaude()).toBe('claude')
    expect(resolveClaude()).toBe('claude')
    expect(fake.whichBin).toHaveBeenCalledTimes(2)

    const elsewhere = path.resolve('/opt/tools/claude')
    fake.whichBin.mockReturnValue(elsewhere)
    expect(resolveClaude()).toBe(elsewhere)
    expect(resolveClaude()).toBe(elsewhere)
    expect(fake.whichBin).toHaveBeenCalledTimes(3)
  })
})

function profileManager(
  profileFiles: Record<string, string>,
  options: { version?: string; overrides?: Partial<ClaudeSubscriptionManagerDependencies> } = {}
) {
  const files = new Map(Object.entries(profileFiles).map(([name, contents]) => [path.join(PROFILE, name), contents]))
  const spawned: string[] = []
  const dependencies: Partial<ClaudeSubscriptionManagerDependencies> = {
    getUserDataPath: () => path.dirname(PROFILE),
    getHomeDirectory: () => HOME,
    getProcessEnvironment: () => ({ PATH: '/usr/bin', HOME }),
    resolveExecutable: resolveClaude,
    forgetExecutable: clearClaudeCache,
    retainExecutable: () => null,
    ensureDirectory: vi.fn(async () => {}),
    readTextFile: vi.fn(async (file: string) => {
      const value = files.get(file)
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return value
    }),
    writePrivateFile: vi.fn(async () => {}),
    // Spawning a path that does not exist fails as the system would; a bare `claude` is not on PATH.
    runProcess: vi.fn(async (executable: string, args: string[]) => {
      spawned.push(executable)
      if (!fake.installed.has(executable))
        throw Object.assign(new Error(`spawn ${executable} ENOENT`), { code: 'ENOENT' })
      if (args[0] === '--version') {
        return { exitCode: 0, stdout: `${options.version ?? '2.1.285'} (Claude Code)`, stderr: '' }
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          email: 'owner@example.com',
          orgName: 'Owner',
          subscriptionType: 'max',
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
        }),
        stderr: '',
      }
    }),
    ...options.overrides,
  }
  return { manager: new ClaudeSubscriptionManager(dependencies), spawned }
}

const SIGNED_IN_PROFILE = {
  '.claude.json': JSON.stringify({ userID: 'selector', oauthAccount: { emailAddress: 'owner@example.com' } }),
  '.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'secret-access-token' } }),
}

describe('Claude subscription "Check again"', () => {
  it('reconnects the saved account once Claude Code is installed with the app open', async () => {
    const { manager, spawned } = profileManager(SIGNED_IN_PROFILE)

    const missing = await manager.status()
    expect(missing).toMatchObject({
      state: 'unavailable',
      authenticated: false,
      errorCode: 'claude-code-not-installed',
      savedSignIn: { email: 'owner@example.com' },
    })
    expect(JSON.stringify(missing)).not.toContain('secret-access-token')
    expect(spawned).toEqual(['claude'])

    fake.installed.add(INSTALLED)
    // Without a refresh the card keeps its answer; "Check again" asks for one.
    await expect(manager.status()).resolves.toMatchObject({ state: 'unavailable' })
    await expect(manager.status({ refresh: true })).resolves.toMatchObject({
      state: 'ready',
      authenticated: true,
      account: { email: 'owner@example.com', subscriptionType: 'max' },
      cliVersion: '2.1.285',
    })
    expect(spawned.slice(1)).toEqual([INSTALLED, INSTALLED])
  })

  it('looks again for the executable on a refresh, not on a cached read', async () => {
    const forgetExecutable = vi.fn()
    const { manager } = profileManager(SIGNED_IN_PROFILE, { overrides: { forgetExecutable } })

    await manager.status()
    await manager.status()
    expect(forgetExecutable).not.toHaveBeenCalled()
    await manager.status({ refresh: true })
    expect(forgetExecutable).toHaveBeenCalledTimes(1)
  })

  it('keeps word of the saved sign-in while Claude Code is too old', async () => {
    fake.installed.add(INSTALLED)
    const { manager } = profileManager(SIGNED_IN_PROFILE, { version: '2.1.100' })
    await expect(manager.status()).resolves.toMatchObject({
      state: 'unavailable',
      cliVersion: '2.1.100',
      errorCode: 'claude-code-incompatible',
      savedSignIn: { email: 'owner@example.com' },
    })
  })

  it('reports a saved sign-in from the credentials file alone, and none for a profile never signed in', async () => {
    const credentialsOnly = profileManager({ '.credentials.json': SIGNED_IN_PROFILE['.credentials.json'] })
    await expect(credentialsOnly.manager.status()).resolves.toMatchObject({ savedSignIn: { email: null } })

    const never = profileManager({ '.claude.json': JSON.stringify({ userID: 'selector' }) })
    const status = await never.manager.status()
    expect(status).toMatchObject({ state: 'unavailable', errorCode: 'claude-code-not-installed' })
    expect(status.savedSignIn).toBeUndefined()
  })
})
