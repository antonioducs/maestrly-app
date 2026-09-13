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
} from '@maestrly/host-protocol'
import { QemuProvider, type Provider, type Runtime, type Image } from './provider.js'
import { verifyAsset } from './assets.js'
export interface HostServiceOptions {
  stateDirectory: string
  runtimes: Runtime[]
  images: Image[]
  capacity?: { cpus: number; memoryMiB: number; diskGiB: number }
  /** Injection seam for provider conformance tests; production defaults to QEMU/HVF. */
  provider?: Provider
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
  private readonly provider: Provider
  private readonly options: HostServiceOptions
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
    this.options = structuredClone({
      ...options,
      provider: undefined,
      capacity,
    })
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
    try {
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
    } catch (error) {
      this.store.close()
      throw error
    }
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
  async dispatch(input: unknown): Promise<Response> {
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
        result: await this.handle(parsed.data),
      }
    } catch (error) {
      return { version: 1, id: parsed.data.id, error: errorInfo(error) }
    }
  }
  private async handle(request: Request): Promise<unknown> {
    switch (request.method) {
      case 'host.inspect': {
        const runtimes = await Promise.all(
          this.options.runtimes.map(async (runtime) => ({
            id: runtime.id,
            ...(await this.provider.inspectRuntime(runtime)),
          }))
        )
        const result: Host = {
          id: this.hostId,
          serviceVersion: '0.1.0',
          protocolVersion: 1,
          capabilities: ['vm.create', 'vm.verify', 'vm.remove.retain', 'vm.remove.purge', 'runtime.hvf-smoke'],
          health: runtimes.some((x) => x.available) ? 'ready' : 'unavailable',
          observedMemoryMiB: observedMemoryMiB(),
          platform: process.platform,
          arch: process.arch,
          supported: runtimes.some((x) => x.available),
          capacity: this.options.capacity!,
          allocated: this.allocated(),
          runtimes,
        }
        return result
      }
      case 'image.list':
        return Promise.all(
          this.options.images.map(async (image) => {
            try {
              await verifyAsset(image.asset)
              return {
                id: image.id,
                name: image.name,
                arch: image.arch,
                virtualSizeGiB: image.virtualSizeGiB,
                available: true,
              }
            } catch (error) {
              return {
                id: image.id,
                name: image.name,
                arch: image.arch,
                virtualSizeGiB: image.virtualSizeGiB,
                available: false,
                reason: errorInfo(error).message,
              }
            }
          })
        )
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
        return this.admit(request)
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
        switch (op.method) {
          case 'vm.create':
            await this.provider.provision(vm, this.runtime(vm.runtimeId), this.image(vm.imageId), signal)
            await this.provider.start(vm, this.runtime(vm.runtimeId), signal)
            break
          case 'vm.start':
            await this.provider.start(vm, this.runtime(vm.runtimeId), signal)
            break
          case 'vm.shutdown':
            await this.provider.shutdown(vm, signal)
            break
          case 'vm.restart':
            await this.provider.restart(vm, signal)
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
    this.store?.close()
  }
}
