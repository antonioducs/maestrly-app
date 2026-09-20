import { execFile } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
import { ghCommandEnv, runGhCommand } from '../../src/main/gh-command'

const mockedExecFile = vi.mocked(execFile)
beforeEach(() => mockedExecFile.mockReset())

describe('gh command runner', () => {
  it('scrubs tokens and uses execFile with timeout, buffer and AbortSignal', async () => {
    const signal = new AbortController().signal
    mockedExecFile.mockImplementationOnce(((
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (...args: unknown[]) => void
    ) => {
      callback(null, 'ok\n', '')
      return {} as never
    }) as never)
    await expect(runGhCommand('/repo', ['repo', 'view'], { signal, timeoutMs: 123, maxBuffer: 456 })).resolves.toBe(
      'ok\n'
    )
    const options = mockedExecFile.mock.calls[0][2] as { env: NodeJS.ProcessEnv; [key: string]: unknown }
    expect(mockedExecFile.mock.calls[0].slice(0, 2)).toEqual(['gh', ['repo', 'view']])
    expect(options).toMatchObject({ cwd: '/repo', timeout: 123, maxBuffer: 456, signal })
    expect(options.env.GH_TOKEN).toBeUndefined()
    expect(options.env.GITHUB_TOKEN).toBeUndefined()
  })

  it('returns useful typed errors with captured output', async () => {
    mockedExecFile.mockImplementationOnce(((
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (...args: unknown[]) => void
    ) => {
      callback(Object.assign(new Error('spawn failed'), { code: 'ENOENT' }), 'partial', 'gh missing')
      return {} as never
    }) as never)
    await expect(runGhCommand('/repo', ['auth', 'status'])).rejects.toMatchObject({
      name: 'GhCommandError',
      kind: 'no-gh',
      stdout: 'partial',
      stderr: 'gh missing',
      exitCode: 'ENOENT',
    })
  })

  it('names an authentication failure on any subcommand and keeps the output of a status exit', async () => {
    // `gh` reports an authentication problem with exit status 4 whichever subcommand hit it.
    mockedExecFile.mockImplementationOnce(((
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (...args: unknown[]) => void
    ) => {
      callback(Object.assign(new Error('failed'), { code: 4 }), '', 'gh auth login required')
      return {} as never
    }) as never)
    await expect(runGhCommand('/repo', ['pr', 'checks', '7'])).rejects.toMatchObject({
      kind: 'not-logged-in',
      exitCode: 4,
    })

    // A command that answered while exiting non-zero keeps its stdout, so the caller can interpret it
    // instead of reading the failure as "there was nothing to report".
    mockedExecFile.mockImplementationOnce(((
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (...args: unknown[]) => void
    ) => {
      callback(Object.assign(new Error('failed'), { code: 8 }), '[{"bucket":"pending"}]', 'still pending')
      return {} as never
    }) as never)
    await expect(runGhCommand('/repo', ['pr', 'checks', '7'])).rejects.toMatchObject({
      kind: 'failed',
      exitCode: 8,
      stdout: '[{"bucket":"pending"}]',
    })
  })

  it('does not mutate the source environment', () => {
    const source = { GH_TOKEN: 'a', GITHUB_TOKEN: 'b', PATH: '/bin' }
    expect(ghCommandEnv(source)).toEqual({ PATH: '/bin', LC_ALL: 'C', LANG: 'C' })
    expect(source.GH_TOKEN).toBe('a')
  })
})
