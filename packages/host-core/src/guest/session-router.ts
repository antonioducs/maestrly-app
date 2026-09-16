import { vmInfoSchema, vmSessionInfoSchema, type BotSession, type VmRequest } from '@maestrly/host-protocol'
import type { DesktopMediaConnector } from '../desktop/media-connector.js'
import type { DesktopVmMethod } from './session.js'
import { HostError } from '../errors.js'
import { VmSession } from './vm-session.js'
import { SocketGuestSession, type GuestConnector } from './session.js'
import type { BotChannelPaths } from './profile.js'
import type { EgressBroker } from '../egress/broker.js'
import type { BotRepository } from '../bots/repository.js'

export class VmGuestConnector implements GuestConnector {
  private channels = new Map<string, Promise<VmSession>>()
  private generations = new Map<string, number>()
  constructor(private hostId: string, private hostGeneration: number, private paths: (vmId: string) => BotChannelPaths, private broker: EgressBroker, private repository: () => BotRepository, private media?: DesktopMediaConnector) {}
  private channel(vmId: string, lane: 'control' | 'egress') {
    const key = `${vmId}:${lane}`
    const old = this.channels.get(key)
    if (old) return old
    const promise = VmSession.open(this.paths(vmId)[lane], this.hostId, this.hostGeneration).then(session => {
      session.wire.once('close', () => { if (this.channels.get(key) === promise) this.channels.delete(key) })
      return session
    }).catch(error => { this.channels.delete(key); throw error })
    this.channels.set(key, promise)
    return promise
  }
  async inspectVm(vmId: string) {
    const connection = await this.channel(vmId, 'control')
    if (!connection.managed) return {}
    return { ...vmInfoSchema.parse(await connection.request('vm.inspect', {})), ...(connection.runtimeVersion ? { runtimeVersion: connection.runtimeVersion } : {}) }
  }
  async createSession(session: BotSession, idempotencyKey: string) {
    if (!session.profile) throw new HostError('SESSION_PROFILE_REQUIRED', 'Perfil de sessão ausente')
    const connection = await this.channel(session.vmId, 'control')
    const result = vmSessionInfoSchema.parse(await connection.request('session.create', { sessionId: session.id, botId: session.botId, profile: session.profile, idempotencyKey, adoptLegacy: session.transport === 'legacy' }))
    this.generations.set(session.id, result.generation)
    return result
  }
  async connect(input: { vmId: string; sessionId: string; hostGeneration: number; transport: 'legacy' | 'managed' }) {
    const record = this.repository().sessionsByVm(input.vmId).find(s => s.id === input.sessionId)
    if (!record || record.issue) throw new HostError('SESSION_CONFLICT', 'A área de trabalho não pertence a este computador')
    if (record.state === 'archived') throw new HostError('SESSION_STOPPED', 'Esta área de trabalho está arquivada')
    if (this.repository().bot(record.botId).status === 'archived') throw new HostError('BOT_ARCHIVED', 'O bot está arquivado')
    const connection = await this.channel(input.vmId, 'control')
    if (!connection.managed) {
      if (input.transport !== 'legacy') throw new HostError('SESSION_UPDATE_REQUIRED', 'Este ambiente ainda não suporta múltiplos bots')
      this.broker.attach(input.vmId, this.paths(input.vmId).egress, this.repository().network(record.botId))
      return SocketGuestSession.fromStream(input.vmId, connection.claimLegacy(), input.hostGeneration)
    }
    if (input.transport !== 'managed') throw new HostError('SESSION_MIGRATION_REQUIRED', 'A área de trabalho antiga precisa ser adotada pelo supervisor antes de executar')
    let info = vmSessionInfoSchema.parse(await connection.request('session.inspect', { sessionId: record.id }))
    if (info.botId !== record.botId) throw new HostError('SESSION_CONFLICT', 'O supervisor apresentou outro bot')
    const active = this.repository().activeTurn(record.botId)
    if (info.state === 'stopped' && active?.cancelRequestedAt) throw new HostError('SESSION_CANCELLING', 'A área de trabalho está concluindo uma parada')
    if (info.state === 'stopped')
      info = vmSessionInfoSchema.parse(await connection.request('session.start', { sessionId: record.id, generation: info.generation, idempotencyKey: `${record.id}:resume:${info.generation}` }))
    if (info.state !== 'running') throw new HostError('SESSION_STOPPED', 'A área de trabalho está parada ou requer reconciliação')
    this.generations.set(record.id, info.generation)
    const egress = await this.channel(input.vmId, 'egress')
    if (!egress.managed) throw new HostError('SESSION_PROTOCOL', 'Canal de rede incompatível')
    if (!this.broker.hasSession(input.vmId, record.id)) {
      const stream = await egress.openRoute(record.id, info.generation)
      this.broker.bindSession(input.vmId, record.id, stream, this.repository().network(record.botId))
    }
    const stream = await connection.openRoute(record.id, info.generation)
    return SocketGuestSession.fromStream(input.vmId, stream, input.hostGeneration)
  }
  async stopSession(session: BotSession, idempotencyKey: string) {
    const connection = await this.channel(session.vmId, 'control')
    const info = vmSessionInfoSchema.parse(await connection.request('session.inspect', { sessionId: session.id }))
    const stopped = vmSessionInfoSchema.parse(await connection.request('session.stop', { sessionId: session.id, generation: info.generation, idempotencyKey }))
    if (stopped.state !== 'stopped') throw new HostError('SESSION_STOP_UNCERTAIN', 'A parada da área de trabalho não foi confirmada')
    this.broker.detachSession(session.vmId, session.id)
    connection.router.closeSession(session.id)
    const egress = this.channels.get(`${session.vmId}:egress`)
    if (egress) (await egress).router.closeSession(session.id)
  }
  async renewSessionLease(session: BotSession, turnId: string, leaseMs: number) {
    if (session.transport !== 'managed') return
    const channel = await this.channel(session.vmId, 'control')
    await channel.request('session.lease', { sessionId: session.id, generation: this.generations.get(session.id) ?? session.generation, turnId, leaseMs: Math.min(30000, leaseMs) }, 5000)
  }
  async releaseSessionLease(session: BotSession, turnId: string) {
    if (session.transport !== 'managed') return
    const channel = await this.channel(session.vmId, 'control')
    await channel.request('session.release', { sessionId: session.id, generation: this.generations.get(session.id) ?? session.generation, turnId }, 5000)
  }
  async inspectSession(session: BotSession) {
    if (session.transport !== 'managed') throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Atualize o ambiente para ver a tela')
    const connection = await this.channel(session.vmId, 'control')
    if (!connection.managed) throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Atualize o ambiente para ver a tela')
    const info = vmSessionInfoSchema.parse(await connection.request('session.inspect', { sessionId: session.id }))
    if (info.botId !== session.botId) throw new HostError('SESSION_CONFLICT', 'O supervisor apresentou outro bot')
    this.generations.set(session.id, info.generation)
    return info
  }
  /** Fixed desktop methods only, on the administrative lane of the exact VM. */
  async desktop(session: BotSession, method: DesktopVmMethod, params: Record<string, unknown>, timeoutMs = 30_000) {
    if (session.transport !== 'managed') throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Atualize o ambiente para ver a tela')
    const connection = await this.channel(session.vmId, 'control')
    if (!connection.managed) throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Atualize o ambiente para ver a tela')
    // The supervisor request schema validates these params before anything is sent.
    return connection.request(method as VmRequest['method'], params as never, timeoutMs)
  }
  async openDesktopMedia(session: BotSession, generation: number, grantId: string) {
    if (!this.media) throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Atualize o Host para ver a tela')
    return this.media.open(session.vmId, { sessionId: session.id, generation, grantId })
  }
  dropDesktop(vmId: string) {
    this.media?.dropVm(vmId)
  }
  dropVm(vmId: string) {
    this.media?.dropVm(vmId)
    for (const lane of ['control', 'egress']) {
      const key = `${vmId}:${lane}`
      const pending = this.channels.get(key)
      this.channels.delete(key)
      if (pending) void pending.then(c => c.close()).catch(() => {})
    }
    this.broker.detach(vmId)
  }
  close() {
    this.media?.close()
    for (const pending of this.channels.values()) void pending.then(c => c.close()).catch(() => {})
    this.channels.clear()
  }
}
