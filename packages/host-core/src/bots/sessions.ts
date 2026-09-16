import { randomUUID } from 'node:crypto'
import { sessionCapacitySchema, type BotOperation, type BotSession, type SessionCapacity, type SessionsInventory, type Vm } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { GuestConnector } from '../guest/session.js'
import { type BotRepository, now } from './repository.js'
import { fingerprint } from './interactions.js'

export function availableSessions(vm: Vm, capacity: SessionCapacity, sessions: readonly BotSession[]): number {
  if (sessions.some(s => s.issue || s.transport !== 'managed' || !s.profile)) return 0
  const active = sessions.filter(s => s.state !== 'archived')
  const sum = (key: 'cpuQuotaPercent' | 'memoryMiB' | 'diskMiB', list: readonly BotSession[]) => list.reduce((n, s) => n + s.profile![key], 0)
  return Math.max(0, Math.min(
    capacity.maxSessions - active.length,
    100 - sessions.length,
    Math.floor((vm.cpus * 100 - sum('cpuQuotaPercent', active)) / capacity.perSession.cpuQuotaPercent),
    Math.floor((vm.memoryMiB - capacity.systemMemoryMiB - sum('memoryMiB', active)) / capacity.perSession.memoryMiB),
    Math.floor((vm.diskGiB * 1024 - capacity.systemDiskMiB - sum('diskMiB', sessions)) / capacity.perSession.diskMiB),
  ))
}
export class BotSessions {
  private inspections = new Map<string, { revision: number; inventory: SessionsInventory }>()
  /** Runtime version each VM supervisor last announced; Host-internal, never sent to clients. */
  private versions = new Map<string, string>()
  runtimeVersion(vmId: string) {
    return this.versions.get(vmId)
  }
  constructor(private repo: BotRepository, private connector: GuestConnector, private vm: (id: string) => Vm,
    private maintenance?: { backup(vmId: string, key: string): Promise<void>; activate(botId: string): Promise<void> }) {}
  snapshot(vmId: string): SessionsInventory {
    const vm = this.vm(vmId), sessions = this.repo.sessionsByVm(vmId), capacity = this.repo.sessionCapacity(vmId)
    const capabilities = this.repo.sessionCapabilities(vmId)
    const last = this.inspections.get(vmId)
    if (last?.revision === vm.revision) return { ...last.inventory, sessions, available: last.inventory.supported && capacity && vm.state === 'running' ? availableSessions(vm, capacity, sessions) : 0 }
    return { vmId, sessions, capabilities, supported: !!capacity, ...(capacity ? { capacity } : {}),
      available: capacity && vm.state === 'running' ? availableSessions(vm, capacity, sessions) : 0 }
  }
  async inspectVm(vmId: string): Promise<SessionsInventory> {
    const revision = this.vm(vmId).revision
    const inventory = await this.inspect(vmId)
    if (revision === this.vm(vmId).revision) this.inspections.set(vmId, { revision, inventory })
    return inventory
  }
  private async inspect(vmId: string): Promise<SessionsInventory> {
    const vm = this.vm(vmId)
    const sessions = this.repo.sessionsByVm(vmId)
    const base = { vmId, sessions, capabilities: [] as string[], supported: false, available: 0 }
    if (this.repo.db.prepare("SELECT vm_id FROM environment_vms WHERE vm_id=? AND state='preparing'").get(vmId)) return { ...base, reason: 'Este ambiente está sendo preparado.' }
    if (sessions.some(s => s.issue === 'LEGACY_BINDING_CONFLICT')) return { ...base, reason: 'Há vínculos antigos conflitantes; o administrador precisa reconciliá-los antes de compartilhar este computador.' }
    if (vm.state !== 'running') return { ...base, reason: 'Ligue o computador para verificar as áreas de trabalho disponíveis.' }
    try {
      const info = await this.connector.inspectVm?.(vmId)
      if (info?.runtimeVersion) this.versions.set(vmId, info.runtimeVersion)
      else this.versions.delete(vmId)
      if (!info?.capacity) return { ...base, reason: 'Atualize o ambiente deste computador para criar áreas de trabalho independentes.' }
      const capacity = sessionCapacitySchema.parse(info.capacity)
      this.repo.saveSessionCapacity(vmId, capacity)
      this.repo.saveSessionCapabilities(vmId, info.capabilities ?? [])
      const available = availableSessions(vm, capacity, sessions)
      return { ...base, supported: true, capabilities: info.capabilities ?? [], capacity, available,
        ...(sessions.some(s => s.transport === 'legacy') ? { reason: 'Migre a área de trabalho existente antes de adicionar outro bot.' }
          : available === 0 ? { reason: 'Este computador não tem recursos reserváveis para outra área de trabalho.' } : {}),
      }
    } catch { return { ...base, reason: 'Não foi possível verificar as áreas de trabalho; reconecte este computador.' } }
  }
  reserve(botId: string, vmId: string, transport: BotSession['transport'], capacity?: SessionCapacity): BotSession {
    const existing = this.repo.session(botId)
    if (existing) {
      if (existing.vmId !== vmId) throw new HostError('SESSION_CONFLICT', 'A área de trabalho já pertence a outro computador')
      return existing
    }
    const others = this.repo.sessionsByVm(vmId)
    if (this.repo.db.prepare("SELECT vm_id FROM environment_vms WHERE vm_id=? AND state='preparing'").get(vmId)) throw new HostError('ENVIRONMENT_BUSY', 'Aguarde a preparação do ambiente antes de criar o bot')
    if (transport === 'managed') {
      if (this.vm(vmId).state !== 'running') throw new HostError('VM_STOPPED', 'Ligue o ambiente antes de criar o bot')
      if (!capacity || availableSessions(this.vm(vmId), capacity, others) < 1)
        throw new HostError('SESSION_CAPACITY_EXCEEDED', 'Não há capacidade para outra área de trabalho neste computador')
    } else if (others.length) throw new HostError('VM_ALREADY_BOUND', 'Atualize o ambiente antes de compartilhar este computador')
    const value: BotSession = { id: randomUUID(), botId, vmId, transport, state: 'reserved', generation: 0, revision: 0,
      ...(capacity ? { profile: capacity.perSession } : {}), createdAt: now(), updatedAt: now() }
    this.repo.saveSession(value)
    return value
  }
  async prepare(botId: string) {
    let session = this.repo.session(botId)
    if (!session || session.issue) throw new HostError('SESSION_UNAVAILABLE', 'A área de trabalho requer reconciliação')
    if (session.transport === 'legacy') {
      const bot = this.repo.bot(botId)
      if (bot.conversationId || bot.accountState !== 'disconnected') return
      const info = await this.connector.inspectVm?.(session.vmId)
      if (!info?.capacity) return
      const others = this.repo.sessionsByVm(session.vmId).filter(s => s.id !== session!.id)
      if (availableSessions(this.vm(session.vmId), info.capacity, others) < 1) throw new HostError('SESSION_CAPACITY_EXCEEDED', 'O computador não tem recursos para esta área de trabalho')
      session = { ...session, transport: 'managed', profile: info.capacity.perSession, revision: session.revision + 1, updatedAt: now() }
      this.repo.saveSession(session)
      this.repo.saveSessionCapacity(session.vmId, info.capacity)
    }
    if (!this.connector.createSession || !session.profile) throw new HostError('SESSION_UPDATE_REQUIRED', 'O ambiente não suporta áreas de trabalho independentes')
    const result = await this.connector.createSession(session, `${session.id}:create`)
    if (result.id !== session.id || result.botId !== session.botId) throw new HostError('SESSION_CONFLICT', 'O ambiente respondeu com outra área de trabalho')
    const current = this.repo.session(botId)!
    this.repo.saveSession({ ...current, state: 'ready', generation: result.generation, revision: current.revision + 1, updatedAt: now() })
  }
  async stop(botId: string) {
    const session = this.repo.session(botId)
    if (!session || session.transport === 'legacy') return
    if (!this.connector.stopSession) throw new HostError('SESSION_UPDATE_REQUIRED', 'O ambiente não suporta a parada independente')
    await this.connector.stopSession(session, `${session.id}:archive`)
    const current = this.repo.session(botId)!
    this.repo.saveSession({ ...current, state: 'archived', revision: current.revision + 1, updatedAt: now() })
  }
  recover() {
    for (const op of this.repo.operations()) {
      if (op.kind !== 'runtime.prepare' || !op.botId || !['queued', 'running'].includes(op.status)) continue
      // No replay of disk backup or adoption after an interrupted Host process.
      this.repo.transaction(() => {
        const bot = this.repo.bot(op.botId!)
        this.repo.saveBot({ ...bot, runtimeState: 'unreachable', revision: bot.revision + 1, updatedAt: now() })
        this.repo.saveOperation({ ...op, status: 'failed', error: { code: 'SESSION_PREPARATION_UNCERTAIN', message: 'A migração foi interrompida; inspecione o supervisor e o backup antes de repetir.' }, updatedAt: now() })
      })
    }
  }
  /** Human bot.runtime.prepare resumes a legacy bot only after a consistent disk backup. */
  adoptLegacy(params: { botId: string; idempotencyKey: string; confirmBackup: true; confirmRestart: true }): BotOperation {
    const print = fingerprint({ method: 'adopt-legacy-session', params })
    const previous = this.repo.operationByKey(params.idempotencyKey)
    if (previous) {
      if (previous.fingerprint !== print) throw new HostError('IDEMPOTENCY_CONFLICT', 'A chave foi usada em outra preparação')
      return previous.operation
    }
    const session = this.repo.session(params.botId)
    if (session?.transport !== 'legacy' || session.issue || this.repo.botsByVm(session.vmId).some(b => this.repo.activeTurn(b.id)))
      throw new HostError('SESSION_MIGRATION_UNAVAILABLE', 'Pare as tarefas e reconcilie o computador antes de migrar a área de trabalho')
    if (params.confirmBackup !== true || params.confirmRestart !== true || !this.maintenance) throw new HostError('CONFIRMATION_REQUIRED', 'Confirme o backup e a janela de reinício')
    const operation = this.repo.transaction(() => {
      const op: BotOperation = { id: randomUUID(), botId: params.botId, kind: 'runtime.prepare', status: 'queued', steps: [{ id: 'backup', label: 'Preservando o computador existente', status: 'pending' }, { id: 'adopt', label: 'Migrando a área de trabalho', status: 'pending' }], createdAt: now(), updatedAt: now() }
      this.repo.insertOperation(op, params.idempotencyKey, print, params)
      const bot = this.repo.bot(params.botId)
      this.repo.saveBot({ ...bot, runtimeState: 'preparing', revision: bot.revision + 1, updatedAt: now() })
      return op
    })
    void this.runAdoption(operation, session).catch(() => {})
    return operation
  }
  private async runAdoption(operation: BotOperation, session: BotSession) {
    try {
      const info = await this.connector.inspectVm?.(session.vmId)
      if (!info?.capacity || !this.connector.createSession) throw new HostError('SESSION_UPDATE_REQUIRED', 'Instale o pacote com supervisor de sessões antes da migração')
      if (availableSessions(this.vm(session.vmId), info.capacity, this.repo.sessionsByVm(session.vmId).filter(s => s.id !== session.id)) < 1) throw new HostError('SESSION_CAPACITY_EXCEEDED', 'O computador não tem recursos para a sessão migrada')
      this.repo.saveOperation({ ...operation, status: 'running', steps: operation.steps.map(s => s.id === 'backup' ? { ...s, status: 'running' } : s) })
      await this.maintenance!.backup(session.vmId, operation.id)
      this.repo.saveOperation({ ...operation, status: 'running', steps: operation.steps.map(s => ({ ...s, status: s.id === 'backup' ? 'succeeded' : 'running' })) })
      const adopted = await this.connector.createSession({ ...session, profile: info.capacity.perSession }, `${session.id}:adopt`)
      if (adopted.id !== session.id || adopted.botId !== session.botId) throw new HostError('SESSION_CONFLICT', 'A migração respondeu com outra identidade')
      this.repo.transaction(() => {
        const current = this.repo.session(session.botId)!
        this.repo.saveSession({ ...current, transport: 'managed', profile: info.capacity!.perSession, state: 'ready', generation: adopted.generation, revision: current.revision + 1, updatedAt: now() })
        this.repo.saveSessionCapacity(session.vmId, info.capacity!)
      })
      await this.maintenance!.activate(session.botId)
      this.repo.transaction(() => {
        const bot = this.repo.bot(session.botId)
        this.repo.saveBot({ ...bot, runtimeState: 'ready', revision: bot.revision + 1, updatedAt: now() })
        this.repo.saveOperation({ ...operation, status: 'succeeded', steps: operation.steps.map(s => ({ ...s, status: 'succeeded' })), updatedAt: now() })
      })
    } catch (error) {
      this.repo.transaction(() => {
        const bot = this.repo.bot(session.botId)
        this.repo.saveBot({ ...bot, runtimeState: 'unreachable', revision: bot.revision + 1, updatedAt: now() })
        this.repo.saveOperation({ ...this.repo.operation(operation.id), status: 'failed', error: { code: error instanceof HostError ? error.code : 'SESSION_PREPARATION_UNCERTAIN', message: error instanceof Error ? error.message : 'Verifique a migração antes de repetir' }, updatedAt: now() })
      })
    }
  }
}
