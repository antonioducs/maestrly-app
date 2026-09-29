import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ClaudeCodeCompatibilityDependencies,
  validateClaudeCodeRuntime,
} from '../../src/main/runtime-assets/claude-code-compatibility'
import type { RuntimeAssetDefinition } from '../../src/main/runtime-assets/registry'

let tempRoot: string
beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-validate-test-'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(tempRoot, { recursive: true, force: true })
})

const INSTALLATION = '/managed/claude-code-runtime/versions/2.1.290-linux-arm64'

function definition(version = '2.1.290'): RuntimeAssetDefinition {
  return { id: 'claude-code-runtime', version, targets: {} }
}

type QueryFactory = NonNullable<ClaudeCodeCompatibilityDependencies['queryFactory']>
type QueryParams = Parameters<QueryFactory>[0]

/** Strict fakes: only `--version` and the three session methods the validator may use exist. */
function fakes(
  options: { version?: string; models?: readonly { value: string }[]; initialization?: () => Promise<unknown> } = {}
) {
  const execFile = vi.fn<NonNullable<ClaudeCodeCompatibilityDependencies['execFile']>>(async (file, args) => {
    expect(file).toBe(path.join(INSTALLATION, 'claude'))
    expect(args).toEqual(['--version'])
    return { stdout: `${options.version ?? '2.1.290'} (Claude Code)\n`, stderr: '' }
  })
  const close = vi.fn()
  const queries: QueryParams[] = []
  const queryFactory = vi.fn<QueryFactory>((params) => {
    queries.push(params)
    return {
      initializationResult: vi.fn(options.initialization ?? (async () => ({}))),
      supportedModels: vi.fn(async () => (options.models ?? [{ value: 'opus' }]) as never),
      close,
    } as unknown as ReturnType<QueryFactory>
  })
  return { execFile, queryFactory, close, queries }
}

async function tempEntries(): Promise<string[]> {
  return readdir(tempRoot)
}

describe('validateClaudeCodeRuntime', () => {
  it('accepts a release that reports its version and lists models without credentials', async () => {
    const { execFile, queryFactory, close, queries } = fakes()
    await expect(
      validateClaudeCodeRuntime(INSTALLATION, definition(), new AbortController().signal, {
        execFile,
        queryFactory,
        tempRoot,
      })
    ).resolves.toBeUndefined()
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(queryFactory).toHaveBeenCalledTimes(1)
    expect(queries[0].options).toMatchObject({
      pathToClaudeCodeExecutable: path.join(INSTALLATION, 'claude'),
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      mcpServers: {},
      permissionMode: 'dontAsk',
      persistSession: false,
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(await tempEntries()).toEqual([])
  })

  it('rejects a binary that reports another version before starting a session', async () => {
    const { execFile, queryFactory } = fakes({ version: '2.1.289' })
    await expect(
      validateClaudeCodeRuntime(INSTALLATION, definition(), new AbortController().signal, {
        execFile,
        queryFactory,
        tempRoot,
      })
    ).rejects.toThrow(/2\.1\.289/)
    expect(queryFactory).not.toHaveBeenCalled()
    expect(await tempEntries()).toEqual([])
  })

  it('rejects a release outside the supported major version', async () => {
    const { execFile, queryFactory } = fakes({ version: '3.0.0' })
    await expect(
      validateClaudeCodeRuntime(INSTALLATION, definition('3.0.0'), new AbortController().signal, {
        execFile,
        queryFactory,
        tempRoot,
      })
    ).rejects.toThrow(/incompatible/)
    expect(queryFactory).not.toHaveBeenCalled()
  })

  it('rejects a release that lists no model', async () => {
    const { execFile, queryFactory, close } = fakes({ models: [] })
    await expect(
      validateClaudeCodeRuntime(INSTALLATION, definition(), new AbortController().signal, {
        execFile,
        queryFactory,
        tempRoot,
      })
    ).rejects.toThrow(/no model/)
    expect(close).toHaveBeenCalledTimes(1)
    expect(await tempEntries()).toEqual([])
  })

  it('times out a handshake that never completes and closes the session', async () => {
    const { execFile, queryFactory, close } = fakes({ initialization: () => new Promise(() => undefined) })
    await expect(
      validateClaudeCodeRuntime(INSTALLATION, definition(), new AbortController().signal, {
        execFile,
        queryFactory,
        tempRoot,
        timeoutMs: 50,
      })
    ).rejects.toThrow(/timed out/)
    expect(close).toHaveBeenCalledTimes(1)
    expect(await tempEntries()).toEqual([])
  })

  it('propagates caller cancellation', async () => {
    const controller = new AbortController()
    const { execFile, queryFactory } = fakes({
      initialization: () => {
        controller.abort(new Error('stop'))
        return new Promise(() => undefined)
      },
    })
    await expect(
      validateClaudeCodeRuntime(INSTALLATION, definition(), controller.signal, { execFile, queryFactory, tempRoot })
    ).rejects.toThrow('stop')
  })

  it('never passes credentials of this process to the binary', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-synthetic')
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'synthetic-oauth-token')
    const { execFile, queryFactory, queries } = fakes()
    await validateClaudeCodeRuntime(INSTALLATION, definition(), new AbortController().signal, {
      execFile,
      queryFactory,
      tempRoot,
    })
    const environments = [execFile.mock.calls[0][2].env, queries[0].options?.env ?? {}]
    for (const env of environments) {
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
      expect(env.HOME?.startsWith(tempRoot)).toBe(true)
      expect(env.CLAUDE_CONFIG_DIR?.startsWith(tempRoot)).toBe(true)
      expect(env.DISABLE_AUTOUPDATER).toBe('1')
    }
  })
})
