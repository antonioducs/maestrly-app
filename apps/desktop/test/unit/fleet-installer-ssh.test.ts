import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunOptions, RunResult } from '../../src/main/fleet/installer/runner'
import {
  authorizeKey,
  installDocker,
  parseProbe,
  probeRemote,
  remoteSupport,
  revokeKey,
  type RemoteProbe,
} from '../../src/main/fleet/installer/remote-host'
import {
  RemoteRunner,
  SshSession,
  generateSshKey,
  hostKeyFingerprint,
  shellQuote,
} from '../../src/main/fleet/installer/ssh'
import { startFakeSshServer, type FakeSshServer, type FakeSshServerOptions } from '../fixtures/fake-ssh-server'

const password = 'synthetic-root-password'
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function server(options: Partial<FakeSshServerOptions> = {}): Promise<FakeSshServer> {
  const fake = await startFakeSshServer({ users: { root: password, deploy: 'synthetic-deploy-password' }, ...options })
  cleanups.push(() => fake.close())
  return fake
}
async function login(fake: FakeSshServer, username = 'root', secret = password) {
  const session = await SshSession.connect(
    { host: '127.0.0.1', port: fake.port, username },
    { kind: 'password', password: secret },
    { expectedHostKey: null }
  )
  cleanups.push(() => session.close())
  return session
}
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}
function echoServer(): Promise<number> {
  return new Promise((resolve) => {
    const echo = net
      .createServer((socket) => socket.pipe(socket))
      .listen(0, '127.0.0.1', () => resolve((echo.address() as net.AddressInfo).port))
    cleanups.push(() => new Promise<void>((done) => echo.close(() => done())))
  })
}

describe('SSH sessions', () => {
  it('signs in with a password, pins nothing on first use, and runs commands with their input', async () => {
    const fake = await server({ exec: (command, input) => ({ code: command === 'cat' ? 0 : 3, stdout: input }) })
    const session = await login(fake)
    expect(session.hostKey).toBe(fake.fingerprint)
    expect(session.hostKey).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(session.root).toBe(true)
    expect(await session.exec('cat', { input: 'synthetic input' })).toEqual({
      code: 0,
      stdout: 'synthetic input',
      stderr: '',
    })
    expect((await session.exec('false')).code).toBe(3)
  })

  it('quotes any string for a POSIX shell', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('{{json .}}')).toBe("'{{json .}}'")
    expect(hostKeyFingerprint(Buffer.from('synthetic'))).toBe('SHA256:s8wEdbt4pQJgmIWOmIms9mbTEGLVE9MDMU7KMdNucvI')
  })

  it('tells a wrong password, a closed port, a changed host key and a cancelled login apart', async () => {
    const fake = await server()
    const target = { host: '127.0.0.1', port: fake.port, username: 'root' }
    await expect(
      SshSession.connect(target, { kind: 'password', password: 'wrong' }, { expectedHostKey: null })
    ).rejects.toMatchObject({ code: 'ssh-auth' })
    await expect(
      SshSession.connect(
        { ...target, port: await freePort() },
        { kind: 'password', password },
        { expectedHostKey: null }
      )
    ).rejects.toMatchObject({ code: 'ssh-unreachable' })
    await expect(
      SshSession.connect(target, { kind: 'password', password }, { expectedHostKey: 'SHA256:somethingElse' })
    ).rejects.toMatchObject({ code: 'ssh-host-key', detail: fake.fingerprint })
    // A server that never answers the handshake: only cancelling ends the wait.
    const silentSockets = new Set<net.Socket>()
    const silent = net.createServer((socket) => silentSockets.add(socket)).listen(0, '127.0.0.1')
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          for (const socket of silentSockets) socket.destroy()
          silent.close(() => done())
        })
    )
    await new Promise((resolve) => silent.once('listening', resolve))
    const controller = new AbortController()
    const connecting = SshSession.connect(
      { ...target, port: (silent.address() as net.AddressInfo).port },
      { kind: 'password', password },
      { expectedHostKey: null, signal: controller.signal }
    )
    setTimeout(() => controller.abort(), 50)
    await expect(connecting).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('runs Docker and writes files through sudo for a user who is not root', async () => {
    const fake = await server({ exec: () => ({ code: 0 }) })
    const session = await login(fake, 'deploy', 'synthetic-deploy-password')
    expect(session.root).toBe(false)
    const runner = new RemoteRunner(session)
    await runner.docker(['info', '--format', '{{json .}}'])
    await runner.writeFile('/opt/maestrly-bots/.env', 'TZ=Etc/UTC\n')
    const [info, write] = fake.commands.filter((item) => item.command !== 'id -u')
    expect(info.command).toBe("sudo -n docker 'info' '--format' '{{json .}}'")
    expect(write.command.startsWith("sudo -n sh -c '# maestrly-bot-server:write-file\n")).toBe(true)
    expect(write.command.endsWith(" sh '/opt/maestrly-bots' '/opt/maestrly-bots/.env'")).toBe(true)
    expect(write.input).toBe('TZ=Etc/UTC\n')
    const rootRunner = new RemoteRunner(await login(fake))
    await rootRunner.docker(['ps'])
    expect(fake.commands.at(-1)?.command).toBe("docker 'ps'")
  })

  it('reports sudo that wants a password', async () => {
    const fake = await server({ exec: () => ({ code: 1, stderr: 'sudo: a password is required\n' }) })
    const runner = new RemoteRunner(await login(fake, 'deploy', 'synthetic-deploy-password'))
    await expect(runner.writeFile('/opt/maestrly-bots/.env', 'x')).rejects.toMatchObject({ code: 'ssh-sudo' })
  })

  it('opens channels to the server loopback, and tells disabled forwarding from a closed port', async () => {
    const echo = await echoServer()
    const fake = await server({ forwardTo: (port) => (port === 7443 ? echo : null) })
    const session = await login(fake)
    const channel = await session.forward(7443)
    const reply = new Promise<string>((resolve) => channel.once('data', (data: Buffer) => resolve(data.toString())))
    channel.write('ping')
    expect(await reply).toBe('ping')
    channel.destroy()
    await expect(session.forward(9999)).rejects.toMatchObject({ code: 'gateway-unhealthy' })
    const locked = await server({ allowForwarding: false })
    await expect((await login(locked)).forward(7443)).rejects.toMatchObject({ code: 'ssh-forwarding' })
  })

  it('signs in with a generated key once the server authorizes it', async () => {
    const fake = await server({
      exec: (command, input) => {
        if (input.startsWith('# maestrly-bot-server:authorize-key\n')) {
          const key = /^sh -s -- '(ssh-ed25519 [^']+)'$/.exec(command)?.[1]
          if (key) fake.authorizedKeys.push(key)
        }
        return { code: 0 }
      },
    })
    const key = generateSshKey('maestrly-synthetic')
    expect(key.publicKey).toMatch(/^ssh-ed25519 \S+ maestrly-synthetic$/)
    const target = { host: '127.0.0.1', port: fake.port, username: 'root' }
    const credentials = { kind: 'key' as const, privateKey: key.privateKey, passphrase: null }
    await expect(SshSession.connect(target, credentials, { expectedHostKey: fake.fingerprint })).rejects.toMatchObject({
      code: 'ssh-auth',
    })
    await authorizeKey(await login(fake), key.publicKey)
    const session = await SshSession.connect(target, credentials, { expectedHostKey: fake.fingerprint })
    cleanups.push(() => session.close())
    expect(session.root).toBe(true)
  })

  it('keeps a public key that starts with zero bytes', async () => {
    // ssh2's own generator stripped these bytes, leaving one key in 256 unreadable.
    let pair = generateKeyPairSync('ed25519')
    while (Buffer.from(pair.privateKey.export({ format: 'jwk' }).x!, 'base64url')[0] !== 0)
      pair = generateKeyPairSync('ed25519')
    const key = generateSshKey('maestrly-000000000000', pair)
    const parsed = ssh2.utils.parseKey(key.privateKey)
    if (parsed instanceof Error) throw parsed
    const blob = parsed.getPublicSSH() as Buffer
    expect(blob.readUInt32BE(15)).toBe(32)
    expect(blob[19]).toBe(0)
    expect(key.publicKey).toBe(`ssh-ed25519 ${blob.toString('base64')} maestrly-000000000000`)
    const fake = await server()
    fake.authorizedKeys.push(key.publicKey)
    const session = await SshSession.connect(
      { host: '127.0.0.1', port: fake.port, username: 'root' },
      { kind: 'key', privateKey: key.privateKey, passphrase: null },
      { expectedHostKey: fake.fingerprint }
    )
    cleanups.push(() => session.close())
    expect(session.root).toBe(true)
  })

  it('refuses a private key it cannot read without echoing it', async () => {
    const fake = await server()
    const attempt = SshSession.connect(
      { host: '127.0.0.1', port: fake.port, username: 'root' },
      { kind: 'key', privateKey: 'synthetic not a key', passphrase: null },
      { expectedHostKey: null }
    )
    await expect(attempt).rejects.toMatchObject({ code: 'ssh-auth' })
    await expect(attempt).rejects.not.toMatchObject({ detail: expect.stringContaining('synthetic not a key') })
  })
})

describe('preparing a VPS', () => {
  const probeOutput = (lines: Record<string, string>) =>
    Object.entries(lines)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
  const ubuntu = {
    os_id: 'ubuntu',
    os_version: '24.04',
    os_name: 'Ubuntu 24.04.1 LTS',
    arch: 'x86_64',
    memory_kb: '4011232',
    disk_free_kb: '41943040',
    hostname: 'vps-synthetic',
    root: '1',
    sudo: '1',
    docker: '1',
    compose: '1',
  }

  it('reads what the probe reports', () => {
    expect(parseProbe(probeOutput(ubuntu))).toEqual({
      osId: 'ubuntu',
      osVersion: '24.04',
      osName: 'Ubuntu 24.04.1 LTS',
      arch: 'x86_64',
      memoryBytes: 4011232 * 1024,
      diskFreeBytes: 41943040 * 1024,
      hostname: 'vps-synthetic',
      root: true,
      sudo: true,
      docker: true,
      compose: true,
      existingEnv: null,
    })
    const debian = parseProbe(
      probeOutput({
        ...ubuntu,
        os_id: 'debian',
        os_version: '12',
        arch: 'aarch64',
        root: '0',
        sudo: '1',
        docker: '0',
        compose: '0',
      })
    )
    expect(debian).toMatchObject({
      osId: 'debian',
      arch: 'aarch64',
      root: false,
      sudo: true,
      docker: false,
      compose: false,
    })
    const env = 'MAESTRLY_GATEWAY_IMAGE=ghcr.io/antonioducs/maestrly-bot-gateway:0.9.1\n'
    expect(parseProbe(probeOutput({ ...ubuntu, existing_env: Buffer.from(env).toString('base64') })).existingEnv).toBe(
      env
    )
  })

  it('supports recent Ubuntu and Debian on x86_64 and arm64, as root or with sudo', () => {
    const probe = (patch: Partial<RemoteProbe>): RemoteProbe => ({ ...parseProbe(probeOutput(ubuntu)), ...patch })
    for (const [osId, osVersion] of [
      ['ubuntu', '22.04'],
      ['ubuntu', '24.04'],
      ['debian', '12'],
      ['debian', '13'],
    ])
      expect(remoteSupport(probe({ osId, osVersion })), `${osId} ${osVersion}`).toBeNull()
    expect(remoteSupport(probe({ osVersion: '20.04' }))).toBe('os-unsupported')
    expect(remoteSupport(probe({ osId: 'centos', osVersion: '9' }))).toBe('os-unsupported')
    expect(remoteSupport(probe({ arch: 'armv7l' }))).toBe('arch-unsupported')
    expect(remoteSupport(probe({ arch: 'aarch64' }))).toBeNull()
    expect(remoteSupport(probe({ root: false, sudo: false }))).toBe('ssh-sudo')
    expect(remoteSupport(probe({ root: false, sudo: true }))).toBeNull()
  })

  it('probes over SSH and installs Docker with the convenience script', async () => {
    const fake = await server({
      exec: (_command, input) => {
        if (input.startsWith('# maestrly-bot-server:probe\n')) return { code: 0, stdout: probeOutput(ubuntu) }
        if (input.startsWith('# maestrly-bot-server:install-docker\n'))
          return {
            code: 100,
            stdout: 'Executing docker install script\n',
            stderr: 'E: Unable to locate package docker-ce\n',
          }
        return { code: 0 }
      },
    })
    const session = await login(fake)
    expect(await probeRemote(session)).toMatchObject({ osId: 'ubuntu', hostname: 'vps-synthetic' })
    expect(fake.commands.at(-1)?.command).toBe("sh -s -- '/opt/maestrly-bots'")
    await expect(installDocker(session)).rejects.toMatchObject({
      code: 'docker-install-failed',
      detail: 'E: Unable to locate package docker-ce',
    })
    const install = fake.commands.at(-1)!
    expect(install.command).toBe('sh -s --')
    expect(install.input).toContain('https://get.docker.com')
  })

  /** Runs the scripts with this machine's `sh`, in a synthetic home. */
  function localShell(home: string) {
    return {
      root: false,
      exec(command: string, options: RunOptions = {}): Promise<RunResult> {
        return new Promise((resolve) => {
          const child = spawn('sh', ['-c', command], { env: { ...process.env, HOME: home } })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (chunk) => (stdout += chunk))
          child.stderr.on('data', (chunk) => (stderr += chunk))
          child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
          child.stdin.end(options.input ?? '')
        })
      },
    }
  }

  it.skipIf(process.platform === 'win32')('authorizes its key once and revokes only its own line', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'fleet-installer-home-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const file = path.join(home, '.ssh', 'authorized_keys')
    const shell = localShell(home)
    const key = generateSshKey('maestrly-a1b2c3d4e5f6').publicKey
    await authorizeKey(shell, key)
    await authorizeKey(shell, key)
    expect(readFileSync(file, 'utf8')).toBe(`${key}\n`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    // The owner's own keys stay, even one without a final newline or sharing the tag as a prefix.
    const own = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsyntheticOwnKey owner@laptop'
    const similar = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsyntheticOtherKey maestrly-a1b2c3d4e5f6-old'
    writeFileSync(file, `${own}\n${key}\n${similar}`)
    await authorizeKey(shell, generateSshKey('maestrly-ffffffffffff').publicKey)
    expect(readFileSync(file, 'utf8').split('\n')[2]).toBe(similar)
    await revokeKey(shell, 'maestrly-a1b2c3d4e5f6')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines[0]).toBe(own)
    expect(lines[1]).toBe(similar)
    expect(lines[2]).toMatch(/ maestrly-ffffffffffff$/)
    expect(lines).toHaveLength(3)
  })
})
