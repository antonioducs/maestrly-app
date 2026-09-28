import { formatPairingCode, normalizePairingCode } from '@maestrly/bot-fleet-protocol'
import type { LocalDockerState } from '../../../shared/fleet-installer'
import { InstallerError } from './errors'
import { BOT_SERVER_DEV_PROJECT, BOT_SERVER_GATEWAY_PORT, BOT_SERVER_SERVICE, composeArgs } from './project'
import type { CommandRunner, RunOptions, RunResult } from './runner'

export interface DockerStatus {
  state: Exclude<LocalDockerState, 'dev-fleet'>
  engine: string | null
  version: string | null
  memoryBytes: number | null
}

/** The last non-empty line of a command's output, which is where Docker puts the reason it failed. */
export function lastLine(...texts: string[]): string | null {
  for (const text of texts) {
    const line = text
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .at(-1)
    if (line) return line.slice(0, 300)
  }
  return null
}

const unavailable = /manifest unknown|not found|denied|unauthorized/i

/** The Docker operations of the bot server, the same on this computer and on a VPS. */
export class DockerHost {
  constructor(
    private readonly runner: CommandRunner,
    readonly dir: string
  ) {}

  private compose(args: string[], options?: RunOptions): Promise<RunResult> {
    return this.runner.docker([...composeArgs(this.dir, (...parts) => this.runner.join(...parts)), ...args], options)
  }

  async status(): Promise<DockerStatus> {
    const none = { engine: null, version: null, memoryBytes: null }
    let info: RunResult
    try {
      info = await this.runner.docker(['info', '--format', '{{json .}}'])
    } catch (error) {
      if (error instanceof InstallerError && error.code === 'docker-missing') return { state: 'missing', ...none }
      throw error
    }
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(info.stdout.trim() || '{}') as Record<string, unknown>
    } catch {
      /* Not JSON: the client reached no server. */
    }
    const serverErrors = Array.isArray(parsed.ServerErrors) ? parsed.ServerErrors.map(String).join('\n') : ''
    if (info.code !== 0 || serverErrors || typeof parsed.ServerVersion !== 'string' || !parsed.ServerVersion) {
      const text = `${info.stderr}\n${serverErrors}`
      return { state: /permission denied/i.test(text) ? 'no-permission' : 'stopped', ...none }
    }
    const engine = typeof parsed.OperatingSystem === 'string' && parsed.OperatingSystem ? parsed.OperatingSystem : null
    const memoryBytes = typeof parsed.MemTotal === 'number' && parsed.MemTotal > 0 ? parsed.MemTotal : null
    const compose = await this.runner.docker(['compose', 'version', '--short'])
    return { state: compose.code === 0 ? 'ready' : 'no-compose', engine, version: parsed.ServerVersion, memoryBytes }
  }

  /** Whether `npm run bot-fleet:dev` runs on this engine: an installed server beside it would share its images. */
  async devFleetRunning(): Promise<boolean> {
    const result = await this.runner.docker([
      'ps',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${BOT_SERVER_DEV_PROJECT}`,
    ])
    return result.code === 0 && result.stdout.trim().length > 0
  }

  async imageExists(ref: string): Promise<boolean> {
    return (await this.runner.docker(['image', 'inspect', '--format', '{{.Id}}', ref])).code === 0
  }

  async pull(ref: string, options?: RunOptions): Promise<void> {
    const result = await this.runner.docker(['pull', ref], options)
    if (result.code === 0) return
    const detail = lastLine(result.stderr, result.stdout)
    throw new InstallerError(
      unavailable.test(`${result.stderr}\n${result.stdout}`) ? 'images-unavailable' : 'image-pull-failed',
      detail
    )
  }

  /** Removes images, leaving the ones that are missing or still used by a container. */
  async removeImages(refs: string[]): Promise<void> {
    for (const ref of refs) await this.runner.docker(['image', 'rm', ref])
  }

  /** The other tags of a repository on this engine, such as the images of an older version. */
  async otherTags(repository: string, keepTag: string): Promise<string[]> {
    const result = await this.runner.docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', repository])
    if (result.code !== 0) return []
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((ref) => ref.startsWith(`${repository}:`))
      .filter((ref) => {
        const tag = ref.slice(repository.length + 1)
        return tag !== keepTag && tag !== '<none>'
      })
  }

  async writeProject(compose: string, env: string): Promise<void> {
    await this.runner.writeFile(this.runner.join(this.dir, 'compose.yml'), compose)
    await this.runner.writeFile(this.runner.join(this.dir, '.env'), env)
  }

  readEnv(): Promise<string | null> {
    return this.runner.readFile(this.runner.join(this.dir, '.env'))
  }

  async up(options?: RunOptions): Promise<void> {
    const result = await this.compose(['up', '-d', '--no-build'], options)
    if (result.code !== 0) throw new InstallerError('start-failed', lastLine(result.stderr, result.stdout))
  }

  /** The port the gateway publishes on this machine's loopback, or null when it does not run. */
  async publishedPort(): Promise<number | null> {
    const result = await this.compose(['port', BOT_SERVER_SERVICE, String(BOT_SERVER_GATEWAY_PORT)])
    if (result.code !== 0) return null
    const port = Number(result.stdout.trim().split(/\r?\n/)[0]?.split(':').at(-1))
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
  }

  /** A one-use pairing code from the gateway, as `XXXX-XXXX`. */
  async pair(): Promise<string> {
    const result = await this.compose(['exec', '-T', BOT_SERVER_SERVICE, 'maestrly-bot-gateway', 'pair'])
    if (result.code === 0)
      for (const token of result.stdout.split(/\s+/)) {
        if (normalizePairingCode(token)) return formatPairingCode(token)
      }
    throw new InstallerError('pair-failed', lastLine(result.stderr, result.stdout))
  }

  async down(options?: RunOptions): Promise<void> {
    const result = await this.compose(['down', '-v', '--remove-orphans'], options)
    if (result.code !== 0) throw new InstallerError('unknown', lastLine(result.stderr, result.stdout))
  }
}
