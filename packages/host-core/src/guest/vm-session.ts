import { connect } from 'node:net'
import { lstat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Duplex } from 'node:stream'
import { JsonWire, SessionRouter, type RoutedStream } from '@maestrly/guest-transport'
import { VM_RUNTIME_PROTOCOL, guestHelloSchema, vmHelloSchema, vmRequestSchema, vmResponseSchema, type VmRequest } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
export class VmSession {
  readonly router: SessionRouter
  readonly legacy?: Duplex
  private pending = new Map<string, Pending>()
  private legacyClaimed = false
  /** Runtime version the supervisor announced in its hello; decides whether an update applies. */
  readonly runtimeVersion?: string
  private constructor(readonly wire: JsonWire, readonly managed: boolean, first: unknown) {
    this.runtimeVersion = managed ? vmHelloSchema.safeParse(first).data?.version : undefined
    this.router = new SessionRouter(wire)
    if (!managed) {
      const stream = new Duplex({ read() {}, write(bytes, _encoding, cb) { wire.stream.write(bytes, cb) }, destroy(error, cb) { wire.close(); cb(error) } })
      stream.on('error', () => {})
      stream.push(JSON.stringify(first) + '\n')
      wire.on('frame', frame => stream.push(JSON.stringify(frame) + '\n'))
      wire.on('close', () => stream.destroy())
      this.legacy = stream
    } else wire.on('frame', (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) return
      if (raw.type === 'vm.hello') { wire.close(); return } // supervisor reboot on an existing QEMU socket
      if (raw.type !== 'vm.response') return
      const frame = vmResponseSchema.parse(raw)
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.error) pending.reject(new HostError(frame.error.code, frame.error.message))
      else pending.resolve(frame.result)
    })
    wire.on('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new HostError('SESSION_UNREACHABLE', 'A conexão do supervisor caiu; consulte a operação antes de repetir')) }
      this.pending.clear()
    })
  }
  get alive() { return !this.wire.stream.destroyed }
  static async open(path: string, hostId: string, hostGeneration: number, timeout = 15000): Promise<VmSession> {
    const stat = await lstat(path)
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new HostError('SESSION_UNREACHABLE', 'VM socket ownership mismatch')
    const socket = connect({ path })
    const wire = new JsonWire(socket)
    const first: unknown = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { wire.close(); reject(new HostError('SESSION_UNREACHABLE', 'O supervisor da VM não respondeu')) }, timeout)
      const close = () => { clearTimeout(timer); reject(new HostError('SESSION_UNREACHABLE', 'A conexão da VM foi encerrada')) }
      wire.once('close', close)
      wire.once('frame', frame => { clearTimeout(timer); wire.off('close', close); resolve(frame) })
    })
    const hello = vmHelloSchema.safeParse(first)
    if (!hello.success && !guestHelloSchema.safeParse(first).success) { wire.close(); throw new HostError('SESSION_PROTOCOL', 'Supervisor incompatível') }
    const session = new VmSession(wire, hello.success, first)
    if (hello.success) wire.send({ type: 'vm.welcome', protocol: VM_RUNTIME_PROTOCOL, nonce: hello.data.nonce, hostId, hostGeneration })
    return session
  }
  claimLegacy(): Duplex {
    if (!this.legacy || this.legacyClaimed) throw new HostError('SESSION_UPDATE_REQUIRED', 'O ambiente antigo suporta somente uma área de trabalho')
    this.legacyClaimed = true
    return this.legacy
  }
  request<M extends VmRequest['method']>(method: M, params: Extract<VmRequest, { method: M }>['params'], timeout = 60000): Promise<unknown> {
    if (!this.managed || !this.alive) return Promise.reject(new HostError('SESSION_UPDATE_REQUIRED', 'Atualize o ambiente para gerenciar áreas de trabalho'))
    if (this.pending.size >= 16) return Promise.reject(new HostError('VM_BUSY', 'Supervisor ocupado'))
    const id = randomUUID()
    const frame = vmRequestSchema.parse({ type: 'vm.request', id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HostError('SESSION_TIMEOUT', 'Resultado da operação incerto; consulte a sessão antes de repetir'))
        this.close()
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.wire.send(frame) } catch { this.close() }
    })
  }
  openRoute(sessionId: string, generation: number): Promise<RoutedStream> { return this.router.open(sessionId, generation) }
  close() { this.router.close(); this.wire.close() }
}
