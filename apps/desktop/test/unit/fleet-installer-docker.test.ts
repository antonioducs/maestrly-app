import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DockerHost } from '../../src/main/fleet/installer/docker-host'
import { InstallerError } from '../../src/main/fleet/installer/errors'
import { LocalRunner, findDockerCli } from '../../src/main/fleet/installer/runner'
import { FakeRunner, fail, ok } from '../fixtures/fleet-installer-fakes'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-installer-docker-'))
  temporary.push(dir)
  return dir
}
const posix = process.platform === 'win32' ? it.skip : it

describe('finding the Docker CLI', () => {
  const present =
    (...files: string[]) =>
    (file: string) =>
      files.includes(file)

  it('prefers the PATH, then the directories Docker engines install to', () => {
    const env = { PATH: '/usr/bin:/opt/tools/bin' }
    expect(
      findDockerCli({ env, platform: 'darwin', home: '/Users/me', exists: present('/opt/tools/bin/docker') })
    ).toBe('/opt/tools/bin/docker')
    expect(
      findDockerCli({ env, platform: 'darwin', home: '/Users/me', exists: present('/Users/me/.orbstack/bin/docker') })
    ).toBe('/Users/me/.orbstack/bin/docker')
    expect(
      findDockerCli({
        env,
        platform: 'darwin',
        home: '/Users/me',
        exists: present('/Applications/Docker.app/Contents/Resources/bin/docker'),
      })
    ).toBe('/Applications/Docker.app/Contents/Resources/bin/docker')
    expect(findDockerCli({ env, platform: 'linux', home: '/home/me', exists: present() })).toBeNull()
  })

  it('takes an explicit CLI first', () => {
    const env = { PATH: '/usr/bin', MAESTRLY_BOT_SERVER_DOCKER: '/tmp/fake/docker' }
    expect(
      findDockerCli({
        env,
        platform: 'linux',
        home: '/home/me',
        exists: present('/usr/bin/docker', '/tmp/fake/docker'),
      })
    ).toBe('/tmp/fake/docker')
  })

  it('finds docker.exe on Windows', () => {
    const programFiles = 'C:\\Program Files'
    const installed = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
    expect(
      findDockerCli({
        env: { PATH: 'C:\\Windows\\System32', ProgramFiles: programFiles },
        platform: 'win32',
        home: 'C:\\Users\\me',
        exists: present(installed),
      })
    ).toBe(installed)
    expect(
      findDockerCli({
        env: { PATH: 'C:\\Windows\\System32;C:\\Tools', ProgramFiles: programFiles },
        platform: 'win32',
        home: 'C:\\Users\\me',
        exists: present('C:\\Tools\\docker.exe', installed),
      })
    ).toBe('C:\\Tools\\docker.exe')
  })
})

describe('running the local Docker CLI', () => {
  posix('puts the CLI and its real directory first on PATH so credential helpers resolve', async () => {
    const links = tempDir()
    const real = tempDir()
    writeFileSync(
      path.join(real, 'docker'),
      `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const dirs = process.env.PATH.split(path.delimiter)
const helper = dirs.map((dir) => path.join(dir, 'docker-credential-fake')).find((file) => fs.existsSync(file))
let input = ''
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => {
  console.log(JSON.stringify({ first: dirs.slice(0, 2), helper: helper ?? null, args: process.argv.slice(2), input }))
  console.error('progress line')
  process.exit(process.argv[2] === 'fail' ? 3 : 0)
})
`
    )
    chmodSync(path.join(real, 'docker'), 0o755)
    writeFileSync(path.join(real, 'docker-credential-fake'), '#!/bin/sh\n')
    chmodSync(path.join(real, 'docker-credential-fake'), 0o755)
    symlinkSync(path.join(real, 'docker'), path.join(links, 'docker'))
    const runner = new LocalRunner({
      env: { PATH: [links, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter) },
      home: tempDir(),
    })
    expect(runner.dockerPath).toBe(path.join(links, 'docker'))
    const lines: string[] = []
    const result = await runner.docker(['info', '--format', '{{json .}}'], {
      input: 'synthetic input',
      onLine: (line) => lines.push(line),
    })
    expect(result.code).toBe(0)
    const seen = JSON.parse(result.stdout)
    // The link target's directory, as the system resolves it (on macOS /var is a link to /private/var).
    expect(seen.first).toEqual([links, realpathSync(real)])
    expect(seen.helper).toBe(path.join(realpathSync(real), 'docker-credential-fake'))
    expect(seen.args).toEqual(['info', '--format', '{{json .}}'])
    expect(seen.input).toBe('synthetic input')
    expect(result.stderr).toContain('progress line')
    expect(lines).toContain('progress line')
    expect((await runner.docker(['fail'])).code).toBe(3)
  })

  posix('stops the CLI when the job is cancelled', async () => {
    const dir = tempDir()
    // By absolute path: with PATH holding only this directory, a bare `sleep` is not found and the CLI exits at once.
    writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\nexec /bin/sleep 30\n')
    chmodSync(path.join(dir, 'docker'), 0o755)
    const runner = new LocalRunner({ env: { PATH: dir }, home: tempDir() })
    const controller = new AbortController()
    const running = runner.docker(['pull', 'synthetic/image:1'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(running).rejects.toMatchObject({ code: 'cancelled' })
    await expect(runner.docker(['info'], { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('reports a missing CLI', async () => {
    // An explicit CLI that does not exist: this computer may have Docker in one of the known directories.
    const runner = new LocalRunner({
      env: { PATH: tempDir(), MAESTRLY_BOT_SERVER_DOCKER: path.join(tempDir(), 'docker') },
    })
    expect(runner.dockerPath).toBeNull()
    await expect(runner.docker(['info'])).rejects.toMatchObject({ code: 'docker-missing' })
  })

  posix('writes project files readable only by this user', async () => {
    const dir = path.join(tempDir(), 'bot-server')
    const runner = new LocalRunner({ env: { PATH: '' }, home: tempDir() })
    await runner.writeFile(runner.join(dir, '.env'), 'TZ=Etc/UTC\n')
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe('TZ=Etc/UTC\n')
    expect(statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(await runner.readFile(runner.join(dir, '.env'))).toBe('TZ=Etc/UTC\n')
    expect(await runner.readFile(runner.join(dir, 'missing'))).toBeNull()
  })
})

describe('Docker operations for the bot server', () => {
  const dir = '/data/bot-server'
  const project = [
    'compose',
    '--project-name',
    'maestrly-bots',
    '--project-directory',
    dir,
    '--file',
    `${dir}/compose.yml`,
    '--env-file',
    `${dir}/.env`,
  ]
  const info = JSON.stringify({ OperatingSystem: 'OrbStack', ServerVersion: '29.4.0', MemTotal: 8589934592 })

  it('reports a ready engine with its name, version, and memory', async () => {
    const runner = new FakeRunner().on(['info'], ok(info)).on(['compose', 'version'], ok('2.40.0\n'))
    expect(await new DockerHost(runner, dir).status()).toEqual({
      state: 'ready',
      engine: 'OrbStack',
      version: '29.4.0',
      memoryBytes: 8589934592,
    })
    expect(runner.calls).toEqual([
      ['info', '--format', '{{json .}}'],
      ['compose', 'version', '--short'],
    ])
  })

  it('tells a stopped engine, a denied socket, a missing Compose plugin and a missing CLI apart', async () => {
    const status = (runner: FakeRunner) => new DockerHost(runner, dir).status().then((value) => value.state)
    expect(
      await status(
        new FakeRunner().on(
          ['info'],
          fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')
        )
      )
    ).toBe('stopped')
    expect(
      await status(
        new FakeRunner().on(
          ['info'],
          fail('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock')
        )
      )
    ).toBe('no-permission')
    expect(
      await status(
        new FakeRunner()
          .on(['info'], ok(info))
          .on(['compose', 'version'], fail("docker: 'compose' is not a docker command.\nSee 'docker --help'"))
      )
    ).toBe('no-compose')
    expect(
      await status(
        new FakeRunner().on(['info'], () => {
          throw new InstallerError('docker-missing')
        })
      )
    ).toBe('missing')
    // A client that reaches no server still prints its own half of `docker info`.
    expect(
      await status(
        new FakeRunner().on(['info'], ok(JSON.stringify({ ServerErrors: ['Cannot connect to the Docker daemon'] })))
      )
    ).toBe('stopped')
  })

  it('tells images that do not exist from a failed download, and streams the progress', async () => {
    const lines: string[] = []
    const missing = new FakeRunner().on(['pull'], fail('Error response from daemon: manifest unknown'))
    await expect(
      new DockerHost(missing, dir).pull('ghcr.io/o/i:1', { onLine: (line) => lines.push(line) })
    ).rejects.toMatchObject({
      code: 'images-unavailable',
      detail: 'Error response from daemon: manifest unknown',
    })
    expect(lines).toEqual(['Error response from daemon: manifest unknown'])
    const denied = new FakeRunner().on(['pull'], fail('Error response from daemon: denied'))
    await expect(new DockerHost(denied, dir).pull('ghcr.io/o/i:1')).rejects.toMatchObject({
      code: 'images-unavailable',
    })
    const offline = new FakeRunner().on(['pull'], fail('Get "https://ghcr.io/v2/": net/http: TLS handshake timeout'))
    await expect(new DockerHost(offline, dir).pull('ghcr.io/o/i:1')).rejects.toMatchObject({
      code: 'image-pull-failed',
    })
    const pulled = new FakeRunner().on(
      ['pull'],
      ok('1.0: Pulling from o/i\nStatus: Downloaded newer image for ghcr.io/o/i:1\n')
    )
    await new DockerHost(pulled, dir).pull('ghcr.io/o/i:1')
    expect(pulled.calls).toEqual([['pull', 'ghcr.io/o/i:1']])
  })

  it('runs Compose on the installed project with exactly these commands', async () => {
    const runner = new FakeRunner()
      .on(['compose', 'port'], ok('127.0.0.1:7444\n'))
      .on(['compose', 'exec'], ok('ABCD-EFGH (expires 2026-09-27T12:10:00.000Z)\n'))
      .on(['ps'], ok('3f2a\n'))
    const host = new DockerHost(runner, dir)
    await host.up()
    await host.down()
    expect(await host.publishedPort()).toBe(7444)
    expect(await host.pair()).toBe('ABCD-EFGH')
    expect(await host.devFleetRunning()).toBe(true)
    expect(runner.calls).toEqual([
      [...project, 'up', '-d', '--no-build'],
      [...project, 'down', '-v', '--remove-orphans'],
      [...project, 'port', 'maestrly-bot-gateway', '7443'],
      [...project, 'exec', '-T', 'maestrly-bot-gateway', 'maestrly-bot-gateway', 'pair'],
      ['ps', '-q', '--filter', 'label=com.docker.compose.project=maestrly-fleet-dev'],
    ])
  })

  it('fails with the right code when Compose or pairing fails', async () => {
    const runner = new FakeRunner()
      .on(['compose', 'up'], fail('Error response from daemon: port is already allocated'))
      .on(['compose', 'exec'], ok('Usage: maestrly-bot-gateway <serve|pair>\n'))
      .on(['compose', 'port'], fail('no container found'))
      .on(['ps'], ok(''))
    const host = new DockerHost(runner, dir)
    await expect(host.up()).rejects.toMatchObject({
      code: 'start-failed',
      detail: 'Error response from daemon: port is already allocated',
    })
    await expect(host.pair()).rejects.toMatchObject({ code: 'pair-failed' })
    expect(await host.publishedPort()).toBeNull()
    expect(await host.devFleetRunning()).toBe(false)
  })

  it('finds images, other tags of a repository, and removes images without failing', async () => {
    const runner = new FakeRunner()
      .on(['image', 'inspect'], fail('Error: No such image'))
      .on(['image', 'inspect', '--format', '{{.Id}}', 'maestrly/bot-gateway:local'], ok('sha256:1\n'))
      .on(
        ['image', 'ls'],
        ok(
          'ghcr.io/o/maestrly-bot-gateway:0.9.4\nghcr.io/o/maestrly-bot-gateway:0.9.3\nghcr.io/o/maestrly-bot-gateway:<none>\n'
        )
      )
      .on(['image', 'rm'], fail('Error response from daemon: conflict: unable to remove repository reference'))
    const host = new DockerHost(runner, dir)
    expect(await host.imageExists('maestrly/bot-gateway:local')).toBe(true)
    expect(await host.imageExists('maestrly/bot-instance:local')).toBe(false)
    expect(await host.otherTags('ghcr.io/o/maestrly-bot-gateway', '0.9.4')).toEqual([
      'ghcr.io/o/maestrly-bot-gateway:0.9.3',
    ])
    await host.removeImages(['ghcr.io/o/maestrly-bot-gateway:0.9.3', 'ghcr.io/o/maestrly-bot-instance:0.9.3'])
    expect(runner.commands(['image', 'rm'])).toEqual([
      ['image', 'rm', 'ghcr.io/o/maestrly-bot-gateway:0.9.3'],
      ['image', 'rm', 'ghcr.io/o/maestrly-bot-instance:0.9.3'],
    ])
    expect(runner.commands(['image', 'ls'])).toEqual([
      ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', 'ghcr.io/o/maestrly-bot-gateway'],
    ])
  })

  it('writes and reads the project files', async () => {
    const runner = new FakeRunner()
    const host = new DockerHost(runner, dir)
    await host.writeProject('services: {}\n', 'TZ=Etc/UTC\n')
    expect(Object.fromEntries(runner.files)).toEqual({
      [`${dir}/compose.yml`]: 'services: {}\n',
      [`${dir}/.env`]: 'TZ=Etc/UTC\n',
    })
    expect(await host.readEnv()).toBe('TZ=Etc/UTC\n')
  })
})
