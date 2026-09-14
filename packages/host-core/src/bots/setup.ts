import type { AccountAuthority } from '../accounts/authority.js'
import { createHash, randomUUID } from 'node:crypto'
import {
  permissionSummary,
  type Bot,
  type BotOperation,
  type BotSetupPreview,
  type Host,
  type Operation,
  type Vm,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { GuestPreparation } from '../provider.js'
import { fingerprint } from './interactions.js'
import { assessExistingVm, pickTemplate, recommendNewVm, type BotTemplate, type ResourceSpec } from './recommendations.js'
import { type BotRepository, now } from './repository.js'
import type { RuntimeCoordinator } from './runtime-coordinator.js'
import type { BotSessions } from './sessions.js'
import type { BotSession } from '@maestrly/host-protocol'

export interface SetupHost {
  hostId: string
  inspectHost(): Promise<Host>
  listImages(): Promise<{ id: string; available: boolean }[]>
  vm(id: string): Vm
  vms(): Vm[]
  admit(method: 'vm.create' | 'vm.start' | 'vm.shutdown' | 'vm.restart', params: Record<string, unknown>): Promise<Operation>
  operation(id: string): Operation
  templates: readonly BotTemplate[]
  preparation?: Partial<GuestPreparation>
}
const PREVIEW_TTL_MS = 15 * 60_000
const STEPS: BotOperation['steps'] = [
  { id: 'computer', label: 'Verificando seu computador', status: 'pending' },
  { id: 'runtime', label: 'Preparando o ambiente', status: 'pending' },
  { id: 'bot', label: 'Registrando o bot', status: 'pending' },
  { id: 'account', label: 'Conectando sua conta', status: 'pending' },
  { id: 'finish', label: 'Finalizando', status: 'pending' },
]
export function inventoryRevision(host: Host, vms: Vm[], templates: readonly BotTemplate[], sessions: readonly BotSession[] = []) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        capacity: host.capacity,
        allocated: host.allocated,
        runtimes: host.runtimes.map((r) => [r.id, r.available]),
        vms: vms.map((vm) => [vm.id, vm.state, vm.revision]),
        templates: templates.map((t) => t.id),
        sessions: sessions.map(s => [s.id, s.vmId, s.state, s.revision, s.profile]),
      })
    )
    .digest('hex')
    .slice(0, 32)
}
/** Guided, resumable bot setup. Intent is durable before any VM effect; steps never replay. */
export class BotSetup {
  private workers = new Map<string, Promise<void>>()
  constructor(
    private readonly repo: BotRepository,
    private readonly host: SetupHost,
    private readonly coordinator: RuntimeCoordinator,
    private readonly sessions: BotSessions,
    private readonly accounts?: { authority: AccountAuthority; connect(botId: string): Promise<unknown> }
  ) {}
  async preview(input: { destination: { kind: 'new-vm' } | { kind: 'existing-vm' | 'shared-vm'; vmId: string }; resources?: ResourceSpec; requiresSharedAccount?: boolean }): Promise<BotSetupPreview> {
    if (input.destination.kind === 'shared-vm') return this.previewSharedVm(input.destination.vmId)
    const host = await this.host.inspectHost()
    const images = await this.host.listImages()
    const vms = this.host.vms().filter((vm) => vm.state !== 'removed')
    const template = pickTemplate(input.requiresSharedAccount ? this.host.templates.filter(template => template.capabilities.includes('account.delegation.v1')) : this.host.templates, host, images)
    const blockers: BotSetupPreview['blockers'] = []
    if (!host.supported) blockers.push({ code: 'HOST_UNSUPPORTED', message: 'Este computador não consegue executar bots agora.', alternatives: ['Escolher outro computador.'] })
    if (!template) blockers.push({ code: 'NO_BOT_TEMPLATE', message: 'Nenhum ambiente de bot compatível está instalado neste computador.', alternatives: ['Atualizar o Host com o pacote de bot.', 'Escolher outro computador.'] })
    const base = template ?? (input.requiresSharedAccount ? undefined : this.host.templates[0])
    if (!base) throw new HostError('NO_BOT_TEMPLATE', 'No bot template is configured on this host')
    let destination: BotSetupPreview['destination']
    let resources: ResourceSpec
    let source: 'recommended' | 'custom' = 'recommended'
    if (input.destination.kind === 'existing-vm') {
      const vm = this.host.vm(input.destination.vmId)
      const bound = !!this.repo.botByVm(vm.id)
      blockers.push(...assessExistingVm(base, vm, bound).map((b) => ({ ...b, code: b.code === 'RUNTIME_UNAVAILABLE' && bound ? ('VM_ALREADY_BOUND' as const) : b.code })))
      const binding = this.repo.bindingByVm(vm.id)
      destination = {
        kind: 'existing-vm',
        vmId: vm.id,
        displayName: vm.name,
        requiresPreparation: !binding?.runtimeVersion,
        requiresRestart: !binding?.runtimeVersion,
        backupRequired: !binding?.runtimeVersion,
      }
      resources = { cpus: vm.cpus, memoryMiB: vm.memoryMiB, diskGiB: vm.diskGiB }
    } else {
      const recommendation = recommendNewVm(base, host, input.resources)
      blockers.push(...recommendation.blockers)
      resources = recommendation.resources
      source = recommendation.source
      destination = { kind: 'new-vm', displayName: 'Novo computador virtual' }
    }
    const preview: BotSetupPreview = {
      previewId: randomUUID(),
      inventoryRevision: inventoryRevision(host, vms, this.host.templates, vms.flatMap(vm => this.repo.sessionsByVm(vm.id))),
      hostId: this.host.hostId,
      destination,
      profile: {
        templateId: base.id,
        imageId: base.imageId,
        runtimeId: base.runtimeId,
        resources,
        source,
        requirements: { minimum: base.minimum, recommended: base.recommended },
      },
      permissions: { mode: 'ask', summary: [...permissionSummary.ask] },
      network: { mode: 'blocklist', domains: [] },
      feasible: blockers.length === 0,
      blockers,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    }
    this.repo.transaction(() => this.repo.savePreview(preview))
    return preview
  }
  private sharedRevision(vmId: string) {
    const vm = this.host.vm(vmId)
    return fingerprint({ vm: [vm.id, vm.revision, vm.state, vm.bootId, vm.cpus, vm.memoryMiB, vm.diskGiB],
      capacity: this.repo.sessionCapacity(vmId), sessions: this.repo.sessionsByVm(vmId).map(s => [s.id, s.state, s.revision, s.profile, s.issue]) })
  }
  /** A prepared environment needs only its live session inventory, never installation assets. */
  private async previewSharedVm(vmId: string): Promise<BotSetupPreview> {
    const inventory = await this.sessions.inspectVm(vmId)
    const vm = this.host.vm(vmId)
    const blockers: BotSetupPreview['blockers'] = []
    if (!inventory.supported || inventory.available < 1) blockers.push({
      code: inventory.sessions.some(s => s.issue === 'LEGACY_BINDING_CONFLICT') ? 'LEGACY_BINDING_CONFLICT'
        : !inventory.supported || inventory.sessions.some(s => s.transport === 'legacy') ? 'SESSION_UPDATE_REQUIRED' : 'SESSION_CAPACITY_EXCEEDED',
      message: inventory.reason ?? 'Não há área de trabalho disponível neste ambiente.',
      alternatives: ['Escolher outro ambiente.', 'Revisar o ambiente e os recursos com o administrador.'],
    })
    const resources = { cpus: vm.cpus, memoryMiB: vm.memoryMiB, diskGiB: vm.diskGiB }
    const preview: BotSetupPreview = {
      previewId: randomUUID(), inventoryRevision: this.sharedRevision(vmId), hostId: this.host.hostId,
      destination: { kind: 'shared-vm', vmId, displayName: vm.name, existingBots: this.repo.botsByVm(vmId).length,
        availableSessions: inventory.available, ...(inventory.capacity ? { sessionProfile: inventory.capacity.perSession } : {}) },
      profile: { templateId: 'prepared-environment', imageId: vm.imageId, runtimeId: vm.runtimeId,
        resources, source: 'recommended', requirements: { minimum: resources, recommended: resources } },
      permissions: { mode: 'ask', summary: [...permissionSummary.ask] },
      network: { mode: 'blocklist', domains: [] }, feasible: blockers.length === 0, blockers,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    }
    this.repo.transaction(() => this.repo.savePreview(preview))
    return preview
  }
  async start(params: {
    idempotencyKey: string
    previewId: string
    inventoryRevision: string
    name: string
    purpose: string
    instructions: string
    accountId?: string
    model?: Bot['model']
    confirmations: { destination: true; permissions: true; prepareExisting: boolean; restartExisting: boolean }
  }): Promise<BotOperation> {
    const print = fingerprint({ method: 'bot.setup.start', params })
    const existing = this.repo.operationByKey(params.idempotencyKey)
    if (existing) {
      if (existing.fingerprint !== print) throw new HostError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different parameters')
      return existing.operation
    }
    const accountId = params.accountId ?? this.accounts?.authority.repo.defaultId()
    const model = accountId ? await this.accounts!.authority.validateModel(accountId, params.model) : undefined
    if (params.model && !accountId) throw new HostError('ACCOUNT_REQUIRED', 'Escolha uma conta antes de selecionar o modelo')
    const preview = this.repo.preview(params.previewId)
    if (!preview) throw new HostError('PREVIEW_EXPIRED', 'A pré-visualização expirou; revise a configuração antes de continuar')
    if (!preview.feasible) throw new HostError(preview.blockers[0]?.code ?? 'INVALID_STATE', preview.blockers[0]?.message ?? 'Setup is not feasible')
    let current: string
    if (preview.destination.kind === 'shared-vm') {
      const inventory = await this.sessions.inspectVm(preview.destination.vmId)
      if (!inventory.supported) throw new HostError('ENVIRONMENT_UNAVAILABLE', inventory.reason ?? 'O ambiente está indisponível')
      current = this.sharedRevision(preview.destination.vmId)
    } else {
      const host = await this.host.inspectHost()
      const vms = this.host.vms().filter((vm) => vm.state !== 'removed')
      current = inventoryRevision(host, vms, this.host.templates, vms.flatMap(vm => this.repo.sessionsByVm(vm.id)))
    }
    if (current !== params.inventoryRevision || current !== preview.inventoryRevision)
      throw new HostError('PREVIEW_STALE', 'Os computadores disponíveis mudaram; revise a configuração antes de continuar')
    if (preview.destination.kind === 'existing-vm' && preview.destination.requiresPreparation && (!params.confirmations.prepareExisting || !params.confirmations.restartExisting))
      throw new HostError('CONFIRMATION_REQUIRED', 'Reutilizar este computador exige confirmar a preparação, o backup e o reinício')
    const operation = this.repo.transaction(() => {
      const duplicate = this.repo.operationByKey(params.idempotencyKey)
      if (duplicate) return duplicate.operation
      if (preview.destination.kind === 'shared-vm' && this.sharedRevision(preview.destination.vmId) !== current)
        throw new HostError('PREVIEW_STALE', 'A disponibilidade do ambiente mudou; tente criar novamente')
      if (preview.destination.kind === 'existing-vm' && this.repo.botByVm(preview.destination.vmId))
        throw new HostError('VM_ALREADY_BOUND', 'Este computador já pertence a outro bot')
      if (accountId) this.accounts!.authority.assertBindable(accountId)
      const botId = randomUUID()
      const opId = randomUUID()
      const bot: Bot = {
        id: botId,
        name: params.name,
        purpose: params.purpose,
        instructions: params.instructions,
        status: 'setup',
        ...(preview.destination.kind !== 'new-vm' ? { vmId: preview.destination.vmId } : {}),
        runtimeState: 'missing',
        accountState: accountId ? 'connected' : 'disconnected',
        ...(accountId ? { accountId, model } : {}),
        permissionMode: 'ask',
        setupOperationId: opId,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      }
      this.repo.saveBot(bot)
      if (preview.destination.kind !== 'new-vm') {
        this.sessions.reserve(bot.id, preview.destination.vmId, preview.destination.kind === 'shared-vm' ? 'managed' : 'legacy',
          preview.destination.kind === 'shared-vm' ? this.repo.sessionCapacity(preview.destination.vmId) : undefined)
      }
      this.repo.saveNetwork(botId, { mode: preview.network.mode, domains: preview.network.domains, revision: 0 })
      const operation: BotOperation = {
        id: opId,
        kind: 'setup',
        botId,
        status: 'queued',
        steps: structuredClone(accountId ? STEPS.filter(step => step.id !== 'account').map(step => ({ ...step, label: step.id === 'computer' ? 'Ambiente selecionado' : step.id === 'runtime' ? 'Criando a área de trabalho' : step.label })) : STEPS),
        createdAt: now(),
        updatedAt: now(),
      }
      this.repo.insertOperation(operation, params.idempotencyKey, print, { ...params, preview })
      return operation
    })
    this.kick(operation.id)
    return operation
  }
  inspect(operationId: string) {
    return this.repo.operation(operationId)
  }
  /** A new attempt retains the failed operation and never allocates a new computer. */
  prepare(params: { botId: string; idempotencyKey: string; confirmBackup: true; confirmRestart: true }): BotOperation {
    const print = fingerprint({ method: 'bot.runtime.prepare', params })
    const operation = this.repo.transaction(() => {
      const existing = this.repo.operationByKey(params.idempotencyKey)
      if (existing) {
        if (existing.fingerprint !== print) throw new HostError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different parameters')
        return existing.operation
      }
      if (params.confirmBackup !== true || params.confirmRestart !== true)
        throw new HostError('CONFIRMATION_REQUIRED', 'Confirme o backup e o reinício antes de tentar novamente')
      const bot = this.repo.bot(params.botId)
      if (this.repo.activeTurn(bot.id)) throw new HostError('BOT_BUSY', 'Pare a tarefa atual antes de preparar o computador')
      if (bot.status !== 'needs_attention' || !bot.setupOperationId || !bot.vmId)
        throw new HostError('INVALID_STATE', 'Somente uma preparação interrompida antes da transferência pode ser retomada')
      const previous = this.repo.operation(bot.setupOperationId)
      const binding = this.repo.binding(bot.id)
      const runtime = previous.steps.find((step) => step.id === 'runtime')
      // This exact legacy QGA rejection precedes file creation and every bundle write.
      // Timeouts, disconnects, installer failures and arbitrary SETUP_FAILED errors are
      // not evidence that the guest did nothing, and must never authorize replay.
      if (previous.kind !== 'setup' || previous.botId !== bot.id || previous.status !== 'failed' ||
          previous.error?.code !== 'SETUP_FAILED' || previous.error.message !== "Monitor rejected command: invalid file open mode 'wx'" ||
          runtime?.status !== 'failed' || runtime.error?.code !== previous.error.code || runtime.error.message !== previous.error.message ||
          previous.steps.find((step) => step.id === 'computer')?.status !== 'succeeded' ||
          previous.steps.some((step) => !['computer', 'runtime'].includes(step.id) && step.status !== 'pending') ||
          !binding || binding.vmId !== bot.vmId || binding.runtimeVersion || bot.conversationId || this.workers.has(previous.id))
        throw new HostError('RUNTIME_RETRY_UNSAFE', 'A falha não comprova que a instalação deixou de executar; a preparação exige reconciliação administrativa')
      const request = this.repo.operationRequest(previous.id) as { preview: BotSetupPreview }
      if (request.preview.destination.kind !== 'existing-vm' || request.preview.destination.vmId !== bot.vmId ||
          request.preview.profile.templateId !== binding.templateId)
        throw new HostError('RUNTIME_RETRY_UNSAFE', 'O vínculo original do computador não corresponde à preparação')
      const vm = this.host.vm(bot.vmId)
      if (!['running', 'stopped'].includes(vm.state)) throw new HostError('INVALID_STATE', 'O computador precisa estar parado ou em execução')
      const operation: BotOperation = {
        id: randomUUID(), kind: 'setup', botId: bot.id, status: 'queued',
        steps: previous.steps.map((step) => step.id === 'runtime' ? { id: step.id, label: step.label, status: 'pending' } : { ...step }),
        retained: { vmId: bot.vmId, diskRetained: true }, createdAt: now(), updatedAt: now(),
      }
      // Admission and pointer replacement are synchronous and atomic: concurrent keys
      // cannot both retry the same failure. Keep the original request and backup events.
      this.repo.insertOperation(operation, params.idempotencyKey, print, {
        ...request, ...params, previousOperationId: previous.id, expectedBotRevision: bot.revision,
        confirmations: { prepareExisting: true, restartExisting: true },
      })
      this.repo.saveBot({ ...bot, status: 'setup', setupOperationId: operation.id, revision: bot.revision + 1, updatedAt: now() })
      return operation
    })
    this.kick(operation.id)
    return operation
  }
  cancel(operationId: string) {
    return this.repo.transaction(() => {
      const op = this.repo.operation(operationId)
      if (op.kind !== 'setup') throw new HostError('INVALID_REQUEST', 'Not a setup operation')
      if (['succeeded', 'failed', 'cancelled'].includes(op.status)) return op
      const bot = op.botId ? this.repo.bot(op.botId) : undefined
      const cancelled: BotOperation = {
        ...op,
        status: 'cancelled',
        retained: { vmId: bot?.vmId, diskRetained: !!bot?.vmId },
        error: { code: 'CANCELLED', message: 'Preparação cancelada. O computador e os dados já criados foram mantidos.' },
        updatedAt: now(),
      }
      this.repo.saveOperation(cancelled)
      if (bot && bot.status === 'setup') this.repo.saveBot({ ...bot, status: 'needs_attention', revision: bot.revision + 1, updatedAt: now() })
      return cancelled
    })
  }
  /** Resume unfinished setups after Host restart without re-running completed effects. */
  recover() {
    for (const op of this.repo.operations()) if (op.kind === 'setup' && ['queued', 'running', 'waiting_user'].includes(op.status)) this.kick(op.id)
  }
  private kick(operationId: string) {
    if (this.workers.has(operationId)) return
    const worker = this.run(operationId)
      .catch(() => {})
      .finally(() => this.workers.delete(operationId))
    this.workers.set(operationId, worker)
  }
  private step(op: BotOperation, id: string, patch: Partial<BotOperation['steps'][number]>) {
    return { ...op, steps: op.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)), updatedAt: now() }
  }
  private save(op: BotOperation) {
    this.repo.transaction(() => this.repo.saveOperation(op))
    return op
  }
  private async waitVmOperation(id: string, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted()
      const op = this.host.operation(id)
      if (op.status === 'succeeded') return op
      if (op.status === 'failed' || op.status === 'cancelled') throw new HostError(op.error?.code ?? 'VM_OPERATION_FAILED', op.error?.message ?? 'A operação no computador falhou')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  private async vmMutation(op: BotOperation, stepId: string, method: 'vm.create' | 'vm.start' | 'vm.shutdown' | 'vm.restart', vmId: string | undefined, params: Record<string, unknown>, signal: AbortSignal) {
    const idempotencyKey = `${op.id}:${stepId}:${method}`
    const existing = op.steps.find((s) => s.id === stepId)?.vmOperationId
    let vmOp: Operation
    if (existing) vmOp = this.host.operation(existing)
    else {
      // The reservation lets the very first boot carry the bot channels before a binding exists.
      if (method === 'vm.create' && op.botId) this.repo.transaction(() => this.repo.reserve(idempotencyKey, op.botId as string))
      const vm = vmId ? this.host.vm(vmId) : undefined
      vmOp = await this.host.admit(method, { ...(vm ? { vmId: vm.id, expectedRevision: vm.revision } : {}), ...params, idempotencyKey })
      this.save(this.step(this.repo.operation(op.id), stepId, { vmOperationId: vmOp.id }))
    }
    return this.waitVmOperation(vmOp.id, signal)
  }
  private async run(operationId: string) {
    const signal = AbortSignal.timeout(45 * 60_000)
    let op = this.repo.operation(operationId)
    if (!op.botId || ['succeeded', 'failed', 'cancelled'].includes(op.status)) return
    const botId = op.botId
    const request = this.repo.operationRequest(operationId) as { preview: BotSetupPreview; confirmations: { prepareExisting: boolean; restartExisting: boolean } }
    const preview = request.preview
    const template = this.host.templates.find((t) => t.id === preview.profile.templateId)
    if (!template && preview.destination.kind !== 'shared-vm') return void this.fail(op, 'NO_BOT_TEMPLATE', 'O ambiente do bot não está mais disponível neste Host')
    // A crash during preparation leaves its effects uncertain. Recovery must not
    // repeat backup, transfer or installation merely because a step is unfinished.
    if (op.steps.find((step) => step.id === 'runtime')?.status === 'running')
      return void this.fail(op, 'RUNTIME_RETRY_UNSAFE', 'A preparação foi interrompida; verifique o computador antes de continuar')
    try {
      op = this.save({ ...op, status: 'running', updatedAt: now() })
      // 1. computer
      if (op.steps.find(step => step.id === 'computer')?.status !== 'succeeded') {
        op = this.save(this.step(op, 'computer', { status: 'running' }))
        let vmId = this.repo.bot(botId).vmId
        if (preview.destination.kind === 'new-vm') {
          if (!vmId) {
            const created = await this.vmMutation(op, 'computer', 'vm.create', undefined, {
              name: `bot-${this.repo.bot(botId).name}`.slice(0, 80),
              imageId: preview.profile.imageId,
              runtimeId: preview.profile.runtimeId,
              ...preview.profile.resources,
              startupPolicy: 'always',
            }, signal)
            vmId = created.vmId
            const bot = this.repo.bot(botId)
            this.repo.transaction(() => {
              this.repo.saveBot({ ...bot, vmId, revision: bot.revision + 1, updatedAt: now() })
              this.repo.saveBinding({ botId: bot.id, vmId: vmId as string, templateId: preview.profile.templateId, profile: 'bot', guestGeneration: 0, ...(template!.runtimeIncluded ? { runtimeVersion: template!.runtimeBundle?.version ?? 'image' } : {}), createdAt: now() })
            })
          } else await this.vmMutation(op, 'computer', 'vm.create', undefined, {}, signal).catch(() => {})
        } else {
          const vm = this.host.vm(preview.destination.vmId)
          if (!this.repo.binding(botId))
            this.repo.transaction(() => this.repo.saveBinding({ botId, vmId: vm.id, templateId: preview.profile.templateId, profile: 'bot', guestGeneration: 0,
              ...(preview.destination.kind === 'shared-vm' ? { runtimeVersion: 'managed' } : {}), createdAt: now() }))
        }
        op = this.save(this.step(this.repo.operation(op.id), 'computer', { status: 'succeeded' }))
      }
      // 2. runtime
      if (this.repo.operation(operationId).status === 'cancelled') return
      if (op.steps.find(step => step.id === 'runtime')?.status !== 'succeeded') {
        op = this.save(this.step(op, 'runtime', { status: 'running' }))
        const bot = this.repo.bot(botId)
        const binding = this.repo.binding(bot.id)
        if (!binding?.runtimeVersion) {
          if (preview.destination.kind !== 'new-vm' && (!request.confirmations.prepareExisting || !request.confirmations.restartExisting))
            throw new HostError('CONFIRMATION_REQUIRED', 'A preparação deste computador exige confirmação de backup e reinício')
          await this.prepareRuntime(op, bot, template!, signal, preview.destination.kind === 'new-vm')
        }
        if (!this.repo.session(bot.id)) {
          const inventory = await this.sessions.inspectVm(bot.vmId!)
          this.repo.transaction(() => this.sessions.reserve(bot.id, bot.vmId!, inventory.supported ? 'managed' : 'legacy', inventory.capacity))
        }
        await this.sessions.prepare(bot.id)
        if (this.repo.operation(operationId).status === 'cancelled') {
          await this.sessions.stop(bot.id)
          return
        }
        await this.verifyRuntime(bot)
        op = this.save(this.step(this.repo.operation(op.id), 'runtime', { status: 'succeeded' }))
      }
      // 3. bot registration (conversation)
      if (this.repo.operation(operationId).status === 'cancelled') { await this.sessions.stop(botId); return }
      if (op.steps.find(step => step.id === 'bot')?.status !== 'succeeded') {
        op = this.save(this.step(op, 'bot', { status: 'running' }))
        const bot = this.repo.bot(botId)
        if (!bot.conversationId) {
          const conversationId = randomUUID()
          this.repo.transaction(() => {
            this.repo.saveConversation({ id: conversationId, botId: bot.id, title: '', contextRevision: 0, lastSequence: 0, revision: 0, createdAt: now(), updatedAt: now() })
            this.repo.saveBot({ ...bot, conversationId, revision: bot.revision + 1, updatedAt: now() })
          })
        }
        op = this.save(this.step(this.repo.operation(op.id), 'bot', { status: 'succeeded' }))
      }
      // Legacy setups can still be resumed; shared accounts are connected before creation.
      if (this.repo.bot(botId).accountId) {
        await this.accounts!.connect(botId)
      } else if (op.steps.find(step => step.id === 'account')?.status !== 'succeeded') {
        const bot = this.repo.bot(botId)
        if (bot.accountState === 'connected' && bot.model) op = this.save(this.step(op, 'account', { status: 'succeeded' }))
        else {
          this.save({ ...this.step(op, 'account', { status: 'waiting_user' }), status: 'waiting_user' })
          return
        }
      }
      this.finish(op)
    } catch (error) {
      if (this.repo.operation(operationId).status === 'cancelled') {
        await this.sessions.stop(botId).catch(() => this.coordinator.events.record(botId, 'attention', 'A preparação foi cancelada; verifique a parada da área de trabalho.'))
        return
      }
      const code = error instanceof HostError ? error.code : 'SETUP_FAILED'
      this.fail(this.repo.operation(operationId), code, error instanceof Error ? error.message : 'Setup failed')
    }
  }
  /** Called when the account becomes connected while a setup is waiting on it. */
  accountConnected(bot: Bot) {
    if (!bot.setupOperationId) return
    const op = this.repo.operation(bot.setupOperationId)
    if (op.status !== 'waiting_user') return
    const updated = this.save({ ...this.step(op, 'account', { status: 'succeeded' }), status: 'running' })
    this.finish(updated)
  }
  private finish(op: BotOperation) {
    this.repo.transaction(() => {
      const current = this.repo.operation(op.id)
      const finished = { ...this.step(current, 'finish', { status: 'succeeded' }), status: 'succeeded' as const, updatedAt: now() }
      this.repo.saveOperation(finished)
      const bot = this.repo.bot(op.botId as string)
      this.repo.saveBot({ ...bot, status: 'ready', setupOperationId: undefined, revision: bot.revision + 1, updatedAt: now() })
    })
    this.coordinator.events.record(op.botId as string, 'runtime.changed', 'Seu bot está pronto')
  }
  private fail(op: BotOperation, code: string, message: string) {
    const bot = op.botId ? this.repo.bot(op.botId) : undefined
    const running = op.steps.find((s) => s.status === 'running')
    const failed: BotOperation = {
      ...(running ? this.step(op, running.id, { status: 'failed', error: { code, message } }) : op),
      status: 'failed',
      error: { code, message },
      retained: { vmId: bot?.vmId, diskRetained: !!bot?.vmId },
      updatedAt: now(),
    }
    this.save(failed)
    if (bot) {
      const latest = this.repo.bot(bot.id)
      this.repo.transaction(() => this.repo.saveBot({ ...latest, status: 'needs_attention', revision: latest.revision + 1, updatedAt: now() }))
      this.coordinator.events.record(bot.id, 'attention', message.slice(0, 400), { detail: { code } })
    }
  }
  private async prepareRuntime(op: BotOperation, bot: Bot, template: BotTemplate, signal: AbortSignal, newVm = false) {
    const preparation = this.host.preparation
    if (!template.runtimeBundle || !preparation?.backupDisk || !preparation.prepareGuestRuntime)
      throw new HostError('RUNTIME_UNAVAILABLE', 'Este Host não tem o pacote necessário para preparar um computador existente')
    const vmId = bot.vmId as string
    let vm = this.host.vm(vmId)
    // Backup requires a stopped guest; the person consented to the restart window.
    if (!newVm) {
      if (vm.state === 'running') await this.vmMutation(op, 'runtime', 'vm.shutdown', vmId, {}, signal)
      vm = this.host.vm(vmId)
      const backup = await preparation.backupDisk(vm, signal)
      this.coordinator.events.record(bot.id, 'runtime.changed', 'Backup do disco criado antes da preparação', { detail: { backup } })
      const started = await this.host.admit('vm.start', { vmId, expectedRevision: this.host.vm(vmId).revision, idempotencyKey: `${op.id}:runtime:start` })
      await this.waitVmOperation(started.id, signal)
    }
    const result = await preparation.prepareGuestRuntime(this.host.vm(vmId), template.runtimeBundle, signal)
    const binding = this.repo.binding(bot.id)
    this.repo.transaction(() => this.repo.saveBinding({ ...(binding as NonNullable<typeof binding>), runtimeVersion: result.version }))
    const restarted = await this.host.admit('vm.restart', { vmId, expectedRevision: this.host.vm(vmId).revision, idempotencyKey: `${op.id}:runtime:restart` })
    await this.waitVmOperation(restarted.id, signal)
  }
  private async verifyRuntime(bot: Bot) {
    const latest = this.repo.bot(bot.id)
    const session = await this.coordinator.session(latest)
    const info = (await session.request('runtime.inspect', {})) as { state?: string }
    if (info?.state !== 'ready') throw new HostError('RUNTIME_INCOMPATIBLE', 'O ambiente do bot respondeu, mas não está pronto')
  }
}
