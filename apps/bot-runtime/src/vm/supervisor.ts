import { createHash } from 'node:crypto'
import { vmRequestSchema, type SessionCapacity, type VmRequest } from '@maestrly/host-protocol'
import { publicSession, type VmCatalog, type SessionRecord } from './catalog.js'
import type { DesktopControl } from './desktop-control.js'

export type UnitState = 'running' | 'stopped' | 'unknown'
export interface SessionDriver {
  resources(): Promise<{ memoryMiB: number; cpus: number; freeDiskMiB: number }>
  provision(record: SessionRecord): Promise<SessionRecord>
  start(record: SessionRecord, options?: { automation?: boolean }): Promise<void>
  stop(record: SessionRecord): Promise<void>
  inspect(record: SessionRecord): Promise<'running' | 'stopped' | 'unknown'>
  /** Automation only; the display, browser and proxy keep running. */
  stopAutomation?(record: SessionRecord): Promise<void>
  startAutomation?(record: SessionRecord): Promise<void>
  units?(record: SessionRecord): Promise<{ desktop: UnitState; services: UnitState; automation: UnitState }>
  refresh?(record: SessionRecord): Promise<void>
}
export function vmError(code: string, message: string) { return Object.assign(new Error(message), { code }) }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type SessionMutation = Exclude<VmRequest, { method: 'vm.inspect' | 'session.inspect' | 'session.lease' | 'session.release' | `desktop.${string}` }>
export class VmSupervisor {
  private operations = new Map<string, { print: string; promise: Promise<unknown> }>()
  private busy = new Set<string>()
  constructor(readonly catalog: VmCatalog, readonly driver: SessionDriver, readonly capacity?: SessionCapacity, readonly desktop?: DesktopControl) {}
  private required(id: string) {
    const record = this.catalog.get(id)
    if (!record) throw vmError('SESSION_NOT_FOUND', 'Área de trabalho não encontrada')
    return record
  }
  /**
   * Session-level state. A held session is running when its display and services run
   * (automation is intentionally stopped); otherwise a stopped automation worker is a
   * stopped session even if the display survived a lease expiry.
   */
  private async observe(record: SessionRecord): Promise<'running' | 'stopped' | 'unknown'> {
    if (!this.driver.units) return this.driver.inspect(record)
    const units = await this.driver.units(record)
    const graphics = units.desktop === 'running' && units.services === 'running'
    const none = Object.values(units).every(value => value === 'stopped')
    if (this.desktop?.held(record.id)) return graphics ? 'running' : none ? 'stopped' : 'unknown'
    if (graphics && units.automation === 'running') return 'running'
    if (units.automation === 'stopped' && (graphics || none)) return 'stopped'
    return 'unknown'
  }
  async handle(raw: unknown): Promise<unknown> {
    const request = vmRequestSchema.parse(raw)
    const p = request.params
    if (request.method.startsWith('desktop.')) {
      if (!this.desktop) throw vmError('DESKTOP_UPDATE_REQUIRED', 'Atualize o ambiente para ver a tela')
      if (this.busy.has((p as { sessionId: string }).sessionId)) throw vmError('SESSION_BUSY', 'A área de trabalho já tem uma operação em andamento')
      return this.desktop.handle(request as Extract<VmRequest, { method: `desktop.${string}` }>)
    }
    if (request.method === 'vm.inspect') return { capabilities: ['account.delegation.v1', ...(this.desktop ? await this.desktop.capabilities() : [])], ...(this.capacity ? { capacity: this.capacity } : {}), sessions: this.catalog.list().map(publicSession), ...await this.driver.resources() }
    if (request.method === 'session.inspect') {
      const record = this.required(request.params.sessionId)
      if (!record.provisioned || this.busy.has(record.id)) return publicSession(record)
      const observed = await this.observe(record)
      return publicSession({ ...record, state: observed === 'unknown' ? 'needs_attention' : observed })
    }
    if (request.method === 'session.lease' || request.method === 'session.release') {
      const input = request.params
      const record = this.required(input.sessionId)
      if (!record.provisioned || record.generation !== input.generation || this.busy.has(record.id)) throw vmError('SESSION_GENERATION_CHANGED', 'A sessão mudou durante a autorização')
      if (request.method === 'session.lease') {
        if (record.desiredState !== 'running') throw vmError('SESSION_STOPPED', 'A área de trabalho foi parada')
        this.catalog.save({ ...record, leaseTurnId: input.turnId, leaseExpiresAt: Date.now() + request.params.leaseMs })
      } else if (record.leaseTurnId === input.turnId) this.catalog.save({ ...record, leaseTurnId: undefined, leaseExpiresAt: undefined })
      return { applied: true }
    }
    if (!('idempotencyKey' in p) || !('sessionId' in p)) throw vmError('INVALID_REQUEST', 'Operação inválida')
    const key = p.idempotencyKey
    const print = fingerprint({ method: request.method, params: request.params })
    const previous = this.catalog.operation(key)
    if (previous && previous.fingerprint !== print) throw vmError('IDEMPOTENCY_CONFLICT', 'A chave já foi usada com outros parâmetros')
    const pending = this.operations.get(key)
    if (pending) {
      if (pending.print !== print) throw vmError('IDEMPOTENCY_CONFLICT', 'A chave já foi usada com outros parâmetros')
      return pending.promise
    }
    if (previous?.status === 'succeeded') return JSON.parse(previous.result!)
    // Pending effects after a daemon crash require inspection, not automatic replay.
    if (previous) throw vmError('SESSION_PREPARATION_UNCERTAIN', 'A operação anterior foi interrompida; inspecione a sessão antes de continuar')
    if (this.busy.has(p.sessionId)) throw vmError('SESSION_BUSY', 'A área de trabalho já tem uma operação em andamento')
    this.busy.add(p.sessionId)
    const operation = this.execute(request as SessionMutation).finally(() => { this.busy.delete(p.sessionId); this.operations.delete(key) })
    this.operations.set(key, { print, promise: operation })
    return operation
  }
  private async execute(request: SessionMutation) {
    const p = request.params
    const print = fingerprint({ method: request.method, params: p })
    if (request.method === 'session.create') {
      const params = request.params
      if (!this.capacity) throw vmError('SESSION_PROFILE_UNVERIFIED', 'O pacote não tem requisitos medidos para sessões compartilhadas')
      const resources = await this.driver.resources()
      const record = this.catalog.transaction(() => {
        const old = this.catalog.get(params.sessionId)
        if (old) throw vmError('SESSION_CONFLICT', 'A identidade desta área de trabalho já está reservada')
        const all = this.catalog.list()
        if (params.adoptLegacy && all.some(s => s.legacy)) throw vmError('LEGACY_BINDING_CONFLICT', 'A sessão antiga já foi adotada por outro bot')
        if (fingerprint(params.profile) !== fingerprint(this.capacity!.perSession)) throw vmError('SESSION_PROFILE_CHANGED', 'O perfil de recursos mudou')
        const active = all.filter(s => s.desiredState === 'running')
        const used = (key: 'memoryMiB' | 'cpuQuotaPercent') => active.reduce((n, r) => n + r.profile[key], 0)
        if (all.length >= 100 || active.length >= this.capacity!.maxSessions || used('memoryMiB') + params.profile.memoryMiB + this.capacity!.systemMemoryMiB > resources.memoryMiB || used('cpuQuotaPercent') + params.profile.cpuQuotaPercent > resources.cpus * 100 || resources.freeDiskMiB < params.profile.diskMiB)
          throw vmError('SESSION_CAPACITY_EXCEEDED', 'A VM não tem recursos disponíveis para outra área de trabalho')
        const next: SessionRecord = { id: params.sessionId, botId: params.botId, profile: params.profile, state: 'preparing', generation: 1, desiredState: 'running', legacy: params.adoptLegacy,
          username: params.adoptLegacy ? 'maestrlybot' : `mb${params.sessionId.replaceAll('-', '').slice(0, 24)}`, provisioned: false, createdAt: new Date().toISOString() }
        this.catalog.begin(p.idempotencyKey, print)
        this.catalog.save(next)
        return next
      })
      try {
        const prepared = await this.driver.provision(record)
        this.catalog.save({ ...prepared, provisioned: true })
        await this.driver.start(prepared)
        if (await this.observe(prepared) !== 'running') throw vmError('SESSION_START_UNCERTAIN', 'A área de trabalho não confirmou a partida')
        const finished = { ...prepared, provisioned: true, state: 'running' as const }
        await this.desktop?.synchronize(finished).catch(() => {})
        return this.catalog.transaction(() => { this.catalog.save(finished); this.catalog.finish(p.idempotencyKey, publicSession(finished)); return publicSession(finished) })
      } catch (error) {
        this.catalog.save({ ...this.required(record.id), state: 'needs_attention' })
        throw error
      }
    }
    const params = request.params
    const current = this.required(params.sessionId)
    if (!current.provisioned || current.generation !== params.generation) throw vmError('SESSION_GENERATION_CHANGED', 'A área de trabalho mudou; consulte seu estado')
    const starting = request.method === 'session.start'
    // A person's pause is durable: only an explicit return restarts automation.
    if (starting && this.desktop?.held(current.id)) throw vmError('BOT_PAUSED_BY_USER', 'O bot está pausado para uma intervenção humana')
    const resources = starting ? await this.driver.resources() : undefined
    const observedBefore = starting ? await this.observe(current) : undefined
    const record = this.catalog.transaction(() => {
      if (starting) {
        if (observedBefore === 'unknown') throw vmError('SESSION_RESULT_UNCERTAIN', 'Inspecione a área de trabalho antes de iniciar novamente')
        const others = this.catalog.list().filter(s => s.id !== current.id && s.desiredState === 'running')
        if (!this.capacity || others.length + 1 > this.capacity.maxSessions ||
          others.reduce((n, s) => n + s.profile.memoryMiB, current.profile.memoryMiB) + this.capacity.systemMemoryMiB > resources!.memoryMiB ||
          others.reduce((n, s) => n + s.profile.cpuQuotaPercent, current.profile.cpuQuotaPercent) > resources!.cpus * 100)
          throw vmError('SESSION_CAPACITY_EXCEEDED', 'Não há recursos para iniciar outra área de trabalho')
      }
      this.catalog.begin(params.idempotencyKey, print)
      const next = { ...current, desiredState: starting ? 'running' as const : 'stopped' as const, generation: starting && observedBefore !== 'running' ? current.generation + 1 : current.generation,
        ...(starting && observedBefore === 'running' ? {} : { leaseTurnId: undefined, leaseExpiresAt: undefined }) }
      this.catalog.save(next)
      return next
    })
    if (starting) await this.driver.start(record)
    else {
      // Viewers and controllers are revoked before the session is torn down.
      this.desktop?.revokeSession(record.id)
      await this.driver.stop(record)
    }
    const observed = await this.observe(record)
    if (observed !== (starting ? 'running' : 'stopped')) throw vmError('SESSION_RESULT_UNCERTAIN', 'Não foi possível confirmar a operação nesta área de trabalho')
    const finished = { ...record, state: observed }
    if (starting) await this.desktop?.synchronize(finished).catch(() => {})
    return this.catalog.transaction(() => { this.catalog.save(finished); this.catalog.finish(params.idempotencyKey, publicSession(finished)); return publicSession(finished) })
  }
  async recover() {
    this.desktop?.recover()
    for (const record of this.catalog.list()) {
      if (!record.provisioned || record.state === 'preparing' || record.state === 'needs_attention') continue
      await this.driver.refresh?.(record)
      const held = this.desktop?.held(record.id) === true
      if (held && record.desiredState === 'running') {
        // Keep the screen available for the person; automation stays stopped.
        await this.driver.start(record, { automation: false })
        await this.driver.stopAutomation?.(record)
        continue
      }
      const state = await this.observe(record)
      if (state === 'stopped' && record.desiredState === 'running') {
        // Starting a worker recovers its journal; it does not resend any provider turn.
        const next = { ...record, generation: record.generation + 1 }
        this.catalog.save(next)
        await this.driver.start(next)
        this.catalog.save({ ...next, state: 'running' })
      }
    }
  }
  /** Keeps restarted graphical services aligned with the durable hold. */
  async synchronizeDesktops() {
    if (!this.desktop) return
    await Promise.allSettled(this.catalog.list().filter(r => r.provisioned && r.desiredState === 'running' && !this.busy.has(r.id)).map(async record => {
      if (this.driver.units && (await this.driver.units(record)).services !== 'running') return
      await this.desktop!.synchronize(record)
    }))
  }
  /**
   * A lost Host turn lease fails closed by stopping automation. The display, browser
   * and any screen the person is watching are separate and keep running.
   */
  async expireLeases(now = Date.now()) {
    await Promise.allSettled(this.catalog.list().filter(r => r.leaseExpiresAt !== undefined && r.leaseExpiresAt <= now && r.desiredState === 'running').map(async r => {
      if (!this.driver.stopAutomation) return this.handle({ type: 'vm.request', id: 'expire', method: 'session.stop', params: { sessionId: r.id, generation: r.generation, idempotencyKey: `${r.id}:expiry:${r.generation}:${r.leaseTurnId}` } })
      if (this.busy.has(r.id)) return
      this.busy.add(r.id)
      try {
        await this.driver.stopAutomation(r)
        const latest = this.required(r.id)
        if (latest.leaseTurnId === r.leaseTurnId) this.catalog.save({ ...latest, leaseTurnId: undefined, leaseExpiresAt: undefined })
      } finally { this.busy.delete(r.id) }
    }))
  }
}
