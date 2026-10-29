import { type SpawnOptions, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ContainerExecutor,
  type ContainerExecutorOptions,
  cacheVolumeName,
  containerArgs,
  defaultRunnerImage,
  probeContainerSupport,
} from '../../src/main/runner/container-executor'
import type { RunnerExecutorJob } from '../../src/main/runner/executor'
import { createFakeDocker, type FakeDockerConfig } from '../helpers/fake-docker'
import { cleanTempDirs, JOB_ID, tempDir } from '../helpers/runner-core'

afterEach(cleanTempDirs)

const suite = process.platform === 'win32' ? describe.skip : describe
const IMAGE = 'ghcr.io/example/maestrly-bot-instance:1.2.3'
const NAME = `maestrly-job-${JOB_ID}`
const FOLDER = '/home/bot/project'

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function setup(
  config: FakeDockerConfig = {},
  overrides: Partial<RunnerExecutorJob> = {},
  options: Partial<ContainerExecutorOptions> = {}
) {
  const root = tempDir()
  const jobDir = path.join(root, 'jobs', 'key')
  const workDir = path.join(jobDir, 'work')
  mkdirSync(workDir, { recursive: true })
  const fake = createFakeDocker(path.join(root, 'bin'), { image: { present: true }, ...config })
  const output: Buffer[] = []
  const controller = new AbortController()
  const executor = new ContainerExecutor({
    docker: () => fake.path,
    limits: () => ({ cpus: null, memoryBytes: null, gpu: false }),
    defaultImage: () => IMAGE,
    platform: 'linux',
    user: () => ({ uid: 1234, gid: 5678 }),
    stopGraceSeconds: 1,
    ...options,
  })
  const job: RunnerExecutorJob = {
    jobId: JOB_ID,
    serverId: 'server-1',
    botId: 'bot_1',
    scope: 'a1b2c3d4',
    folder: FOLDER,
    workDir,
    command: 'echo hello',
    env: {},
    caches: [],
    timeoutMs: 30_000,
    onOutput: (chunk) => output.push(chunk),
    signal: controller.signal,
    ...overrides,
  }
  return {
    root,
    jobDir,
    workDir,
    fake,
    executor,
    job,
    controller,
    text: () => Buffer.concat(output).toString(),
    envFile: path.join(jobDir, 'container.env'),
    /** The `docker run` of the job's command. */
    mainRun: () => fake.argvOf('run').find((argv) => argv.includes(NAME)) ?? [],
  }
}

const argAfter = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]
const valuesOf = (argv: string[], flag: string): string[] =>
  argv.flatMap((item, index) => (item === flag ? [argv[index + 1] ?? ''] : []))
const parseEnvFile = (content: string): Map<string, string> =>
  new Map(
    content
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )

suite('container executor', () => {
  describe('the command', () => {
    it('runs in a container, forwards stdout and stderr and answers the exit code', async () => {
      const { executor, job, text } = setup({ run: { stdout: 'out\n', stderr: 'err\n', exit: 0 } })
      expect(await executor.run(job)).toEqual({ exitCode: 0, timedOut: false, cancelled: false })
      expect(text()).toContain('out\n')
      expect(text()).toContain('err\n')
    })

    it('answers the exit code of a failing command', async () => {
      const { executor, job } = setup({ run: { exit: 7 } })
      expect(await executor.run(job)).toEqual({ exitCode: 7, timedOut: false, cancelled: false })
    })

    it('invokes docker run with the entrypoint, the labels and the job folder mounted at its own path', async () => {
      const { executor, job, workDir, mainRun, jobDir } = setup({}, { command: 'make "all"; echo $HOME' })
      await executor.run(job)
      const argv = mainRun()
      expect(argv.slice(0, 5)).toEqual(['run', '--rm', '--init', '--name', NAME])
      expect(valuesOf(argv, '--label')).toEqual([`maestrly.runner.job=${JOB_ID}`, 'maestrly.runner.scope=a1b2c3d4'])
      expect(argAfter(argv, '--entrypoint')).toBe('/bin/sh')
      expect(valuesOf(argv, '--mount')).toEqual([
        `type=bind,source=${workDir},target=${FOLDER}`,
        `type=bind,source=${path.join(jobDir, 'home')},target=/maestrly-home`,
      ])
      expect(argAfter(argv, '-w')).toBe(FOLDER)
      expect(argv.slice(-3)).toEqual([IMAGE, '-c', 'make "all"; echo $HOME'])
    })

    it('starts every Docker command through the injected spawn', async () => {
      const calls: string[] = []
      const { executor, job } = setup(
        {},
        {},
        {
          spawn: ((file: string, args: readonly string[], options: SpawnOptions) => {
            calls.push(args[0] ?? '')
            return spawn(file, args, options)
          }) as typeof spawn,
        }
      )
      await executor.run(job)
      expect(calls).toEqual(['image', 'run'])
    })

    it('uses the job image instead of the default one', async () => {
      const { executor, job, fake, mainRun } = setup({}, { image: 'registry.example/tools/ffmpeg:7' })
      await executor.run(job)
      expect(mainRun().slice(-3)).toEqual(['registry.example/tools/ffmpeg:7', '-c', 'echo hello'])
      expect(fake.argvOf('image')[0]?.at(-1)).toBe('registry.example/tools/ffmpeg:7')
    })

    it('refuses an image that Docker would read as an option, before calling Docker', async () => {
      const { executor, job, fake } = setup({}, { image: '--privileged' })
      const result = await executor.run(job)
      expect(result.error?.code).toBe('executor_unavailable')
      expect(result.error?.message).toContain('not a valid image reference')
      expect(fake.calls()).toEqual([])
    })
  })

  describe('isolation', () => {
    it('has no privileges, no Docker socket and no host namespaces', async () => {
      const { executor, job, mainRun } = setup({}, { caches: [{ name: 'models', path: 'models', dir: '/unused' }] })
      await executor.run(job)
      const argv = mainRun()
      const joined = argv.join(' ')
      expect(joined).not.toMatch(
        /--privileged|docker\.sock|--network|--net |--pid|--ipc|--cap-add|--device|--volumes-from/
      )
      expect(argAfter(argv, '--security-opt')).toBe('no-new-privileges')
      expect(argAfter(argv, '--shm-size')).toBe('2g')
    })

    it('passes the CPU and memory limits when the runner sets them', async () => {
      const { executor, job, mainRun } = setup(
        {},
        {},
        { limits: () => ({ cpus: 3.5, memoryBytes: 8 * 1024 ** 3, gpu: false }) }
      )
      await executor.run(job)
      expect(argAfter(mainRun(), '--cpus')).toBe('3.5')
      expect(argAfter(mainRun(), '--memory')).toBe(String(8 * 1024 ** 3))
    })

    it('adds no limit the runner did not set', async () => {
      const { executor, job, mainRun } = setup()
      await executor.run(job)
      expect(mainRun()).not.toContain('--cpus')
      expect(mainRun()).not.toContain('--memory')
    })

    it('asks for the GPU only when the limits allow it', async () => {
      const denied = setup()
      await denied.executor.run(denied.job)
      expect(denied.mainRun()).not.toContain('--gpus')
      const allowed = setup({}, {}, { limits: () => ({ cpus: null, memoryBytes: null, gpu: true }) })
      await allowed.executor.run(allowed.job)
      expect(argAfter(allowed.mainRun(), '--gpus')).toBe('all')
    })

    it('reads the limits for each job', async () => {
      let limits = { cpus: 1 as number | null, memoryBytes: null as number | null, gpu: false }
      const { executor, job, fake } = setup({}, {}, { limits: () => limits })
      await executor.run(job)
      limits = { cpus: null, memoryBytes: 1024 ** 3, gpu: true }
      await executor.run(job)
      const [first = [], second = []] = fake.argvOf('run')
      expect(argAfter(first, '--cpus')).toBe('1')
      expect(first).not.toContain('--gpus')
      expect(second).not.toContain('--cpus')
      expect(argAfter(second, '--memory')).toBe(String(1024 ** 3))
      expect(argAfter(second, '--gpus')).toBe('all')
    })

    it('runs as the runner user on Linux only', async () => {
      const linux = setup()
      await linux.executor.run(linux.job)
      expect(argAfter(linux.mainRun(), '--user')).toBe('1234:5678')
      for (const platform of ['darwin', 'win32'] as const) {
        const other = setup({}, {}, { platform })
        await other.executor.run(other.job)
        expect(other.mainRun()).not.toContain('--user')
        expect(valuesOf(other.mainRun(), '--mount')).toHaveLength(2)
      }
    })

    it('runs as the app user on Linux by default', async () => {
      const { executor, job, mainRun } = setup({}, {}, { user: undefined })
      await executor.run(job)
      expect(argAfter(mainRun(), '--user')).toBe(`${process.getuid?.()}:${process.getgid?.()}`)
    })
  })

  describe('environment', () => {
    it('travels in a private file that is gone after the run, never in the arguments', async () => {
      const hidden = 'value-that-stays-out-of-argv'
      const { executor, job, fake, envFile, mainRun } = setup(
        {},
        {
          env: { API_TOKEN: hidden, LANG: 'pt_BR.UTF-8', EMPTY: '', WITH_EQUALS: 'a=b=c', WITH_HASH: '#not-a-comment' },
        }
      )
      await executor.run(job)
      const argv = mainRun()
      expect(argAfter(argv, '--env-file')).toBe(envFile)
      expect(argv).not.toContain('-e')
      expect(argv).not.toContain('--env')
      expect(JSON.stringify(fake.calls().map((call) => call.argv))).not.toContain(hidden)
      const seen = fake.calls().find((call) => call.argv[0] === 'run' && call.argv.includes(NAME))?.envFile
      expect(seen?.mode).toBe(0o600)
      const env = parseEnvFile(seen?.content ?? '')
      expect(Object.fromEntries(env)).toEqual({
        MAESTRLY_JOB_ID: JOB_ID,
        MAESTRLY_JOB_DIR: FOLDER,
        HOME: '/maestrly-home',
        LANG: 'pt_BR.UTF-8',
        API_TOKEN: hidden,
        EMPTY: '',
        WITH_EQUALS: 'a=b=c',
        WITH_HASH: '#not-a-comment',
      })
      expect(existsSync(envFile)).toBe(false)
    })

    it('sets LANG to C.UTF-8 unless the job sets it, and lets the job override the rest', async () => {
      const first = setup()
      await first.executor.run(first.job)
      const base = first.fake.calls().find((call) => call.envFile)?.envFile
      expect(parseEnvFile(base?.content ?? '').get('LANG')).toBe('C.UTF-8')
      const second = setup({}, { env: { HOME: '/somewhere' } })
      await second.executor.run(second.job)
      const overridden = second.fake.calls().find((call) => call.envFile)?.envFile
      expect(overridden?.content.match(/^HOME=/gm)).toHaveLength(1)
      expect(parseEnvFile(overridden?.content ?? '').get('HOME')).toBe('/somewhere')
    })

    it('makes a writable home folder of the job, outside the folder the outputs come from', async () => {
      const { executor, job, jobDir, workDir } = setup()
      await executor.run(job)
      expect(existsSync(path.join(jobDir, 'home'))).toBe(true)
      expect(readdirSync(workDir)).toEqual([])
    })

    it('removes the file when the command fails, and when the image cannot be had', async () => {
      const failing = setup({ run: { exit: 3 } })
      await failing.executor.run(failing.job)
      expect(existsSync(failing.envFile)).toBe(false)
      const noImage = setup({ image: { present: false }, pull: { exit: 1, stderr: 'denied\n' } })
      await noImage.executor.run(noImage.job)
      expect(existsSync(noImage.envFile)).toBe(false)
    })

    it('refuses a value with a line break before calling Docker, naming the variable but not the value', async () => {
      const { executor, job, fake, envFile } = setup(
        {},
        { env: { PRIVATE_KEY: '-----BEGIN-----\nsecret\n-----END-----' } }
      )
      const result = await executor.run(job)
      expect(result.exitCode).toBeNull()
      expect(result.error?.code).toBe('executor_unavailable')
      expect(result.error?.message).toContain('PRIVATE_KEY')
      expect(result.error?.message).toContain('line break')
      expect(result.error?.message).not.toContain('secret')
      expect(fake.calls()).toEqual([])
      expect(existsSync(envFile)).toBe(false)
    })

    it('refuses a name that is not a variable name', async () => {
      const { executor, job, fake } = setup({}, { env: { 'BAD NAME': 'x' } })
      expect((await executor.run(job)).error?.code).toBe('executor_unavailable')
      expect(fake.calls()).toEqual([])
    })
  })

  describe('named caches', () => {
    it('are Docker volumes mounted at their paths in the folder', async () => {
      const { executor, job, mainRun } = setup(
        {},
        {
          caches: [
            { name: 'node_modules', path: 'node_modules', dir: '/unused/a' },
            { name: 'models', path: './assets/models/', dir: '/unused/b' },
          ],
        }
      )
      await executor.run(job)
      const mounts = valuesOf(mainRun(), '--mount').filter((mount) => mount.startsWith('type=volume'))
      expect(mounts).toEqual([
        'type=volume,source=maestrly-runner-a1b2c3d4-node_modules,target=/home/bot/project/node_modules',
        'type=volume,source=maestrly-runner-a1b2c3d4-models,target=/home/bot/project/assets/models',
      ])
    })

    it('are named so that Docker accepts the names, and two names never share a volume', () => {
      const valid = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
      expect(cacheVolumeName('abc123', 'node_modules')).toBe('maestrly-runner-abc123-node_modules')
      const odd = cacheVolumeName('scope with space', 'weights/v2')
      expect(odd).toMatch(valid)
      expect(odd).toMatch(/^maestrly-runner-scope_with_space-weights_v2-[0-9a-f]{8}$/)
      expect(cacheVolumeName('scope', 'a/b')).not.toBe(cacheVolumeName('scope', 'a_b'))
      expect(cacheVolumeName('scope', 'a/b')).not.toBe(cacheVolumeName('scope', 'a:b'))
      expect(cacheVolumeName('scope', 'a/b')).toBe(cacheVolumeName('scope', 'a/b'))
      expect(cacheVolumeName('s1', 'cache')).not.toBe(cacheVolumeName('s2', 'cache'))
    })

    it('refuse a path that leaves the folder', async () => {
      for (const cachePath of ['../outside', '/etc', 'a/../../b', 'a\\b', '.']) {
        const { executor, job, fake } = setup({}, { caches: [{ name: 'c', path: cachePath, dir: '/unused' }] })
        const result = await executor.run(job)
        expect(result.error?.code, cachePath).toBe('executor_unavailable')
        expect(result.error?.message).toContain('outside the job folder')
        expect(fake.calls()).toEqual([])
      }
    })

    it('are handed to the runner user first on Linux, because a new volume belongs to root', async () => {
      const { executor, job, fake } = setup(
        {},
        {
          caches: [
            { name: 'a', path: 'a', dir: '/unused' },
            { name: 'b', path: 'b', dir: '/unused' },
          ],
        }
      )
      await executor.run(job)
      const runs = fake.argvOf('run')
      expect(runs).toHaveLength(2)
      const prepare = runs[0] ?? []
      expect(argAfter(prepare, '--entrypoint')).toBe('chown')
      expect(argAfter(prepare, '--user')).toBe('0:0')
      expect(argAfter(prepare, '--network')).toBe('none')
      expect(argAfter(prepare, '--cap-add')).toBe('CHOWN')
      expect(valuesOf(prepare, '--mount')).toEqual([
        'type=volume,source=maestrly-runner-a1b2c3d4-a,target=/maestrly-caches/0',
        'type=volume,source=maestrly-runner-a1b2c3d4-b,target=/maestrly-caches/1',
      ])
      expect(prepare.slice(-4)).toEqual([IMAGE, '1234:5678', '/maestrly-caches/0', '/maestrly-caches/1'])
      expect(valuesOf(prepare, '--label')).toContain(`maestrly.runner.job=${JOB_ID}`)
    })

    it('are not handed over where Docker maps ownership itself, nor when there are none', async () => {
      const mac = setup({}, { caches: [{ name: 'a', path: 'a', dir: '/unused' }] }, { platform: 'darwin' })
      await mac.executor.run(mac.job)
      expect(mac.fake.argvOf('run')).toHaveLength(1)
      const none = setup()
      await none.executor.run(none.job)
      expect(none.fake.argvOf('run')).toHaveLength(1)
    })

    it('are still used when handing them over fails, and the job log says so', async () => {
      const { executor, job, fake, text } = setup(
        { prepare: { exit: 1, stderr: 'chown: not found' }, run: { stdout: 'ran\n' } },
        { caches: [{ name: 'a', path: 'a', dir: '/unused' }] }
      )
      expect(await executor.run(job)).toEqual({ exitCode: 0, timedOut: false, cancelled: false })
      expect(fake.argvOf('run')).toHaveLength(2)
      expect(text()).toContain('[runner] The cache folders could not be prepared: chown: not found')
      expect(text()).toContain('ran\n')
    })
  })

  describe('containerArgs', () => {
    const optionsOf = (_job: RunnerExecutorJob) => ({
      image: IMAGE,
      cpus: null,
      memoryBytes: null,
      gpu: false,
      user: null,
      envFile: '/jobs/key/container.env',
      homeDir: '/jobs/key/home',
    })
    const args = (job: RunnerExecutorJob) => containerArgs(job, optionsOf(job))

    it('labels the container with its runner when it has an owner', () => {
      const { job } = setup()
      const labelled = containerArgs(job, { ...optionsOf(job), owner: 'abc123' })
      expect(valuesOf(labelled, '--label')).toContain('maestrly.runner.owner=abc123')
      expect(valuesOf(args(job), '--label').join(' ')).not.toContain('maestrly.runner.owner')
    })

    it('keeps a path with a comma or a quote in one mount field', () => {
      const { job } = setup({}, { workDir: '/data/a,b/work', folder: '/home/bot/my "dir"' })
      expect(valuesOf(args(job), '--mount')[0]).toBe('type=bind,"source=/data/a,b/work","target=/home/bot/my ""dir"""')
    })

    it('puts the command last, after the image and -c', () => {
      const { job } = setup({}, { command: '-v --privileged; true' })
      expect(args(job).slice(-3)).toEqual([IMAGE, '-c', '-v --privileged; true'])
    })

    it('rejects an image reference that begins with a dash', () => {
      const { job } = setup()
      expect(() => containerArgs(job, { ...optionsOf(job), image: '-x' })).toThrow('not a valid image reference')
    })
  })

  describe('image', () => {
    it('is not pulled when it is on the computer', async () => {
      const { executor, job, fake } = setup()
      await executor.run(job)
      expect(fake.argvOf('image')).toEqual([['image', 'inspect', '--format', '{{.Id}}', IMAGE]])
      expect(fake.argvOf('pull')).toEqual([])
    })

    it('is pulled on first use, with its output in the job log, and only once', async () => {
      const { executor, job, fake, text } = setup({
        image: { present: false },
        pull: { stdout: 'latest: Pulling from example\nabc123: Pull complete\nStatus: Downloaded newer image\n' },
        run: { stdout: 'done\n' },
      })
      expect(await executor.run(job)).toEqual({ exitCode: 0, timedOut: false, cancelled: false })
      expect(fake.argvOf('pull')).toEqual([['pull', IMAGE]])
      expect(text()).toContain(`[runner] Pulling the image ${IMAGE}\n`)
      expect(text()).toContain('[pull] abc123: Pull complete\n')
      expect(text().indexOf('[pull] Status')).toBeLessThan(text().indexOf('done'))
      const order = fake.calls().map((call) => call.argv[0])
      expect(order).toEqual(['image', 'pull', 'run'])
      // The second job finds it.
      await executor.run(job)
      expect(fake.argvOf('pull')).toHaveLength(1)
    })

    it('fails the job as executor_unavailable when the pull fails, without running anything', async () => {
      const { executor, job, fake } = setup({
        image: { present: false },
        pull: {
          exit: 1,
          stderr: 'Error response from daemon: pull access denied for example, repository does not exist\n',
        },
      })
      const result = await executor.run(job)
      expect(result.exitCode).toBeNull()
      expect(result.error).toEqual({
        code: 'executor_unavailable',
        message: `The image ${IMAGE} could not be pulled: Error response from daemon: pull access denied for example, repository does not exist`,
      })
      expect(fake.argvOf('run')).toEqual([])
    })

    it('fails with runner_disk_full when the pull ran out of space', async () => {
      const { executor, job } = setup({
        image: { present: false },
        pull: { exit: 1, stderr: 'write /var/lib/docker/tmp/GetImageBlob: no space left on device\n' },
      })
      expect((await executor.run(job)).error).toEqual({
        code: 'runner_disk_full',
        message: 'This computer is out of disk space.',
      })
    })

    it('fails as executor_unavailable when the daemon is not running', async () => {
      const { executor, job, fake } = setup({
        image: {
          error: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        },
      })
      const result = await executor.run(job)
      expect(result.error).toEqual({ code: 'executor_unavailable', message: 'Docker is not running on this computer.' })
      expect(fake.argvOf('pull')).toEqual([])
      expect(fake.argvOf('run')).toEqual([])
    })

    it('fails as executor_unavailable when the runner user may not use Docker', async () => {
      const { executor, job } = setup({
        image: {
          error: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
        },
      })
      const result = await executor.run(job)
      expect(result.error?.code).toBe('executor_unavailable')
      expect(result.error?.message).toContain('not allowed to use Docker')
    })

    it('can be cancelled while it is pulled', async () => {
      const { executor, job, fake, controller } = setup({
        image: { present: false },
        pull: { hang: true, stdout: 'Pulling\n' },
      })
      const running = executor.run(job)
      await until(() => fake.argvOf('pull').length > 0, 'the pull')
      controller.abort()
      expect(await running).toEqual({ exitCode: null, timedOut: false, cancelled: true })
      expect(fake.argvOf('run')).toEqual([])
    })
  })

  describe('Docker is missing', () => {
    it('fails as executor_unavailable', async () => {
      const { executor, job, envFile } = setup({}, {}, { docker: () => null })
      expect(await executor.run(job)).toEqual({
        exitCode: null,
        timedOut: false,
        cancelled: false,
        error: { code: 'executor_unavailable', message: 'Docker is not installed on this computer.' },
      })
      expect(existsSync(envFile)).toBe(false)
    })

    it('fails as executor_unavailable when the CLI cannot be started', async () => {
      const { executor, job } = setup({}, {}, { docker: () => '/nonexistent/bin/docker' })
      const result = await executor.run(job)
      expect(result.error?.code).toBe('executor_unavailable')
      expect(result.error?.message).toContain('Docker could not start')
    })
  })

  describe('docker run fails by itself', () => {
    it("is executor_unavailable with Docker's reason when exit code 125 comes with its error", async () => {
      const { executor, job, workDir, fake } = setup()
      const jobDir = path.dirname(workDir)
      fake.configure({
        run: {
          exit: 125,
          stderr: `docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${jobDir}/home.\nSee 'docker run --help'.\n`,
        },
      })
      const result = await executor.run(job)
      expect(result.exitCode).toBeNull()
      expect(result.error?.code).toBe('executor_unavailable')
      expect(result.error?.message).toContain(
        'The container could not start: Error response from daemon: invalid mount'
      )
      expect(result.error?.message).not.toContain(jobDir)
    })

    it('is executor_unavailable when the GPU runtime is missing', async () => {
      const { executor, job } = setup(
        {
          run: {
            exit: 125,
            stderr:
              'docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]].\n',
          },
        },
        {},
        { limits: () => ({ cpus: null, memoryBytes: null, gpu: true }) }
      )
      const result = await executor.run(job)
      expect(result.error?.code).toBe('executor_unavailable')
      expect(result.error?.message).toContain('could not select device driver')
    })

    it('is runner_disk_full when the daemon has no space left', async () => {
      const { executor, job } = setup({
        run: {
          exit: 125,
          stderr: 'docker: Error response from daemon: failed to create task: no space left on device.\n',
        },
      })
      expect((await executor.run(job)).error?.code).toBe('runner_disk_full')
    })

    it('is the exit code of the command when a command itself exits 125', async () => {
      const { executor, job } = setup({ run: { exit: 125, stderr: 'my script failed\n' } })
      expect(await executor.run(job)).toEqual({ exitCode: 125, timedOut: false, cancelled: false })
    })

    it('keeps 137 as the exit code when the command was killed without a stop (memory limit)', async () => {
      const { executor, job } = setup({ run: { exit: 137 } })
      expect(await executor.run(job)).toEqual({ exitCode: 137, timedOut: false, cancelled: false })
    })
  })

  describe('stopping', () => {
    it('stops and removes the container when the timeout passes, then reports it', async () => {
      const { executor, job, fake } = setup({ run: { hang: true, stdout: 'working\n' } }, { timeoutMs: 150 })
      const result = await executor.run(job)
      expect(result).toEqual({ exitCode: null, timedOut: true, cancelled: false })
      const calls = fake.calls().map((call) => call.argv)
      const stop = calls.findIndex((argv) => argv[0] === 'stop')
      const remove = calls.findIndex((argv) => argv[0] === 'rm')
      expect(calls[stop]).toEqual(['stop', '-t', '1', NAME])
      expect(calls[remove]).toEqual(['rm', '-f', NAME])
      expect(stop).toBeGreaterThan(-1)
      expect(remove).toBeGreaterThan(stop)
    })

    it('stops and removes the container when the job is cancelled', async () => {
      const { executor, job, fake, controller, envFile } = setup({ run: { hang: true } })
      const running = executor.run(job)
      await until(() => fake.started(NAME), 'the container')
      controller.abort()
      expect(await running).toEqual({ exitCode: null, timedOut: false, cancelled: true })
      expect(fake.argvOf('stop')).toEqual([['stop', '-t', '1', NAME]])
      expect(fake.argvOf('rm')).toEqual([['rm', '-f', NAME]])
      expect(existsSync(envFile)).toBe(false)
    })

    it('stops a container that was not there yet when the stop first arrived', async () => {
      const { executor, job, fake, controller } = setup({ run: { hang: true, startDelayMs: 400 } })
      const running = executor.run(job)
      await until(() => fake.argvOf('run').length > 0, 'docker run')
      controller.abort()
      expect(await running).toEqual({ exitCode: null, timedOut: false, cancelled: true })
      expect(fake.argvOf('stop').length).toBeGreaterThan(1)
      expect(fake.started(NAME)).toBe(true)
    })

    it('reports a command that ends 0 after a stop as the code it chose', async () => {
      const { executor, job } = setup({ run: { hang: true, stopExit: 0 } }, { timeoutMs: 100 })
      expect(await executor.run(job)).toEqual({ exitCode: 0, timedOut: true, cancelled: false })
    })

    it('runs nothing for a job cancelled before it starts', async () => {
      const { executor, job, fake, controller } = setup()
      controller.abort()
      expect(await executor.run(job)).toEqual({ exitCode: null, timedOut: false, cancelled: true })
      expect(fake.calls()).toEqual([])
    })
  })

  describe('cleanup', () => {
    it('removes the containers of jobs that are not held and keeps the others', async () => {
      const { executor, fake } = setup({
        containers: [
          'aaa111 job_Kept0000000000001',
          'bbb222 job_Gone0000000000002',
          'ccc333 job_Gone0000000000003',
          '',
        ],
      })
      await executor.removeOrphans(new Set(['job_Kept0000000000001']))
      expect(fake.argvOf('ps')).toEqual([
        ['ps', '-a', '--filter', 'label=maestrly.runner.job', '--format', '{{.ID}} {{.Label "maestrly.runner.job"}}'],
      ])
      expect(fake.argvOf('rm')).toEqual([['rm', '-f', 'bbb222', 'ccc333']])
    })

    it('removes only the containers of its own runner when it has an owner', async () => {
      const { executor, fake } = setup({ containers: ['bbb222 job_Gone0000000000001'] }, {}, { owner: () => 'abc123' })
      await executor.removeOrphans(new Set())
      expect(fake.argvOf('ps')).toEqual([
        [
          'ps',
          '-a',
          '--filter',
          'label=maestrly.runner.job',
          '--filter',
          'label=maestrly.runner.owner=abc123',
          '--format',
          '{{.ID}} {{.Label "maestrly.runner.job"}}',
        ],
      ])
    })

    it('removes nothing when every container belongs to a held job', async () => {
      const { executor, fake } = setup({ containers: ['aaa111 job_Kept0000000000001'] })
      await executor.removeOrphans(new Set(['job_Kept0000000000001']))
      expect(fake.argvOf('rm')).toEqual([])
    })

    it('does nothing without Docker, or when the daemon does not answer', async () => {
      const missing = setup({}, {}, { docker: () => null })
      await expect(missing.executor.removeOrphans(new Set())).resolves.toBeUndefined()
      await expect(missing.executor.removeScopeVolumes('a1b2c3d4')).resolves.toBeUndefined()
      expect(missing.fake.calls()).toEqual([])
      const unreachable = setup({}, {}, { docker: () => '/nonexistent/bin/docker' })
      await expect(unreachable.executor.removeOrphans(new Set())).resolves.toBeUndefined()
      await expect(unreachable.executor.removeScopeVolumes('a1b2c3d4')).resolves.toBeUndefined()
    })

    it('removes the named-cache volumes of one bot and no other', async () => {
      const { executor, fake } = setup({
        volumes: [
          'maestrly-runner-a1b2c3d4-node_modules',
          'maestrly-runner-a1b2c3d4-models',
          'maestrly-runner-ffff0000-node_modules',
          'other-maestrly-runner-a1b2c3d4-x',
          'unrelated',
        ],
      })
      await executor.removeScopeVolumes('a1b2c3d4')
      expect(fake.argvOf('volume')).toEqual([
        ['volume', 'ls', '-q', '--filter', 'name=maestrly-runner-a1b2c3d4-'],
        ['volume', 'rm', '-f', 'maestrly-runner-a1b2c3d4-node_modules', 'maestrly-runner-a1b2c3d4-models'],
      ])
    })

    it('does not call volume rm when the bot has no volumes', async () => {
      const { executor, fake } = setup({ volumes: ['unrelated'] })
      await executor.removeScopeVolumes('a1b2c3d4')
      expect(fake.argvOf('volume')).toHaveLength(1)
    })
  })

  describe('probe', () => {
    const probe = (config: FakeDockerConfig) => {
      const { fake } = setup(config)
      return probeContainerSupport({ docker: fake.path })
    }

    it('reports a missing CLI', async () => {
      expect(await probeContainerSupport({ docker: null })).toEqual({ docker: 'missing', gpu: false, message: null })
      expect((await probeContainerSupport({ docker: '/nonexistent/bin/docker' })).docker).toBe('missing')
    })

    it("reports a daemon that does not answer, with Docker's reason", async () => {
      expect(await probe({ info: { state: 'stopped' } })).toEqual({
        docker: 'stopped',
        gpu: false,
        message: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      })
    })

    it('reports a ready Docker without a GPU', async () => {
      expect(await probe({ info: { runtimes: { runc: {}, 'io.containerd.runc.v2': {} } } })).toEqual({
        docker: 'ready',
        gpu: false,
        message: null,
      })
    })

    it('reports the GPU when the NVIDIA runtime is registered', async () => {
      expect(await probe({ info: { runtimes: { runc: {}, nvidia: { path: 'nvidia-container-runtime' } } } })).toEqual({
        docker: 'ready',
        gpu: true,
        message: null,
      })
    })

    it('reports the GPU when Docker lists NVIDIA CDI devices', async () => {
      const found = await probe({ info: { devices: [{ Source: 'cdi', ID: 'nvidia.com/gpu=all' }] } })
      expect(found.gpu).toBe(true)
      const other = await probe({ info: { devices: [{ Source: 'cdi', ID: 'vendor.example/gpu=0' }] } })
      expect(other.gpu).toBe(false)
    })

    it('starts nothing and pulls nothing', async () => {
      const { fake } = setup({ info: { runtimes: { nvidia: {} } } })
      await probeContainerSupport({ docker: fake.path })
      expect(new Set(fake.calls().map((call) => call.argv[0]))).toEqual(new Set(['info']))
    })

    it('takes the answers of an injected exec', async () => {
      const seen: string[][] = []
      const result = await probeContainerSupport({
        docker: '/usr/bin/docker',
        exec: async (_file, args) => {
          seen.push(args)
          return args[2] === '{{json .Runtimes}}'
            ? '{"nvidia":{}}'
            : args[2] === '{{json .ServerVersion}}'
              ? '"27.1.0"'
              : 'null'
        },
      })
      expect(result).toEqual({ docker: 'ready', gpu: true, message: null })
      expect(seen[0]).toEqual(['info', '--format', '{{json .ServerVersion}}'])
    })

    it('treats an empty server version as a daemon that is not there', async () => {
      const result = await probeContainerSupport({ docker: '/usr/bin/docker', exec: async () => '""' })
      expect(result).toEqual({ docker: 'stopped', gpu: false, message: null })
    })
  })

  describe('default image', () => {
    it('is the bot environment image of the app version', () => {
      expect(defaultRunnerImage('1.2.3')).toBe('ghcr.io/antonioducs/maestrly-bot-instance:1.2.3')
      expect(defaultRunnerImage('1.2.3', { env: {} })).toBe('ghcr.io/antonioducs/maestrly-bot-instance:1.2.3')
    })

    it('is the local build in a development build, and follows the installer overrides', () => {
      expect(defaultRunnerImage('1.2.3', { isPackaged: false, env: {} })).toBe('maestrly/bot-instance:local')
      expect(
        defaultRunnerImage('1.2.3', {
          env: { MAESTRLY_BOT_SERVER_REGISTRY: 'registry.example/team', MAESTRLY_BOT_SERVER_TAG: 'rc1' },
        })
      ).toBe('registry.example/team/maestrly-bot-instance:rc1')
    })
  })
})
