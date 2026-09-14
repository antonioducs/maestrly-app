import { requestSchema, responseSchema } from '@maestrly/host-protocol'
import { validateResult, sanitize, HostRequestError } from './host-client'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { aliasValue } from './validation'
import type { Connection } from '../shared/types'
export function sshArgs(alias: string): string[] {
  return [
    '-T',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '--',
    aliasValue(alias),
    '/Library/MaestrlyHost/bin/maestrly-host rpc-stdio',
  ]
}
type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
export class SshTransport {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private state: Connection = { connected: false, alias: null }
  constructor(
    private launch: (command: string, args: string[]) => ChildProcessWithoutNullStreams = (command, args) =>
      spawn(command, args, { shell: false }),
    private timeout = 30_000
  ) {}
  status(): Connection {
    return { ...this.state }
  }
  connect(alias: string): void {
    this.launchFixed('/usr/bin/ssh', sshArgs(alias), alias)
  }
  /** Fixed launcher and argument list only; callers never pass renderer-controlled commands. */
  protected launchFixed(command: string, args: string[], alias: string): void {
    this.disconnect()
    const child = this.launch(command, args)
    this.child = child
    this.state = { connected: true, alias }
    let buffer = ''
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096)
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        this.fail('Host response exceeded frame limit')
        return
      }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          const message = responseSchema.parse(JSON.parse(line))
          const pending = this.pending.get(message.id)
          if (!pending) continue
          this.pending.delete(message.id)
          clearTimeout(pending.timer)
          if (message.error)
            pending.reject(new HostRequestError(String(sanitize(message.error.message)), message.error.code))
          else {
            try {
              pending.resolve(validateResult(pending.method, message.result))
            } catch {
              pending.reject(new Error('Invalid host result for ' + pending.method))
              this.fail('Invalid host protocol result')
            }
          }
        } catch {
          this.fail('Invalid host protocol response')
          return
        }
      }
    })
    child.on('error', (error) => {
      if (this.child === child) this.fail(error.message)
    })
    child.stdin.on('error', (error) => {
      if (this.child === child) this.fail(error.message)
    })
    child.on('close', () => {
      if (this.child === child)
        this.fail(
          alias === 'local'
            ? `O Host local encerrou a conexão. ${stderr || 'Verifique se o serviço está em execução.'}`
            : `SSH disconnected. ${stderr || 'Check the alias, known_hosts, and host installation.'}`
        )
    })
  }
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('Host disconnected. Reconnect to refresh state.'))
    const id = randomUUID()
    const request = requestSchema.parse({ version: 1, id, method, params })
    const child = this.child
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail('Host request timed out. Mutation outcome may be unknown; reconnect and inspect before retrying.'),
        this.timeout
      )
      this.pending.set(id, { method, resolve, reject, timer })
      child.stdin.write(JSON.stringify(request) + '\n')
    })
  }
  disconnect(): void {
    this.fail('Host disconnected. In-flight mutation outcome is unknown; inspect before retrying.')
  }
  private fail(message: string): void {
    message = String(sanitize(message))
    const child = this.child
    this.child = null
    this.state = { ...this.state, connected: false, error: message }
    child?.kill()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.pending.clear()
  }
}
