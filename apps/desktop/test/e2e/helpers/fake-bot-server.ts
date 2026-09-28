import { randomBytes, randomInt } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import {
  FLEET_GATEWAY_ROUTES,
  fleetBotSchema,
  fleetEnvironmentSchema,
  fleetHostInfoSchema,
  type FleetArchivedEnvironment,
  type FleetBot,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import type { FakeExecResult } from '../../fixtures/fake-ssh-server'
import { commandOf } from '../../fixtures/fleet-installer-fakes'

/**
 * A bot server for the installer's end-to-end tests, all in the test process: a gateway, the Docker engine that runs
 * it, a `docker` CLI for this computer, and the commands of a VPS reached through the fake SSH server. Only synthetic
 * credentials and images; nothing touches the real Docker.
 */

const GB = 1024 ** 3
const now = () => new Date().toISOString()
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export interface FakeGatewayRequest {
  key: string
  path: string
  body: unknown
}

/**
 * The gateway routes the installer and the Bots tab use, with one environment holding one bot. Its data survives a
 * restart like the gateway volume; `reset` empties it like `compose down -v`.
 */
export class FakeGateway {
  readonly requests: FakeGatewayRequest[] = []
  readonly pairings: Array<{ code: string; deviceName: string; deviceId: string }> = []
  private readonly codes = new Set<string>()
  private readonly tokens = new Set<string>()
  private readonly streams = new Set<ServerResponse>()
  private readonly server = createServer((request, response) => {
    this.handle(request, response).catch((error: unknown) => {
      console.error('[fake gateway]', error)
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ code: 'INTERNAL', message: 'The fake gateway failed; see the test output' }))
    })
  })
  private listening = false
  private devices = 0
  private environments: FleetEnvironment[] = []
  private bots: FleetBot[] = []
  private archived: FleetArchivedEnvironment[] = []

  constructor(private readonly hostname: string) {
    this.reset()
  }

  get running(): boolean {
    return this.listening
  }

  get port(): number | null {
    return this.listening ? (this.server.address() as AddressInfo).port : null
  }

  /** Listens on this loopback port, or any with 0, as the started container does. */
  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject)
        this.listening = true
        resolve((this.server.address() as AddressInfo).port)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.listening) return
    this.listening = false
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.dropConnections()
    await closed
  }

  /** Ends every open connection, as a recreated container does. */
  dropConnections(): void {
    for (const stream of this.streams) stream.destroy()
    this.streams.clear()
    this.server.closeAllConnections()
  }

  /** The gateway volume's data as on a new server: no device, one environment with one bot. */
  reset(): void {
    this.codes.clear()
    this.tokens.clear()
    const at = now()
    const capabilities = ['provisioning', 'environments']
    this.environments = [
      fleetEnvironmentSchema.parse({
        id: 'acme',
        name: 'Acme',
        lifecycle: 'running',
        setup: { step: 'ready', error: null, errorMessage: null },
        resources: { memoryBytes: GB, memoryLimitBytes: 4 * GB, cpuPercent: 3, startedAt: at },
        memoryLimitBytes: null,
        appVersion: '0.9.3',
        capabilities,
        botIds: ['scout'],
        createdAt: at,
        updatedAt: at,
      }),
    ]
    this.bots = [
      fleetBotSchema.parse({
        id: 'scout',
        name: 'Scout',
        environmentId: 'acme',
        capabilities,
        role: 'Finds orders',
        instructions: 'Synthetic installer bot',
        tint: '#6688aa',
        ceiling: 'auto',
        selection: null,
        talksTo: [],
        paused: false,
        lifecycle: 'running',
        setup: { step: 'ready', error: null, errorMessage: null },
        status: 'idle',
        activity: null,
        pendingCount: 0,
        accounts: { connected: true, providers: [] },
        takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
        resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
        screen: { width: 1280, height: 800, display: ':1' },
        appVersion: '0.9.3',
        createdAt: at,
        updatedAt: at,
      }),
    ]
    this.archived = []
  }

  /** A new one-use pairing code, as `maestrly-bot-gateway pair` prints it. */
  issueCode(): string {
    const code = Array.from({ length: 8 }, () => CROCKFORD[randomInt(CROCKFORD.length)]).join('')
    this.codes.add(code)
    return `${code.slice(0, 4)}-${code.slice(4)}`
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, value?: unknown) => {
      if (value === undefined) {
        response.writeHead(status)
        response.end()
        return
      }
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
      ([, route]) =>
        route.method === request.method && new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
    )
    if (!entry) return send(404, { code: 'NOT_FOUND', message: 'Unknown route' })
    const [key] = entry
    if (request.headers['x-maestrly-fleet-protocol'] !== '1')
      return send(426, { code: 'PROTOCOL_INCOMPATIBLE', message: 'Bad protocol' })
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? null
    if (key !== 'meta' && key !== 'pair' && !(token && this.tokens.has(token)))
      return send(401, { code: 'UNAUTHORIZED', message: 'Unknown device' })
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString('utf8')
    const body: unknown = text ? JSON.parse(text) : null
    this.requests.push({ key, path: url.pathname, body })
    const id = url.pathname.split('/')[3] ?? ''
    switch (key) {
      case 'meta':
        return send(200, {
          protocol: 1,
          gatewayVersion: '0.9.3',
          botImage: 'e2e',
          botImageVersion: null,
          features: ['provisioning', 'environments'],
        })
      case 'pair': {
        const { code, deviceName } = body as { code: string; deviceName: string }
        if (!this.codes.delete(code))
          return send(401, { code: 'UNAUTHORIZED', message: 'Pairing code expired or used' })
        const deviceId = `device-${++this.devices}`
        const issued = `token-${randomBytes(12).toString('hex')}`
        this.tokens.add(issued)
        this.pairings.push({ code, deviceName, deviceId })
        return send(200, { deviceId, token: issued })
      }
      case 'devicesSelfDelete':
        if (token) this.tokens.delete(token)
        return send(204)
      case 'events':
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        this.streams.add(response)
        response.write(': connected\n\n')
        request.on('close', () => this.streams.delete(response))
        return
      case 'host':
        return send(
          200,
          fleetHostInfoSchema.parse({
            hostname: this.hostname,
            os: 'Linux',
            kernel: '6.8',
            arch: 'x64',
            cpus: 4,
            cpuPercent: 5,
            memory: { totalBytes: 8 * GB, usedBytes: 2 * GB, botsBytes: GB },
            disk: { totalBytes: 80 * GB, usedBytes: 20 * GB },
            uptimeSeconds: 600,
            gatewayVersion: '0.9.3',
            botImage: 'e2e',
            botImageVersion: null,
            dockerVersion: '28.0.1',
          })
        )
      case 'botsList':
        return send(200, { bots: this.bots })
      case 'environmentsList':
        return send(200, { environments: this.environments })
      case 'inbox':
        return send(200, { items: [] })
      case 'peerMessages':
        return send(200, { messages: [] })
      case 'archivedBotsList':
        return send(200, { bots: [] })
      case 'archivedEnvironmentsList':
        return send(200, { environments: this.archived })
      case 'environmentArchive': {
        const environment = this.environments.find((item) => item.id === id)
        if (!environment) return send(404, { code: 'NOT_FOUND', message: 'Environment not found' })
        const bots = this.bots.filter((bot) => bot.environmentId === id)
        this.environments = this.environments.filter((item) => item.id !== id)
        this.bots = this.bots.filter((bot) => bot.environmentId !== id)
        this.archived.push({
          id,
          name: environment.name,
          createdAt: environment.createdAt,
          archivedAt: now(),
          files: 'kept',
          bots: bots.map((bot) => ({ id: bot.id, name: bot.name, role: bot.role, tint: bot.tint })),
        })
        return send(200, { ...environment, lifecycle: 'archived', updatedAt: now() })
      }
      case 'archivedEnvironmentDelete':
        this.archived = this.archived.filter((item) => item.id !== id)
        return send(204)
      default:
        return send(404, { code: 'NOT_FOUND', message: `Not in the fake gateway: ${key}` })
    }
  }
}

export interface DockerReply {
  code: number
  stdout: string
  stderr: string
}

const ok = (stdout = ''): DockerReply => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, code = 1): DockerReply => ({ code, stdout: '', stderr: `${stderr}\n` })

function envValues(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match) values.set(match[1], match[2].replace(/^'(.*)'$/, '$1'))
  }
  return values
}

/**
 * The Docker engine of this computer or of a VPS: the commands the installer runs, the images it holds, and the gateway
 * container, which `compose up` starts from the project's `.env`.
 */
export class FakeDockerEngine {
  readonly calls: string[][] = []
  readonly images = new Set<string>()
  daemon: 'running' | 'stopped' | 'no-permission' = 'running'
  private upEnv: string | null = null
  private published: number | null = null

  constructor(
    private readonly options: {
      gateway: FakeGateway
      engineName: string
      /** A file on the engine's machine, such as the project's `.env`. */
      readFile: (file: string) => Promise<string | null>
      /** Where the gateway listens for the port the `.env` publishes: that port here, any port behind a VPS tunnel. */
      listenPort: (published: number) => number
    }
  ) {}

  /** The commands run, without the Compose project flags, that start with this prefix. */
  commands(prefix: string[] = []): string[][] {
    return this.calls.map(commandOf).filter((command) => prefix.every((part, index) => command[index] === part))
  }

  async run(args: string[]): Promise<DockerReply> {
    this.calls.push(args)
    const command = commandOf(args)
    const [first, second] = command
    const gateway = this.options.gateway
    if (first === 'info') {
      if (this.daemon === 'running')
        return ok(
          JSON.stringify({ ServerVersion: '28.0.1', OperatingSystem: this.options.engineName, MemTotal: 8 * GB })
        )
      const reason =
        this.daemon === 'stopped'
          ? 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
          : 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'
      return { code: 1, stdout: JSON.stringify({ ServerErrors: [reason] }), stderr: '' }
    }
    if (this.daemon !== 'running')
      return fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')
    if (first === 'compose' && second === 'version') return ok('2.29.7\n')
    if (first === 'ps') return ok('')
    if (first === 'pull') {
      const ref = command[1]
      this.images.add(ref)
      const tag = ref.slice(ref.lastIndexOf(':') + 1)
      return ok(
        [
          `${tag}: Pulling from ${ref.slice(0, ref.lastIndexOf(':'))}`,
          '0a1b2c3d4e5f: Pulling fs layer',
          '0a1b2c3d4e5f: Pull complete',
          `Status: Downloaded newer image for ${ref}`,
          '',
        ].join('\n')
      )
    }
    if (first === 'image' && second === 'inspect') {
      const ref = command.at(-1) ?? ''
      return this.images.has(ref) ? ok('sha256:0a1b2c3d4e5f\n') : fail(`Error: No such image: ${ref}`)
    }
    if (first === 'image' && second === 'rm') {
      const ref = command[2]
      return this.images.delete(ref)
        ? ok(`Untagged: ${ref}\n`)
        : fail(`Error response from daemon: No such image: ${ref}`)
    }
    if (first === 'image' && second === 'ls') {
      const repository = command.at(-1) ?? ''
      return ok([...this.images].filter((ref) => ref.startsWith(`${repository}:`)).join('\n'))
    }
    if (first === 'compose') {
      const envFile = args[args.indexOf('--env-file') + 1] ?? ''
      switch (second) {
        case 'up':
          return this.up(envFile)
        case 'port':
          return gateway.running && this.published ? ok(`127.0.0.1:${this.published}\n`) : fail('no container found')
        case 'exec':
          return gateway.running
            ? ok(`${gateway.issueCode()} (expires ${new Date(Date.now() + 600_000).toISOString()})\n`)
            : fail('service "maestrly-bot-gateway" is not running')
        case 'down':
          await gateway.stop()
          gateway.reset()
          this.upEnv = null
          this.published = null
          return ok('')
      }
    }
    return fail(`The fake Docker engine does not know: docker ${command.join(' ')}`, 125)
  }

  private async up(envFile: string): Promise<DockerReply> {
    const env = await this.options.readFile(envFile)
    if (env === null) return fail(`open ${envFile}: no such file or directory`)
    const values = envValues(env)
    for (const key of ['MAESTRLY_GATEWAY_IMAGE', 'MAESTRLY_GATEWAY_BOT_IMAGE']) {
      const ref = values.get(key) ?? ''
      if (!this.images.has(ref)) return fail(`Error response from daemon: No such image: ${ref}`)
    }
    const gateway = this.options.gateway
    if (gateway.running && env === this.upEnv) return ok('Container maestrly-bots-maestrly-bot-gateway-1  Running\n')
    const published = Number(values.get('MAESTRLY_GATEWAY_PORT'))
    // A changed `.env` recreates the container: its connections end, and the gateway keeps its volume.
    if (gateway.running) gateway.dropConnections()
    else await gateway.start(this.options.listenPort(published))
    this.upEnv = env
    this.published = published
    return ok('Container maestrly-bots-maestrly-bot-gateway-1  Started\n')
  }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * A `docker` executable for the app on this computer: a POSIX shell script that runs a Node client, which posts its
 * arguments to a server here and prints the engine's reply with its exit code.
 */
export async function startFakeDockerCli(
  engine: FakeDockerEngine,
  dir: string
): Promise<{ path: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const { args } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { args: string[] }
      engine
        .run(args)
        .catch((error: unknown): DockerReply => ({ code: 125, stdout: '', stderr: `${String(error)}\n` }))
        .then((reply) => {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(reply))
        })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await mkdir(dir, { recursive: true })
  const client = path.join(dir, 'fake-docker.mjs')
  await writeFile(
    client,
    `const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const response = await fetch('http://127.0.0.1:${port}/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ args: process.argv.slice(2), input: Buffer.concat(chunks).toString('utf8') }),
})
const reply = await response.json()
process.stdout.write(reply.stdout)
process.stderr.write(reply.stderr)
process.exitCode = reply.code
`
  )
  const docker = path.join(dir, 'docker')
  await writeFile(docker, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(client)} "$@"\n`)
  await chmod(docker, 0o755)
  return {
    path: docker,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/** The words of a command the installer quotes for a POSIX shell. */
export function shellWords(command: string): string[] {
  const words: string[] = []
  let word = ''
  let started = false
  let quoted = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quoted) {
      if (char === "'") quoted = false
      else word += char
    } else if (char === "'") {
      quoted = true
      started = true
    } else if (char === '\\') {
      word += command[++index] ?? ''
      started = true
    } else if (char === ' ') {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (started) words.push(word)
  return words
}

/**
 * An Ubuntu VPS behind the fake SSH server: it answers the installer's scripts by the name on their first line, runs
 * Docker through its own engine once Docker is installed, keeps the files the installer writes, and forwards its
 * loopback port 7443 to the gateway.
 */
export class FakeVps {
  readonly files = new Map<string, string>()
  readonly engine: FakeDockerEngine
  dockerInstalled = false
  /** The SSH server's authorized keys, which the installer's scripts add to and remove from. */
  authorizedKeys: string[] = []

  constructor(
    private readonly gateway: FakeGateway,
    private readonly hostname: string
  ) {
    this.engine = new FakeDockerEngine({
      gateway,
      engineName: 'Ubuntu 24.04.1 LTS',
      readFile: async (file) => this.files.get(file) ?? null,
      listenPort: () => 0,
    })
  }

  /** The scripts run so far, by the name on their first line. */
  scripts(commands: Array<{ command: string; input: string }>): string[] {
    return commands.flatMap(({ command, input }) => {
      const name = /# maestrly-bot-server:([a-z-]+)/.exec(`${input}\n${command}`)?.[1]
      return name ? [name] : []
    })
  }

  readonly forwardTo = (port: number): number | null => (port === 7443 ? this.gateway.port : null)

  readonly exec = async (command: string, input: string, user: string): Promise<FakeExecResult> => {
    const words = shellWords(command)
    if (words[0] === 'sudo' && words[1] === '-n') words.splice(0, 2)
    const [program] = words
    if (program === 'docker') {
      if (!this.dockerInstalled) return { code: 127, stderr: 'sh: 1: docker: not found\n' }
      return this.engine.run(words.slice(1))
    }
    if (program === 'cat' && words[1] === '--') {
      const content = this.files.get(words[2])
      return content === undefined
        ? { code: 1, stderr: `cat: ${words[2]}: No such file or directory\n` }
        : { code: 0, stdout: content }
    }
    if (program === 'sh' && words[1] === '-c' && words[2]?.includes('maestrly-bot-server:write-file')) {
      this.files.set(words[5], input)
      return { code: 0 }
    }
    if (program !== 'sh' || words[1] !== '-s' || words[2] !== '--')
      return { code: 127, stderr: `The fake VPS does not know: ${command}\n` }
    const args = words.slice(3)
    switch (/^# maestrly-bot-server:([a-z-]+)/.exec(input)?.[1]) {
      case 'probe': {
        const env = this.files.get(`${args[0]}/.env`)
        return {
          code: 0,
          stdout: [
            'os_id=ubuntu',
            'os_version=24.04',
            'os_name=Ubuntu 24.04.1 LTS',
            'arch=x86_64',
            'memory_kb=8000000',
            'disk_free_kb=40000000',
            `hostname=${this.hostname}`,
            `root=${user === 'root' ? 1 : 0}`,
            'sudo=1',
            `docker=${this.dockerInstalled ? 1 : 0}`,
            `compose=${this.dockerInstalled ? 1 : 0}`,
            ...(env === undefined ? [] : [`existing_env=${Buffer.from(env).toString('base64')}`]),
            '',
          ].join('\n'),
        }
      }
      case 'install-docker':
        this.dockerInstalled = true
        return { code: 0, stdout: '# Executing docker install script\nDocker Compose version v2.29.7\n' }
      case 'authorize-key':
        if (!this.authorizedKeys.includes(args[0])) this.authorizedKeys.push(args[0])
        return { code: 0 }
      case 'revoke-key':
        for (let index = this.authorizedKeys.length - 1; index >= 0; index--)
          if (this.authorizedKeys[index].endsWith(` ${args[0]}`)) this.authorizedKeys.splice(index, 1)
        return { code: 0 }
      case 'remove-project':
        for (const file of [...this.files.keys()]) if (file.startsWith(`${args[0]}/`)) this.files.delete(file)
        return { code: 0 }
      default:
        return { code: 127, stderr: `The fake VPS does not know this script: ${input.split('\n')[0]}\n` }
    }
  }
}
