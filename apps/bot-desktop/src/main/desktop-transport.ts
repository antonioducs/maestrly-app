import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Duplex } from 'node:stream'
import { DESKTOP_ATTACH_LINE_MAX, desktopAttachReplySchema } from '@maestrly/host-protocol'
import { aliasValue } from './validation'
import { LOCAL_HOST_EXECUTABLE } from './local-transport'
import type { HostTarget } from '../shared/types'

export const DESKTOP_STDIO = 'desktop-stdio'
/** Same strict SSH policy as the RPC channel; the remote command is a literal. */
export function sshMediaArgs(alias: string): string[] {
  return [
    '-T',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'IPQoS=lowdelay',
    '--',
    aliasValue(alias),
    `/Library/MaestrlyHost/bin/maestrly-host ${DESKTOP_STDIO}`,
  ]
}
export type Launch = (command: string, args: string[]) => ChildProcessWithoutNullStreams
const defaultLaunch: Launch = (command, args) =>
  spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], ...(command === LOCAL_HOST_EXECUTABLE ? { env: { PATH: '/usr/bin:/bin' } } : {}) })

/** Bytes of one attached media process, after its accept line. */
class ProcessStream extends Duplex {
  constructor(private readonly child: ChildProcessWithoutNullStreams, leftover: Buffer) {
    super({ allowHalfOpen: false })
    this.on('error', () => {})
    if (leftover.length) this.push(leftover)
    child.stdout.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) child.stdout.pause()
    })
    child.stdout.once('end', () => this.push(null))
    child.once('close', () => this.destroy())
    child.stdin.on('error', () => this.destroy())
  }
  override _read() {
    this.child.stdout.resume()
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.child.stdin.destroyed) return callback(new Error('Desktop media closed'))
    if (this.child.stdin.write(chunk)) callback()
    else this.child.stdin.once('drain', () => callback())
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.child.stdin.destroy()
    if (this.child.exitCode === null) this.child.kill()
    callback(error)
  }
}
/**
 * Starts the fixed media command for the selected Host and exchanges the single-use
 * ticket over stdin. The ticket never appears in arguments, environment or logs.
 */
export async function openMedia(target: HostTarget, ticket: string, launch: Launch = defaultLaunch, timeoutMs = 20_000) {
  if (!/^[a-f0-9]{64}$/.test(ticket)) throw new Error('Invalid desktop ticket')
  const child = target.kind === 'local' ? launch(LOCAL_HOST_EXECUTABLE, [DESKTOP_STDIO]) : launch('/usr/bin/ssh', sshMediaArgs(target.alias))
  child.stderr.resume()
  const reply = await new Promise<{ width: number; height: number; leftover: Buffer }>((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const finish = (error?: Error, value?: { width: number; height: number; leftover: Buffer }) => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('close', onClose)
      child.off('error', onError)
      if (error) {
        child.kill()
        reject(error)
      } else resolve(value!)
    }
    const onError = () => finish(new Error('Não foi possível abrir o canal da tela'))
    const onClose = () => finish(Object.assign(new Error('O computador encerrou o canal da tela'), { code: 'DESKTOP_UNAVAILABLE' }))
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(10)
      if (newline < 0) {
        if (buffer.length > DESKTOP_ATTACH_LINE_MAX) finish(new Error('Resposta inválida do canal da tela'))
        return
      }
      child.stdout.pause()
      try {
        const parsed = desktopAttachReplySchema.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8')))
        if (!parsed.accepted) return finish(Object.assign(new Error('A tela recusou a conexão'), { code: parsed.code }))
        finish(undefined, { width: parsed.width, height: parsed.height, leftover: buffer.subarray(newline + 1) })
      } catch {
        finish(new Error('Resposta inválida do canal da tela'))
      }
    }
    const timer = setTimeout(() => finish(Object.assign(new Error('O canal da tela não respondeu'), { code: 'DESKTOP_UNAVAILABLE' })), timeoutMs)
    child.stdout.on('data', onData)
    child.once('close', onClose)
    child.once('error', onError)
    child.stdin.write(`${JSON.stringify({ version: 1, ticket })}\n`)
  })
  return { stream: new ProcessStream(child, reply.leftover), width: reply.width, height: reply.height }
}
