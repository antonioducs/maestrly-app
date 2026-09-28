import { createHash } from 'node:crypto'
import net from 'node:net'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2

/**
 * The fingerprint as OpenSSH prints it, computed here rather than with the app's function: tests then check the app's
 * computation, and Electron end-to-end tests can use this server without loading main-process modules.
 */
const hostKeyFingerprint = (key: Buffer) =>
  `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`

export interface FakeExecResult {
  code: number
  stdout?: string
  stderr?: string
}

export interface FakeSshServerOptions {
  /** Users who may sign in with a password, by name. */
  users: Record<string, string>
  /** Answers a command with its whole standard input; `id -u` is answered already (0 for root, else 1000). */
  exec?: (command: string, input: string, user: string) => FakeExecResult | Promise<FakeExecResult>
  /** Where a tunnel to a server port goes on this machine; null refuses it as a closed port would. */
  forwardTo?: (port: number) => number | null
  /** False refuses every tunnel, as `AllowTcpForwarding no` does. */
  allowForwarding?: boolean
}

export interface FakeSshServer {
  readonly port: number
  /** The current host key's fingerprint, as `hostKeyFingerprint` computes it. */
  readonly fingerprint: string
  /** Public keys accepted for any user, in OpenSSH format. */
  readonly authorizedKeys: string[]
  /** Commands run, with their input and user. */
  readonly commands: Array<{ command: string; input: string; user: string }>
  /** SSH connections accepted so far. */
  readonly connections: number
  close(): Promise<void>
  /** Drops every connection and listens again on the same port, optionally with a new host key. */
  restart(options?: { newHostKey?: boolean }): Promise<void>
}

/** An SSH server in this process, standing in for a VPS in tests. Uses only synthetic credentials. */
export async function startFakeSshServer(options: FakeSshServerOptions): Promise<FakeSshServer> {
  let hostKey = utils.generateKeyPairSync('ed25519').private
  const authorizedKeys: string[] = []
  const commands: FakeSshServer['commands'] = []
  const clients = new Set<{ end(): unknown }>()
  let connections = 0
  let port = 0
  let server: InstanceType<typeof Server>

  const fingerprintOf = (key: string) => {
    const parsed = utils.parseKey(key)
    if (parsed instanceof Error) throw parsed
    return hostKeyFingerprint(parsed.getPublicSSH() as Buffer)
  }

  const create = () =>
    new Server({ hostKeys: [hostKey] }, (client) => {
      connections++
      clients.add(client)
      client.on('close', () => clients.delete(client))
      let user = ''
      client.on('error', () => {})
      client.on('authentication', (context) => {
        if (context.method === 'password' && options.users[context.username] === context.password) {
          user = context.username
          return context.accept()
        }
        if (context.method === 'publickey') {
          const allowed = authorizedKeys
            .map((line) => utils.parseKey(line))
            .find(
              (key) =>
                !(key instanceof Error) &&
                key.type === context.key.algo &&
                Buffer.compare(key.getPublicSSH() as Buffer, context.key.data) === 0
            )
          if (!allowed || allowed instanceof Error) return context.reject()
          if (!context.signature) return context.accept()
          if (allowed.verify(context.blob as Buffer, context.signature, context.hashAlgo) !== true)
            return context.reject()
          user = context.username
          return context.accept()
        }
        context.reject(['password', 'publickey'])
      })
      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession()
          session.on('exec', (accept, _reject, info) => {
            const stream = accept()
            let input = ''
            stream.on('data', (chunk: Buffer) => {
              input += chunk.toString('utf8')
            })
            stream.on('end', async () => {
              commands.push({ command: info.command, input, user })
              const result: FakeExecResult =
                info.command === 'id -u'
                  ? { code: 0, stdout: user === 'root' ? '0\n' : '1000\n' }
                  : ((await options.exec?.(info.command, input, user)) ?? { code: 0 })
              if (result.stdout) stream.write(result.stdout)
              if (result.stderr) stream.stderr.write(result.stderr)
              stream.exit(result.code)
              stream.end()
            })
          })
        })
        if (options.allowForwarding !== false)
          client.on('tcpip', (accept, reject, info) => {
            const target = options.forwardTo?.(info.destPort) ?? null
            if (target === null) return reject()
            const socket = net.connect(target, '127.0.0.1')
            socket.once('error', () => reject())
            socket.once('connect', () => {
              const channel = accept()
              channel.on('error', () => socket.destroy())
              socket.pipe(channel).pipe(socket)
            })
          })
      })
    })

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server = create()
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        port = (server.address() as net.AddressInfo).port
        resolve()
      })
    })

  const close = () =>
    new Promise<void>((resolve) => {
      for (const client of clients) client.end()
      clients.clear()
      server.close(() => resolve())
    })

  await listen()
  return {
    get port() {
      return port
    },
    get fingerprint() {
      return fingerprintOf(hostKey)
    },
    authorizedKeys,
    commands,
    get connections() {
      return connections
    },
    close,
    async restart(restartOptions = {}) {
      await close()
      if (restartOptions.newHostKey) hostKey = utils.generateKeyPairSync('ed25519').private
      await listen()
    },
  }
}
