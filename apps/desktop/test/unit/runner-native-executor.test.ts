import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunnerExecutorJob, RunnerExecutorUsage } from '../../src/main/runner/executor'
import { NativeExecutor } from '../../src/main/runner/native-executor'
import { cleanTempDirs, JOB_ID, tempDir } from '../helpers/runner-core'

afterEach(cleanTempDirs)

const suite = process.platform === 'win32' ? describe.skip : describe
const INJECTED_PATH = '/injected/bin:/usr/bin:/bin'

function setup(
  overrides: Partial<RunnerExecutorJob> = {},
  options: ConstructorParameters<typeof NativeExecutor>[0] = {}
) {
  const workDir = path.join(tempDir(), 'work')
  mkdirSync(workDir)
  const output: Buffer[] = []
  const controller = new AbortController()
  const executor = new NativeExecutor({ loginPath: async () => INJECTED_PATH, killGraceMs: 200, ...options })
  const job: RunnerExecutorJob = {
    jobId: JOB_ID,
    serverId: 'server-1',
    botId: 'bot_1',
    scope: 'scope',
    folder: '/home/bot/project',
    workDir,
    command: 'true',
    env: {},
    caches: [],
    timeoutMs: 30_000,
    onOutput: (chunk) => output.push(chunk),
    signal: controller.signal,
    ...overrides,
  }
  return { executor, job, workDir, controller, text: () => Buffer.concat(output).toString() }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const readPid = (file: string): number => Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
/** Whether a process runs: one that ended and waits to be collected does not. */
function isRunning(pid: number): boolean {
  if (!alive(pid)) return false
  try {
    const state =
      process.platform === 'linux'
        ? /\) (\S)/.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1]
        : execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()[0]
    return state !== 'Z'
  } catch {
    return false
  }
}
const waitForPid = async (file: string): Promise<number> => {
  await vi.waitFor(() => expect(readPid(file)).toBeGreaterThan(0), { timeout: 5_000 })
  return readPid(file)
}

/** Starts `sleep 60` in a session of its own, which no process group signal reaches, and writes its pid. */
const START_SESSION = `
const { spawn } = require('node:child_process')
const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
require('node:fs').writeFileSync('parent.pid', String(process.pid))
require('node:fs').writeFileSync('grandchild.pid', String(child.pid))
child.unref()
`
/** The same, then stays: the sleeper's parent is alive. */
const START_SESSION_AND_STAY = `${START_SESSION}\nsetInterval(() => {}, 1000)\n`
const node = (script: string): string => `${JSON.stringify(process.execPath)} ${script}`

suite('native executor', () => {
  it('runs the command in the job folder and forwards stdout and stderr', async () => {
    const { executor, job, workDir, text } = setup({ command: 'pwd; echo out; echo err >&2' })
    const result = await executor.run(job)
    expect(result).toEqual({ exitCode: 0, timedOut: false, cancelled: false })
    expect(text()).toContain(`${workDir}\n`)
    expect(text()).toContain('out\n')
    expect(text()).toContain('err\n')
  })

  it('answers the exit code of the command', async () => {
    const { executor, job } = setup({ command: 'exit 7' })
    expect(await executor.run(job)).toEqual({ exitCode: 7, timedOut: false, cancelled: false })
  })

  it('reports no exit code for a command a signal ended', async () => {
    const { executor, job } = setup({ command: 'kill -9 $$' })
    expect(await executor.run(job)).toEqual({ exitCode: null, timedOut: false, cancelled: false })
  })

  describe('environment', () => {
    it('is built from scratch: nothing of the app reaches the job', async () => {
      process.env.MAESTRLY_SECRET_TEST = 'app secret'
      process.env.OPENAI_API_KEY = 'sk-should-not-leak'
      try {
        const { executor, job, workDir, text } = setup({ command: 'env', env: { FROM_JOB: 'yes' } })
        await executor.run(job)
        const env = new Map(
          text()
            .split('\n')
            .filter((line) => line.includes('='))
            .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
        )
        expect(env.has('MAESTRLY_SECRET_TEST')).toBe(false)
        expect(env.has('OPENAI_API_KEY')).toBe(false)
        expect(text()).not.toContain('app secret')
        expect(env.get('PATH')).toBe(INJECTED_PATH)
        expect(env.get('HOME')).toBeTruthy()
        expect(env.get('LANG')).toBeTruthy()
        expect(env.get('TMPDIR')).toBe(path.join(workDir, '.tmp'))
        expect(env.get('MAESTRLY_JOB_ID')).toBe(JOB_ID)
        expect(env.get('MAESTRLY_JOB_DIR')).toBe(workDir)
        expect(env.get('FROM_JOB')).toBe('yes')
        // Only these, and what the shell itself sets.
        const allowed = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR', 'MAESTRLY_JOB_ID', 'MAESTRLY_JOB_DIR', 'FROM_JOB'])
        const shell = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])
        expect([...env.keys()].filter((name) => !allowed.has(name) && !shell.has(name))).toEqual([])
        expect(existsSync(path.join(workDir, '.tmp'))).toBe(true)
      } finally {
        delete process.env.MAESTRLY_SECRET_TEST
        delete process.env.OPENAI_API_KEY
      }
    })

    it("lets the job's own variables override the runner's", async () => {
      const { executor, job, text } = setup({
        command: 'echo "$PATH|$LANG"',
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      })
      await executor.run(job)
      expect(text()).toBe('/usr/bin:/bin|C\n')
    })

    it('runs at niceness 10', async () => {
      const { executor, job, text } = setup({ command: 'ps -o ni= -p $$ 2>/dev/null || true' })
      await executor.run(job)
      if (text().trim()) expect(text().trim()).toBe('10')
    })
  })

  describe('stopping', () => {
    it('stops a command that outlives its timeout, with its whole process group', async () => {
      const { executor, job, workDir } = setup({
        command: 'sleep 60 & echo $! > child.pid; (sleep 60 & echo $! > grandchild.pid; wait) & wait',
        timeoutMs: 400,
      })
      const started = Date.now()
      const result = await executor.run(job)
      expect(result.timedOut).toBe(true)
      expect(result.cancelled).toBe(false)
      expect(Date.now() - started).toBeLessThan(10_000)
      for (const name of ['child.pid', 'grandchild.pid']) {
        const pid = readPid(path.join(workDir, name))
        await vi.waitFor(() => expect(alive(pid)).toBe(false))
      }
    })

    it('kills with SIGKILL a command that ignores SIGTERM, after the grace', async () => {
      const { executor, job, workDir } = setup({
        command: "trap '' TERM; (trap '' TERM; sleep 60) & echo $! > stubborn.pid; while :; do sleep 1; done",
        timeoutMs: 300,
      })
      const started = Date.now()
      const result = await executor.run(job)
      expect(result.timedOut).toBe(true)
      expect(Date.now() - started).toBeGreaterThanOrEqual(400)
      await vi.waitFor(() => expect(alive(readPid(path.join(workDir, 'stubborn.pid')))).toBe(false))
    })

    it('stops on cancel and says so', async () => {
      const { executor, job, controller, workDir } = setup({
        command: 'echo started; sleep 60 & echo $! > child.pid; wait',
      })
      const running = executor.run(job)
      await vi.waitFor(() => expect(existsSync(path.join(workDir, 'child.pid'))).toBe(true))
      controller.abort()
      const result = await running
      expect(result.cancelled).toBe(true)
      expect(result.timedOut).toBe(false)
      await vi.waitFor(() => expect(alive(readPid(path.join(workDir, 'child.pid')))).toBe(false))
    })

    it('does not start a command for a job that was cancelled already', async () => {
      const { executor, job, controller, workDir } = setup({ command: 'touch ran' })
      controller.abort()
      expect(await executor.run(job)).toEqual({ exitCode: null, timedOut: false, cancelled: true })
      expect(existsSync(path.join(workDir, 'ran'))).toBe(false)
    })

    describe('a process that left the command’s group and session', () => {
      const withScript = (command: string, script: string, overrides: Partial<RunnerExecutorJob> = {}) => {
        const prepared = setup({ command, ...overrides })
        writeFileSync(path.join(prepared.workDir, 'session.js'), script)
        return { ...prepared, pidFile: path.join(prepared.workDir, 'grandchild.pid') }
      }

      it('is stopped with the command on cancel', async () => {
        const { executor, job, controller, pidFile } = withScript(node('session.js'), START_SESSION_AND_STAY)
        const running = executor.run(job)
        const pid = await waitForPid(pidFile)
        expect(isRunning(pid)).toBe(true)
        controller.abort()
        const result = await running
        expect(result.cancelled).toBe(true)
        expect(isRunning(pid)).toBe(false)
      })

      it('is stopped with the command on timeout', async () => {
        const { executor, job, pidFile } = withScript(node('session.js'), START_SESSION_AND_STAY, { timeoutMs: 2_500 })
        const result = await executor.run(job)
        expect(result.timedOut).toBe(true)
        expect(isRunning(await waitForPid(pidFile))).toBe(false)
      })

      it('is killed with SIGKILL when it ignores SIGTERM, after the grace', async () => {
        const stubborn = `${START_SESSION_AND_STAY.replace("spawn('sleep', ['60']", "spawn('/bin/sh', ['-c', \"trap '' TERM; sleep 60\"]")}`
        const { executor, job, controller, pidFile } = withScript(node('session.js'), stubborn)
        const running = executor.run(job)
        const pid = await waitForPid(pidFile)
        controller.abort()
        await running
        expect(isRunning(pid)).toBe(false)
      })

      // Linux finds a daemon that was handed to init by the variable in its environment; macOS has none to look at.
      const linux = process.platform === 'linux' ? it : it.skip

      linux('is stopped on cancel, though its parent is gone and init holds it', async () => {
        const { executor, job, controller, pidFile, workDir } = withScript(
          `${node('session.js')}; sleep 60`,
          START_SESSION
        )
        const running = executor.run(job)
        const pid = await waitForPid(pidFile)
        // The first sample after this is the one that has to find it.
        const parent = await waitForPid(path.join(workDir, 'parent.pid'))
        await vi.waitFor(() => expect(isRunning(parent)).toBe(false))
        controller.abort()
        await running
        expect(isRunning(pid)).toBe(false)
      })

      linux('is stopped on timeout, though its parent is gone and init holds it', async () => {
        const { executor, job, pidFile } = withScript(`${node('session.js')}; sleep 60`, START_SESSION, {
          timeoutMs: 2_500,
        })
        const result = await executor.run(job)
        expect(result.timedOut).toBe(true)
        expect(isRunning(await waitForPid(pidFile))).toBe(false)
      })

      linux('is killed when the command ends, and the run waits until it is gone', async () => {
        const { executor, job, pidFile } = withScript(node('session.js'), START_SESSION)
        const started = Date.now()
        const result = await executor.run(job)
        expect(result.exitCode).toBe(0)
        expect(Date.now() - started).toBeLessThan(8_000)
        expect(isRunning(await waitForPid(pidFile))).toBe(false)
      })

      it('is killed when the command ends while the parent that started it still runs', async () => {
        const { executor, job, pidFile } = withScript(
          `${node('session.js')} & while [ ! -s grandchild.pid ]; do sleep 0.05; done`,
          START_SESSION_AND_STAY
        )
        const result = await executor.run(job)
        expect(result.exitCode).toBe(0)
        expect(isRunning(await waitForPid(pidFile))).toBe(false)
      })
    })

    it('kills what the command left running when it ends', async () => {
      const { executor, job, workDir } = setup({ command: 'sleep 60 & echo $! > leftover.pid' })
      const started = Date.now()
      const result = await executor.run(job)
      expect(result.exitCode).toBe(0)
      expect(Date.now() - started).toBeLessThan(5_000)
      await vi.waitFor(() => expect(alive(readPid(path.join(workDir, 'leftover.pid')))).toBe(false))
    })
  })

  describe('usage', () => {
    // A busy command that holds some memory for a few seconds.
    const BUSY = `
const held = Buffer.alloc(60 * 1024 * 1024, 1)
const end = Date.now() + 2400
while (Date.now() < end) Math.sqrt(Math.random())
process.stdout.write(String(held.length))
`
    it('reports what the command uses while it runs', async () => {
      const usages: RunnerExecutorUsage[] = []
      const { executor, job, workDir } = setup({
        command: node('busy.js'),
        onUsage: (usage) => usages.push(usage),
      })
      writeFileSync(path.join(workDir, 'busy.js'), BUSY)
      expect((await executor.run(job)).exitCode).toBe(0)
      expect(usages.length).toBeGreaterThanOrEqual(1)
      // Reports come at most every two seconds or so.
      expect(usages.length).toBeLessThanOrEqual(3)
      const busy = usages.find((usage) => usage.cpuPercent > 5)
      expect(busy).toBeDefined()
      for (const usage of usages) {
        expect(usage.processes).toBeGreaterThanOrEqual(1)
        expect(usage.memoryBytes).toBeGreaterThan(0)
        expect(usage.cpuPercent).toBeGreaterThanOrEqual(0)
        expect(usage.cpuSeconds).toBeGreaterThan(0)
      }
      expect(Math.max(...usages.map((usage) => usage.memoryBytes))).toBeGreaterThan(40 * 1024 * 1024)
    })

    it('gives a last sample when the command is stopped, and none after the run', async () => {
      const usages: RunnerExecutorUsage[] = []
      const { executor, job, controller } = setup({
        command: 'sleep 60',
        onUsage: (usage) => usages.push(usage),
      })
      const running = executor.run(job)
      await new Promise((resolve) => setTimeout(resolve, 300))
      controller.abort()
      await running
      expect(usages.length).toBeGreaterThanOrEqual(1)
      const count = usages.length
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      expect(usages).toHaveLength(count)
    })

    it('goes on when the consumer of the samples throws', async () => {
      const { executor, job } = setup({
        command: 'sleep 1.5',
        onUsage: () => {
          throw new Error('consumer failed')
        },
      })
      expect((await executor.run(job)).exitCode).toBe(0)
    })
  })

  describe('named caches', () => {
    it('links each cache folder at its path in the job folder', async () => {
      const cacheRoot = tempDir()
      const npm = path.join(cacheRoot, 'npm')
      const models = path.join(cacheRoot, 'models')
      const { executor, job, workDir } = setup({
        command: 'echo cached > node_modules/pkg.txt; echo w > .cache/models/w.bin',
        caches: [
          { name: 'npm', path: 'node_modules', dir: npm },
          { name: 'models', path: '.cache/models', dir: models },
        ],
      })
      expect((await executor.run(job)).exitCode).toBe(0)
      expect(readlinkSync(path.join(workDir, 'node_modules'))).toBe(npm)
      expect(readFileSync(path.join(npm, 'pkg.txt'), 'utf8')).toBe('cached\n')
      expect(readFileSync(path.join(models, 'w.bin'), 'utf8')).toBe('w\n')
    })

    it('keeps what a cache holds for the next job', async () => {
      const dir = path.join(tempDir(), 'npm')
      const cache = { name: 'npm', path: 'node_modules', dir }
      const first = setup({ command: 'echo one > node_modules/a.txt', caches: [cache] })
      await first.executor.run(first.job)
      const second = setup({ command: 'cat node_modules/a.txt', caches: [cache] })
      await second.executor.run(second.job)
      expect(second.text()).toBe('one\n')
    })

    it('replaces an empty folder or a link that is already there', async () => {
      const cacheRoot = tempDir()
      const { executor, job, workDir } = setup({
        command: 'true',
        caches: [
          { name: 'empty', path: 'empty-folder', dir: path.join(cacheRoot, 'empty') },
          { name: 'linked', path: 'a-link', dir: path.join(cacheRoot, 'linked') },
        ],
      })
      mkdirSync(path.join(workDir, 'empty-folder'))
      symlinkSync('/nowhere', path.join(workDir, 'a-link'))
      expect((await executor.run(job)).exitCode).toBe(0)
      expect(lstatSync(path.join(workDir, 'empty-folder')).isSymbolicLink()).toBe(true)
      expect(readlinkSync(path.join(workDir, 'a-link'))).toBe(path.join(cacheRoot, 'linked'))
    })

    it('fails the job, saying why, when the inputs already have files where a cache goes', async () => {
      const cacheRoot = tempDir()
      const { executor, job, workDir } = setup({
        command: 'touch ran',
        caches: [{ name: 'npm', path: 'node_modules', dir: path.join(cacheRoot, 'npm') }],
      })
      mkdirSync(path.join(workDir, 'node_modules'))
      writeFileSync(path.join(workDir, 'node_modules', 'left.txt'), 'x')
      const result = await executor.run(job)
      expect(result.exitCode).toBeNull()
      expect(result.error?.code).toBe('executor_unavailable')
      expect(result.error?.message).toContain('npm')
      expect(result.error?.message).toContain('node_modules')
      expect(existsSync(path.join(workDir, 'ran'))).toBe(false)
    })

    it('refuses a cache path that leaves the folder', async () => {
      const cacheRoot = tempDir()
      const { executor, job } = setup({
        caches: [{ name: 'npm', path: '../escape', dir: path.join(cacheRoot, 'npm') }],
      })
      const result = await executor.run(job)
      expect(result.error?.code).toBe('executor_unavailable')
    })
  })

  it('answers executor_unavailable when the shell cannot start', async () => {
    const { executor, job } = setup({ workDir: '/definitely/not/here' })
    const result = await executor.run(job)
    expect(result.error?.code).toBe('executor_unavailable')
    expect(result.exitCode).toBeNull()
  })

  it('answers executor_unavailable on Windows', async () => {
    const { executor, job } = setup({}, { platform: 'win32' })
    expect((await executor.run(job)).error?.code).toBe('executor_unavailable')
  })
})
