import { HostRequestError } from './host-client'
import { mkdir, readFile, open, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { operationSchema, type Host, type Operation } from '@maestrly/host-protocol'
import { validateCall } from './validation'
import type { Call } from '../shared/types'
type Entry = { aliases?: string[]; alias: string; hostId: string; call: Call; operation?: Operation }
const terminal = (op: Operation) => !['queued', 'running'].includes(op.status)
export class HostConnections {
  private entries: Entry[] = []
  private alias = ''
  private hostId = ''
  private generation = 0
  private ready = false
  private working = false
  private retryable = new Set<Entry>()
  private issue: string | undefined
  constructor(
    private file: string,
    private request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  ) {}
  private writes: Promise<void> = Promise.resolve()
  private save() {
    const snapshot = JSON.stringify(this.entries)
    const write = this.writes.then(() => this.write(snapshot))
    this.writes = write.catch(() => {})
    return write
  }
  private async write(snapshot: string) {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    const handle = await open(temp, 'w', 0o600)
    try {
      await handle.writeFile(snapshot)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, this.file)
  }
  status() {
    const removals = new Map<string, boolean>()
    for (const entry of this.entries) {
      if (entry.hostId === this.hostId && entry.call.method === 'vm.remove' && entry.operation?.status === 'succeeded')
        removals.set(entry.operation.vmId, entry.call.params.deleteData !== true)
    }
    return {
      retainedVmIds: [...removals].filter(([, retained]) => retained).map(([id]) => id),
      hostId: this.hostId,
      recoveryIssue: this.issue,
      retryableKeys: this.ready ? [...this.retryable].map((e) => String(e.call.params.idempotencyKey)) : [],
      lastOperation: this.entries.filter((e) => e.hostId === this.hostId && e.operation).at(-1)?.operation,
      pending: this.entries
        .filter((e) => e.hostId === this.hostId && e.operation && !terminal(e.operation))
        .map((e) => e.operation!),
    }
  }
  disconnect() {
    this.generation++
    this.ready = false
  }
  async connect(alias: string, host: Host) {
    this.generation++
    this.ready = false
    this.retryable.clear()
    this.alias = alias
    this.hostId = host.id
    this.issue = undefined
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (!Array.isArray(data)) throw new Error('Invalid journal')
      this.entries = data.map((e) => {
        if (typeof e.alias !== 'string' || typeof e.hostId !== 'string') throw new Error('Invalid journal entry')
        if (
          e.aliases !== undefined &&
          (!Array.isArray(e.aliases) || e.aliases.some((a: unknown) => typeof a !== 'string'))
        )
          throw new Error('Invalid journal aliases')
        return {
          aliases: e.aliases ?? [e.alias],
          alias: e.alias,
          hostId: e.hostId,
          call: validateCall(e.call),
          ...(e.operation ? { operation: operationSchema.parse(e.operation) } : {}),
        }
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.issue = 'Mutation journal unavailable. Inspect host operations before making changes.'
        return
      }
      this.entries = []
    }
    for (const entry of this.entries.filter(
      (e) => e.alias === alias || e.aliases?.includes(alias) || e.hostId === host.id
    )) {
      if (entry.operation && terminal(entry.operation)) continue
      if (entry.hostId !== host.id) {
        this.issue =
          'Host identity changed with an unresolved request. Restore the original host and inspect its operations.'
        continue
      }
      entry.aliases = [...new Set([...(entry.aliases ?? [entry.alias]), alias])]
      if (!entry.operation) {
        try {
          const found = await this.request('operation.lookup', { idempotencyKey: entry.call.params.idempotencyKey })
          if (found !== null) entry.operation = operationSchema.parse(found)
          else {
            await this.request('vm.list', { includeRetained: true })
            this.retryable.add(entry)
            this.issue = `Request outcome unknown (${entry.call.method}, key ${entry.call.params.idempotencyKey}). Inspect current state, then retry the same request explicitly.`
            continue
          }
        } catch {
          this.issue = `Request outcome unknown for key ${entry.call.params.idempotencyKey}. Reconnect to look up the request before retrying.`
          continue
        }
      }
      try {
        entry.operation = operationSchema.parse(
          await this.request('operation.get', { operationId: entry.operation.id })
        )
      } catch {
        this.issue = `Could not recover operation ${entry.operation.id}. Reconnect to inspect before making changes.`
      }
    }
    if (
      this.entries.some(
        (e) =>
          (e.alias === alias || e.aliases?.includes(alias)) &&
          e.hostId !== host.id &&
          (!e.operation || !terminal(e.operation))
      )
    )
      this.retryable.clear()
    await this.save()
    this.ready = true
  }
  async retry(idempotencyKey: string): Promise<Operation> {
    const entry = [...this.retryable].find(
      (e) => e.hostId === this.hostId && e.call.params.idempotencyKey === idempotencyKey
    )
    if (!this.ready || this.working || !entry) throw new Error('Reconnect and look up this request before retrying.')
    const generation = this.generation
    const assertConnection = () => {
      if (!this.ready || generation !== this.generation)
        throw new Error('Connection changed. Reconnect before retrying.')
    }
    this.working = true
    this.retryable.delete(entry)
    try {
      const host = (await this.request('host.inspect', {})) as Host
      assertConnection()
      if (host.id !== entry.hostId) {
        this.ready = false
        this.issue = 'Host identity changed. Restore the original host before retrying.'
        throw new Error(this.issue)
      }
      const found = await this.request('operation.lookup', { idempotencyKey })
      assertConnection()
      if (found !== null) entry.operation = operationSchema.parse(found)
      else {
        await this.request('vm.list', { includeRetained: true })
        assertConnection()
        if (entry.call.method !== 'vm.create') await this.request('vm.inspect', { vmId: entry.call.params.vmId })
        assertConnection()
        try {
          entry.operation = operationSchema.parse(await this.request(entry.call.method, entry.call.params))
        } catch (error) {
          if (error instanceof HostRequestError && error.code === 'REVISION_CONFLICT') {
            this.entries = this.entries.filter((e) => e !== entry)
            this.issue = undefined
            await this.save()
            throw new HostRequestError(
              'REVISION_CONFLICT: The retry was not applied because the VM changed. Inspect current state and resolve the request.',
              error.code
            )
          }
          throw error
        }
      }
      await this.save()
      this.issue = undefined
      return entry.operation
    } finally {
      this.working = false
    }
  }
  async call(call: Call): Promise<unknown> {
    call = validateCall(call)
    const mutation = ['vm.create', 'vm.start', 'vm.shutdown', 'vm.restart', 'vm.remove', 'operation.cancel'].includes(
      call.method
    )
    if (!mutation) {
      const result = await this.request(call.method, call.params)
      if (call.method === 'operation.get') {
        const op = operationSchema.parse(result)
        const entry = this.entries.find((e) => e.hostId === this.hostId && e.operation?.id === op.id)
        if (entry) {
          entry.operation = op
          await this.save()
        }
      }
      return result
    }
    if (!this.ready || this.issue || this.working)
      throw new Error(this.issue ?? 'Reconnect and recover pending requests before making changes.')
    const pending = this.status().pending
    if (
      call.method !== 'operation.cancel' &&
      pending.some((op) => call.method === 'vm.create' || op.vmId === call.params.vmId)
    )
      throw new Error('This VM already has an accepted operation. Wait for its outcome.')
    this.working = true
    try {
      // Cancellation targets a known operation; an uncertain cancellation is recovered by inspecting that operation.
      if (call.method === 'operation.cancel') {
        const op = operationSchema.parse(await this.request(call.method, call.params))
        const entry = this.entries.find((e) => e.hostId === this.hostId && e.operation?.id === op.id)
        if (entry) {
          entry.operation = op
          await this.save()
        }
        return op
      }
      const entry: Entry = { alias: this.alias, hostId: this.hostId, call }
      this.entries.push(entry)
      await this.save() // Durable key and exact request precede any wire write.
      try {
        entry.operation = operationSchema.parse(await this.request(call.method, call.params))
        await this.save()
        return entry.operation
      } catch (error) {
        if (error instanceof HostRequestError) {
          this.entries = this.entries.filter((e) => e !== entry)
          await this.save()
          throw error
        }
        this.issue = `Request outcome unknown. Reconnect and inspect host operations for key ${call.params.idempotencyKey}. Fresh mutations are blocked.`
        throw new Error(`${this.issue} ${error instanceof Error ? error.message : ''}`)
      }
    } finally {
      this.working = false
    }
  }
}
