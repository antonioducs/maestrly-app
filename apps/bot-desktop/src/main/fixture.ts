import { HostRequestError } from './host-client'
import type { Host, Vm, Operation } from '@maestrly/host-protocol'
// Explicit local UI fixture; never hardware evidence and disabled in packaged builds.
const timestamp = '2026-01-01T00:00:00.000Z'
export class FixtureHost {
  connected = false
  vms: Vm[] = [
    {
      id: 'fixture-vm',
      name: 'Build worker',
      state: 'stopped',
      desiredState: 'stopped',
      health: 'unknown',
      startupPolicy: 'manual',
      diskRetained: true,
      revision: 1,
      cpus: 2,
      memoryMiB: 2048,
      diskGiB: 20,
      imageId: 'fixture-linux',
      runtimeId: 'qemu',
      createdAt: timestamp,
      updatedAt: timestamp,
      identity: '6dc3300d-5547-4e38-8caf-89a229f29bd8',
    },
  ]
  constructor(private options: { lostReply?: string; retained?: boolean } = {}) {
    if (options.retained) this.vms[0].state = 'removed'
  }
  operations = new Map<string, Operation>()
  private keys = new Map<string, Operation>()
  private removals = new Map<string, boolean>()
  async request(method: string, p: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) throw new Error('Fixture disconnected')
    if (method === 'host.inspect')
      return {
        id: 'd9a02e5b-0c12-4411-9393-b5106ecff181',
        serviceVersion: '0.1.0',
        protocolVersion: 1,
        capabilities: ['fixture'],
        health: 'ready',
        observedMemoryMiB: 4096,
        platform: 'darwin',
        arch: 'arm64',
        supported: true,
        capacity: { cpus: 12, memoryMiB: 32768, diskGiB: 500 },
        allocated: { cpus: 2, memoryMiB: 2048, diskGiB: 20 },
        runtimes: [{ id: 'qemu', available: true }],
      } satisfies Host
    if (method === 'vm.list')
      return this.vms.filter((v) => v.state !== 'removed' || (p.includeRetained === true && v.diskRetained))
    if (method === 'image.list') return [{ id: 'fixture-linux', name: 'Linux fixture', available: true }]
    if (method === 'vm.inspect') return this.vms.find((vm) => vm.id === p.vmId)
    if (method === 'events.list')
      return Array.from({ length: 105 }, (_, i) => ({
        seq: i + 1,
        kind: 'fixture',
        value: { message: `Fixture event ${i + 1} — no hardware exercised` },
        createdAt: timestamp,
      }))
        .filter((e) => e.seq > Number(p.after))
        .slice(0, Number(p.limit))
    if (method === 'operation.lookup') return this.keys.get(String(p.idempotencyKey)) ?? null
    if (method === 'operation.get') {
      const op = this.operations.get(String(p.operationId))
      if (!op) throw new Error('Operation missing')
      if (op.method === 'vm.remove') {
        const vm = this.vms.find((vm) => vm.id === op.vmId)!
        vm.state = 'removed'
        vm.diskRetained = !this.removals.get(op.id)
        vm.revision++
        op.status = 'succeeded'
        return op
      }
      op.status = 'failed'
      op.error = { code: 'FIXTURE_FAILURE', message: 'Fixture: VM launch failed' }
      return op
    }
    if (method === 'operation.cancel') {
      const op = this.operations.get(String(p.operationId))
      if (op) op.status = 'cancelled'
      return op
    }
    const lostReply = this.options.lostReply
    this.options.lostReply = undefined
    if (lostReply === 'unaccepted') {
      this.connected = false
      throw new Error('Fixture lost request')
    }
    const existing = this.keys.get(String(p.idempotencyKey))
    if (existing) return existing
    if (method !== 'vm.create' && this.vms.find((v) => v.id === p.vmId)?.revision !== p.expectedRevision)
      throw new HostRequestError('REVISION_CONFLICT: VM changed; inspect current state', 'REVISION_CONFLICT')
    if (method === 'vm.create') this.vms.push({ ...this.vms[0], id: 'created-vm', name: String(p.name) })
    const op: Operation = {
      id: `op-${this.operations.size}`,
      vmId: String(p.vmId ?? 'created-vm'),
      method,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.operations.set(op.id, op)
    this.keys.set(String(p.idempotencyKey), op)
    if (method === 'vm.remove') this.removals.set(op.id, p.deleteData === true)
    if (lostReply === 'accepted') {
      this.connected = false
      throw new Error('Fixture lost reply')
    }
    return op
  }
}
