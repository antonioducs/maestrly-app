import { randomUUID } from 'node:crypto'
import { HostRequestError } from './host-client'
import { FixtureBots } from './fixture-bots'
import { FixtureTeams } from './fixture-teams'
import { FixtureRoutines } from './fixture-routines'
import { FixturePrompts } from './fixture-prompts'
import { FixtureExtensions } from './fixture-extensions'
import { FixtureVoice } from './fixture-voice'
import type { Host, Vm, Operation } from '@maestrly/host-protocol'
// Explicit local UI fixture; never hardware evidence and disabled in packaged builds.
const timestamp = '2026-01-01T00:00:00.000Z'
export class FixtureHost {
  connected = false
  readonly prompts = new FixturePrompts()
  readonly extensions = new FixtureExtensions()
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
  readonly bots: FixtureBots
  readonly teams: FixtureTeams
  readonly routines: FixtureRoutines
  readonly voice: FixtureVoice
  constructor(private options: { lostReply?: string; retained?: boolean; slowSetup?: boolean; autoLoginMs?: number; noBots?: boolean; noTeams?: boolean; noRoutines?: boolean; noVoice?: boolean; noChat?: boolean; suggestRoutine?: boolean; readyEnvironment?: boolean; connectedAccount?: boolean } = {}) {
    if (options.readyEnvironment) { this.vms[0].state = 'running'; this.vms[0].health = 'ready'; this.vms[0].desiredState = 'running' }
    if (options.retained) this.vms[0].state = 'removed'
    this.bots = new FixtureBots(
      () => this.hostInfo(),
      () => this.vms,
      (name) => {
        const vm: Vm = { ...this.vms[0], id: `vm-${this.vms.length}`, name, state: 'running', desiredState: 'running', health: 'ready', startupPolicy: 'always', revision: 1, identity: randomUUID() }
        this.vms.push(vm)
        return vm
      },
      { slowSetup: options.slowSetup, autoLoginMs: options.autoLoginMs, readyEnvironment: options.readyEnvironment, connectedAccount: options.connectedAccount }
    )
    this.teams = new FixtureTeams((id) => this.bots.bots.get(id))
    this.routines = new FixtureRoutines('d9a02e5b-0c12-4411-9393-b5106ecff181', (target) =>
      (target.kind === 'bot' ? this.bots.bots.get(target.id)?.name : this.teams.teams.get(target.id)?.name) ?? 'destino'
    )
    // A voice message becomes a real message in the fixture domains, exactly as on a Host.
    this.voice = new FixtureVoice(async (target, text, clientMessageId) => {
      if (target.kind === 'bot') {
        const receipt = (await this.bots.request('bot.messages.send', { botId: target.id, clientMessageId, content: text, attachments: [] })) as { message: { id: string } }
        return { messageId: receipt.message.id, result: { bot: receipt } }
      }
      const receipt = this.teams.request('team.messages.send', { teamId: target.id, clientMessageId, content: text, artifactIds: [] }) as { message: { id: string } }
      return { messageId: receipt.message.id, result: { team: receipt } }
    })
  }
  operations = new Map<string, Operation>()
  private keys = new Map<string, Operation>()
  private removals = new Map<string, boolean>()
  private hostInfo(): Host {
    const active = this.vms.filter((v) => v.state !== 'removed')
    return {
      id: 'd9a02e5b-0c12-4411-9393-b5106ecff181',
      serviceVersion: '0.3.0',
      protocolVersion: 1,
      capabilities: this.options.noBots
        ? ['fixture']
        : [
            'fixture',
            'environments.v1',
            'accounts.v1',
            'bot.runtime.v1',
            'bot.setup',
            'bot.sessions.v1',
            ...(this.options.noTeams ? [] : ['teams.v1']),
            ...(this.options.noRoutines ? [] : ['routines.v1']),
            // Voice is advertised only when transcription is actually available, as on a Host.
            ...(this.options.noVoice ? [] : ['voice.messages.v1']),
            // Rich transcripts: the fixture folds them with the Host's own projection.
            ...(this.options.noChat ? [] : ['chat.experience.v1']),
          ],
      health: 'ready',
      observedMemoryMiB: 4096,
      platform: 'darwin',
      arch: 'arm64',
      supported: true,
      capacity: { cpus: 12, memoryMiB: 32768, diskGiB: 500 },
      allocated: { cpus: active.reduce((s, v) => s + v.cpus, 0), memoryMiB: active.reduce((s, v) => s + v.memoryMiB, 0), diskGiB: this.vms.reduce((s, v) => s + (v.diskRetained ? v.diskGiB : 0), 0) },
      runtimes: [{ id: 'qemu', available: true }],
    }
  }
  /** Fixture media: a real read-only RFB stream for a single-use ticket. */
  async desktopMedia(ticket: string) {
    if (!this.connected) throw new Error('Fixture disconnected')
    return { stream: this.bots.desktop.media(ticket) }
  }
  async request(method: string, p: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) throw new Error('Fixture disconnected')
    if (method.startsWith('bot.') || method.startsWith('account.') || method.startsWith('environment.')) {
      if (this.options.noBots) throw new HostRequestError('Host request failed', 'INVALID_REQUEST')
      return this.bots.request(method, p)
    }
    if (method.startsWith('team.')) {
      if (this.options.noBots || this.options.noTeams) throw new HostRequestError('Host request failed', 'INVALID_REQUEST')
      return this.teams.request(method, p)
    }
    if (method.startsWith('routine.')) {
      if (this.options.noBots || this.options.noRoutines) throw new HostRequestError('Host request failed', 'INVALID_REQUEST')
      // A suggestion the bot left during the conversation, seeded once for interface work.
      if (this.options.suggestRoutine && method === 'routine.proposals.list' && !this.routines.proposals.size) {
        const target = (p.target as { kind: 'bot' | 'team'; id: string } | undefined) ?? undefined
        if (target)
          this.routines.suggest(target, {
            name: 'Resumo de segunda',
            request: 'Prepare o resumo da semana',
            schedule: { kind: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' },
          })
      }
      return this.routines.request(method, p)
    }
    if (method.startsWith('voice.')) {
      if (this.options.noBots || this.options.noVoice) throw new HostRequestError('Host request failed', 'INVALID_REQUEST')
      return this.voice.request(method, p)
    }
    if (method.startsWith('prompt.')) {
      if (this.options.noBots || this.options.noChat) throw new HostRequestError('Host request failed', 'INVALID_REQUEST')
      return this.prompts.request(method, p)
    }
    if (method.startsWith('extension.')) {
      if (this.options.noBots || this.options.noChat) throw new HostRequestError('Host request failed', 'INVALID_REQUEST')
      return this.extensions.request(method, p)
    }
    if (method === 'host.inspect') return this.hostInfo()
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
