import type { FleetBackupDestination } from '@maestrly/bot-fleet-protocol'
import type { GatewayConfig } from '../config.js'
import type { DockerDriver, HelperFile, HelperMount, HelperResult } from '../docker.js'
import { GatewayError } from '../errors.js'
import { helperLabel } from '../lifecycle.js'
import { BACKUP_CACHE_DIR, resticEnvironment } from './restic.js'

/** The value of the helper label on the containers backups run, which a restart of the gateway cleans up. */
export const BACKUP_HELPER = 'backup'
const CACHE_READY_MS = 60_000

/**
 * Runs restic, and the few commands around it, in short-lived containers of the bot image. Only these containers see
 * the destination's credentials and the recovery key; the environments never do. restic keeps its cache, which saves
 * downloading the repository's index on each run, in a volume of its own.
 */
export class BackupHelper {
  readonly cacheVolume: string
  private cacheReady: Promise<void> | null = null
  constructor(
    readonly docker: DockerDriver,
    readonly config: GatewayConfig
  ) {
    this.cacheVolume = config.network + '-backup-cache'
  }
  /** Creates the cache volume with a folder the bot user owns, once per process; a failure is tried again next time. */
  ensureCache(): Promise<void> {
    this.cacheReady ??= this.prepareCache().catch((error: unknown) => {
      this.cacheReady = null
      throw error
    })
    return this.cacheReady
  }
  private async prepareCache() {
    if (!(await this.docker.volumeExists(this.cacheVolume)))
      await this.docker.volumeCreate(this.cacheVolume, { [helperLabel]: 'backup-cache' })
    const result = await this.docker.runHelper({
      image: this.config.botImage,
      command: ['install', '-d', '-o', '1000', '-g', '1000', '-m', '0700', BACKUP_CACHE_DIR],
      user: '0',
      env: [],
      network: 'none',
      mounts: [{ type: 'volume', source: this.cacheVolume, target: '/cache', readOnly: false }],
      files: [],
      securityOpt: this.config.botSecurityOpt,
      capAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
      labels: { [helperLabel]: BACKUP_HELPER },
      timeoutMs: CACHE_READY_MS,
    })
    if (result.exitCode !== 0 || result.ending !== 'exited')
      throw new GatewayError('DOCKER_UNAVAILABLE', 'Backup cache not ready')
  }
  /** Runs restic against a destination as the bot user, on the fleet network (it reaches the storage, not the bots). */
  async restic(input: {
    destination: FleetBackupDestination
    password: string
    args: string[]
    mounts?: HelperMount[]
    files?: HelperFile[]
    timeoutMs: number
    signal?: AbortSignal
    onStdoutLine?: (line: string) => void
    stdoutLimitBytes?: number
  }): Promise<HelperResult> {
    await this.ensureCache()
    return this.docker.runHelper({
      image: this.config.botImage,
      command: ['restic', ...input.args],
      user: '1000',
      env: resticEnvironment(input.destination, input.password),
      network: this.config.network,
      mounts: [
        ...(input.mounts ?? []),
        { type: 'volume', source: this.cacheVolume, target: '/cache', readOnly: false },
      ],
      files: input.files ?? [],
      securityOpt: this.config.botSecurityOpt,
      capAdd: [],
      labels: { [helperLabel]: BACKUP_HELPER },
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onStdoutLine ? { onStdoutLine: input.onStdoutLine } : {}),
      ...(input.stdoutLimitBytes ? { stdoutLimitBytes: input.stdoutLimitBytes } : {}),
    })
  }
  /** Runs a command with no network and no credentials: looking into a folder, putting a restored file in place. */
  command(input: {
    command: string[]
    mounts: HelperMount[]
    user?: string
    capAdd?: string[]
    timeoutMs: number
  }): Promise<HelperResult> {
    return this.docker.runHelper({
      image: this.config.botImage,
      command: input.command,
      user: input.user ?? '1000',
      env: [],
      network: 'none',
      mounts: input.mounts,
      files: [],
      securityOpt: this.config.botSecurityOpt,
      capAdd: input.capAdd ?? [],
      labels: { [helperLabel]: BACKUP_HELPER },
      timeoutMs: input.timeoutMs,
    })
  }
}
