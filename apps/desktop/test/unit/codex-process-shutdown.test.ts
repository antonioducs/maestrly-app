import * as childProcess from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServerClient } from '../../src/main/chat/codex-subscription/client'

import { CodexProcessTree } from '../../src/main/chat/codex-subscription/process-tree'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
}))

const fixture = path.resolve('test/fixtures/codex-process-shutdown/app-server.mjs')

describe.skipIf(process.platform === 'win32')('Codex owned process group shutdown', () => {
  it.each(['eof', 'stubborn', 'exit', 'closed-pipes', 'abort'])('stops descendant writes after %s', async (mode) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-tree-'))
    const heartbeat = path.join(directory, 'heartbeat')
    const client = await CodexAppServerClient.connect({
      binaryPath: process.execPath,
      binaryArgs: [fixture, heartbeat, mode],
      clientInfo: { name: 'tree-test', title: null, version: '1' },
    })
    const pids = await client.request<{ root: number; worker: number }>('test/pids')
    const unrelated = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      if (mode === 'exit' || mode === 'closed-pipes') {
        void client.request('test/exit').catch(() => {})
        await delay(100)
      }
      if (mode === 'abort') client.abort()
      const started = Date.now()
      await Promise.all([client.close({ gracePeriodMs: 50 }), client.close({ gracePeriodMs: 50 })])
      expect(Date.now() - started).toBeLessThan(2000)
      const stopped = await readFile(heartbeat, 'utf8')
      await delay(80)
      expect(await readFile(heartbeat, 'utf8')).toBe(stopped)
      try {
        const status = childProcess
          .execFileSync('ps', ['-o', 'stat=', '-p', String(pids.worker)], { encoding: 'utf8' })
          .trim()
        expect(status).toMatch(/^Z/)
      } catch (error) {
        if ((error as { status?: number }).status !== 1) throw error
      }
      expect(client.state).toBe('closed')
      expect(unrelated.exitCode).toBeNull()
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
      await rm(directory, { recursive: true })
      await client.close()
    } finally {
      unrelated.kill('SIGKILL')
      for (const pid of client.state === 'closed' ? [] : [pids.worker, pids.root]) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* Already exited. */
        }
      }
      await client.close({ gracePeriodMs: 0 })
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('Windows Codex shutdown targeting', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([true, false])('waits for delayed root exit without hiding a live root: %s', async (exits) => {
    vi.useFakeTimers()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const child = new childProcess.ChildProcess()
    Object.defineProperty(child, 'pid', { value: 12345 })
    const error = new Error('taskkill failed')
    vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
      const complete = args.at(-1) as (error: Error, stdout: string, stderr: string) => void
      complete(error, '', 'Reason: There is no running instance of the task.')
      return new childProcess.ChildProcess()
    })
    const tree = new CodexProcessTree(child as childProcess.ChildProcessWithoutNullStreams)
    let finished = false
    const stopping = tree.stop(50)
    const outcome = stopping.then(
      () => {
        finished = true
        return null
      },
      (failure) => {
        finished = true
        return failure
      }
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(finished).toBe(false)
    if (exits) child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await outcome).toBe(exits ? null : error)
    expect(child.listenerCount('exit')).toBe(exits ? 0 : 1)
    expect(childProcess.execFile).toHaveBeenCalledTimes(1)
  })

  it('awaits taskkill for only the live root tree before sending EOF', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const child = new childProcess.ChildProcess()
    Object.defineProperty(child, 'pid', { value: 12345 })
    let complete!: (error: Error | null) => void
    const kill = vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
      complete = args.at(-1) as typeof complete
      return new childProcess.ChildProcess()
    })
    const tree = new CodexProcessTree(child as childProcess.ChildProcessWithoutNullStreams)
    let finished = false
    const stopping = tree.stop(50).then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(kill).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '12345', '/T', '/F'],
      {
        windowsHide: true,
        timeout: 5_000,
      },
      expect.any(Function)
    )
    complete(null)
    await stopping
    expect(finished).toBe(true)
  })

  it.each([
    ['Reason: There is no running instance of the task.', true],
    ['Reason: Access is denied.', false],
  ] as const)('validates taskkill failure after root exit: %s', async (stderr, alreadyExited) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const child = new childProcess.ChildProcess()
    Object.defineProperty(child, 'pid', { value: 12345 })
    let complete!: (error: Error, stdout: string, stderr: string) => void
    vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
      complete = args.at(-1) as typeof complete
      return new childProcess.ChildProcess()
    })
    const stopping = new CodexProcessTree(child as childProcess.ChildProcessWithoutNullStreams).stop(50)
    child.emit('exit', 0, null)
    const error = new Error('taskkill failed')
    complete(error, '', stderr)
    if (alreadyExited) await expect(stopping).resolves.toBeUndefined()
    else await expect(stopping).rejects.toBe(error)
  })

  it('does not target a stale Windows PID after root exit', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const child = new childProcess.ChildProcess()
    Object.defineProperty(child, 'pid', { value: 12345 })
    const kill = vi.spyOn(childProcess, 'execFile')
    const tree = new CodexProcessTree(child as childProcess.ChildProcessWithoutNullStreams)
    child.emit('exit', 0, null)
    await tree.stop(0)
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('POSIX termination inspection', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['zombie', '12345 Z\n999 S\n', true],
    ['absent', '999 S\n', true],
    ['live', '12345 S\n', false],
  ] as const)('handles a permission error for a %s group without targeting unrelated processes', async (_name, output, terminated) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const child = new childProcess.ChildProcess()
    Object.defineProperty(child, 'pid', { value: 12345 })
    Object.defineProperty(child, 'stdin', { value: { destroyed: true } })
    const error = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error
    })
    vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void
      callback(null, output)
      return new childProcess.ChildProcess()
    })
    const stopping = new CodexProcessTree(child as childProcess.ChildProcessWithoutNullStreams).stop(0)
    if (terminated) await expect(stopping).resolves.toBeUndefined()
    else await expect(stopping).rejects.toBe(error)
    expect(signal.mock.calls).toEqual([[-12345, 0]])
  })
})
