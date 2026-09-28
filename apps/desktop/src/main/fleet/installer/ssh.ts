import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import path from 'node:path'
import type { Duplex } from 'node:stream'
// ssh2 is CommonJS without named exports Node can detect from the ESM main bundle.
import ssh2, { type ClientChannel, type ConnectConfig } from 'ssh2'
import type { FleetRemoteTarget, FleetSshCredentials } from '../../../shared/fleet-installer'
import { lastLine } from './docker-host'
import { InstallerError } from './errors'
import type { CommandRunner, RunOptions, RunResult } from './runner'

const { Client } = ssh2

/** The SSH host key fingerprint as OpenSSH prints it: `SHA256:` and unpadded base64. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** A POSIX shell word for any string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** An SSH wire `string`: its length as a 32-bit big-endian number, then its bytes. */
function sshString(value: Buffer | string): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value) : value
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, data])
}

/**
 * A new ed25519 key pair in OpenSSH format; the comment ends the public key line. Encoded here from Node's key: ssh2's
 * generator strips the leading zero bytes of the public key, so one key in 256 came out unreadable.
 */
export function generateSshKey(
  comment: string,
  pair: { privateKey: KeyObject } = generateKeyPairSync('ed25519')
): { privateKey: string; publicKey: string } {
  const jwk = pair.privateKey.export({ format: 'jwk' })
  if (jwk.crv !== 'Ed25519' || !jwk.d || !jwk.x) throw new Error('Not an ed25519 private key')
  const seed = Buffer.from(jwk.d, 'base64url')
  const publicKey = Buffer.from(jwk.x, 'base64url')
  const keyType = 'ssh-ed25519'
  const publicBlob = Buffer.concat([sshString(keyType), sshString(publicKey)])
  // Two equal check numbers, the key, and padding 1, 2, 3… to the 8-byte block of the unencrypted format.
  const check = randomBytes(4)
  const secret = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshString(comment),
  ])
  const padding = Buffer.from(Array.from({ length: (8 - (secret.length % 8)) % 8 }, (_, index) => index + 1))
  const keys = Buffer.alloc(4)
  keys.writeUInt32BE(1)
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    keys,
    sshString(publicBlob),
    sshString(Buffer.concat([secret, padding])),
  ])
  const lines = body.toString('base64').match(/.{1,70}/g) ?? []
  return {
    privateKey: ['-----BEGIN OPENSSH PRIVATE KEY-----', ...lines, '-----END OPENSSH PRIVATE KEY-----', ''].join('\n'),
    publicKey: `${keyType} ${publicBlob.toString('base64')} ${comment}`,
  }
}

export interface SshConnectOptions {
  /** The pinned fingerprint; null trusts the key on first use and reports it as `hostKey`. */
  expectedHostKey: string | null
  signal?: AbortSignal
  readyTimeoutMs?: number
  keepaliveIntervalMs?: number
}

const OUTPUT_MAX = 1_048_576
const unreachableCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
])
/** RFC 4254 channel open failure reasons. */
const PROHIBITED = 1
const CONNECT_FAILED = 2

/** An SSH connection to a VPS: commands, and tunnels to its loopback ports. */
export class SshSession {
  private closed = false
  private isRoot = false
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private lastError: Error | undefined

  private constructor(
    private readonly client: InstanceType<typeof Client>,
    readonly hostKey: string
  ) {
    client.on('error', (error) => {
      this.lastError = error
    })
    client.on('close', () => {
      this.closed = true
      for (const listener of [...this.closeListeners]) listener(this.lastError)
      this.closeListeners.clear()
    })
  }

  /** Whether commands run as root; otherwise they go through `sudo -n`. */
  get root(): boolean {
    return this.isRoot
  }

  static connect(
    target: FleetRemoteTarget,
    credentials: FleetSshCredentials,
    options: SshConnectOptions
  ): Promise<SshSession> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new InstallerError('cancelled'))
      const client = new Client()
      let hostKey: string | null = null
      let hostKeyMismatch = false
      let settled = false
      const fail = (error: InstallerError) => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener('abort', onAbort)
        // A server that never finished the handshake may never close its side either.
        client.destroy()
        reject(error)
      }
      const onAbort = () => fail(new InstallerError('cancelled'))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        // Servers that ask for the password through keyboard-interactive authentication get the same password.
        finish(prompts.map(() => (credentials.kind === 'password' ? credentials.password : '')))
      })
      // Kept for the whole connection: an 'error' without a listener would throw.
      client.on('error', (error: Error & { level?: string; code?: string }) => {
        if (hostKeyMismatch) return fail(new InstallerError('ssh-host-key', hostKey))
        if (error.level === 'client-authentication') return fail(new InstallerError('ssh-auth', null))
        const detail = error.code && unreachableCodes.has(error.code) ? error.code : error.message
        fail(new InstallerError('ssh-unreachable', detail))
      })
      client.once('ready', () => {
        if (settled) return client.end()
        const session = new SshSession(client, hostKey ?? '')
        session
          .exec('id -u')
          .then((result) => {
            if (settled) return
            settled = true
            options.signal?.removeEventListener('abort', onAbort)
            session.isRoot = result.code === 0 && result.stdout.trim() === '0'
            resolve(session)
          })
          .catch((error: unknown) =>
            fail(error instanceof InstallerError ? error : new InstallerError('ssh-unreachable', String(error)))
          )
      })
      client.once('close', () => fail(new InstallerError('ssh-unreachable', 'Connection closed')))
      const config: ConnectConfig = {
        host: target.host.replace(/^\[(.*)\]$/, '$1'),
        port: target.port,
        username: target.username,
        readyTimeout: options.readyTimeoutMs ?? 20_000,
        keepaliveInterval: options.keepaliveIntervalMs ?? 0,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          hostKey = hostKeyFingerprint(key)
          hostKeyMismatch = options.expectedHostKey !== null && hostKey !== options.expectedHostKey
          return !hostKeyMismatch
        },
        ...(credentials.kind === 'password'
          ? { password: credentials.password, tryKeyboard: true }
          : {
              privateKey: credentials.privateKey,
              ...(credentials.passphrase ? { passphrase: credentials.passphrase } : {}),
            }),
      }
      try {
        client.connect(config)
      } catch (error) {
        // A private key that cannot be parsed or decrypted; the message names the problem, never the key.
        fail(new InstallerError('ssh-auth', error instanceof Error ? error.message : null))
      }
    })
  }

  /** Runs a command; its standard input gets `input`, then end of file. Resolves with any exit code. */
  exec(command: string, options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new InstallerError('cancelled'))
      if (this.closed) return reject(new InstallerError('ssh-unreachable', 'Connection closed'))
      this.client.exec(command, (error, stream) => {
        if (error) return reject(new InstallerError('ssh-unreachable', error.message))
        let stdout = ''
        let stderr = ''
        let pending = ''
        let settled = false
        let timedOut = false
        const emit = (chunk: string) => {
          if (!options.onLine) return
          pending += chunk
          const lines = pending.split(/\r\n|\n|\r/)
          pending = lines.pop() ?? ''
          for (const line of lines) if (line.trim()) options.onLine(line.trimEnd())
        }
        const onAbort = () => {
          stream.close()
          finish(() => reject(new InstallerError('cancelled')))
        }
        const timer = options.timeoutMs
          ? setTimeout(() => {
              timedOut = true
              stream.close()
            }, options.timeoutMs)
          : null
        const finish = (settle: () => void) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          settle()
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        stream.setEncoding('utf8')
        stream.stderr.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          stdout = (stdout + chunk).slice(-OUTPUT_MAX)
          emit(chunk)
        })
        stream.stderr.on('data', (chunk: string) => {
          stderr = (stderr + chunk).slice(-OUTPUT_MAX)
          emit(chunk)
        })
        let exitCode: number | null = null
        stream.on('exit', (code: number | null, signal?: string) => {
          exitCode = typeof code === 'number' ? code : signal ? 128 : null
        })
        stream.on('close', (code?: number | null) => {
          if (options.onLine && pending.trim()) options.onLine(pending.trimEnd())
          const status = exitCode ?? (typeof code === 'number' ? code : null)
          finish(() =>
            resolve(
              timedOut
                ? {
                    code: 124,
                    stdout,
                    stderr: `${stderr}\nTimed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} s`,
                  }
                : status !== null
                  ? { code: status, stdout, stderr }
                  : { code: 255, stdout, stderr: `${stderr}\nConnection lost` }
            )
          )
        })
        stream.end(options.input ?? '')
      })
    })
  }

  /** A channel to a TCP port on the server's loopback. */
  forward(remotePort: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new InstallerError('ssh-unreachable', 'Connection closed'))
      this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (error, channel: ClientChannel) => {
        if (!error) return resolve(channel)
        const reason = (error as Error & { reason?: number }).reason
        reject(
          new InstallerError(
            reason === PROHIBITED
              ? 'ssh-forwarding'
              : reason === CONNECT_FAILED
                ? 'gateway-unhealthy'
                : 'ssh-unreachable',
            error.message
          )
        )
      })
    })
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.closed) {
      listener(this.lastError)
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): void {
    this.client.end()
  }
}

/** Runs Docker and writes files on a VPS, through `sudo -n` when the SSH user is not root. */
export class RemoteRunner implements CommandRunner {
  readonly kind = 'remote' as const

  constructor(private readonly session: Pick<SshSession, 'exec' | 'root'>) {}

  private get sudo(): string {
    return this.session.root ? '' : 'sudo -n '
  }

  docker(args: string[], options?: RunOptions): Promise<RunResult> {
    return this.session.exec(`${this.sudo}docker ${args.map(shellQuote).join(' ')}`, options)
  }

  async writeFile(file: string, content: string): Promise<void> {
    const script =
      '# maestrly-bot-server:write-file\numask 077 && mkdir -p -- "$1" && cat > "$2.tmp" && mv -f -- "$2.tmp" "$2"'
    const result = await this.session.exec(
      `${this.sudo}sh -c ${shellQuote(script)} sh ${shellQuote(path.posix.dirname(file))} ${shellQuote(file)}`,
      { input: content }
    )
    if (result.code !== 0) throw remoteFailure(result)
  }

  async readFile(file: string): Promise<string | null> {
    const result = await this.session.exec(`${this.sudo}cat -- ${shellQuote(file)}`)
    if (result.code === 0) return result.stdout
    if (/No such file/i.test(result.stderr)) return null
    throw remoteFailure(result)
  }

  join(...parts: string[]): string {
    return path.posix.join(...parts)
  }
}

/** A failed command on the server: sudo that wants a password is its own error. */
export function remoteFailure(result: RunResult): InstallerError {
  if (/sudo: .*password/i.test(result.stderr)) return new InstallerError('ssh-sudo', lastLine(result.stderr))
  return new InstallerError('unknown', lastLine(result.stderr, result.stdout))
}
