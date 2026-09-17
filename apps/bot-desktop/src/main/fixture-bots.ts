import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type {
  SharedAccount,
  EnvironmentOperation,
  ModelCatalogEntry,
  AuthStatus,
  Bot,
  BotSession,
  BotConversation,
  BotEvent,
  BotInteraction,
  BotMemory,
  BotMessage,
  BotOperation,
  BotSetupPreview,
  BotTurn,
  Host,
  NetworkPolicy,
  TransferState,
  Vm,
} from '@maestrly/host-protocol'
import { foldTranscript, permissionSummary, transcriptCursor } from '@maestrly/host-protocol'
import { HostRequestError } from './host-client'
import { FixtureDesktops } from './fixture-desktop'
// 1x1 PNG standing in for the fresh capture attached to a continuation.
const FIXTURE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
// Development-only in-memory Bot domain for UI work. Never hardware evidence; disabled when packaged.
const now = () => new Date().toISOString()
const fail = (code: string, message: string) => new HostRequestError(message, code)
export class FixtureBots {
  sharedAccounts = new Map<string, SharedAccount>()
  preparedEnvironments = new Set<string>()
  environmentOperations = new Map<string, EnvironmentOperation>()
  environmentKeys = new Map<string, string>()
  accountKeys = new Map<string, string>()
  bots = new Map<string, Bot>()
  sessions = new Map<string, BotSession>()
  conversations = new Map<string, BotConversation>()
  messages = new Map<string, BotMessage[]>()
  turns = new Map<string, BotTurn>()
  interactions = new Map<string, BotInteraction>()
  memories = new Map<string, BotMemory[]>()
  events: BotEvent[] = []
  operations = new Map<string, BotOperation>()
  keys = new Map<string, BotOperation>()
  previews = new Map<string, BotSetupPreview>()
  networks = new Map<string, NetworkPolicy>()
  auth = new Map<string, AuthStatus>()
  files = new Map<string, Map<string, Buffer>>()
  transfers = new Map<string, TransferState & { botId: string }>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private fixtureSessions = new Map<string, string>()
  readonly desktop = new FixtureDesktops({
    later: (ms, fn) => this.later(ms, fn),
    sessionId: (botId) => {
      const known = this.sessions.get(botId)?.id
      if (known) return known
      if (!this.fixtureSessions.has(botId)) this.fixtureSessions.set(botId, randomUUID())
      return this.fixtureSessions.get(botId)!
    },
    activeTurn: (botId) => {
      const id = this.bot(botId).activeTurnId
      return id ? this.turns.get(id) : undefined
    },
    turn: (turnId) => this.turns.get(turnId),
    interrupt: (turnId) => {
      const turn = this.updateTurn(turnId, { status: 'interrupted', finishedAt: now(), error: { code: 'HUMAN_TAKEOVER', message: 'Tarefa pausada para você usar a tela. Ela pode continuar quando você devolver o controle.' } })
      this.save({ ...this.bot(turn.botId), activeTurnId: undefined })
      this.emit(turn.botId, 'turn.status', 'Tarefa pausada para você usar a tela', { turnId, detail: { status: 'interrupted' } })
    },
    continueTask: (botId, interruptedTurnId, operationId) => this.continueAfterHandoff(botId, interruptedTurnId, operationId),
    event: (botId, summary) => {
      this.emit(botId, 'runtime.changed', summary, { detail: { kind: 'desktop' } })
    },
  })
  constructor(
    private readonly host: () => Host,
    private readonly vms: () => Vm[],
    private readonly createVm: (name: string) => Vm,
    private readonly options: { slowSetup?: boolean; autoLoginMs?: number; readyEnvironment?: boolean; connectedAccount?: boolean } = {}
  ) {
    if (options.readyEnvironment) this.preparedEnvironments.add('fixture-vm')
    if (options.connectedAccount) {
      const account: SharedAccount = { id: 'fixture-account', authorityHostId: this.host().id, name: 'Conta OpenAI', provider: 'codex', role: 'authority', status: { state: 'connected', provider: 'codex', method: 'device', account: { email: 'fixture@example.test', plan: 'plus' } }, available: true, isDefault: true, revision: 0, createdAt: now(), updatedAt: now() }
      this.sharedAccounts.set(account.id, account)
    }
  }
  dispose() {
    for (const timer of this.timers) clearTimeout(timer)
    this.desktop.dispose()
  }
  private continueAfterHandoff(botId: string, interruptedTurnId: string, operationId: string) {
    const bot = this.bot(botId)
    const conversation = this.conversations.get(bot.conversationId!)!
    const original = (this.messages.get(conversation.id) ?? []).find((m) => m.turnId === interruptedTurnId)
    const capture = '.maestrly/screens/fixture-continuation.png'
    this.files.get(botId)?.set(capture, FIXTURE_PNG)
    const turn: BotTurn = { id: randomUUID(), botId, conversationId: conversation.id, messageId: randomUUID(), status: 'running', generation: 1, revision: 0, startedAt: now(), createdAt: now(), updatedAt: now() }
    const message: BotMessage = {
      id: turn.messageId, conversationId: conversation.id, clientMessageId: `desktop-return:${operationId}`, role: 'system',
      content: `Continuação após intervenção humana.\n\nA pessoa assumiu o controle da área de trabalho, fez alterações e devolveu o controle.\n\nTarefa original:\n${original?.content ?? ''}`,
      turnId: turn.id, sequence: ++conversation.lastSequence, attachments: [{ path: capture, name: 'tela-atual.png', size: FIXTURE_PNG.length }], createdAt: now(),
    }
    this.messages.get(conversation.id)!.push(message)
    this.turns.set(turn.id, turn)
    this.save({ ...bot, activeTurnId: turn.id })
    this.emit(botId, 'turn.status', 'Tarefa retomada a partir do estado atual da tela', { turnId: turn.id, detail: { status: 'running' } })
    this.desktop.screen(botId).setActivity(true)
    this.later(1200, () => this.finish(turn.id, 'succeeded', 'Continuei a partir do que você deixou na tela e concluí a tarefa.'))
    return turn.id
  }
  private later(ms: number, fn: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }
  private emit(botId: string, kind: BotEvent['kind'], summary: string, extra: Partial<BotEvent> = {}) {
    const event: BotEvent = { seq: this.events.length + 1, botId, kind, summary, createdAt: now(), ...extra }
    this.events.push(event)
    return event
  }
  private bot(id: string) {
    const bot = this.bots.get(String(id))
    if (!bot) throw fail('NOT_FOUND', 'Bot not found')
    return bot
  }
  private save(bot: Bot) {
    this.bots.set(bot.id, { ...bot, revision: bot.revision + 1, updatedAt: now() })
    return this.bots.get(bot.id)!
  }
  private sharedAccount(id: string) { const account = this.sharedAccounts.get(id); if (!account) throw fail('ACCOUNT_NOT_FOUND', 'Conta não encontrada'); return account }
  private accountModels(): ModelCatalogEntry[] { return [
    { id: 'fixture-small', displayName: 'Fixture small', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', recommended: true },
    { id: 'fixture-large', displayName: 'Fixture large', efforts: ['medium', 'high'], defaultEffort: 'high', recommended: false },
  ] }
  async request(method: string, p: Record<string, unknown>): Promise<unknown> {
    if (method.startsWith('bot.desktop.')) return this.desktop.request(method, p)
    switch (method) {
      case 'account.list': return [...this.sharedAccounts.values()]
      case 'account.create': {
        const previous = this.accountKeys.get(String(p.idempotencyKey))
        if (previous) return this.sharedAccounts.get(previous)
        const account: SharedAccount = { id: randomUUID(), authorityHostId: this.host().id, name: String(p.name), provider: 'codex', role: 'authority', status: { state: 'disconnected', provider: 'codex' }, available: true, isDefault: this.sharedAccounts.size === 0, revision: 0, createdAt: now(), updatedAt: now() }
        this.sharedAccounts.set(account.id, account); this.accountKeys.set(String(p.idempotencyKey), account.id); return account
      }
      case 'account.inspect': return this.sharedAccount(String(p.accountId))
      case 'account.models': return this.accountModels()
      case 'account.default': {
        for (const account of this.sharedAccounts.values()) account.isDefault = account.id === p.accountId
        return this.sharedAccount(String(p.accountId))
      }
      case 'account.impact': {
        const bots = [...this.bots.values()].filter(bot => bot.accountId === p.accountId && bot.status !== 'archived').map(bot => ({ botId: bot.id, name: bot.name, hostId: this.host().id, active: !!bot.activeTurnId }))
        return { bots, activeLeases: bots.filter(bot => bot.active).length }
      }
      case 'account.start': {
        const account = this.sharedAccount(String(p.accountId))
        account.status = { state: 'connecting', provider: 'codex', method: 'device', pending: { loginId: randomUUID(), verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', expiresAt: new Date(Date.now() + 600000).toISOString() } }
        const loginId = account.status.pending!.loginId
        if (this.options.autoLoginMs) this.later(this.options.autoLoginMs, () => { if (account.status.pending?.loginId === loginId) account.status = { state: 'connected', provider: 'codex', method: 'device', account: { email: 'fixture@example.test', plan: 'plus' } } })
        return account
      }
      case 'account.setApiKey': {
        const account = this.sharedAccount(String(p.accountId)); account.status = { state: 'connected', provider: 'codex', method: 'apiKey' }; return account
      }
      case 'account.logout':
      case 'account.cancel': {
        const account = this.sharedAccount(String(p.accountId))
        if (method === 'account.logout' && [...this.bots.values()].some(bot => bot.accountId === account.id && bot.activeTurnId)) throw fail('ACCOUNT_BUSY', 'Pare as tarefas antes de desconectar a conta')
        account.status = { state: 'disconnected', provider: 'codex' }
        for (const bot of this.bots.values()) if (bot.accountId === account.id) bot.accountState = 'disconnected'
        return account
      }
      case 'account.migrate': {
        const bot = this.bot(String(p.botId))
        if (bot.accountId) return this.sharedAccount(bot.accountId)
        const account = await this.request('account.create', { idempotencyKey: p.idempotencyKey, name: `Conta de ${bot.name}` }) as SharedAccount
        account.status = { state: 'connected', provider: 'codex', method: 'device', account: { email: 'fixture@example.test', plan: 'plus' } }
        this.save({ ...bot, accountId: account.id }); return account
      }
      case 'environment.list': return this.vms().filter(vm => vm.state !== 'removed').map(vm => {
        const sessions = [...this.sessions.values()].filter(session => session.vmId === vm.id)
        const supported = this.preparedEnvironments.has(vm.id) || sessions.length > 0
        const available = Math.max(0, 2 - sessions.filter(session => session.state !== 'archived').length)
        return { vm, status: vm.state === 'stopped' ? 'stopped' : !supported ? 'needs-preparation' : available > 0 ? 'ready' : 'full', inventory: { vmId: vm.id, supported, sessions, available: supported && vm.state === 'running' ? available : 0, capabilities: supported ? ['account.delegation.v1'] : [] } }
      })
      case 'environment.operations': return [...this.environmentOperations.values()]
      case 'environment.lookup': return this.environmentOperations.get(this.environmentKeys.get(String(p.idempotencyKey)) ?? '') ?? null
      case 'environment.operation': return this.environmentOperations.get(String(p.operationId))
      case 'environment.create':
      case 'environment.prepare': {
        const previous = this.environmentKeys.get(String(p.idempotencyKey)); if (previous) return this.environmentOperations.get(previous)
        const vm = method === 'environment.create' ? this.createVm(String(p.name)) : this.vms().find(vm => vm.id === p.vmId)!
        this.preparedEnvironments.add(vm.id); vm.state = 'running'; vm.desiredState = 'running'; vm.health = 'ready'
        const operation: EnvironmentOperation = { id: randomUUID(), vmId: vm.id, kind: method === 'environment.create' ? 'create' : 'prepare', status: 'succeeded', steps: [{ id: 'runtime', label: 'Ambiente pronto', status: 'succeeded' }], createdAt: now(), updatedAt: now() }
        this.environmentOperations.set(operation.id, operation); this.environmentKeys.set(String(p.idempotencyKey), operation.id); return operation
      }
      case 'bot.list':
        return [...this.bots.values()].filter((b) => p.includeArchived || b.status !== 'archived')
      case 'bot.inspect':
        return this.bot(String(p.botId))
      case 'bot.session.inspect': return this.sessions.get(String(p.botId)) ?? null
      case 'bot.sessions.list': {
        const sessions = [...this.sessions.values()].filter(s => s.vmId === p.vmId)
        const supported = this.preparedEnvironments.has(String(p.vmId)) || sessions.length > 0
        return { vmId: String(p.vmId), supported, capabilities: ['account.delegation.v1'], sessions, available: supported ? Math.max(0, 2 - sessions.length) : 0, ...(supported ? {} : { reason: 'Atualize o ambiente para compartilhar este computador.' }) }
      }
      case 'bot.update': {
        const bot = this.bot(String(p.botId))
        if (bot.revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'O bot mudou; recarregue antes de editar')
        if (p.permissionMode === 'full-vm' && !p.confirmFullVm) throw fail('CONFIRMATION_REQUIRED', 'O controle administrativo completo exige confirmação explícita')
        return this.save({ ...bot, ...(p.name !== undefined ? { name: String(p.name) } : {}), ...(p.purpose !== undefined ? { purpose: String(p.purpose) } : {}), ...(p.instructions !== undefined ? { instructions: String(p.instructions) } : {}), ...(p.model ? { model: { ...(p.model as Bot['model'])!, source: 'custom' } } : {}), ...(p.permissionMode ? { permissionMode: p.permissionMode as Bot['permissionMode'] } : {}) })
      }
      case 'bot.archive': {
        const bot = this.bot(String(p.botId))
        if (bot.activeTurnId) throw fail('BOT_BUSY', 'Pare a tarefa atual antes de arquivar o bot')
        this.save({ ...bot, status: 'archived' })
        const op: BotOperation = { id: randomUUID(), kind: 'archive', botId: bot.id, status: 'succeeded', steps: [], retained: { vmId: bot.vmId, diskRetained: true }, createdAt: now(), updatedAt: now() }
        this.operations.set(op.id, op)
        return op
      }
      case 'bot.setup.preview': {
        const host = this.host()
        const destination = p.destination as { kind: string; vmId?: string } | undefined
        const free = { cpus: host.capacity.cpus - host.allocated.cpus, memoryMiB: host.capacity.memoryMiB - host.allocated.memoryMiB, diskGiB: host.capacity.diskGiB - host.allocated.diskGiB }
        const resources = { cpus: 2, memoryMiB: 4096, diskGiB: 24 }
        const blockers: BotSetupPreview['blockers'] = []
        if (free.cpus < resources.cpus || free.memoryMiB < resources.memoryMiB || free.diskGiB < resources.diskGiB)
          blockers.push({ code: 'CAPACITY_APPROVAL_REQUIRED', message: 'Não há capacidade autorizada suficiente neste computador para um novo bot.', alternatives: ['Reutilizar um computador virtual existente que você escolher explicitamente.', 'Pedir ao administrador para aumentar a cota do Host.'] })
        let dest: BotSetupPreview['destination'] = { kind: 'new-vm', displayName: 'Novo computador virtual' }
        if (destination?.kind === 'shared-vm') {
          const vm = this.vms().find(v => v.id === destination.vmId)
          if (!vm) throw fail('NOT_FOUND', 'VM not found')
          blockers.length = 0
          const count = [...this.sessions.values()].filter(s => s.vmId === vm.id).length
          if ((!this.preparedEnvironments.has(vm.id) && count === 0) || count >= 2) blockers.push({ code: count === 0 ? 'SESSION_UPDATE_REQUIRED' : 'SESSION_CAPACITY_EXCEEDED', message: count === 0 ? 'Atualize o ambiente para compartilhar este computador.' : 'Não há recursos para outra área de trabalho.', alternatives: [] })
          dest = { kind: 'shared-vm', vmId: vm.id, displayName: vm.name, existingBots: count, availableSessions: Math.max(0, 2 - count), sessionProfile: { cpuQuotaPercent: 100, memoryMiB: 640, tasksMax: 256, diskMiB: 1024 } }
        } else if (destination?.kind === 'existing-vm') {
          const vm = this.vms().find((v) => v.id === destination.vmId)
          if (!vm) throw fail('NOT_FOUND', 'VM not found')
          if ([...this.bots.values()].some((b) => b.vmId === vm.id && b.status !== 'archived')) blockers.push({ code: 'VM_ALREADY_BOUND', message: 'Este computador já pertence a outro bot.', alternatives: [] })
          dest = { kind: 'existing-vm', vmId: vm.id, displayName: vm.name, requiresPreparation: true, requiresRestart: true, backupRequired: true }
        }
        const preview: BotSetupPreview = {
          previewId: randomUUID(),
          inventoryRevision: createHash('sha256').update(JSON.stringify(this.vms().map((v) => v.id))).digest('hex').slice(0, 16),
          hostId: host.id,
          destination: dest,
          profile: { templateId: 'fixture-bot', imageId: 'fixture-linux', runtimeId: 'qemu', resources, source: 'recommended', requirements: { minimum: { cpus: 2, memoryMiB: 3072, diskGiB: 16 }, recommended: resources } },
          permissions: { mode: 'ask', summary: [...permissionSummary.ask] },
          network: { mode: 'blocklist', domains: [] },
          feasible: blockers.length === 0,
          blockers,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }
        this.previews.set(preview.previewId, preview)
        return preview
      }
      case 'bot.setup.start': {
        const existing = this.keys.get(String(p.idempotencyKey))
        if (existing) return existing
        const preview = this.previews.get(String(p.previewId))
        if (!preview) throw fail('PREVIEW_EXPIRED', 'A pré-visualização expirou; revise a configuração antes de continuar')
        if (!preview.feasible) throw fail(preview.blockers[0].code, preview.blockers[0].message)
        const confirmations = p.confirmations as { prepareExisting?: boolean; restartExisting?: boolean }
        if (preview.destination.kind === 'existing-vm' && (!confirmations.prepareExisting || !confirmations.restartExisting)) throw fail('CONFIRMATION_REQUIRED', 'Reutilizar este computador exige confirmar a preparação, o backup e o reinício')
        const bot: Bot = { ...(p.accountId ? { accountId: String(p.accountId), model: p.model as Bot['model'] } : {}), id: randomUUID(), name: String(p.name), purpose: String(p.purpose ?? ''), instructions: String(p.instructions ?? ''), status: 'setup', runtimeState: 'missing', accountState: 'disconnected', permissionMode: 'ask', revision: 0, createdAt: now(), updatedAt: now() }
        const op: BotOperation = {
          id: randomUUID(),
          kind: 'setup',
          botId: bot.id,
          status: 'running',
          steps: [
            { id: 'computer', label: 'Verificando seu computador', status: 'running' },
            { id: 'runtime', label: 'Preparando o ambiente', status: 'pending' },
            { id: 'bot', label: 'Registrando o bot', status: 'pending' },
            { id: 'account', label: 'Conectando sua conta', status: 'pending' },
            { id: 'finish', label: 'Finalizando', status: 'pending' },
          ],
          createdAt: now(),
          updatedAt: now(),
        }
        bot.setupOperationId = op.id
        this.bots.set(bot.id, bot)
        this.networks.set(bot.id, { mode: 'blocklist', domains: [], revision: 0 })
        this.memories.set(bot.id, [])
        this.files.set(bot.id, new Map())
        this.operations.set(op.id, op)
        this.keys.set(String(p.idempotencyKey), op)
        const step = (id: string, status: BotOperation['steps'][number]['status'], opStatus?: BotOperation['status']) => {
          const current = this.operations.get(op.id)!
          const next = { ...current, steps: current.steps.map((s) => (s.id === id ? { ...s, status } : s)), status: opStatus ?? current.status, updatedAt: now() }
          this.operations.set(op.id, next)
        }
        const delay = this.options.slowSetup ? 900 : 150
        this.later(delay, () => {
          const vm = preview.destination.kind !== 'new-vm' ? this.vms().find((v) => v.id === (preview.destination as { vmId: string }).vmId)! : this.createVm(`bot-${bot.name}`)
          this.bots.set(bot.id, { ...this.bots.get(bot.id)!, vmId: vm.id })
          this.sessions.set(bot.id, { id: randomUUID(), botId: bot.id, vmId: vm.id, transport: 'managed', state: 'ready', generation: 1, revision: 0, createdAt: now(), updatedAt: now() })
          step('computer', 'succeeded')
          step('runtime', 'running')
          this.later(delay, () => {
            this.bots.set(bot.id, { ...this.bots.get(bot.id)!, runtimeState: 'ready' })
            step('runtime', 'succeeded')
            step('bot', 'running')
            const conversation: BotConversation = { id: randomUUID(), botId: bot.id, title: '', contextRevision: 0, lastSequence: 0, revision: 0, createdAt: now(), updatedAt: now() }
            this.conversations.set(conversation.id, conversation)
            this.messages.set(conversation.id, [])
            this.bots.set(bot.id, { ...this.bots.get(bot.id)!, conversationId: conversation.id })
            step('bot', 'succeeded')
            if (bot.accountId) {
              const connected = this.sharedAccount(bot.accountId).status.state === 'connected'
              if (connected) {
                this.bots.set(bot.id, { ...this.bots.get(bot.id)!, status: 'ready', accountState: 'connected', setupOperationId: undefined })
                const current = this.operations.get(op.id)!
                this.operations.set(op.id, { ...current, status: 'succeeded', steps: current.steps.filter(step => step.id !== 'account').map(step => ({ ...step, status: 'succeeded' })) })
              }
            } else step('account', 'waiting_user', 'waiting_user')
          })
        })
        return op
      }
      case 'bot.setup.inspect':
      case 'bot.operation.get': {
        const op = this.operations.get(String(p.operationId))
        if (!op) throw fail('NOT_FOUND', 'Bot operation not found')
        return op
      }
      case 'bot.operation.lookup':
        return this.keys.get(String(p.idempotencyKey)) ?? null
      case 'bot.setup.cancel': {
        const op = this.operations.get(String(p.operationId))
        if (!op) throw fail('NOT_FOUND', 'Bot operation not found')
        const cancelled = { ...op, status: 'cancelled' as const, retained: { vmId: this.bots.get(op.botId!)?.vmId, diskRetained: true }, updatedAt: now() }
        this.operations.set(op.id, cancelled)
        if (op.botId) this.save({ ...this.bot(op.botId), status: 'needs_attention' })
        return cancelled
      }
      case 'bot.runtime.inspect': {
        const bot = this.bot(String(p.botId))
        return { state: bot.runtimeState, version: '0.1.0-fixture', capabilities: ['provider.codex', 'tools.files', 'tools.browser'] }
      }
      case 'bot.models.list':
        return [
          { id: 'fixture-small', displayName: 'Fixture Small', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', recommended: true },
          { id: 'fixture-large', displayName: 'Fixture Large', efforts: ['medium', 'high'], recommended: false },
        ]
      case 'bot.auth.status':
        return this.auth.get(String(p.botId)) ?? { state: 'disconnected', provider: 'codex' }
      case 'bot.auth.start': {
        const bot = this.bot(String(p.botId))
        const status: AuthStatus = { state: 'connecting', provider: 'codex', method: 'device', pending: { loginId: 'fixture-login', verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-EFGH', expiresAt: new Date(Date.now() + 600_000).toISOString() } }
        this.auth.set(bot.id, status)
        this.save({ ...bot, accountState: 'connecting' })
        this.later(this.options.autoLoginMs ?? 1200, () => {
          if (this.auth.get(bot.id)?.state !== 'connecting') return
          this.connectAccount(bot.id, 'device')
        })
        return status
      }
      case 'bot.auth.setApiKey': {
        const bot = this.bot(String(p.botId))
        this.connectAccount(bot.id, 'apiKey')
        return this.auth.get(bot.id)
      }
      case 'bot.auth.cancel':
      case 'bot.auth.logout': {
        const bot = this.bot(String(p.botId))
        if (method === 'bot.auth.logout' && bot.activeTurnId) throw fail('BOT_BUSY', 'Pare a tarefa atual antes de desconectar a conta')
        this.auth.set(bot.id, { state: 'disconnected', provider: 'codex' })
        this.save({ ...bot, accountState: 'disconnected' })
        return this.auth.get(bot.id)
      }
      case 'bot.messages.list': {
        const bot = this.bot(String(p.botId))
        if (!bot.conversationId) return { messages: [], turns: [], hasMore: false }
        const all = this.messages.get(bot.conversationId) ?? []
        const before = typeof p.before === 'number' ? p.before : Number.MAX_SAFE_INTEGER
        const limit = typeof p.limit === 'number' ? p.limit : 50
        const filtered = all.filter((m) => m.sequence < before)
        const page = filtered.slice(-limit)
        const turnIds = [...new Set(page.map((m) => m.turnId).filter(Boolean))] as string[]
        return { conversation: this.conversations.get(bot.conversationId), messages: page, turns: turnIds.map((id) => this.turns.get(id)!), hasMore: filtered.length > page.length }
      }
      case 'bot.transcript.list': {
        const bot = this.bot(String(p.botId))
        if (!bot.conversationId) return { messages: [], turns: [], hasMore: false, cursor: 0 }
        const all = this.messages.get(bot.conversationId) ?? []
        const before = typeof p.before === 'number' ? p.before : Number.MAX_SAFE_INTEGER
        const limit = typeof p.limit === 'number' ? p.limit : 50
        const filtered = all.filter((m) => m.sequence < before)
        const page = filtered.slice(-limit)
        const turnIds = [...new Set(page.map((m) => m.turnId).filter(Boolean))] as string[]
        const turns = turnIds.map((id) => this.turns.get(id)!)
        const events = this.events.filter((e) => e.turnId && turnIds.includes(e.turnId))
        // The fixture folds with the very function the Host uses: same projection, no hardware.
        return { messages: foldTranscript({ messages: page, turns, events }), turns, hasMore: filtered.length > page.length, cursor: transcriptCursor(events) }
      }
      case 'bot.messages.lookup': {
        const bot = this.bot(String(p.botId))
        const message = (this.messages.get(bot.conversationId ?? '') ?? []).find((m) => m.clientMessageId === p.clientMessageId)
        return message?.turnId ? { message, turn: this.turns.get(message.turnId) } : null
      }
      case 'bot.messages.send':
        return this.send(String(p.botId), String(p.clientMessageId), String(p.content), (p.attachments as BotMessage['attachments']) ?? [])
      case 'bot.turn.get': {
        const turn = this.turns.get(String(p.turnId))
        if (!turn) throw fail('NOT_FOUND', 'Turn not found')
        return turn
      }
      case 'bot.turn.cancel': {
        const turn = this.turns.get(String(p.turnId))
        if (!turn) throw fail('NOT_FOUND', 'Turn not found')
        if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(turn.status)) return turn
        if (turn.revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'A tarefa mudou; verifique o estado atual antes de parar')
        this.updateTurn(turn.id, { status: 'cancelling', cancelRequestedAt: now() })
        for (const interaction of this.interactions.values()) if (interaction.turnId === turn.id && interaction.status === 'pending') this.interactions.set(interaction.id, { ...interaction, status: 'invalidated', updatedAt: now() })
        this.emit(turn.botId, 'turn.status', 'Parando a tarefa…', { turnId: turn.id, detail: { status: 'cancelling' } })
        this.later(400, () => this.finish(turn.id, 'cancelled'))
        return this.turns.get(turn.id)
      }
      case 'bot.interactions.list':
        return [...this.interactions.values()].filter((i) => i.botId === p.botId && (!p.pendingOnly || i.status === 'pending'))
      case 'bot.interactions.resolve': {
        const interaction = this.interactions.get(String(p.interactionId))
        if (!interaction) throw fail('NOT_FOUND', 'Interaction not found')
        if (interaction.status !== 'pending') throw fail('INTERACTION_RESOLVED', 'Esta decisão já foi registrada ou deixou de valer')
        if (interaction.generation !== p.expectedGeneration) throw fail('INTERACTION_STALE', 'A tarefa mudou desde que este pedido foi feito')
        const decision = String(p.decision)
        const resolved: BotInteraction = { ...interaction, status: decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'answered', ...(p.answer ? { answer: String(p.answer) } : {}), updatedAt: now() }
        this.interactions.set(interaction.id, resolved)
        this.updateTurn(interaction.turnId, { status: 'running' })
        this.emit(interaction.botId, decision === 'answer' ? 'question.answered' : 'approval.resolved', decision === 'approve' ? 'Você permitiu desta vez' : decision === 'deny' ? 'Você não permitiu' : 'Você respondeu ao bot', { turnId: interaction.turnId })
        this.later(600, () => {
          if (decision === 'approve') this.files.get(interaction.botId)?.set('approved.txt', Buffer.from('approved'))
          this.finish(interaction.turnId, 'succeeded', decision === 'approve' ? 'Feito: executei a ação que você autorizou.' : decision === 'deny' ? 'Tudo bem, não executei essa ação. Posso seguir de outra forma.' : `Entendi: ${String(p.answer)}. Vou continuar com isso.`)
        })
        return resolved
      }
      case 'bot.memory.list': {
        this.bot(String(p.botId))
        return (this.memories.get(String(p.botId)) ?? []).filter((m) => p.includeInactive || m.active)
      }
      case 'bot.memory.upsert': {
        const bot = this.bot(String(p.botId))
        const list = this.memories.get(bot.id) ?? []
        if (p.memoryId) {
          const index = list.findIndex((m) => m.id === p.memoryId)
          if (index < 0) throw fail('NOT_FOUND', 'Memory not found')
          if (list[index].revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'Esta memória mudou; recarregue antes de editar')
          list[index] = { ...list[index], content: String(p.content), active: p.active !== false, revision: list[index].revision + 1, updatedAt: now() }
          return list[index]
        }
        const memory: BotMemory = { id: randomUUID(), botId: bot.id, content: String(p.content), origin: 'user', active: p.active !== false, revision: 0, createdAt: now(), updatedAt: now() }
        list.push(memory)
        this.memories.set(bot.id, list)
        return memory
      }
      case 'bot.memory.delete': {
        const list = this.memories.get(String(p.botId)) ?? []
        const index = list.findIndex((m) => m.id === p.memoryId)
        if (index < 0) throw fail('NOT_FOUND', 'Memory not found')
        if (list[index].revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'Esta memória mudou; recarregue antes de remover')
        const [removed] = list.splice(index, 1)
        return { ...removed, active: false, revision: removed.revision + 1, updatedAt: now() }
      }
      case 'bot.events.list': {
        const after = typeof p.after === 'number' ? p.after : 0
        const limit = typeof p.limit === 'number' ? p.limit : 100
        const events = this.events.filter((e) => e.botId === p.botId && e.seq > after)
        const page = events.slice(0, limit)
        return { events: page, cursor: page.at(-1)?.seq ?? after, hasMore: events.length > page.length }
      }
      case 'bot.network.inspect': {
        const bot = this.bot(String(p.botId))
        return { policy: this.networks.get(bot.id) ?? { mode: 'offline', domains: [], revision: 0 }, mediated: bot.runtimeState === 'ready', activeStreams: 0 }
      }
      case 'bot.network.update': {
        const bot = this.bot(String(p.botId))
        const policy = this.networks.get(bot.id) ?? { mode: 'offline' as const, domains: [], revision: 0 }
        if (policy.revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'A política de rede mudou; recarregue antes de editar')
        const next: NetworkPolicy = { mode: p.mode as NetworkPolicy['mode'], domains: (p.domains as string[]).map((d) => d.toLowerCase()), revision: policy.revision + 1 }
        this.networks.set(bot.id, next)
        this.emit(bot.id, 'network.changed', next.mode === 'offline' ? 'Acesso à internet desativado' : `Destinos permitidos: ${next.domains.length}`)
        return { policy: next, mediated: true, activeStreams: 0 }
      }
      case 'bot.files.list': {
        const bot = this.bot(String(p.botId))
        const prefix = String(p.path ?? '')
        if (prefix.includes('..')) throw fail('INVALID_PATH', 'Use um caminho relativo dentro do espaço de trabalho do bot')
        return [...(this.files.get(bot.id) ?? new Map<string, Buffer>()).entries()]
          .filter(([path]) => path.startsWith(prefix) && !path.endsWith('.part'))
          .map(([path, data]) => ({ path, name: path.split('/').pop()!, kind: 'file' as const, size: data.length, digest: createHash('sha256').update(data).digest('hex'), modifiedAt: now() }))
      }
      case 'bot.files.transferBegin': {
        const bot = this.bot(String(p.botId))
        const path = String(p.path)
        if (path.startsWith('/') || path.includes('..')) throw fail('INVALID_PATH', 'Use um caminho relativo dentro do espaço de trabalho do bot')
        const store = this.files.get(bot.id)!
        if (p.direction === 'download') {
          const data = store.get(path)
          if (!data) throw fail('NOT_FOUND', 'Arquivo não encontrado')
          const transfer = { transferId: randomUUID(), direction: 'download' as const, path, size: data.length, offset: 0, chunkBytes: 49_152 as const, digest: createHash('sha256').update(data).digest('hex'), done: data.length === 0, expiresAt: new Date(Date.now() + 600_000).toISOString(), botId: bot.id }
          this.transfers.set(transfer.transferId, transfer)
          const { botId: _b, ...state } = transfer
          return state
        }
        if (store.has(path) && !p.overwrite) throw fail('FILE_EXISTS', 'Já existe um arquivo com este nome; confirme a substituição')
        const transfer = { transferId: randomUUID(), direction: 'upload' as const, path, size: Number(p.size ?? 0), offset: 0, chunkBytes: 49_152 as const, done: false, expiresAt: new Date(Date.now() + 600_000).toISOString(), botId: bot.id }
        this.transfers.set(transfer.transferId, transfer)
        store.set(`${path}.part`, Buffer.alloc(0))
        const { botId: _b, ...state } = transfer
        return state
      }
      case 'bot.files.transferChunk': {
        const transfer = this.transfers.get(String(p.transferId))
        if (!transfer) throw fail('NOT_FOUND', 'Transfer not found')
        if (transfer.offset !== p.offset) throw fail('TRANSFER_OFFSET', `Deslocamento inesperado; retome a partir de ${transfer.offset}`)
        const store = this.files.get(transfer.botId)!
        if (transfer.direction === 'download') {
          const data = store.get(transfer.path)!
          const slice = data.subarray(transfer.offset, transfer.offset + transfer.chunkBytes)
          transfer.offset += slice.length
          transfer.done = transfer.offset >= transfer.size
          const { botId: _b, ...state } = transfer
          return { ...state, dataBase64: slice.toString('base64') }
        }
        const bytes = Buffer.from(String(p.dataBase64 ?? ''), 'base64')
        store.set(`${transfer.path}.part`, Buffer.concat([store.get(`${transfer.path}.part`) ?? Buffer.alloc(0), bytes]))
        transfer.offset += bytes.length
        transfer.done = transfer.offset >= transfer.size
        const { botId: _b, ...state } = transfer
        return state
      }
      case 'bot.files.transferFinish': {
        const transfer = this.transfers.get(String(p.transferId))
        if (!transfer) throw fail('NOT_FOUND', 'Transfer not found')
        if (!transfer.done) throw fail('TRANSFER_INCOMPLETE', 'A transferência ainda não terminou')
        if (transfer.direction === 'upload') {
          const store = this.files.get(transfer.botId)!
          store.set(transfer.path, store.get(`${transfer.path}.part`) ?? Buffer.alloc(0))
          store.delete(`${transfer.path}.part`)
        }
        this.transfers.delete(transfer.transferId)
        const { botId: _b, ...state } = transfer
        return state
      }
      case 'bot.files.transferAbort': {
        const transfer = this.transfers.get(String(p.transferId))
        if (!transfer) throw fail('NOT_FOUND', 'Transfer not found')
        this.files.get(transfer.botId)?.delete(`${transfer.path}.part`)
        this.transfers.delete(transfer.transferId)
        const { botId: _b, ...state } = transfer
        return { ...state, done: false }
      }
      case 'bot.runtime.prepare':
        throw fail('UNSUPPORTED', 'Prepare o computador pelo fluxo de configuração do bot')
      case 'bot.create':
        throw fail('UNSUPPORTED', 'Use bot.setup.start')
    }
    throw fail('INVALID_REQUEST', `Unsupported fixture method ${method}`)
  }
  private connectAccount(botId: string, method: 'device' | 'apiKey') {
    const bot = this.bot(botId)
    this.auth.set(botId, { state: 'connected', provider: 'codex', method, account: { email: 'fixture@example.test', plan: 'plus' } })
    const updated = this.save({ ...bot, accountState: 'connected', model: bot.model ?? { model: 'fixture-small', effort: 'medium', source: 'recommended' } })
    this.emit(botId, 'account.changed', 'Conta de IA conectada')
    if (updated.setupOperationId) {
      const op = this.operations.get(updated.setupOperationId)
      if (op && op.status === 'waiting_user') {
        this.operations.set(op.id, { ...op, status: 'succeeded', steps: op.steps.map((s) => ({ ...s, status: 'succeeded' })), updatedAt: now() })
        this.save({ ...this.bot(botId), status: 'ready', setupOperationId: undefined })
        this.emit(botId, 'runtime.changed', 'Seu bot está pronto')
      }
    }
  }
  private updateTurn(turnId: string, patch: Partial<BotTurn>) {
    const turn = this.turns.get(turnId)!
    const next = { ...turn, ...patch, revision: turn.revision + 1, updatedAt: now() }
    this.turns.set(turnId, next)
    return next
  }
  private send(botId: string, clientMessageId: string, content: string, attachments: BotMessage['attachments']) {
    const bot = this.bot(botId)
    if (!bot.conversationId) throw fail('BOT_NOT_READY', 'O bot ainda está sendo preparado')
    const list = this.messages.get(bot.conversationId)!
    const existing = list.find((m) => m.clientMessageId === clientMessageId)
    if (existing) return { message: existing, turn: this.turns.get(existing.turnId!) }
    if (this.desktop.held(botId)) throw fail('BOT_PAUSED_BY_USER', 'O bot está pausado enquanto você usa a tela. Devolva o controle para enviar novas tarefas.')
    if (bot.accountState !== 'connected') throw fail('ACCOUNT_REQUIRED', 'Conecte a conta de IA do bot antes de enviar tarefas')
    if (bot.activeTurnId) throw fail('BOT_BUSY', 'O bot ainda está trabalhando na tarefa anterior. Aguarde ou pare a tarefa.')
    const conversation = this.conversations.get(bot.conversationId)!
    const turn: BotTurn = { id: randomUUID(), botId, conversationId: conversation.id, messageId: randomUUID(), status: 'queued', generation: 1, revision: 0, createdAt: now(), updatedAt: now() }
    const message: BotMessage = { id: turn.messageId, conversationId: conversation.id, clientMessageId, role: 'user', content, turnId: turn.id, sequence: ++conversation.lastSequence, attachments, createdAt: now() }
    list.push(message)
    this.turns.set(turn.id, turn)
    this.save({ ...bot, activeTurnId: turn.id })
    this.emit(botId, 'turn.status', 'Tarefa recebida', { turnId: turn.id, detail: { status: 'queued' } })
    this.later(200, () => {
      if (this.turns.get(turn.id)?.status !== 'queued') return
      this.updateTurn(turn.id, { status: 'running', startedAt: now() })
      this.desktop.screen(botId).setActivity(true)
      this.emit(botId, 'turn.status', 'O bot começou a trabalhar', { turnId: turn.id, detail: { status: 'running' } })
      this.emit(botId, 'tool.started', 'Executando um comando', { turnId: turn.id, detail: { callId: `c-${turn.id.slice(0, 8)}`, tool: 'commandExecution', summary: 'Executando um comando', command: 'ls' } })
      this.later(400, () => {
        const current = this.turns.get(turn.id)!
        if (current.status !== 'running') return
        this.emit(botId, 'tool.finished', 'Executando um comando', { turnId: turn.id, detail: { callId: `c-${turn.id.slice(0, 8)}`, tool: 'commandExecution', summary: 'Executando um comando', output: 'a\nb', exitCode: 0 } })
        if (content.includes('#approve')) {
          const interaction: BotInteraction = { id: randomUUID(), botId, turnId: turn.id, actionId: 'act-1', kind: 'approval', title: 'Executar com privilégios', reason: 'O bot quer instalar uma ferramenta do sistema para concluir a tarefa.', consequence: 'Altera pacotes dentro do computador do bot. Não afeta o seu Mac.', parameters: { command: 'apt-get install -y pandoc' }, fingerprint: 'f'.repeat(64), policyRevision: 0, generation: 1, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), status: 'pending', createdAt: now(), updatedAt: now() }
          this.interactions.set(interaction.id, interaction)
          this.updateTurn(turn.id, { status: 'waiting_approval' })
          this.emit(botId, 'approval.requested', 'Preciso da sua autorização', { turnId: turn.id, detail: { interactionId: interaction.id, title: interaction.title } })
          return
        }
        if (content.includes('#ask')) {
          const interaction: BotInteraction = { id: randomUUID(), botId, turnId: turn.id, actionId: 'q-1', kind: 'question', title: 'Qual formato você prefere?', reason: 'Posso entregar em Markdown ou HTML.', consequence: '', parameters: {}, fingerprint: 'e'.repeat(64), policyRevision: 0, generation: 1, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), status: 'pending', createdAt: now(), updatedAt: now() }
          this.interactions.set(interaction.id, interaction)
          this.updateTurn(turn.id, { status: 'waiting_input' })
          this.emit(botId, 'question.asked', 'O bot tem uma pergunta', { turnId: turn.id, detail: { interactionId: interaction.id, title: interaction.title } })
          return
        }
        if (content.includes('#slow')) return
        if (content.includes('#fail')) return void this.finish(turn.id, 'failed')
        const report = `# Relatório\n\nPedido: ${content}\n\nResumo gerado pelo fixture — sem hardware exercitado.\n`
        this.files.get(botId)!.set('relatorio.md', Buffer.from(report))
        this.emit(botId, 'file.produced', 'Arquivo criado: relatorio.md', { turnId: turn.id, detail: { path: 'relatorio.md', name: 'relatorio.md', size: Buffer.byteLength(report) } })
        this.finish(turn.id, 'succeeded', `Pronto. Escrevi o relatório em **relatorio.md** com base no seu pedido: "${content.slice(0, 80)}".`, [{ path: 'relatorio.md', name: 'relatorio.md', size: Buffer.byteLength(report) }])
      })
    })
    return { message, turn }
  }
  private finish(turnId: string, status: 'succeeded' | 'failed' | 'cancelled', reply?: string, attachments: BotMessage['attachments'] = []) {
    const turn = this.turns.get(turnId)
    if (!turn || ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(turn.status)) return
    this.desktop.screen(turn.botId).setActivity(false)
    const bot = this.bot(turn.botId)
    const conversation = this.conversations.get(turn.conversationId)!
    if (reply) {
      const message: BotMessage = { id: randomUUID(), conversationId: conversation.id, clientMessageId: `assistant-${turnId}`, role: 'assistant', content: reply, turnId, sequence: ++conversation.lastSequence, attachments, createdAt: now() }
      this.messages.get(conversation.id)!.push(message)
      this.emit(bot.id, 'assistant.message', 'O bot respondeu', { turnId, runtimeEventId: `assistant-${turnId}`, detail: { preview: reply.slice(0, 200) } })
    }
    this.updateTurn(turnId, { status, finishedAt: now(), ...(status === 'failed' ? { error: { code: 'FIXTURE_FAILURE', message: 'A tarefa falhou no fixture' } } : {}) })
    this.save({ ...this.bot(bot.id), activeTurnId: undefined })
    this.emit(bot.id, 'turn.status', status === 'succeeded' ? 'Tarefa concluída' : status === 'failed' ? 'A tarefa falhou' : 'Tarefa interrompida', { turnId, detail: { status } })
  }
}
