import type { SetupHost } from './bots/setup.js'
import { EnvironmentService } from './environments/service.js'
import { AccountAuthority } from './accounts/authority.js'
import { AccountPeers } from './accounts/peers.js'
import { AccountService } from './accounts/service.js'
import { AccountMigration } from './accounts/migration.js'
import { CodexAccountProvider, type AccountRuntime } from './accounts/codex-provider.js'
import type { AccountProviderFactory } from './accounts/provider.js'
import { VmGuestConnector } from './guest/session-router.js'
import { HostStore } from './persistence/store.js'
import { HostError } from './errors.js'
import { randomUUID } from 'node:crypto'
import { mkdirSync, lstatSync, realpathSync } from 'node:fs'
import { usableCapacity, observedMemoryMiB } from './capacity.js'
import { isAbsolute, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  requestSchema,
  verifyResultSchema,
  type Request,
  type Response,
  type Vm,
  type Host,
  type Operation,
  DESKTOP_HANDOFF_CAPABILITY,
  DESKTOP_LIVE_CAPABILITY,
  TEAM_HOST_CAPABILITY,
} from '@maestrly/host-protocol'
import { QemuProvider, type Provider, type Runtime, type Image } from './provider.js'
import { verifyAsset } from './assets.js'
import { BotService } from './bots/service.js'
import type { BotTemplate } from './bots/recommendations.js'
import { type GuestConnector } from './guest/session.js'
import { EgressBroker } from './egress/broker.js'
import { DesktopMediaConnector } from './desktop/media-connector.js'
import type { DesktopContext } from './desktop/service.js'
export interface HostServiceOptions {
  stateDirectory: string
  accounts?: { runtime?: AccountRuntime; peers?: { host: string; port: number } }
  accountProvider?: AccountProviderFactory
  runtimes: Runtime[]
  images: Image[]
  capacity?: { cpus: number; memoryMiB: number; diskGiB: number }
  /** Injection seam for provider conformance tests; production defaults to QEMU/HVF. */
  provider?: Provider
  /** Bot-ready templates (image + runtime bundle + measured requirements). Administrator input. */
  templates?: BotTemplate[]
  /** Injection seam for guest-runtime conformance tests; production connects to the VM control socket. */
  connector?: GuestConnector
  /** Injection seam for egress tests; production brokers the VM egress socket with real DNS/TCP. */
  egress?: EgressBroker
}
const now = () => new Date().toISOString()
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
function errorInfo(error: unknown) {
  return {
    code: error instanceof HostError ? error.code : 'PROVIDER_ERROR',
    message: error instanceof Error ? error.message : 'Host operation failed',
  }
}
export class HostService {
  private db!: DatabaseSync
  private store!: HostStore
  private initialized?: Promise<void>
  private worker?: Promise<void>
  private closed = false
  private hostId!: string
  private verifying = new Set<string>()
  private vmConnector?: VmGuestConnector
  private readonly provider: Provider
  private readonly options: HostServiceOptions
  private environments!: EnvironmentService
  private accounts!: AccountService
  private readonly accountProvider?: AccountProviderFactory
  private bots!: BotService
  private egress?: EgressBroker
  private hostGeneration = 0
  private readonly templates: BotTemplate[]
  private readonly connector?: GuestConnector
  constructor(options: HostServiceOptions) {
    if (!['darwin', 'linux'].includes(process.platform) || typeof process.getuid !== 'function')
      throw new Error('Host service requires POSIX ownership on macOS or Linux')
    if (!isAbsolute(options.stateDirectory)) throw new Error('stateDirectory must be absolute')
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 })
    const stat = lstatSync(options.stateDirectory)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      realpathSync(options.stateDirectory) !== options.stateDirectory
    )
      throw new Error('State directory must be canonical, private and owned by current user')
    if (Buffer.byteLength(join(options.stateDirectory, 'vms', '0'.repeat(36), 'qmp.sock')) > 100)
      throw new Error('State directory exceeds Unix socket path limit')
    if (
      new Set(options.runtimes.map((x) => x.id)).size !== options.runtimes.length ||
      new Set(options.images.map((x) => x.id)).size !== options.images.length
    )
      throw new Error('Catalogue IDs must be unique')
    const physical = usableCapacity(options.stateDirectory)
    const capacity = options.capacity ?? physical
    if (Object.values(capacity).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new Error('Invalid host capacity')
    // Disk capacity is a live free-space budget. It may be below the configured
    // ceiling after existing VM disks are allocated, but that must not prevent
    // recovery of the service and management of those VMs.
    for (const dimension of ['cpus', 'memoryMiB'] as const)
      if (capacity[dimension] > physical[dimension])
        throw new Error(`Configured ${dimension} exceeds usable physical capacity`)
    if (new Set((options.templates ?? []).map((x) => x.id)).size !== (options.templates ?? []).length)
      throw new Error('Catalogue IDs must be unique')
    for (const template of options.templates ?? [])
      if (!options.images.some((image) => image.id === template.imageId) || !options.runtimes.some((runtime) => runtime.id === template.runtimeId))
        throw new Error(`Bot template ${template.id} references an unknown image or runtime`)
    this.options = structuredClone({
      ...options,
      provider: undefined,
      accountProvider: undefined,
      connector: undefined,
      egress: undefined,
      templates: undefined,
      capacity,
    })
    this.templates = structuredClone(options.templates ?? [])
    this.accountProvider = options.accountProvider
    this.connector = options.connector
    this.egress = options.egress
    this.provider = options.provider ?? new QemuProvider(options.stateDirectory)
  }
  ready() {
    if (this.closed) return Promise.reject(new HostError('CLOSED', 'Host service is closed'))
    return (this.initialized ??= this.initialize())
  }
  private async initialize() {
    this.store = new HostStore(this.options.stateDirectory)
    this.db = this.store.db
    this.hostId = this.store.hostId
    this.hostGeneration = this.store.nextGeneration()
    this.egress ??= new EgressBroker()
    const accountDirectory = join(this.options.stateDirectory, 'accounts')
    const authority = new AccountAuthority({ store: this.store, directory: accountDirectory,
      provider: this.accountProvider ?? (this.options.accounts?.runtime ? id => CodexAccountProvider.open(join(accountDirectory, id), this.options.accounts!.runtime!) : undefined),
      onChanged: account => this.bots?.delegation?.changed(account),
    })
    const peers = new AccountPeers(authority, join(accountDirectory, 'peers'), this.options.accounts?.peers)
    this.accounts = new AccountService(authority, peers, (botId, key) => migration.migrate(botId, key))
    const setupHost: SetupHost & { hostGeneration: number } = {
        hostId: this.hostId,
        hostGeneration: this.hostGeneration,
        inspectHost: () => this.inspectHost(),
        listImages: () => this.listImages(),
        vm: (id) => this.store.vm(id),
        vms: () => this.store.vms(),
        operation: (id) => this.store.operation(id),
        admit: (method, params) => this.admit(requestSchema.parse({ version: 1, id: randomUUID(), method, params }) as Parameters<HostService['admit']>[0]),
        templates: this.templates,
        preparation: this.provider,
    }
    this.bots = new BotService({
      store: this.store,
      stateDirectory: this.options.stateDirectory,
      sharedAccounts: authority,
      connector: this.connector ?? (this.vmConnector = new VmGuestConnector(this.hostId, this.hostGeneration, vmId => {
        const vm = this.store.vm(vmId)
        if (!this.provider.botChannels) throw new HostError('UNSUPPORTED', 'Provider has no bot channels')
        return this.provider.botChannels(vm)
      }, this.egress, () => this.bots.repo, new DesktopMediaConnector(this.hostId, this.hostGeneration, (vmId) => {
        const vm = this.store.vm(vmId)
        return this.provider.botChannels?.(vm).desktop
      }))),
      host: setupHost,
      onPolicyChanged: (botId, vmId, policy) => {
        const session = this.bots.repo.session(botId)
        if (vmId) this.egress?.updatePolicy(vmId, policy, session?.transport === 'managed' ? session.id : undefined)
      },
      activeStreams: (vmId, botId) => { const session = botId ? this.bots.repo.session(botId) : undefined; return this.egress?.activeStreams(vmId, session?.transport === 'managed' ? session.id : undefined) ?? 0 },
    })
    this.environments = new EnvironmentService(this.bots.repo, setupHost, this.bots.sessions, this.bots.setup)
    const migration = new AccountMigration(authority, this.bots.repo, this.bots.coordinator, this.bots.delegation!)
    try {
      this.environments.recover()
      await authority.ready()
      await peers.ready()
      // Never replay an uncertain side effect after a crash. Keep the reservation and
      // reconcile identity through the private QMP UUID before allowing more work.
      const interrupted = new Set<string>()
      for (const op of this.store.operations().filter((x) => x.status === 'running' || x.status === 'queued')) {
        interrupted.add(op.vmId)
        const vm = this.store.vm(op.vmId)
        const state = await this.provider.inspect(vm).catch(() => 'unknown' as const)
        this.store.transaction(() => {
          this.store.saveVm({
            ...vm,
            state,
            health: 'unknown',
            revision: vm.revision + 1,
            updatedAt: now(),
          })
          this.store.saveOperation({
            ...op,
            status: 'failed',
            updatedAt: now(),
            error: {
              code: 'INTERRUPTED',
              message: 'Host stopped before operation completion; state reconciled conservatively',
            },
          })
        })
      }
      for (const vm of this.store.vms().filter((x) => x.state !== 'removed')) {
        const state = await this.provider.inspect(vm).catch(() => 'unknown' as const)
        let health: Vm['health'] = 'unknown'
        let bootId = vm.bootId
        if (state === 'running') {
          try {
            const readiness = verifyResultSchema.parse(
              await this.provider.verify(vm, 'read-marker', AbortSignal.timeout(30_000))
            )
            health = readiness.ready && readiness.networkIsolated ? 'ready' : 'unresponsive'
            bootId = readiness.bootId
          } catch {
            health = 'unresponsive'
          }
        }
        if (state !== vm.state || health !== vm.health || bootId !== vm.bootId)
          this.store.transaction(() =>
            this.store.saveVm({
              ...vm,
              state,
              health,
              bootId,
              revision: vm.revision + 1,
              updatedAt: now(),
            })
          )
        if (state === 'running') this.attachEgress(vm)
        if (
          state === 'stopped' &&
          vm.startupPolicy === 'always' &&
          vm.desiredState === 'running' &&
          !interrupted.has(vm.id)
        ) {
          const current = this.store.vm(vm.id)
          await this.admit({
            version: 1,
            id: randomUUID(),
            method: 'vm.start',
            params: {
              vmId: vm.id,
              expectedRevision: current.revision,
              idempotencyKey: randomUUID(),
            },
          })
        }
      }
      await this.bots.ready()
    } catch (error) {
      await this.accounts?.peers.close().catch(() => {})
      await this.accounts?.authority.close().catch(() => {})
      await this.bots?.close().catch(() => {})
      this.store.close()
      throw error
    }
  }
  private attachEgress(vm: Vm) {
    // Managed sessions attach their own routes when connecting. Never bind a VM-wide policy to a multiplexed channel.
    const legacy = this.bots.repo.sessionsByVm(vm.id).filter(s => s.transport === 'legacy' && !s.issue)
    if (legacy.length !== 1 || !this.provider.botChannels || !this.egress) return
    this.egress.attach(vm.id, this.provider.botChannels(vm).egress, this.bots.repo.network(legacy[0].botId))
  }
  private runtimeChecks = new Map<string, { at: number; value: Promise<{ available: boolean; reason?: string }> }>()
  /**
   * host.inspect is how clients confirm identity (the screen channel does it on open), and a
   * full runtime check hashes QEMU and firmware and boots a probe VM (~0.8 s). A successful
   * check is reused for a minute; failures are rechecked every time. Starting a VM still
   * verifies the runtime in full.
   */
  private runtimeAvailability(runtime: Runtime) {
    const cached = this.runtimeChecks.get(runtime.id)
    if (cached && Date.now() - cached.at < 60_000) return cached.value
    const value = this.provider.inspectRuntime(runtime)
    const entry = { at: Date.now(), value }
    this.runtimeChecks.set(runtime.id, entry)
    void value.then(
      (result) => {
        if (!result.available && this.runtimeChecks.get(runtime.id) === entry) this.runtimeChecks.delete(runtime.id)
      },
      () => {
        if (this.runtimeChecks.get(runtime.id) === entry) this.runtimeChecks.delete(runtime.id)
      }
    )
    return value
  }
  private async inspectHost(): Promise<Host> {
    const runtimes = await Promise.all(
      this.options.runtimes.map(async (runtime) => ({
        id: runtime.id,
        ...(await this.runtimeAvailability(runtime)),
      }))
    )
    return {
      id: this.hostId,
      serviceVersion: '0.3.0',
      protocolVersion: 1,
      capabilities: ['environments.v1', 'accounts.v1', 'bot.sessions.v1', DESKTOP_LIVE_CAPABILITY, DESKTOP_HANDOFF_CAPABILITY, TEAM_HOST_CAPABILITY, 'vm.create', 'vm.verify', 'vm.remove.retain', 'vm.remove.purge', 'runtime.hvf-smoke', 'bot.runtime.v1', ...(this.templates.length ? ['bot.setup'] : [])],
      health: runtimes.some((x) => x.available) ? 'ready' : 'unavailable',
      observedMemoryMiB: observedMemoryMiB(),
      platform: process.platform,
      arch: process.arch,
      supported: runtimes.some((x) => x.available),
      capacity: this.options.capacity!,
      allocated: this.allocated(),
      runtimes,
    }
  }
  private listImages() {
    return Promise.all(
      this.options.images.map(async (image) => {
        try {
          await verifyAsset(image.asset)
          return { id: image.id, name: image.name, arch: image.arch, virtualSizeGiB: image.virtualSizeGiB, available: true }
        } catch (error) {
          return { id: image.id, name: image.name, arch: image.arch, virtualSizeGiB: image.virtualSizeGiB, available: false, reason: errorInfo(error).message }
        }
      })
    )
  }
  private allocated() {
    return this.store
      .vms()
      .filter((vm) => vm.state !== 'removed' || vm.diskRetained)
      .reduce(
        (sum, vm) => ({
          cpus: sum.cpus + (vm.state === 'removed' ? 0 : vm.cpus),
          memoryMiB: sum.memoryMiB + (vm.state === 'removed' ? 0 : vm.memoryMiB),
          diskGiB: sum.diskGiB + vm.diskGiB,
        }),
        { cpus: 0, memoryMiB: 0, diskGiB: 0 }
      )
  }
  private runtime(id: string) {
    const value = this.options.runtimes.find((x) => x.id === id)
    if (!value) throw new HostError('RUNTIME_UNAVAILABLE', 'Unknown runtime')
    return value
  }
  private image(id: string) {
    const value = this.options.images.find((x) => x.id === id)
    if (!value) throw new HostError('IMAGE_UNAVAILABLE', 'Unknown image')
    return value
  }
  /** @param context the Host connection the request arrived on; viewers are bound to it. */
  async dispatch(input: unknown, context?: DesktopContext): Promise<Response> {
    const parsed = requestSchema.safeParse(input)
    const candidate = input as { id?: unknown } | null
    const id =
      typeof candidate?.id === 'string' && candidate.id.length > 0 && candidate.id.length <= 128
        ? candidate.id
        : 'invalid'
    if (!parsed.success)
      return {
        version: 1,
        id,
        error: {
          code:
            input && typeof input === 'object' && 'version' in input && input.version !== 1
              ? 'INCOMPATIBLE_VERSION'
              : 'INVALID_REQUEST',
          message: parsed.error.issues
            .map((x) => `${x.path.join('.')}: ${x.message}`)
            .join(';')
            .slice(0, 2048),
        },
      }
    try {
      await this.ready()
      return {
        version: 1,
        id: parsed.data.id,
        result: await this.handle(parsed.data, context),
      }
    } catch (error) {
      return { version: 1, id: parsed.data.id, error: errorInfo(error) }
    }
  }
  /** desktop-stdio: a single-use ticket becomes one RFB stream on the private media lane. */
  async attachDesktop(ticket: string) {
    await this.ready()
    return this.bots.desktop.attach(ticket)
  }
  /** A Host socket closed: its desktop viewers end and a controller becomes a pause. */
  async disconnect(connectionId: string) {
    if (!this.initialized) return
    await this.initialized.catch(() => {})
    await this.bots?.desktop.disconnect(connectionId)
  }
  private async handle(request: Request, context?: DesktopContext): Promise<unknown> {
    if (request.method.startsWith('environment.')) return this.environments.handle(request as any)
    if (request.method.startsWith('account.')) return this.accounts.handle(request as any)
    if (request.method.startsWith('bot.')) return this.bots.handle(request as any, context)
    if (request.method.startsWith('team.')) return this.bots.teams.handle(request as any)
    switch (request.method) {
      case 'host.inspect':
        return this.inspectHost()
      case 'image.list':
        return this.listImages()
      case 'vm.list':
        return this.store
          .vms()
          .filter((x) => x.state !== 'removed' || (request.params.includeRetained && x.diskRetained))
      case 'vm.inspect': {
        const vm = this.store.vm(request.params.vmId)
        if (
          vm.state === 'removed' ||
          this.store.operations().some((op) => op.vmId === vm.id && ['queued', 'running'].includes(op.status))
        )
          return vm
        const state = await this.provider.inspect(vm).catch(() => 'unknown' as const)
        const latest = this.store.vm(vm.id)
        if (latest.revision !== vm.revision) return latest
        if (state === vm.state) return vm
        const updated: Vm = {
          ...vm,
          state,
          health: 'unknown',
          revision: vm.revision + 1,
          updatedAt: now(),
        }
        this.store.transaction(() => this.store.saveVm(updated))
        return updated
      }
      case 'vm.logs': {
        const vm = this.store.vm(request.params.vmId)
        if (!this.provider.logs) throw new HostError('UNSUPPORTED', 'Guest console is unavailable for this provider')
        if (
          this.verifying.has(vm.id) ||
          this.store.operations().some((op) => op.vmId === vm.id && ['queued', 'running'].includes(op.status))
        )
          throw new HostError('VM_BUSY', 'Read guest console after the active operation finishes')
        this.verifying.add(vm.id)
        try {
          return await this.provider.logs(vm)
        } finally {
          this.verifying.delete(vm.id)
        }
      }
      case 'vm.verify': {
        const vm = this.store.vm(request.params.vmId)
        if (
          this.verifying.has(vm.id) ||
          this.store.operations().some((x) => x.vmId === vm.id && ['queued', 'running'].includes(x.status))
        )
          throw new HostError('VM_BUSY', 'VM has active work')
        if (vm.state !== 'running' || vm.health !== 'ready')
          throw new HostError('INVALID_STATE', 'VM is not safely ready')
        this.verifying.add(vm.id)
        try {
          return verifyResultSchema.parse(
            await this.provider.verify(vm, request.params.mode, AbortSignal.timeout(30_000))
          )
        } finally {
          this.verifying.delete(vm.id)
        }
      }
      case 'operation.lookup': {
        const row = this.db.prepare('SELECT body FROM operations WHERE key=?').get(request.params.idempotencyKey)
        return row ? JSON.parse(row.body as string) : null
      }
      case 'operation.get':
        return this.store.operation(request.params.operationId)
      case 'events.list':
        return this.db
          .prepare('SELECT seq,body FROM events WHERE seq>? ORDER BY seq LIMIT ?')
          .all(request.params.after, request.params.limit)
          .map((row) => ({ seq: row.seq, ...JSON.parse(row.body as string) }))
      case 'operation.cancel':
        return this.store.transaction(() => {
          const op = this.store.operation(request.params.operationId)
          if (op.status === 'cancelled') return op
          if (op.status !== 'queued') throw new HostError('NOT_CANCELLABLE', 'Only queued operations can be cancelled')
          const cancelled: Operation = {
            ...op,
            status: 'cancelled',
            updatedAt: now(),
          }
          this.store.saveOperation(cancelled)
          if (op.method === 'vm.create') {
            const vm = this.store.vm(op.vmId)
            this.store.saveVm({
              ...vm,
              state: 'removed',
              diskRetained: false,
              desiredState: 'stopped',
              revision: vm.revision + 1,
              updatedAt: now(),
            })
          }
          return cancelled
        })
      default:
        return this.admit(request as Parameters<HostService['admit']>[0])
    }
  }
  private async admit(
    request: Extract<
      Request,
      {
        method: 'vm.create' | 'vm.start' | 'vm.shutdown' | 'vm.restart' | 'vm.remove'
      }
    >
  ) {
    const fingerprint = canonical({
      method: request.method,
      params: request.params,
    })
    const existing = this.db
      .prepare('SELECT fingerprint,body FROM operations WHERE key=?')
      .get(request.params.idempotencyKey)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new HostError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different parameters')
      return JSON.parse(existing.body as string)
    }
    if (request.method === 'vm.create') {
      const runtime = this.runtime(request.params.runtimeId)
      const image = this.image(request.params.imageId)
      if (runtime.arch !== image.arch || request.params.diskGiB < image.virtualSizeGiB || image.guestAgent !== true)
        throw new HostError('IMAGE_INCOMPATIBLE', 'Image is incompatible with requested VM')
      const availability = await this.provider.inspectRuntime(runtime)
      if (!availability.available)
        throw new HostError('RUNTIME_UNAVAILABLE', availability.reason ?? 'Runtime unavailable')
      await verifyAsset(image.asset)
    }
    const op = this.store.transaction(() => {
      // Recheck after asynchronous verification; another request may have committed.
      const duplicate = this.db
        .prepare('SELECT fingerprint,body FROM operations WHERE key=?')
        .get(request.params.idempotencyKey)
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint)
          throw new HostError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different parameters')
        return JSON.parse(duplicate.body as string) as Operation
      }
      let vm: Vm
      if (request.method === 'vm.create') {
        const used = this.allocated()
        const cap = this.options.capacity!
        if (used.diskGiB + request.params.diskGiB > usableCapacity(this.options.stateDirectory).diskGiB)
          throw new HostError('CAPACITY_EXCEEDED', 'Insufficient uncommitted disk capacity')
        for (const dimension of ['cpus', 'memoryMiB', 'diskGiB'] as const)
          if (used[dimension] + request.params[dimension] > cap[dimension])
            throw new HostError('CAPACITY_EXCEEDED', `Insufficient ${dimension} capacity`)
        const { idempotencyKey: _, ...spec } = request.params
        vm = {
          ...spec,
          id: randomUUID(),
          identity: randomUUID(),
          state: 'stopped',
          desiredState: 'running',
          health: 'provisioning',
          diskRetained: true,
          revision: 0,
          createdAt: now(),
          updatedAt: now(),
        }
        this.store.saveVm(vm)
      } else {
        vm = this.store.vm(request.params.vmId)
        if (vm.revision !== request.params.expectedRevision)
          throw new HostError('REVISION_CONFLICT', 'VM revision changed')
        if (
          this.verifying.has(vm.id) ||
          this.store.operations().some((x) => x.vmId === vm.id && (x.status === 'queued' || x.status === 'running'))
        )
          throw new HostError('VM_BUSY', 'VM already has an active operation')
        this.environments.assertVmOperationAllowed(vm.id, request.params.idempotencyKey)
        this.bots.assertVmOperationAllowed(vm.id, request.method, request.method === 'vm.remove' && request.params.deleteData)
        if (
          (vm.state === 'removed' && !(request.method === 'vm.remove' && request.params.deleteData)) ||
          vm.state === 'unknown'
        )
          throw new HostError('INVALID_STATE', 'VM state does not permit this operation')
        if (request.method === 'vm.remove' && vm.state !== 'stopped' && vm.state !== 'removed')
          throw new HostError('INVALID_STATE', 'VM must be stopped before removal')
        if (request.method === 'vm.restart' && vm.state !== 'running')
          throw new HostError('INVALID_STATE', 'VM must be running before restart')
      }
      vm = {
        ...vm,
        desiredState: ['vm.create', 'vm.start', 'vm.restart'].includes(request.method) ? 'running' : 'stopped',
        revision: vm.revision + 1,
        updatedAt: now(),
      }
      this.store.saveVm(vm)
      const operation: Operation = {
        id: randomUUID(),
        vmId: vm.id,
        method: request.method,
        status: 'queued',
        createdAt: now(),
        updatedAt: now(),
      }
      this.db
        .prepare('INSERT INTO operations(id,vm_id,key,fingerprint,request,body) VALUES(?,?,?,?,?,?)')
        .run(
          operation.id,
          vm.id,
          request.params.idempotencyKey,
          fingerprint,
          JSON.stringify(request),
          JSON.stringify(operation)
        )
      this.store.event('operation.changed', operation)
      return operation
    })
    // A macrotask gives callers a chance to cancel an accepted queued operation.
    if (!this.worker)
      this.worker = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.drain())
        .finally(() => {
          this.worker = undefined
        })
    return op
  }
  private async drain() {
    for (;;) {
      const op = this.store.operations().find((x) => x.status === 'queued')
      if (!op) return
      let vm = this.store.vm(op.vmId)
      this.store.transaction(() => {
        this.store.saveOperation({ ...op, status: 'running', updatedAt: now() })
        if (['vm.create', 'vm.start', 'vm.restart', 'vm.shutdown'].includes(op.method)) {
          vm = {
            ...vm,
            state: op.method === 'vm.shutdown' ? 'stopping' : 'starting',
            health: op.method === 'vm.shutdown' ? 'unknown' : 'provisioning',
            revision: vm.revision + 1,
            updatedAt: now(),
          }
          this.store.saveVm(vm)
        }
      })
      try {
        const signal = AbortSignal.timeout(360_000)
        const request = requestSchema.parse(
          JSON.parse(this.db.prepare('SELECT request FROM operations WHERE id=?').get(op.id)!.request as string)
        )
        let readiness: Awaited<ReturnType<Provider['waitReady']>> | undefined
        const createKey = (this.db.prepare('SELECT key FROM operations WHERE id=?').get(op.id) as { key: string } | undefined)?.key
        const profile = (this.bots.launchProfileFor(vm.id, createKey) || this.environments.launchProfileFor(vm.id, createKey)) && this.provider.botChannels ? { botChannels: this.provider.botChannels(vm) } : {}
        switch (op.method) {
          case 'vm.create':
            await this.provider.provision(vm, this.runtime(vm.runtimeId), this.image(vm.imageId), signal)
            await this.provider.start(vm, this.runtime(vm.runtimeId), signal, profile)
            break
          case 'vm.start':
            await this.provider.start(vm, this.runtime(vm.runtimeId), signal, profile)
            break
          case 'vm.shutdown':
            this.egress?.detach(vm.id)
            await this.provider.shutdown(vm, signal)
            this.bots.vmStopped(vm.id)
          this.vmConnector?.dropVm(vm.id)
            break
          case 'vm.restart':
            this.egress?.detach(vm.id)
            await this.provider.restart(vm, signal)
            this.bots.vmStopped(vm.id)
          this.vmConnector?.dropVm(vm.id)
            break
          case 'vm.remove':
            if ((await this.provider.inspect(vm)) !== 'stopped')
              throw new Error('Only a proven stopped VM can be removed')
            if (request.method === 'vm.remove' && request.params.deleteData) {
              await this.provider.remove(vm, signal)
              vm = { ...vm, diskRetained: false }
            }
            break
        }
        if (['vm.create', 'vm.start', 'vm.restart'].includes(op.method)) {
          readiness = verifyResultSchema.parse(await this.provider.waitReady(vm, signal))
          if (!readiness.ready || !readiness.networkIsolated) throw new Error('Guest provisioning is not ready')
          if (op.method === 'vm.restart' && readiness.bootId === vm.bootId)
            throw new Error('Guest boot identity did not change')
        }
        const state = op.method === 'vm.remove' ? 'removed' : await this.provider.inspect(vm)
        if (['vm.create', 'vm.start', 'vm.restart'].includes(op.method) && state !== 'running')
          throw new Error('VM did not reach running state')
        if (op.method === 'vm.shutdown' && state !== 'stopped') throw new Error('VM did not reach stopped state')
        this.store.transaction(() => {
          this.store.saveVm({
            ...vm,
            state,
            health: readiness ? 'ready' : 'unknown',
            ...(readiness ? { bootId: readiness.bootId } : {}),
            revision: vm.revision + 1,
            updatedAt: now(),
          })
          this.store.saveOperation({ ...op, status: 'succeeded', updatedAt: now() })
        })
        if (state === 'running') this.attachEgress(this.store.vm(vm.id))
      } catch (error) {
        const state =
          vm.state === 'removed' ? 'removed' : await this.provider.inspect(vm).catch(() => 'unknown' as const)
        this.store.transaction(() => {
          this.store.saveVm({
            ...vm,
            state,
            health: 'unresponsive',
            revision: vm.revision + 1,
            updatedAt: now(),
          })
          this.store.saveOperation({
            ...op,
            status: 'failed',
            updatedAt: now(),
            error: errorInfo(error),
          })
        })
      }
    }
  }
  async close() {
    if (this.closed) return
    this.closed = true
    await this.initialized?.catch(() => {})
    await this.worker
    await this.environments?.close()
    await this.accounts?.peers.close()
    await this.accounts?.authority.close()
    await this.bots?.close().catch(() => {})
    this.egress?.close()
    this.vmConnector?.close()
    this.store?.close()
  }
}
