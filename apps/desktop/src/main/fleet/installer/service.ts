import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import {
  FLEET_ARTIFACTS_FEATURE,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_PORTS,
  FLEET_PROTOCOL_VERSION,
} from '@maestrly/bot-fleet-protocol'
import {
  fleetUpdateState,
  knownServerVersion,
  type FleetEnvironmentUpdateResult,
  type FleetInstallLocalInput,
  type FleetInstallMode,
  type FleetInstallRecord,
  type FleetInstallRemoteInput,
  type FleetInstallerJob,
  type FleetInstallerJobKind,
  type FleetInstallerStatus,
  type FleetInstallerStep,
  type FleetInstallerStepId,
  type FleetRemoteTarget,
  type FleetSshCredentials,
  type FleetUpdateBotsResult,
  type FleetUpdateState,
  type LocalDockerCheck,
} from '../../../shared/fleet-installer'
import { compareSemver } from '../../../shared/update'
import { broadcast } from '../../window-ipc'
import { fleetClientService, type FleetClientService } from '../client/service'
import { DockerHost, lastLine } from './docker-host'
import { scheduleEnvironmentUpdates } from './environment-updates'
import { InstallerError, installerErrorOf } from './errors'
import { botServerImages, type BotServerImages } from './images'
import {
  BOT_SERVER_GATEWAY_PORT,
  BOT_SERVER_REMOTE_DIR,
  bundledComposePath,
  checkoutRoot,
  displayNameFor,
  imageVersion,
  parseBotServerEnv,
  renderBotServerEnv,
  splitImageRef,
  timezoneOrUtc,
  withEnvValues,
} from './project'
import { authorizeKey, installDocker, probeRemote, remoteSupport, removeRemoteProject, revokeKey } from './remote-host'
import { LocalRunner, type CommandRunner, type RunOptions, type RunResult } from './runner'
import { RemoteRunner, SshSession, generateSshKey, type SshConnectOptions } from './ssh'
import {
  clearInstallRecord,
  clearSshKey,
  readInstallRecord,
  readSshKey,
  saveSshKey,
  sshKeyPersistence,
  writeInstallRecord,
} from './store'
import { SshTunnel, type TunnelOptions } from './tunnel'

/** What the installer needs from an SSH connection. */
export type InstallerSession = Pick<SshSession, 'exec' | 'forward' | 'onClose' | 'close' | 'hostKey' | 'root'>
export type InstallerTunnel = Pick<SshTunnel, 'start' | 'stop' | 'port' | 'state' | 'lastForwardError'>
export type FleetInstallerFleet = Pick<
  FleetClientService,
  'getConnection' | 'getSnapshot' | 'connect' | 'disconnect' | 'retarget' | 'call' | 'hasFeature'
>
export interface FleetInstallerStore {
  readRecord(): FleetInstallRecord | null
  writeRecord(record: FleetInstallRecord): void
  clearRecord(): void
  readKey(): string | null
  saveKey(privateKey: string): 'secure' | 'memory'
  clearKey(): void
  keyPersistence(): 'secure' | 'memory' | null
}

export interface FleetInstallerDeps {
  appVersion: string
  isPackaged: boolean
  env: NodeJS.ProcessEnv
  /** Read when used: the app sets its data directory after modules load. */
  userDataDir: () => string
  desktopArtifactsPort: () => number
  hostname: string
  timezone: string | undefined
  localRunner: () => CommandRunner
  connectSsh: (
    target: FleetRemoteTarget,
    credentials: FleetSshCredentials,
    options: SshConnectOptions
  ) => Promise<InstallerSession>
  remoteRunner?: (session: InstallerSession) => CommandRunner
  createTunnel?: (options: TunnelOptions) => InstallerTunnel
  fleet: FleetInstallerFleet
  store: FleetInstallerStore
  /** Resolves once the gateway at this origin answers `/v1/meta`. */
  fetchMeta: (origin: string) => Promise<void>
  /** This port when free on the loopback, else the next free one. */
  freePort: (preferred: number) => Promise<number>
  broadcast: (status: FleetInstallerStatus) => void
  readBundledCompose: () => Promise<string>
  /** Builds the `:local` images from the checkout, for a development build. */
  runImageBuilder: (options: RunOptions, only?: 'gateway' | 'bot') => Promise<RunResult>
  removeLocalDir?: (dir: string) => Promise<void>
  now: () => Date
  randomId: (length: number) => string
  healthTimeoutMs?: number
  pollMs?: number
}

interface JobContext {
  signal: AbortSignal
  step<T>(id: FleetInstallerStepId, work: (detail: (text: string | null) => void) => Promise<T>): Promise<T>
  skip(id: FleetInstallerStepId): void
  setHostKey(hostKey: string): void
}

const dockerFailures = {
  missing: 'docker-missing',
  stopped: 'docker-stopped',
  'no-permission': 'docker-permission',
  'no-compose': 'compose-missing',
} as const
const DEV_REMOTE_DETAIL = 'A development build installs on a VPS only with MAESTRLY_BOT_SERVER_REGISTRY set'
const loopbackOrigin = (port: number) => `http://127.0.0.1:${port}`
const targetOf = (remote: FleetRemoteTarget): FleetRemoteTarget => ({
  host: remote.host,
  port: remote.port,
  username: remote.username,
})

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new InstallerError('cancelled'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new InstallerError('cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Shows the latest output line as a step's detail, at most four times a second. */
function lineDetail(detail: (text: string | null) => void): (line: string) => void {
  let last = 0
  return (line) => {
    const now = Date.now()
    if (now - last < 250) return
    last = now
    detail(line.trim().slice(0, 160))
  }
}

/** A download's layers as `ref (done/total)`, from `docker pull` output. */
export function pullDetail(ref: string, detail: (text: string | null) => void): (line: string) => void {
  const layers = new Map<string, boolean>()
  let last = 0
  return (line) => {
    const match = /^([0-9a-f]{12}): (.+)$/.exec(line.trim())
    if (!match) return
    // Docker's containerd image store also reports the image's config, only as downloaded: it is not a layer.
    if (!layers.has(match[1]) && match[2].startsWith('Download complete')) return
    const finished = /Pull complete|Already exists/.test(match[2])
    layers.set(match[1], finished || (layers.get(match[1]) ?? false))
    const now = Date.now()
    if (!finished && now - last < 250) return
    last = now
    detail(`${ref} (${[...layers.values()].filter(Boolean).length}/${layers.size})`)
  }
}

/**
 * Installs the bot server on this computer's Docker or on a VPS over SSH, keeps it on the app's version, and keeps the
 * SSH tunnel to a VPS open. One job runs at a time; every change of a step or of the tunnel is broadcast.
 */
export class FleetInstallerService {
  private job: FleetInstallerJob | null = null
  private controller: AbortController | null = null
  private tunnel: InstallerTunnel | null = null
  private artifactsTunnel: InstallerTunnel | null = null
  private artifactsTunnelError: ReturnType<typeof installerErrorOf> | null = null
  /** What the last server update's `environment-updates` step scheduled, for `updateBots` to report. */
  private lastEnvironmentUpdate: FleetEnvironmentUpdateResult | null = null

  constructor(private readonly deps: FleetInstallerDeps) {}

  private localDir(): string {
    return path.join(this.deps.userDataDir(), 'bot-server')
  }

  private remoteRunner(session: InstallerSession): CommandRunner {
    return this.deps.remoteRunner?.(session) ?? new RemoteRunner(session)
  }

  private createTunnel(options: TunnelOptions): InstallerTunnel {
    return this.deps.createTunnel?.(options) ?? new SshTunnel(options)
  }

  private images(): BotServerImages {
    return botServerImages({ version: this.deps.appVersion, isPackaged: this.deps.isPackaged, env: this.deps.env })
  }

  /** The version the connected gateway reports; a reconnecting client may still hold the one it replaced. */
  private reportedGatewayVersion(): string | null {
    return this.deps.fleet.getConnection().state === 'connected'
      ? (this.deps.fleet.getSnapshot().host?.gatewayVersion ?? null)
      : null
  }
  private serverUpdateState(record: FleetInstallRecord): FleetUpdateState {
    return fleetUpdateState(knownServerVersion(record.version, this.reportedGatewayVersion()), this.deps.appVersion)
  }

  status(): FleetInstallerStatus {
    const record = this.deps.store.readRecord()
    return {
      record,
      appVersion: this.deps.appVersion,
      update: record ? this.serverUpdateState(record) : 'none',
      tunnel: this.tunnel?.state ?? 'off',
      artifactsTunnel: this.artifactsTunnel?.state ?? 'off',
      artifactsTunnelError: this.artifactsTunnel?.lastForwardError ?? this.artifactsTunnelError,
      keyPersistence: record?.mode === 'remote' ? this.deps.store.keyPersistence() : null,
      job: this.job ? structuredClone(this.job) : null,
    }
  }

  private emit(): void {
    this.deps.broadcast(this.status())
  }

  private assertIdle(): void {
    if (this.job?.state === 'running') throw new InstallerError('job-running')
  }

  cancel(): void {
    this.controller?.abort()
  }

  private async runJob(
    kind: FleetInstallerJobKind,
    mode: FleetInstallMode,
    ids: FleetInstallerStepId[],
    work: (context: JobContext) => Promise<void>
  ): Promise<FleetInstallerStatus> {
    this.assertIdle()
    const controller = new AbortController()
    const steps: FleetInstallerStep[] = ids.map((id) => ({ id, state: 'pending', detail: null }))
    const job: FleetInstallerJob = {
      id: this.deps.randomId(16),
      kind,
      mode,
      steps,
      state: 'running',
      error: null,
      startedAt: this.deps.now().toISOString(),
      hostKey: null,
    }
    this.job = job
    this.controller = controller
    this.emit()
    const update = (id: FleetInstallerStepId, patch: Partial<FleetInstallerStep>) => {
      const step = steps.find((item) => item.id === id)
      if (!step) return
      Object.assign(step, patch)
      this.emit()
    }
    const context: JobContext = {
      signal: controller.signal,
      step: async (id, run) => {
        if (controller.signal.aborted) throw new InstallerError('cancelled')
        update(id, { state: 'running', detail: null })
        try {
          const value = await run((detail) => update(id, { detail }))
          update(id, { state: 'done' })
          return value
        } catch (error) {
          update(id, { state: 'failed' })
          throw error
        }
      },
      skip: (id) => update(id, { state: 'skipped' }),
      setHostKey: (hostKey) => {
        job.hostKey = hostKey
        this.emit()
      },
    }
    try {
      await work(context)
      job.state = 'succeeded'
    } catch (error) {
      if (controller.signal.aborted) {
        job.state = 'cancelled'
        job.error = { code: 'cancelled', detail: null }
      } else {
        job.state = 'failed'
        job.error = installerErrorOf(error)
      }
    } finally {
      if (this.controller === controller) this.controller = null
      this.emit()
    }
    return this.status()
  }

  async checkLocal(): Promise<LocalDockerCheck> {
    const host = new DockerHost(this.deps.localRunner(), this.localDir())
    const status = await host.status()
    if (status.state === 'ready' && !this.deps.isPackaged && (await host.devFleetRunning()))
      return { ...status, state: 'dev-fleet' }
    return status
  }

  installLocal(input: FleetInstallLocalInput): Promise<FleetInstallerStatus> {
    return this.runJob('install-local', 'local', ['check', 'files', 'images', 'start', 'pair'], async (context) => {
      const host = new DockerHost(this.deps.localRunner(), this.localDir())
      const images = this.images()
      await context.step('check', async (detail) => {
        const status = await host.status()
        if (status.state !== 'ready') throw new InstallerError(dockerFailures[status.state])
        if (!this.deps.isPackaged && (await host.devFleetRunning())) throw new InstallerError('dev-fleet-running')
        detail([status.engine, status.version].filter(Boolean).join(' ') || null)
      })
      let joining = false
      let artifactsOnly = input.hosts === 'artifacts-only'
      let artifactsPort: number
      const port = await context.step('files', async () => {
        const record = this.deps.store.readRecord()
        const port =
          (record?.mode === 'local' ? record.port : null) ??
          (await host.publishedPort()) ??
          (await this.deps.freePort(BOT_SERVER_GATEWAY_PORT))
        const existingEnv = await host.readEnv()
        joining = existingEnv !== null
        if (joining) artifactsOnly = record?.artifactsOnly ?? artifactsOnly
        artifactsPort =
          parseBotServerEnv(existingEnv ?? '').artifactsPort ??
          (record?.mode === 'local' ? record.artifactsPort : null) ??
          (await this.deps.freePort(this.deps.desktopArtifactsPort() + 1))
        const env = renderBotServerEnv({
          artifactsPort,
          gatewayImage: images.gateway,
          botImage: images.bot,
          port,
          displayName: displayNameFor(this.deps.hostname),
          egress: input.allowPrivateNetwork ? 'open' : 'public',
          timezone: timezoneOrUtc(this.deps.timezone),
        })
        await host.writeProject(await this.deps.readBundledCompose(), env)
        return port
      })
      await context.step('images', (detail) =>
        this.provideImages(host, images, 'local', context.signal, detail, artifactsOnly ? 'gateway' : 'both')
      )
      const origin = loopbackOrigin(port)
      await context.step('start', async () => {
        await host.up({ signal: context.signal })
        await this.waitHealthy(origin, context.signal)
      })
      await this.pair(context, origin, input.deviceName, () => host.pair())
      if (!joining) await this.initializeArtifacts()
      this.deps.store.writeRecord({
        mode: 'local',
        ...(artifactsOnly ? { artifactsOnly: true } : {}),
        artifactsPort: artifactsPort!,
        version: this.deps.appVersion,
        port,
        allowPrivateNetwork: input.allowPrivateNetwork,
        remote: null,
        installedAt: this.deps.now().toISOString(),
      })
    })
  }

  installRemote(input: FleetInstallRemoteInput): Promise<FleetInstallerStatus> {
    const ids: FleetInstallerStepId[] = [
      'connect',
      'check',
      'docker',
      'files',
      'images',
      'start',
      'tunnel',
      'pair',
      'key',
    ]
    return this.runJob('install-remote', 'remote', ids, async (context) => {
      const previous = this.deps.store.readRecord()
      const sameServer =
        previous?.remote && previous.remote.host === input.target.host && previous.remote.port === input.target.port
          ? previous.remote
          : null
      const pinned = sameServer?.hostKey ?? null
      // Setting up the same server again (its key was lost or refused): its idle tunnel gives the port back.
      if (sameServer) {
        await this.artifactsTunnel?.stop()
        this.artifactsTunnel = null
        await this.tunnel?.stop()
        this.tunnel = null
      }
      const session = await context.step('connect', async () => {
        const opened = await this.deps.connectSsh(input.target, input.credentials, {
          expectedHostKey: pinned,
          signal: context.signal,
        })
        context.setHostKey(opened.hostKey)
        return opened
      })
      let sessionClosed = false
      session.onClose(() => {
        sessionClosed = true
      })
      let temporary: InstallerTunnel | null = null
      let paired = false
      let saved = false
      try {
        const probe = await context.step('check', async (detail) => {
          const found = await probeRemote(session, { signal: context.signal })
          const problem = remoteSupport(found)
          if (problem)
            throw new InstallerError(
              problem,
              [found.osName || found.osId, found.arch].filter(Boolean).join(', ') || null
            )
          detail(found.osName || null)
          return found
        })
        const host = new DockerHost(this.remoteRunner(session), BOT_SERVER_REMOTE_DIR)
        if (probe.docker && probe.compose) context.skip('docker')
        else
          await context.step('docker', (detail) =>
            installDocker(session, { signal: context.signal, onLine: lineDetail(detail) })
          )
        // A server Maestrly already installed, from another computer or an attempt that stopped: join it as it is.
        const joining = probe.existingEnv !== null
        let env: string
        if (probe.existingEnv !== null) {
          env = probe.existingEnv
          context.skip('files')
          context.skip('images')
        } else {
          const images = this.images()
          env = await context.step('files', async () => {
            if (images.source === 'local') throw new InstallerError('images-unavailable', DEV_REMOTE_DETAIL)
            const rendered = renderBotServerEnv({
              gatewayImage: images.gateway,
              botImage: images.bot,
              port: BOT_SERVER_GATEWAY_PORT,
              artifactsPort: 4010,
              displayName: displayNameFor(probe.hostname || input.target.host),
              egress: input.allowPrivateNetwork ? 'open' : 'public',
              timezone: timezoneOrUtc(this.deps.timezone),
            })
            await host.writeProject(await this.deps.readBundledCompose(), rendered)
            return rendered
          })
          await context.step('images', (detail) =>
            this.provideImages(
              host,
              images,
              'remote',
              context.signal,
              detail,
              input.hosts === 'artifacts-only' ? 'gateway' : 'both'
            )
          )
        }
        await context.step('start', () => host.up({ signal: context.signal }))
        const port = await context.step('tunnel', async () => {
          const listenPort = await this.deps.freePort(
            previous?.mode === 'remote' ? previous.port : BOT_SERVER_GATEWAY_PORT
          )
          // Until Maestrly's own key is in place, the password session carries the gateway's traffic.
          temporary = this.createTunnel({
            target: input.target,
            hostKey: session.hostKey,
            privateKey: () => null,
            listenPort,
            session: async () => {
              if (sessionClosed) throw new InstallerError('ssh-auth')
              return session
            },
            freePort: () => this.deps.freePort(listenPort),
          })
          const bound = await temporary.start()
          await this.waitHealthy(loopbackOrigin(bound), context.signal, temporary)
          return bound
        })
        paired = await this.pair(context, loopbackOrigin(port), input.deviceName, () => host.pair())
        if (!joining) await this.initializeArtifacts()
        await context.step('key', async () => {
          const keyTag = `maestrly-${this.deps.randomId(12)}`
          const key = generateSshKey(keyTag)
          await authorizeKey(session, key.publicKey)
          const check = await this.deps.connectSsh(
            input.target,
            { kind: 'key', privateKey: key.privateKey, passphrase: null },
            { expectedHostKey: session.hostKey, signal: context.signal }
          )
          check.close()
          // The key of an earlier setup of this server no longer has a holder.
          if (sameServer && sameServer.keyTag !== keyTag) await revokeKey(session, sameServer.keyTag).catch(() => {})
          this.deps.store.saveKey(key.privateKey)
          const current = parseBotServerEnv(env)
          const record: FleetInstallRecord = {
            mode: 'remote',
            ...((joining ? sameServer && previous?.artifactsOnly : input.hosts === 'artifacts-only')
              ? { artifactsOnly: true }
              : {}),
            artifactsPort: await this.deps.freePort(previous?.artifactsPort ?? 4011),
            remoteArtifactsPort: current.artifactsPort ?? 4010,
            version: joining ? imageVersion(current.gatewayImage ?? '') : this.deps.appVersion,
            port,
            // Without the setting the gateway lets bots reach private networks, as before it existed.
            allowPrivateNetwork: joining ? current.egress !== 'public' : input.allowPrivateNetwork,
            remote: { ...targetOf(input.target), hostKey: session.hostKey, keyTag },
            installedAt: this.deps.now().toISOString(),
          }
          this.deps.store.writeRecord(record)
          saved = true
          await temporary?.stop()
          temporary = null
          await this.startTunnel(record)
        })
      } catch (error) {
        // A device paired through a tunnel that is going away would only reconnect in vain.
        if (paired && !saved) await this.deps.fleet.disconnect().catch(() => {})
        throw error
      } finally {
        await (temporary as InstallerTunnel | null)?.stop()
        session.close()
        const kept = this.deps.store.readRecord()
        if (!saved && kept?.mode === 'remote') await this.startTunnel(kept).catch(() => {})
      }
    })
  }

  private async provideImages(
    host: DockerHost,
    images: BotServerImages,
    mode: FleetInstallMode,
    signal: AbortSignal,
    detail: (text: string | null) => void,
    selection: 'gateway' | 'bot' | 'both' = 'both'
  ): Promise<void> {
    const refs = selection === 'both' ? [images.gateway, images.bot] : [images[selection]]
    if (images.source === 'registry') {
      for (const ref of refs) {
        detail(ref)
        await host.pull(ref, { signal, onLine: pullDetail(ref, detail) })
      }
      return
    }
    const missing: string[] = []
    for (const ref of refs) if (!(await host.imageExists(ref))) missing.push(ref)
    if (!missing.length) return
    if (mode === 'remote') throw new InstallerError('images-unavailable', DEV_REMOTE_DETAIL)
    detail('Building from this checkout')
    const result = await this.deps.runImageBuilder(
      { signal, onLine: lineDetail(detail) },
      selection === 'both' ? undefined : selection
    )
    if (result.code !== 0) throw new InstallerError('image-build-failed', lastLine(result.stderr, result.stdout))
    for (const ref of missing) if (!(await host.imageExists(ref))) throw new InstallerError('images-unavailable', ref)
  }

  private async initializeArtifacts(): Promise<void> {
    if (!this.deps.fleet.hasFeature(FLEET_ARTIFACTS_FEATURE)) return
    try {
      await this.deps.fleet.call('artifactHostPatch', { body: { enabled: true } })
    } catch {
      if (this.job) this.job.warning = 'artifacts-enable-failed'
      this.emit()
    }
  }

  /** Installs the bot image only; a failed attempt leaves the artifact-only flag intact. */
  async provideBotEnvironment(): Promise<FleetInstallerStatus> {
    this.assertIdle()
    const record = this.deps.store.readRecord()
    if (!record) throw new InstallerError('not-connected')
    if (!record.artifactsOnly) return this.status()
    return this.runJob(
      'bot-environment',
      record.mode,
      record.remote ? ['connect', 'images'] : ['images'],
      async (context) => {
        const { host, close } = await this.openHost(record, context)
        try {
          const current = parseBotServerEnv((await host.readEnv()) ?? '')
          const images = this.images()
          if (!current.botImage) throw new InstallerError('images-unavailable', 'The server bot image is unknown')
          // The running gateway may be older than this desktop; provision the image its environment names.
          await context.step('images', (detail) =>
            this.provideImages(
              host,
              {
                ...images,
                bot: current.botImage!,
                source: current.botImage === images.bot ? images.source : 'registry',
              },
              record.mode,
              context.signal,
              detail,
              'bot'
            )
          )
          this.deps.store.writeRecord({ ...(this.deps.store.readRecord() ?? record), artifactsOnly: false })
        } finally {
          close()
        }
      }
    )
  }

  private async waitHealthy(origin: string, signal: AbortSignal, tunnel?: InstallerTunnel | null): Promise<void> {
    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? 120_000)
    for (;;) {
      if (signal.aborted) throw new InstallerError('cancelled')
      let failure: unknown
      try {
        await this.deps.fetchMeta(origin)
        return
      } catch (error) {
        failure = error
      }
      if (tunnel?.lastForwardError?.code === 'ssh-forwarding') throw tunnel.lastForwardError
      if (Date.now() >= deadline)
        throw new InstallerError('gateway-unhealthy', failure instanceof Error ? failure.message : null)
      await sleep(this.deps.pollMs ?? 1_000, signal)
    }
  }

  /** Pairs this computer with the gateway, unless it already is; true when it paired now. */
  private async pair(
    context: JobContext,
    origin: string,
    deviceName: string,
    code: () => Promise<string>
  ): Promise<boolean> {
    const connection = this.deps.fleet.getConnection()
    if (
      connection.url === origin &&
      connection.deviceId &&
      ['connecting', 'connected', 'reconnecting'].includes(connection.state)
    ) {
      context.skip('pair')
      return false
    }
    await context.step('pair', async () => {
      const pairing = await code()
      try {
        await this.deps.fleet.connect({ url: origin, code: pairing, deviceName })
      } catch (error) {
        throw new InstallerError('connect-failed', error instanceof Error ? error.message : null)
      }
    })
    return true
  }

  private async startTunnel(record: FleetInstallRecord): Promise<void> {
    if (!record.remote) return
    await this.artifactsTunnel?.stop()
    this.artifactsTunnel = null
    await this.tunnel?.stop()
    const tunnel = this.createTunnel({
      target: targetOf(record.remote),
      hostKey: record.remote.hostKey,
      privateKey: () => this.deps.store.readKey(),
      listenPort: record.port,
      freePort: () => this.deps.freePort(record.port),
      onState: () => this.emit(),
    })
    this.tunnel = tunnel
    const port = await tunnel.start()
    if (port !== record.port) {
      this.deps.store.writeRecord({ ...record, port })
      this.deps.fleet.retarget(loopbackOrigin(port))
    }
    await this.startArtifactsTunnel(this.deps.store.readRecord() ?? record)
    this.emit()
  }

  /** A failed artifact connection must never take down the gateway's tunnel. */
  private async startArtifactsTunnel(record: FleetInstallRecord): Promise<void> {
    await this.artifactsTunnel?.stop()
    this.artifactsTunnel = null
    this.artifactsTunnelError = null
    if (!record.remote || !record.artifactsPort) return
    try {
      const tunnel = this.createTunnel({
        target: targetOf(record.remote),
        hostKey: record.remote.hostKey,
        privateKey: () => this.deps.store.readKey(),
        listenPort: record.artifactsPort,
        remotePort: record.remoteArtifactsPort ?? 4010,
        recoverForwarding: true,
        onForwardError: (error) => {
          this.artifactsTunnelError = error
          this.emit()
        },
        freePort: () => this.deps.freePort(record.artifactsPort!),
        onState: () => this.emit(),
      })
      this.artifactsTunnel = tunnel
      const artifactsPort = await tunnel.start()
      if (artifactsPort !== record.artifactsPort)
        this.deps.store.writeRecord({ ...(this.deps.store.readRecord() ?? record), artifactsPort })
    } catch (error) {
      this.artifactsTunnelError = installerErrorOf(error)
      await this.artifactsTunnel?.stop()
      this.artifactsTunnel = null
    }
    this.emit()
  }

  artifactsViewerPort(): number | null {
    const record = this.deps.store.readRecord()
    if (!record?.artifactsPort) return null
    if (record.mode === 'local') return record.artifactsPort
    return this.artifactsTunnel?.state === 'connected' && !this.artifactsTunnel.lastForwardError
      ? this.artifactsTunnel.port
      : null
  }

  /** The server's Docker: this computer's, or the VPS's over a new key session (a step of the job). */
  private async openHost(
    record: FleetInstallRecord,
    context: JobContext
  ): Promise<{ host: DockerHost; session: InstallerSession | null; close: () => void }> {
    if (record.mode === 'local' || !record.remote)
      return { host: new DockerHost(this.deps.localRunner(), this.localDir()), session: null, close: () => {} }
    const remote = record.remote
    const session = await context.step('connect', async () => {
      const privateKey = this.deps.store.readKey()
      if (!privateKey) throw new InstallerError('ssh-auth', null)
      const opened = await this.deps.connectSsh(
        targetOf(remote),
        { kind: 'key', privateKey, passphrase: null },
        { expectedHostKey: remote.hostKey, signal: context.signal }
      )
      context.setHostKey(opened.hostKey)
      return opened
    })
    return {
      host: new DockerHost(this.remoteRunner(session), BOT_SERVER_REMOTE_DIR),
      session,
      close: () => session.close(),
    }
  }

  private origin(record: FleetInstallRecord): string {
    return loopbackOrigin(record.mode === 'remote' ? (this.tunnel?.port ?? record.port) : record.port)
  }

  /** Moves the server to the app's images, keeping its port, name, time zone and network setting. */
  async update(): Promise<FleetInstallerStatus> {
    this.assertIdle()
    const record = this.deps.store.readRecord()
    if (!record) throw new InstallerError('not-connected')
    if (this.serverUpdateState(record) !== 'available') return this.status()
    const ids: FleetInstallerStepId[] =
      record.mode === 'remote'
        ? ['connect', 'files', 'images', 'start', 'environment-updates']
        : ['files', 'images', 'start', 'environment-updates']
    return this.runJob('update', record.mode, ids, async (context) => {
      const { host, close } = await this.openHost(record, context)
      try {
        const images = this.images()
        await context.step('files', async () => {
          if (record.mode === 'remote' && images.source === 'local')
            throw new InstallerError('images-unavailable', DEV_REMOTE_DETAIL)
          const current = await host.readEnv()
          // Another computer may have moved the server past this app: its files tell, whatever this one recorded.
          const installed = current ? imageVersion(parseBotServerEnv(current).gatewayImage ?? '') : null
          if (installed && compareSemver(installed, this.deps.appVersion) > 0) {
            this.deps.store.writeRecord({ ...(this.deps.store.readRecord() ?? record), version: installed })
            throw new InstallerError('server-newer')
          }
          const artifactsPort =
            (current ? parseBotServerEnv(current).artifactsPort : null) ??
            (record.mode === 'local'
              ? (record.artifactsPort ?? (await this.deps.freePort(this.deps.desktopArtifactsPort() + 1)))
              : (record.remoteArtifactsPort ?? 4010))
          const env = current
            ? withEnvValues(current, {
                MAESTRLY_GATEWAY_IMAGE: images.gateway,
                MAESTRLY_GATEWAY_BOT_IMAGE: images.bot,
                MAESTRLY_ARTIFACTS_PORT: String(artifactsPort),
              })
            : renderBotServerEnv({
                artifactsPort,
                gatewayImage: images.gateway,
                botImage: images.bot,
                port: record.mode === 'local' ? record.port : BOT_SERVER_GATEWAY_PORT,
                displayName: displayNameFor(record.mode === 'local' ? this.deps.hostname : (record.remote?.host ?? '')),
                egress: record.allowPrivateNetwork ? 'open' : 'public',
                timezone: timezoneOrUtc(this.deps.timezone),
              })
          await host.writeProject(await this.deps.readBundledCompose(), env)
          this.deps.store.writeRecord({
            ...(this.deps.store.readRecord() ?? record),
            artifactsPort:
              record.mode === 'local' ? artifactsPort : (record.artifactsPort ?? (await this.deps.freePort(4011))),
            ...(record.mode === 'remote' ? { remoteArtifactsPort: artifactsPort } : {}),
          })
        })
        await context.step('images', (detail) =>
          this.provideImages(
            host,
            images,
            record.mode,
            context.signal,
            detail,
            record.artifactsOnly ? 'gateway' : 'both'
          )
        )
        await context.step('start', async () => {
          await host.up({ signal: context.signal })
          await this.waitHealthy(this.origin(record), context.signal, this.tunnel)
        })
        if (record.mode === 'remote') await this.startArtifactsTunnel(this.deps.store.readRecord() ?? record)
        await this.removeOtherVersions(host, images)
        this.deps.store.writeRecord({ ...(this.deps.store.readRecord() ?? record), version: this.deps.appVersion })
        // The updated gateway recreates no running environment on its own: each is scheduled to follow once idle.
        const environments = await context.step('environment-updates', () =>
          scheduleEnvironmentUpdates(this.deps.fleet, {
            signal: context.signal,
            waitMs: this.deps.healthTimeoutMs,
            pollMs: this.deps.pollMs,
          })
        )
        if (!environments.supported) context.skip('environment-updates')
        this.lastEnvironmentUpdate = environments
      } finally {
        close()
      }
    })
  }

  /**
   * Updates bots in one click: moves the server to the app's version when this app installed it and it is older,
   * then schedules every running environment on an older image to update once its bots are idle.
   */
  async updateBots(): Promise<FleetUpdateBotsResult> {
    const record = this.deps.store.readRecord()
    if (record && this.serverUpdateState(record) === 'available') {
      this.lastEnvironmentUpdate = null
      const status = await this.update()
      return { status, environments: status.job?.state === 'succeeded' ? this.lastEnvironmentUpdate : null }
    }
    this.assertIdle()
    return { status: this.status(), environments: await scheduleEnvironmentUpdates(this.deps.fleet, { waitMs: 0 }) }
  }

  /** Removes this registry's images of other versions; ones still in use stay. Never fails the update. */
  private async removeOtherVersions(host: DockerHost, images: BotServerImages): Promise<void> {
    try {
      for (const ref of [images.gateway, images.bot]) {
        const { repository, tag } = splitImageRef(ref)
        if (tag) await host.removeImages(await host.otherTags(repository, tag))
      }
    } catch {
      /* Leftover images only take disk space. */
    }
  }

  /** Lets bots reach private networks and this computer, or not; each environment follows when it restarts. */
  async setPrivateNetwork(allow: boolean): Promise<FleetInstallerStatus> {
    this.assertIdle()
    const record = this.deps.store.readRecord()
    if (!record) throw new InstallerError('not-connected')
    const ids: FleetInstallerStepId[] = record.mode === 'remote' ? ['connect', 'files', 'start'] : ['files', 'start']
    return this.runJob('private-network', record.mode, ids, async (context) => {
      const { host, close } = await this.openHost(record, context)
      try {
        await context.step('files', async () => {
          const current = await host.readEnv()
          if (!current) throw new InstallerError('unknown', 'The bot server environment file is missing')
          await host.writeEnv(withEnvValues(current, { MAESTRLY_GATEWAY_BOT_EGRESS: allow ? 'open' : 'public' }))
        })
        await context.step('start', async () => {
          await host.up({ signal: context.signal })
          await this.waitHealthy(this.origin(record), context.signal, this.tunnel)
        })
        this.deps.store.writeRecord({ ...(this.deps.store.readRecord() ?? record), allowPrivateNetwork: allow })
      } finally {
        close()
      }
    })
  }

  /** Unpairs this computer and forgets its access to a VPS; the server keeps running. */
  async disconnect(): Promise<FleetInstallerStatus> {
    this.assertIdle()
    const record = this.deps.store.readRecord()
    await this.deps.fleet.disconnect()
    if (record?.remote) {
      const privateKey = this.deps.store.readKey()
      if (privateKey) {
        try {
          const session = await this.deps.connectSsh(
            targetOf(record.remote),
            { kind: 'key', privateKey, passphrase: null },
            { expectedHostKey: record.remote.hostKey, signal: AbortSignal.timeout(15_000), readyTimeoutMs: 15_000 }
          )
          try {
            await revokeKey(session, record.remote.keyTag, { timeoutMs: 15_000 })
          } finally {
            session.close()
          }
        } catch {
          /* An unreachable server keeps a key nobody holds any more. */
        }
      }
    }
    await this.artifactsTunnel?.stop()
    this.artifactsTunnel = null
    await this.tunnel?.stop()
    this.tunnel = null
    if (record) {
      this.deps.store.clearKey()
      this.deps.store.clearRecord()
    }
    this.emit()
    return this.status()
  }

  /** Deletes every environment and bot, the gateway and its data, its images, and Maestrly's files and key. */
  async remove(): Promise<FleetInstallerStatus> {
    this.assertIdle()
    const record = this.deps.store.readRecord()
    if (!record || this.deps.fleet.getConnection().state !== 'connected') throw new InstallerError('not-connected')
    const ids: FleetInstallerStepId[] =
      record.mode === 'remote' ? ['connect', 'environments', 'teardown'] : ['environments', 'teardown']
    return this.runJob('remove', record.mode, ids, async (context) => {
      const { host, session, close } = await this.openHost(record, context)
      try {
        await context.step('environments', (detail) => this.deleteEverything(detail))
        await context.step('teardown', async () => {
          const env = parseBotServerEnv((await host.readEnv()) ?? '')
          await this.deps.fleet.disconnect()
          await host.down({ signal: context.signal })
          await host.removeImages([env.gatewayImage, env.botImage].filter((ref): ref is string => ref !== null))
          if (session && record.remote) {
            await revokeKey(session, record.remote.keyTag)
            await removeRemoteProject(session)
          } else
            await (this.deps.removeLocalDir ?? ((dir) => rm(dir, { recursive: true, force: true })))(this.localDir())
          await this.artifactsTunnel?.stop()
          this.artifactsTunnel = null
          await this.tunnel?.stop()
          this.tunnel = null
          this.deps.store.clearKey()
          this.deps.store.clearRecord()
        })
      } finally {
        close()
      }
    })
  }

  /** Archives every environment and bot, then deletes them for good, through the gateway. */
  private async deleteEverything(detail: (text: string | null) => void): Promise<void> {
    const fleet = this.deps.fleet
    if (fleet.hasFeature(FLEET_ENVIRONMENTS_FEATURE)) {
      const { environments } = await fleet.call('environmentsList')
      for (const environment of environments) {
        if (environment.lifecycle === 'archived') continue
        detail(environment.name)
        await fleet.call('environmentArchive', { params: { eid: environment.id } })
      }
      const archived = await fleet.call('archivedEnvironmentsList')
      for (const environment of archived.environments) {
        detail(environment.name)
        await fleet.call('archivedEnvironmentDelete', { params: { eid: environment.id } })
      }
      const bots = await fleet.call('archivedBotsList', { query: { separateEnvironments: 1 } })
      for (const bot of bots.bots) {
        detail(bot.name)
        await fleet.call('archivedBotDelete', { params: { id: bot.id } })
      }
      return
    }
    const { bots } = await fleet.call('botsList')
    for (const bot of bots) {
      detail(bot.name)
      await fleet.call('botArchive', { params: { id: bot.id } })
    }
    const archived = await fleet.call('archivedBotsList')
    for (const bot of archived.bots) {
      detail(bot.name)
      await fleet.call('archivedBotDelete', { params: { id: bot.id } })
    }
  }

  /** Opens the tunnel of a VPS install at startup; a bot's own Maestrly has no bot server. */
  async start(): Promise<void> {
    if (this.deps.env.MAESTRLY_BOT_MODE === '1') return
    const record = this.deps.store.readRecord()
    if (record?.mode === 'remote') await this.startTunnel(record)
  }

  async stop(): Promise<void> {
    this.controller?.abort()
    await this.artifactsTunnel?.stop()
    this.artifactsTunnel = null
    await this.tunnel?.stop()
    this.tunnel = null
  }
}

const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
function randomId(length: number): string {
  return Array.from({ length }, () => RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)]).join('')
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function firstFreePort(preferred: number): Promise<number> {
  for (let port = preferred; port < Math.min(preferred + 100, 65536); port++) if (await isFree(port)) return port
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

async function fetchMeta(origin: string): Promise<void> {
  const response = await fetch(`${origin}/v1/meta`, {
    headers: { 'X-Maestrly-Fleet-Protocol': String(FLEET_PROTOCOL_VERSION) },
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`The gateway answered ${response.status}`)
  await response.body?.cancel()
}

const localRunner = () => new LocalRunner()

/** `scripts/bot-fleet-images.mjs` from the checkout, run by Electron as Node with Docker on PATH. */
function runImageBuilder(options: RunOptions, only?: 'gateway' | 'bot'): Promise<RunResult> {
  const root = checkoutRoot()
  const script = path.join(root, 'scripts', 'bot-fleet-images.mjs')
  if (!existsSync(script))
    return Promise.resolve({ code: 1, stdout: '', stderr: 'scripts/bot-fleet-images.mjs is not in this checkout' })
  return new LocalRunner().run(process.execPath, [script, ...(only ? ['--only', only] : [])], {
    ...options,
    cwd: root,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })
}

export const fleetInstallerService = new FleetInstallerService({
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  env: process.env,
  userDataDir: () => app.getPath('userData'),
  // Earlier versions hosted artifacts here on 4010; a server installed on this computer keeps clear of it.
  desktopArtifactsPort: () => FLEET_PORTS.artifacts,
  hostname: os.hostname(),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  localRunner,
  connectSsh: (target, credentials, options) => SshSession.connect(target, credentials, options),
  fleet: fleetClientService,
  store: {
    readRecord: readInstallRecord,
    writeRecord: writeInstallRecord,
    clearRecord: clearInstallRecord,
    readKey: readSshKey,
    saveKey: saveSshKey,
    clearKey: clearSshKey,
    keyPersistence: sshKeyPersistence,
  },
  fetchMeta,
  freePort: firstFreePort,
  broadcast: (status) => broadcast('fleet:installer:status', status),
  readBundledCompose: () => readFile(bundledComposePath(), 'utf8'),
  runImageBuilder,
  now: () => new Date(),
  randomId,
})
