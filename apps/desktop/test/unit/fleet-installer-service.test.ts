import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FleetConnectionView } from '../../src/main/fleet/client/service'
import { InstallerError } from '../../src/main/fleet/installer/errors'
import { renderBotServerEnv } from '../../src/main/fleet/installer/project'
import type { RunOptions, RunResult } from '../../src/main/fleet/installer/runner'
import {
  FleetInstallerService,
  pullDetail,
  type FleetInstallerDeps,
  type FleetInstallerFleet,
  type InstallerSession,
  type InstallerTunnel,
} from '../../src/main/fleet/installer/service'
import type { TunnelOptions } from '../../src/main/fleet/installer/tunnel'
import type { FleetInstallRecord, FleetInstallerStatus, FleetTunnelState } from '../../src/shared/fleet-installer'
import { FakeRunner, fail, ok } from '../fixtures/fleet-installer-fakes'

const at = '2026-09-27T12:00:00.000Z'
const localDir = path.join('/profile', 'bot-server')
const localFile = (name: string) => path.posix.join(localDir, name)
const info = ok(JSON.stringify({ OperatingSystem: 'OrbStack', ServerVersion: '29.4.0', MemTotal: 8589934592 }))
const pairing = ok('ABCD-EFGH (expires 2026-09-27T12:10:00.000Z)\n')
const images = {
  gateway: 'ghcr.io/antonioducs/maestrly-bot-gateway:0.9.4',
  bot: 'ghcr.io/antonioducs/maestrly-bot-instance:0.9.4',
}
const target = { host: '203.0.113.10', port: 22, username: 'root' }
const hostKey = 'SHA256:syntheticHostKey'
const probe = (lines: Record<string, string> = {}) =>
  Object.entries({
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
    ...lines,
  })
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

function dockerRunner(kind: 'local' | 'remote') {
  return new FakeRunner(kind)
    .on(['info'], info)
    .on(['compose', 'version'], ok('2.40.0\n'))
    .on(['ps'], ok(''))
    .on(['compose', 'port'], fail('no container found for service'))
    .on(['compose', 'exec'], pairing)
}

function fakeSession(script: (command: string, input: string) => RunResult | undefined = () => undefined) {
  const commands: Array<{ command: string; input: string }> = []
  const listeners = new Set<() => void>()
  let closed = false
  const session = {
    hostKey,
    root: true,
    commands,
    get closed() {
      return closed
    },
    async exec(command: string, options: RunOptions = {}): Promise<RunResult> {
      commands.push({ command, input: options.input ?? '' })
      return script(command, options.input ?? '') ?? ok()
    },
    async forward(): Promise<never> {
      throw new InstallerError('gateway-unhealthy')
    },
    onClose(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      closed = true
      for (const listener of listeners) listener()
    },
  }
  return session
}

function vpsScript(lines: Record<string, string> = {}) {
  return (_command: string, input: string): RunResult | undefined => {
    if (input.startsWith('# maestrly-bot-server:probe\n')) return ok(probe(lines))
    return undefined
  }
}

interface SetupOptions {
  record?: FleetInstallRecord | null
  key?: string | null
  connection?: Partial<FleetConnectionView>
  deps?: Partial<FleetInstallerDeps>
  vps?: ReturnType<typeof fakeSession>
  tunnelPort?: (options: TunnelOptions) => number
}

function setup(options: SetupOptions = {}) {
  const local = dockerRunner('local')
  const remote = dockerRunner('remote')
  const vps = options.vps ?? fakeSession(vpsScript())
  const keySession = fakeSession()
  const stored = { record: options.record ?? null, key: options.key ?? null }
  const fleetState = {
    connection: {
      features: ['environments'],
      state: 'unconfigured',
      deviceId: null,
      url: null,
      hostname: null,
      error: null,
      tokenPersistence: 'secure',
      ...options.connection,
    } as FleetConnectionView,
    connects: [] as Array<{ url: string; code: string; deviceName?: string }>,
    disconnects: 0,
    retargets: [] as string[],
    calls: [] as Array<[string, unknown]>,
    /** Every gateway call a test expects, by route: a value, or a function of the call's options. Others fail. */
    responses: {} as Record<string, unknown>,
    snapshot: { host: null, bots: [], environments: [], inbox: [], peerMessages: [] } as {
      host: { gatewayVersion: string } | null
      bots: unknown[]
      environments: unknown[]
      inbox: unknown[]
      peerMessages: unknown[]
    },
  }
  const fleet = {
    getConnection: () => fleetState.connection,
    async connect(input: { url: string; code: string; deviceName?: string }) {
      fleetState.connects.push(input)
      fleetState.connection = { ...fleetState.connection, url: input.url, deviceId: 'device-1', state: 'connected' }
      return fleetState.connection
    },
    async disconnect() {
      fleetState.disconnects++
      fleetState.connection = { ...fleetState.connection, url: null, deviceId: null, state: 'unconfigured' }
    },
    retarget: (url: string) => fleetState.retargets.push(url),
    hasFeature: (feature: string) => fleetState.connection.features.includes(feature),
    getSnapshot: () => fleetState.snapshot,
    async call(key: string, callOptions?: unknown) {
      fleetState.calls.push([key, callOptions])
      if (!(key in fleetState.responses)) throw new Error('Unexpected gateway call: ' + key)
      const response = fleetState.responses[key]
      return typeof response === 'function' ? response(callOptions) : response
    },
  } as unknown as FleetInstallerFleet
  const connections: Array<{ credentials: { kind: string }; expectedHostKey: string | null }> = []
  const tunnels: Array<{ options: TunnelOptions; stopped: boolean }> = []
  const broadcasts: FleetInstallerStatus[] = []
  const removedDirs: string[] = []
  const metaOrigins: string[] = []
  // Ports held by started tunnels, so that the default free port skips them as the real one would.
  const busy = new Set<number>()
  const deps: FleetInstallerDeps = {
    appVersion: '0.9.4',
    isPackaged: true,
    env: {},
    userDataDir: () => '/profile',
    hostname: 'Estação de Trabalho',
    timezone: 'America/Sao_Paulo',
    localRunner: () => local,
    async connectSsh(_target, credentials, connectOptions): Promise<InstallerSession> {
      connections.push({ credentials, expectedHostKey: connectOptions.expectedHostKey })
      if (connectOptions.expectedHostKey && connectOptions.expectedHostKey !== hostKey)
        throw new InstallerError('ssh-host-key', hostKey)
      return (credentials.kind === 'key' ? keySession : vps) as unknown as InstallerSession
    },
    remoteRunner: () => remote,
    createTunnel(tunnelOptions): InstallerTunnel {
      const entry = { options: tunnelOptions, stopped: false }
      tunnels.push(entry)
      let state: FleetTunnelState = 'off'
      let port = tunnelOptions.listenPort
      return {
        async start() {
          port = options.tunnelPort?.(tunnelOptions) ?? tunnelOptions.listenPort
          busy.add(port)
          // As the real tunnel: a given session carries the traffic, else Maestrly's key signs in.
          state = tunnelOptions.session || tunnelOptions.privateKey() !== null ? 'connected' : 'needs-credentials'
          tunnelOptions.onState?.(state)
          return port
        },
        async stop() {
          entry.stopped = true
          busy.delete(port)
          state = 'off'
        },
        get port() {
          return port
        },
        get state() {
          return state
        },
        lastForwardError: null,
      }
    },
    fleet,
    store: {
      readRecord: () => (stored.record ? structuredClone(stored.record) : null),
      writeRecord: (record) => {
        stored.record = structuredClone(record)
      },
      clearRecord: () => {
        stored.record = null
      },
      readKey: () => stored.key,
      saveKey: (privateKey) => {
        stored.key = privateKey
        return 'secure'
      },
      clearKey: () => {
        stored.key = null
      },
      keyPersistence: () => (stored.key ? 'secure' : null),
    },
    async fetchMeta(origin) {
      metaOrigins.push(origin)
    },
    freePort: async (preferred) => {
      let port = preferred
      while (busy.has(port)) port++
      return port
    },
    broadcast: (status) => broadcasts.push(status),
    readBundledCompose: async () => 'services: {}\n',
    runImageBuilder: async () => ok(),
    removeLocalDir: async (dir) => {
      removedDirs.push(dir)
    },
    now: () => new Date(at),
    randomId: (length) => 'a'.repeat(length),
    healthTimeoutMs: 50,
    pollMs: 5,
    ...options.deps,
  }
  return {
    service: new FleetInstallerService(deps),
    local,
    remote,
    vps,
    keySession,
    stored,
    fleetState,
    connections,
    tunnels,
    broadcasts,
    removedDirs,
    metaOrigins,
  }
}

const steps = (status: FleetInstallerStatus) => status.job?.steps.map((step) => [step.id, step.state])

const localRecord = (patch: Partial<FleetInstallRecord> = {}): FleetInstallRecord => ({
  mode: 'local',
  version: '0.9.3',
  port: 7450,
  allowPrivateNetwork: false,
  remote: null,
  installedAt: at,
  ...patch,
})
const remoteRecord = (patch: Partial<FleetInstallRecord> = {}): FleetInstallRecord => ({
  mode: 'remote',
  version: '0.9.4',
  port: 7443,
  allowPrivateNetwork: false,
  remote: { ...target, hostKey, keyTag: 'maestrly-bbbbbbbbbbbb' },
  installedAt: at,
  ...patch,
})

describe('installing on this computer', () => {
  it('checks Docker, writes the project, downloads the images, starts, pairs, and records the install', async () => {
    const { service, local, fleetState, stored, broadcasts, metaOrigins } = setup()
    const status = await service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })
    expect(status.job).toMatchObject({ kind: 'install-local', mode: 'local', state: 'succeeded', error: null })
    expect(steps(status)).toEqual([
      ['check', 'done'],
      ['files', 'done'],
      ['images', 'done'],
      ['start', 'done'],
      ['pair', 'done'],
    ])
    expect(status.job?.steps[0].detail).toBe('OrbStack 29.4.0')
    expect(local.files.get(localFile('compose.yml'))).toBe('services: {}\n')
    expect(local.files.get(localFile('.env'))).toBe(
      renderBotServerEnv({
        gatewayImage: images.gateway,
        botImage: images.bot,
        port: 7443,
        artifactsPort: 4011,
        displayName: 'Estação de Trabalho',
        egress: 'public',
        timezone: 'America/Sao_Paulo',
      })
    )
    expect(local.commands(['pull'])).toEqual([
      ['pull', images.gateway],
      ['pull', images.bot],
    ])
    expect(local.commands(['compose', 'up'])).toEqual([['compose', 'up', '-d', '--no-build']])
    expect(metaOrigins).toEqual(['http://127.0.0.1:7443'])
    expect(fleetState.connects).toEqual([{ url: 'http://127.0.0.1:7443', code: 'ABCD-EFGH', deviceName: 'Mac' }])
    expect(stored.record).toEqual({
      mode: 'local',
      artifactsPort: 4011,
      version: '0.9.4',
      port: 7443,
      allowPrivateNetwork: false,
      remote: null,
      installedAt: at,
    })
    expect(status).toMatchObject({ update: 'none', tunnel: 'off', keyPersistence: null })
    // Progress is broadcast from the first pending step to the end.
    expect(broadcasts[0].job?.state).toBe('running')
    expect(broadcasts[0].job?.steps.every((step) => step.state === 'pending')).toBe(true)
    expect(broadcasts.at(-1)?.job?.state).toBe('succeeded')
  })

  it('names what is wrong with Docker and records nothing', async () => {
    const cases: Array<[string, (runner: FakeRunner) => void]> = [
      [
        'docker-missing',
        (runner) =>
          runner.on(['info'], () => {
            throw new InstallerError('docker-missing')
          }),
      ],
      ['docker-stopped', (runner) => runner.on(['info'], fail('Cannot connect to the Docker daemon'))],
      ['docker-permission', (runner) => runner.on(['info'], fail('permission denied while trying to connect'))],
      [
        'compose-missing',
        (runner) => runner.on(['compose', 'version'], fail("docker: 'compose' is not a docker command.")),
      ],
    ]
    for (const [code, arrange] of cases) {
      const { service, local, stored } = setup()
      arrange(local)
      const status = await service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })
      expect(status.job?.error?.code, code).toBe(code)
      expect(steps(status)?.[0]).toEqual(['check', 'failed'])
      expect(stored.record).toBeNull()
      expect(local.commands(['compose', 'up'])).toEqual([])
    }
    const development = setup({ deps: { isPackaged: false } })
    development.local.on(['ps'], ok('3f2a\n'))
    const status = await development.service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })
    expect(status.job?.error?.code).toBe('dev-fleet-running')
    expect(await development.service.checkLocal()).toMatchObject({ state: 'dev-fleet', engine: 'OrbStack' })
  })

  it('keeps the recorded port, else the gateway’s published one, else the first free one', async () => {
    const recorded = setup({ record: localRecord() })
    await recorded.service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })
    expect(recorded.local.files.get(localFile('.env'))).toContain('MAESTRLY_GATEWAY_PORT=7450\n')
    const published = setup()
    published.local.on(['compose', 'port'], ok('127.0.0.1:7461\n'))
    await published.service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: true })
    expect(published.local.files.get(localFile('.env'))).toContain('MAESTRLY_GATEWAY_PORT=7461\n')
    expect(published.local.files.get(localFile('.env'))).toContain('MAESTRLY_GATEWAY_BOT_EGRESS=open\n')
    const free = setup({ deps: { freePort: async (preferred) => (preferred === 7443 ? 7470 : preferred) } })
    await free.service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })
    expect(free.local.files.get(localFile('.env'))).toContain('MAESTRLY_GATEWAY_PORT=7470\n')
    expect(free.stored.record?.port).toBe(7470)
  })

  it('does not pair again with the server this computer is already paired with', async () => {
    const { service, fleetState, local } = setup({
      connection: { url: 'http://127.0.0.1:7443', deviceId: 'device-1', state: 'connected' },
    })
    const status = await service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })
    expect(steps(status)?.at(-1)).toEqual(['pair', 'skipped'])
    expect(fleetState.connects).toEqual([])
    expect(local.commands(['compose', 'exec'])).toEqual([])
  })

  it('builds the checkout’s images in a development build when they are missing', async () => {
    let built = false
    const builds: RunOptions[] = []
    const { service, local } = setup({
      deps: {
        isPackaged: false,
        runImageBuilder: async (options) => {
          builds.push(options)
          built = true
          return ok()
        },
      },
    })
    local.on(['image', 'inspect'], () => (built ? ok('sha256:1\n') : fail('Error: No such image')))
    const status = await service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })
    expect(status.job?.state).toBe('succeeded')
    expect(builds).toHaveLength(1)
    expect(local.commands(['pull'])).toEqual([])
    expect(local.files.get(localFile('.env'))).toContain('MAESTRLY_GATEWAY_BOT_IMAGE=maestrly/bot-instance:local\n')
    const failing = setup({ deps: { isPackaged: false, runImageBuilder: async () => fail('ERROR: failed to solve') } })
    failing.local.on(['image', 'inspect'], fail('Error: No such image'))
    const failed = await failing.service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })
    expect(failed.job?.error).toEqual({ code: 'image-build-failed', detail: 'ERROR: failed to solve' })
  })

  it('stops the download when cancelled and records nothing', async () => {
    let signal: AbortSignal | undefined
    const { service, local, stored } = setup()
    local.on(
      ['pull'],
      (_args, runOptions) =>
        new Promise<RunResult>((_resolve, reject) => {
          signal = runOptions?.signal
          signal?.addEventListener('abort', () => reject(new InstallerError('cancelled')))
        })
    )
    const running = service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })
    await expect(service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })).rejects.toMatchObject({
      code: 'job-running',
    })
    while (!signal) await new Promise((resolve) => setTimeout(resolve, 1))
    service.cancel()
    const status = await running
    expect(signal.aborted).toBe(true)
    expect(status.job).toMatchObject({ state: 'cancelled', error: { code: 'cancelled', detail: null } })
    expect(steps(status)?.[2]).toEqual(['images', 'failed'])
    expect(stored.record).toBeNull()
  })
})

describe('installing on a VPS', () => {
  it('installs over SSH, pairs through a temporary tunnel, then keeps its own key and tunnel', async () => {
    const { service, vps, keySession, remote, connections, tunnels, stored, fleetState, metaOrigins } = setup()
    const status = await service.installRemote({
      target,
      credentials: { kind: 'password', password: 'synthetic-root-password' },
      deviceName: 'Mac',
      allowPrivateNetwork: false,
    })
    expect(status.job?.error).toBeNull()
    expect(steps(status)).toEqual([
      ['connect', 'done'],
      ['check', 'done'],
      ['docker', 'skipped'],
      ['files', 'done'],
      ['images', 'done'],
      ['start', 'done'],
      ['tunnel', 'done'],
      ['pair', 'done'],
      ['key', 'done'],
    ])
    expect(status.job?.hostKey).toBe(hostKey)
    // Trusted on first use, then pinned for Maestrly's own key.
    expect(connections).toEqual([
      { credentials: { kind: 'password', password: 'synthetic-root-password' }, expectedHostKey: null },
      expect.objectContaining({ credentials: expect.objectContaining({ kind: 'key' }), expectedHostKey: hostKey }),
    ])
    expect(remote.files.get('/opt/maestrly-bots/.env')).toContain("MAESTRLY_GATEWAY_DISPLAY_NAME='vps-synthetic'\n")
    expect(remote.files.get('/opt/maestrly-bots/.env')).toContain('MAESTRLY_GATEWAY_PORT=7443\n')
    expect(remote.commands(['pull'])).toEqual([
      ['pull', images.gateway],
      ['pull', images.bot],
    ])
    expect(remote.commands(['compose', 'up'])).toHaveLength(1)
    const [temporary, persistent] = tunnels
    expect(temporary.stopped).toBe(true)
    expect(persistent.stopped).toBe(false)
    expect(persistent.options).toMatchObject({ target, hostKey, listenPort: 7443 })
    expect(metaOrigins).toEqual(['http://127.0.0.1:7443'])
    expect(fleetState.connects).toEqual([{ url: 'http://127.0.0.1:7443', code: 'ABCD-EFGH', deviceName: 'Mac' }])
    const authorize = vps.commands.find((item) => item.input.startsWith('# maestrly-bot-server:authorize-key\n'))
    expect(authorize?.command).toMatch(/^sh -s -- 'ssh-ed25519 \S+ maestrly-aaaaaaaaaaaa'$/)
    expect(stored.key).toContain('OPENSSH PRIVATE KEY')
    expect(persistent.options.privateKey()).toBe(stored.key)
    expect(stored.record).toEqual({
      mode: 'remote',
      artifactsPort: 4011,
      remoteArtifactsPort: 4010,
      version: '0.9.4',
      port: 7443,
      allowPrivateNetwork: false,
      remote: { ...target, hostKey, keyTag: 'maestrly-aaaaaaaaaaaa' },
      installedAt: at,
    })
    expect(status).toMatchObject({ tunnel: 'connected', keyPersistence: 'secure', update: 'none' })
    expect(vps.closed).toBe(true)
    expect(keySession.closed).toBe(true)
    // The password was used by the job only.
    expect(JSON.stringify(stored)).not.toContain('synthetic-root-password')
  })

  it('installs Docker when the server has none', async () => {
    const { service, vps } = setup({ vps: fakeSession(vpsScript({ docker: '0', compose: '0' })) })
    const status = await service.installRemote({
      target,
      credentials: { kind: 'password', password: 'synthetic-root-password' },
      deviceName: 'Mac',
      allowPrivateNetwork: false,
    })
    expect(steps(status)?.[2]).toEqual(['docker', 'done'])
    expect(vps.commands.some((item) => item.input.startsWith('# maestrly-bot-server:install-docker\n'))).toBe(true)
  })

  it('joins a server Maestrly already installed without changing it', async () => {
    const existing = renderBotServerEnv({
      gatewayImage: 'ghcr.io/antonioducs/maestrly-bot-gateway:0.9.1',
      botImage: 'ghcr.io/antonioducs/maestrly-bot-instance:0.9.1',
      port: 7443,
      displayName: 'vps-synthetic',
      egress: 'open',
      timezone: 'Etc/UTC',
    })
    const { service, remote, stored } = setup({
      vps: fakeSession(vpsScript({ existing_env: Buffer.from(existing).toString('base64') })),
    })
    const status = await service.installRemote({
      target,
      credentials: { kind: 'password', password: 'synthetic-root-password' },
      deviceName: 'Mac',
      allowPrivateNetwork: false,
    })
    expect(steps(status)?.slice(3, 6)).toEqual([
      ['files', 'skipped'],
      ['images', 'skipped'],
      ['start', 'done'],
    ])
    expect(remote.files.size).toBe(0)
    expect(remote.commands(['pull'])).toEqual([])
    expect(remote.commands(['compose', 'up'])).toHaveLength(1)
    expect(stored.record).toMatchObject({ version: '0.9.1', allowPrivateNetwork: true })
    expect(status.update).toBe('available')
  })

  it('refuses an unsupported server before installing anything', async () => {
    const { service, vps } = setup({ vps: fakeSession(vpsScript({ os_id: 'ubuntu', os_version: '20.04' })) })
    const status = await service.installRemote({
      target,
      credentials: { kind: 'password', password: 'synthetic-root-password' },
      deviceName: 'Mac',
      allowPrivateNetwork: false,
    })
    expect(status.job?.error?.code).toBe('os-unsupported')
    expect(vps.commands.some((item) => item.input.includes('install-docker'))).toBe(false)
    expect(vps.closed).toBe(true)
  })

  it('refuses a server whose host key changed since it was installed', async () => {
    const { service } = setup({
      record: remoteRecord({ remote: { ...target, hostKey: 'SHA256:other', keyTag: 'maestrly-bbbbbbbbbbbb' } }),
    })
    const status = await service.installRemote({
      target,
      credentials: { kind: 'password', password: 'synthetic-root-password' },
      deviceName: 'Mac',
      allowPrivateNetwork: false,
    })
    expect(status.job?.error).toEqual({ code: 'ssh-host-key', detail: hostKey })
    expect(steps(status)?.[0]).toEqual(['connect', 'failed'])
  })

  it('refuses a development build on a VPS before writing anything there', async () => {
    const { service, remote } = setup({ deps: { isPackaged: false } })
    const status = await service.installRemote({
      target,
      credentials: { kind: 'password', password: 'synthetic-root-password' },
      deviceName: 'Mac',
      allowPrivateNetwork: false,
    })
    expect(status.job?.error?.code).toBe('images-unavailable')
    expect(status.job?.error?.detail).toContain('MAESTRLY_BOT_SERVER_REGISTRY')
    expect(steps(status)?.[3]).toEqual(['files', 'failed'])
    expect(remote.files.size).toBe(0)
  })

  it('keeps a pairing it did not make when a later step fails', async () => {
    const vps = fakeSession((_command, input) => {
      if (input.startsWith('# maestrly-bot-server:probe\n')) return ok(probe())
      if (input.startsWith('# maestrly-bot-server:authorize-key\n'))
        return fail('touch: cannot touch: Read-only file system')
      return undefined
    })
    const { service, fleetState } = setup({
      vps,
      connection: { url: 'http://127.0.0.1:7443', deviceId: 'device-1', state: 'connected' },
    })
    const status = await service.installRemote({
      target,
      credentials: { kind: 'password', password: 'synthetic-root-password' },
      deviceName: 'Mac',
      allowPrivateNetwork: false,
    })
    expect(status.job?.error?.code).toBe('unknown')
    expect(steps(status)?.[7]).toEqual(['pair', 'skipped'])
    expect(fleetState.disconnects).toBe(0)
  })

  it('sets up the same server again on its own port, keeps the pairing, and revokes the lost key', async () => {
    const { service, vps, tunnels, stored, fleetState } = setup({
      record: remoteRecord(),
      key: null,
      connection: { url: 'http://127.0.0.1:7443', deviceId: 'device-1', state: 'reconnecting' },
      vps: fakeSession(
        vpsScript({
          existing_env: Buffer.from('MAESTRLY_GATEWAY_IMAGE=ghcr.io/antonioducs/maestrly-bot-gateway:0.9.4\n').toString(
            'base64'
          ),
        })
      ),
    })
    await service.start()
    expect(service.status().tunnel).toBe('needs-credentials')
    const status = await service.installRemote({
      target,
      credentials: { kind: 'password', password: 'synthetic-root-password' },
      deviceName: 'Mac',
      allowPrivateNetwork: false,
    })
    expect(status.job?.error).toBeNull()
    // The idle tunnel stopped first, so the temporary one and the new one take the recorded port.
    expect(tunnels.map((tunnel) => [tunnel.options.listenPort, tunnel.stopped])).toEqual([
      [7443, true],
      [7443, true],
      [7443, false],
      [4011, false],
    ])
    expect(steps(status)?.[7]).toEqual(['pair', 'skipped'])
    expect(fleetState.connects).toEqual([])
    const scripts = vps.commands.map((item) => item.input.split('\n')[0]).filter((line) => line.startsWith('#'))
    expect(scripts.slice(-2)).toEqual(['# maestrly-bot-server:authorize-key', '# maestrly-bot-server:revoke-key'])
    expect(vps.commands.at(-1)?.command).toBe("sh -s -- 'maestrly-bbbbbbbbbbbb'")
    expect(stored.record?.remote?.keyTag).toBe('maestrly-aaaaaaaaaaaa')
    expect(status.tunnel).toBe('connected')
  })

  it('reopens the tunnel of the recorded server when setting it up again fails', async () => {
    const { service, tunnels, stored } = setup({
      record: remoteRecord(),
      key: 'synthetic-private-key',
      vps: fakeSession(vpsScript({ os_version: '20.04' })),
    })
    await service.start()
    const status = await service.installRemote({
      target,
      credentials: { kind: 'password', password: 'synthetic-root-password' },
      deviceName: 'Mac',
      allowPrivateNetwork: false,
    })
    expect(status.job?.error?.code).toBe('os-unsupported')
    expect(stored.record?.remote?.keyTag).toBe('maestrly-bbbbbbbbbbbb')
    expect(tunnels.map((tunnel) => tunnel.stopped)).toEqual([true, false])
    expect(service.status().tunnel).toBe('connected')
  })

  it('undoes the pairing when the key cannot be set up', async () => {
    const vps = fakeSession((_command, input) => {
      if (input.startsWith('# maestrly-bot-server:probe\n')) return ok(probe())
      if (input.startsWith('# maestrly-bot-server:authorize-key\n'))
        return fail('touch: cannot touch: Read-only file system')
      return undefined
    })
    const { service, fleetState, stored, tunnels } = setup({ vps })
    const status = await service.installRemote({
      target,
      credentials: { kind: 'password', password: 'synthetic-root-password' },
      deviceName: 'Mac',
      allowPrivateNetwork: false,
    })
    expect(status.job?.error?.code).toBe('unknown')
    expect(fleetState.connects).toHaveLength(1)
    expect(fleetState.disconnects).toBe(1)
    expect(stored).toEqual({ record: null, key: null })
    expect(tunnels.every((tunnel) => tunnel.stopped)).toBe(true)
  })
})

describe('keeping the server up to date', () => {
  const oldEnv = renderBotServerEnv({
    gatewayImage: 'ghcr.io/antonioducs/maestrly-bot-gateway:0.9.3',
    botImage: 'ghcr.io/antonioducs/maestrly-bot-instance:0.9.3',
    port: 7450,
    displayName: 'Estação antiga',
    egress: 'public',
    timezone: 'Europe/Lisbon',
  })

  it('moves the server to the app’s images, keeping its port, name and time zone', async () => {
    const { service, local, stored } = setup({ record: localRecord() })
    local.files.set(localFile('.env'), oldEnv)
    local.on(['image', 'ls'], (args) => ok(`${args.at(-1)}:0.9.4\n${args.at(-1)}:0.9.3\n`))
    expect(service.status().update).toBe('available')
    const status = await service.update()
    expect(steps(status)).toEqual([
      ['files', 'done'],
      ['images', 'done'],
      ['start', 'done'],
      // Not connected to a gateway that schedules updates: environments keep their own Update button.
      ['environment-updates', 'skipped'],
    ])
    expect(local.files.get(localFile('.env'))).toBe(oldEnv.replace(/:0\.9\.3/g, ':0.9.4'))
    expect(local.commands(['pull'])).toEqual([
      ['pull', images.gateway],
      ['pull', images.bot],
    ])
    expect(local.commands(['image', 'rm'])).toEqual([
      ['image', 'rm', 'ghcr.io/antonioducs/maestrly-bot-gateway:0.9.3'],
      ['image', 'rm', 'ghcr.io/antonioducs/maestrly-bot-instance:0.9.3'],
    ])
    expect(stored.record?.version).toBe('0.9.4')
    expect(status.update).toBe('none')
  })

  it('never moves a newer server back', async () => {
    const { service, local } = setup({ record: localRecord({ version: '0.9.5' }) })
    const status = await service.update()
    expect(status.update).toBe('server-newer')
    expect(status.job).toBeNull()
    expect(local.calls).toEqual([])
  })

  it('never moves back a server another computer updated, as its files tell', async () => {
    const { service, local, stored } = setup({ record: localRecord() })
    const newerEnv = oldEnv.replace(/:0\.9\.3/g, ':0.9.9')
    local.files.set(localFile('.env'), newerEnv)
    expect(service.status().update).toBe('available')
    const status = await service.update()
    expect(status.job?.state).toBe('failed')
    expect(status.job?.error?.code).toBe('server-newer')
    expect(steps(status)?.[0]).toEqual(['files', 'failed'])
    expect(local.files.get(localFile('.env'))).toBe(newerEnv)
    expect(local.commands(['pull'])).toEqual([])
    expect(local.commands(['compose', 'up'])).toEqual([])
    expect(stored.record?.version).toBe('0.9.9')
    expect(status.update).toBe('server-newer')
  })

  it('takes the version the connected gateway reports over the recorded one', async () => {
    const { service, local, fleetState } = setup({
      record: localRecord(),
      connection: { url: 'http://127.0.0.1:7450', deviceId: 'device-1', state: 'connected' },
    })
    fleetState.snapshot.host = { gatewayVersion: '0.9.9' }
    expect(service.status().update).toBe('server-newer')
    const status = await service.update()
    expect(status.job).toBeNull()
    expect(local.calls).toEqual([])
    fleetState.snapshot.host = { gatewayVersion: '0.9.4' }
    expect(service.status().update).toBe('none')
    // A development gateway reports no release version: the recorded one counts.
    fleetState.snapshot.host = { gatewayVersion: '1' }
    expect(service.status().update).toBe('available')
    // A reconnecting client may still hold the old gateway's host: only a connected one counts.
    fleetState.snapshot.host = { gatewayVersion: '0.9.9' }
    fleetState.connection = { ...fleetState.connection, state: 'reconnecting' }
    expect(service.status().update).toBe('available')
  })

  it('switches what bots may reach and restarts the gateway', async () => {
    const { service, local, stored } = setup({ record: localRecord() })
    local.files.set(localFile('.env'), oldEnv)
    const status = await service.setPrivateNetwork(true)
    expect(steps(status)).toEqual([
      ['files', 'done'],
      ['start', 'done'],
    ])
    expect(local.files.get(localFile('.env'))).toBe(oldEnv.replace('BOT_EGRESS=public', 'BOT_EGRESS=open'))
    expect(local.files.has(localFile('compose.yml'))).toBe(false)
    expect(local.commands(['compose', 'up'])).toHaveLength(1)
    expect(stored.record?.allowPrivateNetwork).toBe(true)
  })
})

describe('updating bots in one click', () => {
  const oldEnv = renderBotServerEnv({
    gatewayImage: 'ghcr.io/antonioducs/maestrly-bot-gateway:0.9.3',
    botImage: 'ghcr.io/antonioducs/maestrly-bot-instance:0.9.3',
    port: 7450,
    displayName: 'Estação antiga',
    egress: 'public',
    timezone: 'Europe/Lisbon',
  })
  const environment = (
    id: string,
    lifecycle: string,
    update: { available: boolean; pendingSince: string | null } | null
  ) => ({ id, name: 'Environment ' + id, lifecycle, update })
  const listed = [
    environment('a', 'running', { available: true, pendingSince: null }),
    environment('b', 'running', { available: true, pendingSince: at }),
    environment('c', 'stopped', { available: true, pendingSince: null }),
    environment('d', 'running', { available: false, pendingSince: null }),
    environment('e', 'running', null),
  ]
  const connected = { url: 'http://127.0.0.1:7450', deviceId: 'device-1', state: 'connected' as const }
  const updatesFeature = ['environments', 'environment-updates']
  /** A gateway that lists these environments and schedules each update it is asked for, but the failing ones. */
  function gateway(fleetState: ReturnType<typeof setup>['fleetState'], environments = listed, failing: string[] = []) {
    fleetState.responses = {
      environmentsList: { environments },
      environmentUpdate: (options: { params: { eid: string }; body: unknown }) => {
        if (failing.includes(options.params.eid)) throw new Error('Synthetic refusal')
        return { ...environments.find((item) => item.id === options.params.eid), body: options.body }
      },
    }
  }
  const updates = (fleetState: ReturnType<typeof setup>['fleetState']) =>
    fleetState.calls.filter(([key]) => key === 'environmentUpdate')

  it('schedules only running environments with an update that none waits for', async () => {
    const { fleetState, service } = setup({ connection: { ...connected, features: updatesFeature } })
    gateway(fleetState)
    const result = await service.updateBots()
    expect(result.status.job).toBeNull()
    expect(result.environments).toEqual({ supported: true, scheduled: ['a'], failed: [] })
    expect(updates(fleetState)).toEqual([['environmentUpdate', { params: { eid: 'a' }, body: { when: 'idle' } }]])
  })

  it('schedules the others when one environment refuses', async () => {
    const { fleetState, service } = setup({ connection: { ...connected, features: updatesFeature } })
    const two = [
      environment('a', 'running', { available: true, pendingSince: null }),
      environment('f', 'running', { available: true, pendingSince: null }),
    ]
    gateway(fleetState, two, ['a'])
    const result = await service.updateBots()
    expect(result.environments).toEqual({
      supported: true,
      scheduled: ['f'],
      failed: [{ environmentId: 'a', name: 'Environment a', message: 'Synthetic refusal' }],
    })
  })

  it('waits for a gateway that schedules updates, and schedules nothing on one that does not', async () => {
    const { fleetState } = setup({ connection: { ...connected, features: ['environments'] } })
    gateway(fleetState)
    const { scheduleEnvironmentUpdates } = await import('../../src/main/fleet/installer/environment-updates')
    let asked = 0
    const fleet = {
      getConnection: () => fleetState.connection,
      hasFeature: (feature: string) => {
        // The client reconnects to the updated gateway after two checks.
        if (++asked > 2) fleetState.connection = { ...fleetState.connection, features: updatesFeature }
        return fleetState.connection.features.includes(feature)
      },
      call: (key: string, options?: unknown) =>
        (fleetState.responses[key] as (value?: unknown) => unknown) instanceof Function
          ? (fleetState.responses[key] as (value?: unknown) => unknown)(options)
          : fleetState.responses[key],
    } as unknown as FleetInstallerFleet
    expect(await scheduleEnvironmentUpdates(fleet, { waitMs: 1000, pollMs: 1 })).toMatchObject({ scheduled: ['a'] })

    const old = setup({ connection: { ...connected, features: ['environments'] } })
    const result = await old.service.updateBots()
    expect(result.environments).toEqual({ supported: false, scheduled: [], failed: [] })
    expect(old.fleetState.calls).toEqual([])
  })

  it('updates the server first, then schedules its environments once the gateway is back', async () => {
    const { service, local, stored, fleetState } = setup({
      record: localRecord(),
      connection: { ...connected, features: updatesFeature },
    })
    local.files.set(localFile('.env'), oldEnv)
    local.on(['image', 'ls'], () => ok(''))
    const recorded: Array<string | null | undefined> = []
    gateway(fleetState)
    const list = fleetState.responses.environmentsList
    fleetState.responses.environmentsList = () => {
      recorded.push(stored.record?.version)
      return list
    }
    const result = await service.updateBots()
    expect(steps(result.status)).toEqual([
      ['files', 'done'],
      ['images', 'done'],
      ['start', 'done'],
      ['environment-updates', 'done'],
    ])
    // The server is recorded as updated before its environments are scheduled.
    expect(recorded).toEqual(['0.9.4'])
    expect(result.environments).toEqual({ supported: true, scheduled: ['a'], failed: [] })
    expect(updates(fleetState)).toHaveLength(1)
  })

  it('schedules no environment when the server update fails', async () => {
    const { service, local, fleetState } = setup({
      record: localRecord(),
      connection: { ...connected, features: updatesFeature },
    })
    local.files.set(localFile('.env'), oldEnv)
    local.on(['pull'], fail('manifest unknown'))
    gateway(fleetState)
    const result = await service.updateBots()
    expect(result.status.job?.state).toBe('failed')
    expect(result.environments).toBeNull()
    expect(fleetState.calls).toEqual([])
  })

  it('reports no environment update while another server task runs', async () => {
    const { service, local, fleetState } = setup({
      record: localRecord(),
      connection: { ...connected, features: updatesFeature },
    })
    local.files.set(localFile('.env'), oldEnv)
    gateway(fleetState)
    const running = service.setPrivateNetwork(true)
    await expect(service.updateBots()).rejects.toMatchObject({ code: 'job-running' })
    await running
  })
})

describe('leaving and removing the server', () => {
  it('unpairs, revokes Maestrly’s key on the VPS, and forgets the install', async () => {
    const { service, keySession, fleetState, stored, tunnels } = setup({
      record: remoteRecord(),
      key: 'synthetic-private-key',
    })
    await service.start()
    const status = await service.disconnect()
    expect(fleetState.disconnects).toBe(1)
    const revoke = keySession.commands.find((item) => item.input.startsWith('# maestrly-bot-server:revoke-key\n'))
    expect(revoke?.command).toBe("sh -s -- 'maestrly-bbbbbbbbbbbb'")
    expect(tunnels[0].stopped).toBe(true)
    expect(stored).toEqual({ record: null, key: null })
    expect(status).toMatchObject({ record: null, tunnel: 'off', keyPersistence: null })
  })

  it('forgets the install even when the server cannot be reached', async () => {
    const { service, stored } = setup({
      record: remoteRecord(),
      key: 'synthetic-private-key',
      deps: {
        connectSsh: async () => {
          throw new InstallerError('ssh-unreachable', 'ETIMEDOUT')
        },
      },
    })
    await service.disconnect()
    expect(stored).toEqual({ record: null, key: null })
  })

  it('deletes every environment and bot through the gateway, then the server and its files', async () => {
    const { service, local, fleetState, stored, removedDirs } = setup({
      record: localRecord({ version: '0.9.4', port: 7443 }),
      connection: { url: 'http://127.0.0.1:7443', deviceId: 'device-1', state: 'connected' },
    })
    local.files.set(
      localFile('.env'),
      renderBotServerEnv({
        gatewayImage: images.gateway,
        botImage: images.bot,
        port: 7443,
        displayName: 'x',
        egress: 'public',
        timezone: 'Etc/UTC',
      })
    )
    fleetState.responses = {
      environmentsList: { environments: [{ id: 'work', name: 'Work', lifecycle: 'running' }] },
      environmentArchive: { id: 'work', name: 'Work', lifecycle: 'archived' },
      archivedEnvironmentsList: {
        environments: [
          { id: 'work', name: 'Work' },
          { id: 'old', name: 'Old' },
        ],
      },
      archivedEnvironmentDelete: undefined,
      archivedBotsList: { bots: [{ id: 'scout', name: 'Scout' }] },
      archivedBotDelete: undefined,
    }
    const status = await service.remove()
    expect(steps(status)).toEqual([
      ['environments', 'done'],
      ['teardown', 'done'],
    ])
    expect(fleetState.calls).toEqual([
      ['environmentsList', undefined],
      ['environmentArchive', { params: { eid: 'work' } }],
      ['archivedEnvironmentsList', undefined],
      ['archivedEnvironmentDelete', { params: { eid: 'work' } }],
      ['archivedEnvironmentDelete', { params: { eid: 'old' } }],
      ['archivedBotsList', { query: { separateEnvironments: 1 } }],
      ['archivedBotDelete', { params: { id: 'scout' } }],
    ])
    expect(fleetState.disconnects).toBe(1)
    expect(local.commands(['compose', 'down'])).toEqual([['compose', 'down', '-v', '--remove-orphans']])
    expect(local.commands(['image', 'rm'])).toEqual([
      ['image', 'rm', images.gateway],
      ['image', 'rm', images.bot],
    ])
    expect(removedDirs).toEqual([localDir])
    expect(stored.record).toBeNull()
  })

  it('removes Maestrly’s files and key from a VPS, and refuses to remove without a connection', async () => {
    const { service, keySession, fleetState } = setup({
      record: remoteRecord(),
      key: 'synthetic-private-key',
      connection: { url: 'http://127.0.0.1:7443', deviceId: 'device-1', state: 'connected' },
    })
    fleetState.responses = {
      environmentsList: { environments: [] },
      archivedEnvironmentsList: { environments: [] },
      archivedBotsList: { bots: [] },
    }
    const status = await service.remove()
    expect(status.job?.state).toBe('succeeded')
    expect(keySession.commands.map((item) => item.input.split('\n')[0])).toEqual([
      '# maestrly-bot-server:revoke-key',
      '# maestrly-bot-server:remove-project',
    ])
    const offline = setup({ record: localRecord(), connection: { state: 'reconnecting' } })
    await expect(offline.service.remove()).rejects.toMatchObject({ code: 'not-connected' })
  })
})

describe('the tunnel at startup', () => {
  it('opens the tunnel of a VPS install and follows it to another port', async () => {
    const { service, tunnels, stored, fleetState } = setup({
      record: remoteRecord(),
      key: 'synthetic-private-key',
      tunnelPort: () => 7471,
    })
    await service.start()
    expect(tunnels).toHaveLength(1)
    expect(tunnels[0].options).toMatchObject({ target, hostKey, listenPort: 7443 })
    expect(stored.record?.port).toBe(7471)
    expect(fleetState.retargets).toEqual(['http://127.0.0.1:7471'])
    expect(service.status().tunnel).toBe('connected')
  })

  it('asks for access again without a key, and does nothing for a local install or a bot', async () => {
    const withoutKey = setup({ record: remoteRecord(), key: null })
    await withoutKey.service.start()
    expect(withoutKey.service.status().tunnel).toBe('needs-credentials')
    const local = setup({ record: localRecord() })
    await local.service.start()
    expect(local.tunnels).toHaveLength(0)
    const bot = setup({ record: remoteRecord(), key: 'k', deps: { env: { MAESTRLY_BOT_MODE: '1' } } })
    await bot.service.start()
    expect(bot.tunnels).toHaveLength(0)
  })
})

describe('image download progress', () => {
  const progress = (lines: string[]) => {
    const details: Array<string | null> = []
    const push = pullDetail('registry.example.test/maestrly-bot-gateway:0.9.4', (text) => details.push(text))
    for (const line of lines) push(line)
    return details.at(-1)
  }

  it('counts the layers of a download on the classic image store', () => {
    expect(
      progress([
        '0.9.4: Pulling from maestrly-bot-gateway',
        'e0efe4312ea5: Already exists',
        'e88e872a61b8: Pulling fs layer',
        'e88e872a61b8: Waiting',
        'e88e872a61b8: Verifying Checksum',
        'e88e872a61b8: Download complete',
        'e88e872a61b8: Pull complete',
        'Digest: sha256:e9de3bae272a2d1ee97165b60d63bdc3b7fe7382298dd226cc95ef11808bccd5',
      ])
    ).toBe('registry.example.test/maestrly-bot-gateway:0.9.4 (2/2)')
  })

  it("leaves out the image config that Docker's containerd store reports as downloaded", () => {
    // As Docker 29 prints it: the config blob appears once, as downloaded, and is never pulled.
    expect(
      progress([
        '0.9.4: Pulling from maestrly-bot-gateway',
        'e0efe4312ea5: Pulling fs layer',
        'e88e872a61b8: Pulling fs layer',
        '216d81376ad7: Download complete',
        'e0efe4312ea5: Download complete',
        'e88e872a61b8: Download complete',
        'e88e872a61b8: Pull complete',
        'e0efe4312ea5: Pull complete',
        'Status: Downloaded newer image for registry.example.test/maestrly-bot-gateway:0.9.4',
      ])
    ).toBe('registry.example.test/maestrly-bot-gateway:0.9.4 (2/2)')
  })
})

describe('artifact viewer ports', () => {
  it('allocates beside the desktop port and preserves a custom env port on reinstall and update', async () => {
    const { service, local, stored } = setup({ deps: { desktopArtifactsPort: () => 5000 } })
    await service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })
    expect(service.artifactsViewerPort()).toBe(5001)
    local.files.set(localFile('.env'), local.files.get(localFile('.env'))!.replace('PORT=5001', 'PORT=5123'))
    await service.installLocal({ deviceName: 'Mac', allowPrivateNetwork: false })
    expect(stored.record?.artifactsPort).toBe(5123)
    stored.record!.version = '0.9.3'
    await service.update()
    expect(service.artifactsViewerPort()).toBe(5123)
    expect(local.files.get(localFile('.env'))).toContain('MAESTRLY_ARTIFACTS_PORT=5123')
  })

  it('upgrades legacy local installs with a free viewer port', async () => {
    const { service, stored } = setup({ record: localRecord(), deps: { desktopArtifactsPort: () => 5100 } })
    expect(service.artifactsViewerPort()).toBeNull()
    expect((await service.update()).job?.state).toBe('succeeded')
    expect(stored.record?.artifactsPort).toBe(5101)
  })

  it('restores the independent remote target, remaps the viewer, and stops both tunnels', async () => {
    const { service, tunnels, stored, fleetState } = setup({
      record: remoteRecord({ artifactsPort: 4011, remoteArtifactsPort: 4210 }),
      key: 'synthetic',
      tunnelPort: (options) => (options.remotePort ? 4111 : options.listenPort),
    })
    expect(service.artifactsViewerPort()).toBeNull()
    await service.start()
    expect(tunnels[1].options).toMatchObject({ listenPort: 4011, remotePort: 4210 })
    expect(service.artifactsViewerPort()).toBe(4111)
    expect(stored.record?.artifactsPort).toBe(4111)
    expect(fleetState.retargets).toEqual([])
    await service.stop()
    expect(tunnels.every((tunnel) => tunnel.stopped)).toBe(true)
    expect(service.artifactsViewerPort()).toBeNull()
    await service.start()
    expect(tunnels.at(-1)?.options.listenPort).toBe(4111)
  })

  it('keeps the gateway connected when the artifact listener fails', async () => {
    const { service, tunnels } = setup({
      record: remoteRecord({ artifactsPort: 4011 }),
      key: 'synthetic',
      tunnelPort: (options) => {
        if (options.remotePort) throw new Error('Synthetic listener failure')
        return options.listenPort
      },
    })
    await service.start()
    expect(service.status().tunnel).toBe('connected')
    expect(service.status().artifactsTunnelError?.detail).toContain('Synthetic listener failure')
    expect(service.artifactsViewerPort()).toBeNull()
    expect(tunnels[0].stopped).toBe(false)
  })
})
