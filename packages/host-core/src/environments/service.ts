import { randomUUID } from 'node:crypto'
import { DESKTOP_LIVE_CAPABILITY, environmentOperationSchema, type BotEnvironment, type BotRequest, type EnvironmentOperation, type BotSetupPreview } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { fingerprint } from '../bots/interactions.js'
import { type BotRepository, now } from '../bots/repository.js'
import type { BotSetup, SetupHost } from '../bots/setup.js'
import type { BotSessions } from '../bots/sessions.js'

type Intent = { kind: 'create'; name: string; preview: BotSetupPreview } | { kind: 'prepare'; vmId: string; templateId: string }
export class EnvironmentService {
  private workers = new Map<string, Promise<void>>()
  private refreshing = new Map<string, number>()
  private abort = new AbortController()
  constructor(private repo: BotRepository, private host: SetupHost, private sessions: BotSessions, private setup: BotSetup) {}
  recover() {
    for (const operation of this.operations()) if (operation.status === 'queued' || operation.status === 'running') {
      this.save({ ...operation, status: 'failed', error: { code: 'ENVIRONMENT_PREPARATION_UNCERTAIN', message: 'A preparação foi interrompida. Verifique o ambiente e o backup antes de repetir.' }, updatedAt: now() })
      if (operation.vmId) this.record(operation.vmId, 'failed', operation.id)
    }
  }
  private operations() { return this.repo.db.prepare('SELECT body FROM environment_operations ORDER BY rowid').all().map(row => environmentOperationSchema.parse(JSON.parse(String(row.body)))) }
  operation(id: string) {
    const row = this.repo.db.prepare('SELECT body FROM environment_operations WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'A preparação não foi encontrada')
    return environmentOperationSchema.parse(JSON.parse(String(row.body)))
  }
  lookup(key: string) {
    const row = this.repo.db.prepare('SELECT body FROM environment_operations WHERE key=?').get(key)
    return row ? environmentOperationSchema.parse(JSON.parse(String(row.body))) : null
  }
  private prior(key: string, print: string) {
    const row = this.repo.db.prepare('SELECT fingerprint,body FROM environment_operations WHERE key=?').get(key)
    if (!row) return undefined
    if (row.fingerprint !== print) throw new HostError('IDEMPOTENCY_CONFLICT', 'A chave já foi usada para outro ambiente')
    return environmentOperationSchema.parse(JSON.parse(String(row.body)))
  }
  private save(operation: EnvironmentOperation) {
    this.repo.db.prepare('UPDATE environment_operations SET body=? WHERE id=?').run(JSON.stringify(environmentOperationSchema.parse(operation)), operation.id)
    return operation
  }
  private record(vmId: string, state: string, operationId: string) {
    this.repo.db.prepare('INSERT INTO environment_vms(vm_id,state,operation_id) VALUES(?,?,?) ON CONFLICT(vm_id) DO UPDATE SET state=excluded.state,operation_id=excluded.operation_id').run(vmId, state, operationId)
  }
  /** A shared-account template for this runtime that also brings the live screen. */
  private desktopTemplate(runtimeId: string) {
    return this.host.templates.find(template => template.runtimeId === runtimeId && template.runtimeBundle && template.capabilities.includes('account.delegation.v1') && template.capabilities.includes(DESKTOP_LIVE_CAPABILITY))
  }
  /**
   * The environment works, but this Host carries a live-screen runtime it does not run yet:
   * either the guest predates the screen, or it announced a different runtime version (for
   * example a fix to the screen). Optional; the update keeps the backup and restart consent.
   */
  private desktopUpdate(vmId: string, runtimeId: string, capabilities: readonly string[]) {
    const template = this.desktopTemplate(runtimeId)
    if (!template?.runtimeBundle || !capabilities.includes('account.delegation.v1')) return false
    if (!capabilities.includes(DESKTOP_LIVE_CAPABILITY)) return true
    const version = this.sessions.runtimeVersion(vmId)
    return !!version && version !== template.runtimeBundle.version
  }
  list(): BotEnvironment[] {
    return this.host.vms().filter(vm => vm.state !== 'removed').map(vm => {
      const inventory = this.sessions.snapshot(vm.id)
      const record = this.repo.db.prepare('SELECT state,operation_id FROM environment_vms WHERE vm_id=?').get(vm.id)
      const legacy = inventory.sessions.some(session => session.transport === 'legacy' || session.issue)
      let status: BotEnvironment['status'] = vm.state === 'stopped' ? 'stopped' : vm.state !== 'running' ? 'unavailable'
        : !inventory.supported ? this.repo.sessionCapacity(vm.id) ? 'unavailable' : 'needs-preparation' : legacy ? 'needs-migration'
        : !inventory.capabilities.includes('account.delegation.v1') ? 'needs-update' : inventory.available < 1 ? 'full' : 'ready'
      if (record?.state === 'preparing') status = 'preparing'
      // A failed update leaves the earlier runtime installed (the installer publishes atomically).
      // While its supervisor still answers with the shared account, the environment stays usable,
      // shows why the update stopped and can be updated again; otherwise it is unavailable.
      if (record?.state === 'failed' && !(vm.state === 'running' && inventory.supported && inventory.capabilities.includes('account.delegation.v1'))) status = 'unavailable'
      const operation = record ? this.operation(String(record.operation_id)) : undefined
      // Known environments refresh in the background. Listing never waits for an offline guest or hashes an image.
      if (!this.abort.signal.aborted && vm.state === 'running' && status !== 'preparing' && (inventory.supported || this.repo.bindingByVm(vm.id) || record) && Date.now() - (this.refreshing.get(vm.id) ?? 0) > 15000) {
        this.refreshing.set(vm.id, Date.now())
        void this.sessions.inspectVm(vm.id).catch(() => {})
      }
      // After a failed update the person can always try again from the app, even when the guest
      // stopped answering (for example a full disk): the retry takes a new backup first.
      const retry = record?.state === 'failed' && vm.state === 'running' && !!this.desktopTemplate(vm.runtimeId)?.runtimeBundle
      const update = retry || (['ready', 'full'].includes(status) && this.desktopUpdate(vm.id, vm.runtimeId, inventory.capabilities))
      return { vm, status, inventory, ...(operation?.error ? { reason: operation.error.message } : inventory.reason ? { reason: inventory.reason } : {}), ...(operation && ['queued', 'running', 'failed'].includes(operation.status) ? { operationId: operation.id } : {}), ...(update ? { updateAvailable: 'desktop' as const } : {}) }
    })
  }
  assertVmOperationAllowed(vmId: string, key: string) {
    const record = this.repo.db.prepare('SELECT state,operation_id FROM environment_vms WHERE vm_id=?').get(vmId)
    if (record && ['preparing', 'verifying'].includes(String(record.state)) && !key.startsWith(`${record.operation_id}:`))
      throw new HostError('ENVIRONMENT_BUSY', 'Aguarde a preparação deste ambiente antes de alterar o computador')
  }
  launchProfileFor(vmId: string, createKey?: string) {
    if (this.repo.db.prepare('SELECT vm_id FROM environment_vms WHERE vm_id=?').get(vmId)) return true
    return !!createKey?.endsWith(':create') && !!this.repo.db.prepare('SELECT id FROM environment_operations WHERE id=?').get(createKey.slice(0, -7))
  }
  private insert(key: string, print: string, intent: Intent) {
      const previous = this.prior(key, print)
      if (previous) return previous
      const operation: EnvironmentOperation = { id: randomUUID(), kind: intent.kind, ...(intent.kind === 'prepare' ? { vmId: intent.vmId } : {}), status: 'queued',
        steps: (intent.kind === 'create' ? [['computer', 'Criando o ambiente'], ['runtime', 'Preparando o ambiente'], ['verify', 'Abrindo o ambiente']] : [['backup', 'Preservando os dados'], ['runtime', 'Atualizando o ambiente'], ['verify', 'Abrindo o ambiente']]).map(([id, label]) => ({ id, label, status: 'pending' })), createdAt: now(), updatedAt: now() }
      this.repo.db.prepare('INSERT INTO environment_operations(id,key,fingerprint,request,body) VALUES(?,?,?,?,?)').run(operation.id, key, print, JSON.stringify(intent), JSON.stringify(operation))
      if (operation.vmId) this.record(operation.vmId, 'preparing', operation.id)
      return operation
  }
  async create(input: { idempotencyKey: string; name: string }) {
    const print = fingerprint({ method: 'environment.create', ...input })
    const previous = this.prior(input.idempotencyKey, print)
    if (previous) return previous
    const preview = await this.setup.preview({ destination: { kind: 'new-vm' }, requiresSharedAccount: true })
    if (!preview.feasible) throw new HostError(preview.blockers[0].code, preview.blockers[0].message)
    const op = this.repo.transaction(() => this.insert(input.idempotencyKey, print, { kind: 'create', name: input.name, preview }))
    this.kick(op.id)
    return op
  }
  async prepare(input: { vmId: string; idempotencyKey: string; confirmBackup: true; confirmRestart: true }) {
    const print = fingerprint({ method: 'environment.prepare', ...input })
    const previous = this.prior(input.idempotencyKey, print)
    if (previous) return previous
    if (input.confirmBackup !== true || input.confirmRestart !== true) throw new HostError('CONFIRMATION_REQUIRED', 'Confirme o backup e o reinício do ambiente')
    if (this.repo.botsByVm(input.vmId).some(bot => this.repo.activeTurn(bot.id))) throw new HostError('BOT_ACTIVE', 'Pare as tarefas dos bots deste ambiente antes de prepará-lo')
    const record = this.repo.db.prepare('SELECT state FROM environment_vms WHERE vm_id=?').get(input.vmId)
    // A failed preparation can be repeated: every attempt takes a new backup, and a failed
    // installer leaves the running runtime and removes its partial copy.
    if (record?.state === 'preparing' || record?.state === 'verifying') throw new HostError('ENVIRONMENT_BUSY', 'Aguarde a preparação atual deste ambiente terminar')
    const current = await this.sessions.inspectVm(input.vmId)
    // A prepared environment is reinstalled only when this Host can bring it the live screen.
    const prepared = current.supported && current.capabilities.includes('account.delegation.v1') && !this.desktopUpdate(input.vmId, this.host.vm(input.vmId).runtimeId, current.capabilities)
    let templateId = 'prepared-environment'
    if (!prepared) {
      const vm = this.host.vm(input.vmId)
      const template = this.desktopTemplate(vm.runtimeId) ?? this.host.templates.find(template => template.runtimeId === vm.runtimeId && template.runtimeBundle && template.capabilities.includes('account.delegation.v1'))
      if (!template) throw new HostError('NO_BOT_TEMPLATE', 'Este Host não tem um pacote compatível para preparar o ambiente')
      if (vm.cpus < template.minimum.cpus || vm.memoryMiB < template.minimum.memoryMiB || vm.diskGiB < template.minimum.diskGiB) throw new HostError('CAPACITY_APPROVAL_REQUIRED', 'Este ambiente não tem os recursos mínimos necessários')
      templateId = template.id
    }
    const op = this.repo.transaction(() => {
      if (this.repo.botsByVm(input.vmId).some(bot => this.repo.activeTurn(bot.id))) throw new HostError('BOT_ACTIVE', 'Pare as tarefas dos bots deste ambiente antes de prepará-lo')
      const pending = this.repo.db.prepare("SELECT vm_id FROM environment_vms WHERE vm_id=? AND state='preparing'").get(input.vmId)
      if (pending) throw new HostError('ENVIRONMENT_BUSY', 'O ambiente já está sendo preparado')
      return this.insert(input.idempotencyKey, print, { kind: 'prepare', vmId: input.vmId, templateId })
    })
    if (prepared) {
      this.record(input.vmId, 'ready', op.id)
      return this.save({ ...op, status: 'succeeded', steps: op.steps.map(step => ({ ...step, status: 'succeeded' })), updatedAt: now() })
    }
    this.kick(op.id)
    return op
  }
  private kick(id: string) {
    if (this.workers.has(id) || ['succeeded', 'failed'].includes(this.operation(id).status)) return
    const pending = this.run(id).finally(() => this.workers.delete(id))
    this.workers.set(id, pending)
    void pending.catch(() => {})
  }
  private step(id: string, stepId: string, status: EnvironmentOperation['steps'][number]['status']) {
    const op = this.operation(id)
    this.save({ ...op, steps: op.steps.map(step => step.id === stepId ? { ...step, status } : step), updatedAt: now() })
  }
  private async wait(id: string) {
    const deadline = Date.now() + 360000
    for (;;) {
      this.abort.signal.throwIfAborted()
      const result = this.host.operation(id)
      if (result.status === 'succeeded') return result
      if (result.status === 'failed' || result.status === 'cancelled') throw new HostError(result.error?.code ?? 'ENVIRONMENT_FAILED', 'A operação no ambiente não foi concluída')
      if (Date.now() > deadline) throw new HostError('ENVIRONMENT_PREPARATION_UNCERTAIN', 'A operação no ambiente precisa ser verificada')
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  private async mutation(opId: string, vmId: string, action: 'vm.start' | 'vm.shutdown' | 'vm.restart', suffix: string) {
    return this.wait((await this.host.admit(action, { vmId, expectedRevision: this.host.vm(vmId).revision, idempotencyKey: `${opId}:${suffix}` })).id)
  }
  private async run(id: string) {
    let op = this.save({ ...this.operation(id), status: 'running', updatedAt: now() })
    const intent = JSON.parse(String(this.repo.db.prepare('SELECT request FROM environment_operations WHERE id=?').get(id)!.request)) as Intent
    try {
      const template = this.host.templates.find(template => template.id === (intent.kind === 'create' ? intent.preview.profile.templateId : intent.templateId))
      if (!template) throw new HostError('NO_BOT_TEMPLATE', 'O pacote deste ambiente não está disponível')
      if (intent.kind === 'create') {
        this.step(id, 'computer', 'running')
        const created = await this.host.admit('vm.create', { idempotencyKey: `${id}:create`, name: intent.name, imageId: intent.preview.profile.imageId, runtimeId: intent.preview.profile.runtimeId, ...intent.preview.profile.resources, startupPolicy: 'always' })
        op = this.save({ ...this.operation(id), vmId: created.vmId })
        this.record(created.vmId, 'preparing', id)
        await this.wait(created.id)
        this.step(id, 'computer', 'succeeded')
      } else {
        this.step(id, 'backup', 'running')
        if (!this.host.preparation?.backupDisk) throw new HostError('RUNTIME_UNAVAILABLE', 'O backup do ambiente não está disponível')
        if (this.host.vm(intent.vmId).state === 'running') await this.mutation(id, intent.vmId, 'vm.shutdown', 'stop')
        await this.host.preparation.backupDisk(this.host.vm(intent.vmId), this.abort.signal)
        await this.mutation(id, intent.vmId, 'vm.start', 'start')
        this.step(id, 'backup', 'succeeded')
      }
      const vmId = op.vmId!
      this.step(id, 'runtime', 'running')
      if (intent.kind === 'prepare' || !template.runtimeIncluded) {
        if (!template.runtimeBundle || !this.host.preparation?.prepareGuestRuntime) throw new HostError('RUNTIME_UNAVAILABLE', 'O pacote de preparação não está disponível')
        await this.host.preparation.prepareGuestRuntime(this.host.vm(vmId), template.runtimeBundle, this.abort.signal)
        await this.mutation(id, vmId, 'vm.restart', 'restart')
      }
      this.step(id, 'runtime', 'succeeded')
      this.step(id, 'verify', 'running')
      this.record(vmId, 'verifying', id)
      const inventory = await this.sessions.inspectVm(vmId)
      if (!inventory.supported || !inventory.capabilities.includes('account.delegation.v1')) throw new HostError('ENVIRONMENT_INCOMPATIBLE', 'O ambiente não confirmou suporte à conta geral e às áreas de trabalho independentes')
      this.record(vmId, 'ready', id)
      this.step(id, 'verify', 'succeeded')
      this.save({ ...this.operation(id), status: 'succeeded', updatedAt: now() })
    } catch (error) {
      op = this.operation(id)
      if (op.vmId) this.record(op.vmId, 'failed', id)
      this.save({ ...op, status: 'failed', error: { code: error instanceof HostError ? error.code : 'ENVIRONMENT_PREPARATION_UNCERTAIN', message: error instanceof HostError ? error.message : 'A preparação foi interrompida. O ambiente e seus dados foram preservados; verifique a operação antes de repetir.' }, steps: op.steps.map(step => step.status === 'running' ? { ...step, status: 'failed' } : step), updatedAt: now() })
    }
  }
  async handle(request: BotRequest) {
    const p = request.params as any
    switch (request.method) {
      case 'environment.list': return this.list()
      case 'environment.operations': return this.operations().slice(-100)
      case 'environment.create': return this.create(p)
      case 'environment.prepare': return this.prepare(p)
      case 'environment.operation': return this.operation(p.operationId)
      case 'environment.lookup': return this.lookup(p.idempotencyKey)
      default: throw new HostError('INVALID_REQUEST', 'Método de ambiente desconhecido')
    }
  }
  async close() { this.abort.abort(); await Promise.allSettled([...this.workers.values()]) }
}
