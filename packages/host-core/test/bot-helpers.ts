import type { AccountProviderFactory } from '../src/accounts/provider.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import type { GuestEvent, HostToGuestRequest, Vm, BotSession, SessionCapacity } from '@maestrly/host-protocol'
import { HostService } from '../src/index.js'
import type { Provider, Runtime } from '../src/provider.js'
import type { GuestConnector, GuestSession, GuestRequestParams } from '../src/guest/session.js'
import type { BotTemplate } from '../src/bots/recommendations.js'

export const runtime: Runtime = {
  id: 'qemu',
  arch: 'arm64',
  qemu: { path: '/missing/qemu', sha256: 'a'.repeat(64) },
  qemuImg: { path: '/missing/img', sha256: 'b'.repeat(64) },
}
export class FakeProvider implements Provider {
  states = new Map<string, 'running' | 'stopped' | 'unknown'>()
  calls: string[] = []
  profiles = new Map<string, unknown>()
  backups: string[] = []
  prepared: string[] = []
  async inspectRuntime() {
    return { available: true }
  }
  async inspect(vm: Vm) {
    return this.states.get(vm.id) ?? ('stopped' as const)
  }
  async provision(vm: Vm) {
    this.calls.push('provision')
    this.states.set(vm.id, 'stopped')
  }
  async start(vm: Vm, _runtime: Runtime, _signal: AbortSignal, profile?: unknown) {
    this.calls.push('start')
    this.profiles.set(vm.id, profile)
    this.states.set(vm.id, 'running')
  }
  async shutdown(vm: Vm) {
    this.calls.push('shutdown')
    this.states.set(vm.id, 'stopped')
  }
  async restart(vm: Vm) {
    this.calls.push('restart')
    this.states.set(vm.id, 'running')
  }
  async waitReady() {
    return { ready: true, markerMatches: true, networkIsolated: true, bootId: randomUUID() }
  }
  async verify() {
    return this.waitReady()
  }
  async remove(vm: Vm) {
    this.calls.push('remove')
    this.states.delete(vm.id)
  }
  botChannels(vm: Vm) {
    return { control: `/tmp/${vm.id}-control.sock`, egress: `/tmp/${vm.id}-egress.sock` }
  }
  async backupDisk(vm: Vm) {
    this.backups.push(vm.id)
    return 'disk-backup.qcow2'
  }
  async prepareGuestRuntime(vm: Vm, bundle: { version: string }) {
    this.prepared.push(vm.id)
    return { version: bundle.version, digest: 'c'.repeat(64) }
  }
}
type Handler = (method: HostToGuestRequest['method'], params: any, guest: FakeGuest) => unknown | Promise<unknown>
/** In-memory guest runtime with a journal of accepted turns; mimics apps/bot-runtime semantics for tests. */
export class FakeGuest implements GuestSession {
  sessionId = randomUUID()
  bootId = randomUUID()
  generation = 1
  runtimeVersion = '0.1.0-test'
  capabilities = ['account.delegation.v1', 'provider.codex', 'tools.files', 'network.blocklist.v1']
  alive = true
  requests: { method: string; params: any }[] = []
  turns = new Map<string, { status: string; snapshot: any }>()
  interactions = new Map<string, (decision: string, answer?: string) => void>()
  private accountHandler?: (forceRefresh: boolean) => Promise<import('@maestrly/host-protocol').DelegatedCredential>
  setAccountHandler(handler: (forceRefresh: boolean) => Promise<import('@maestrly/host-protocol').DelegatedCredential>) { this.accountHandler = handler }
  refreshAccount() { if (!this.accountHandler) throw new Error('No shared account'); return this.accountHandler(true) }
  private collaborationHandler?: (request: import('@maestrly/host-protocol').CollaborationRequest) => Promise<Record<string, unknown>>
  setCollaborationHandler(handler: (request: import('@maestrly/host-protocol').CollaborationRequest) => Promise<Record<string, unknown>>) { this.collaborationHandler = handler }
  /** Calls a collaboration tool the way the packaged runtime does: over this session only. */
  collaborate(turnId: string, method: string, params: Record<string, unknown> = {}, generation = 1, requestId = randomUUID()) {
    if (!this.collaborationHandler) throw new Error('Collaboration unavailable on this session')
    return this.collaborationHandler({ type: 'collaboration.request', id: requestId, turnId, generation, method: method as never, params })
  }
  private listeners = new Set<(event: GuestEvent, ack: () => void) => void>()
  private closeListeners = new Set<(error: Error) => void>()
  private queue: { event: GuestEvent; acked: boolean }[] = []
  acked: string[] = []
  auth: any = { state: 'disconnected', provider: 'codex' }
  files = new Map<string, Buffer>()
  handler?: Handler
  constructor(readonly vmId: string) {}
  async request<M extends HostToGuestRequest['method']>(method: M, params: GuestRequestParams<M>): Promise<unknown> {
    if (!this.alive) throw new Error('closed')
    this.requests.push({ method, params })
    if (this.handler) {
      const custom = await this.handler(method, params, this)
      if (custom !== undefined) return custom
    }
    switch (method) {
      case 'runtime.inspect':
        return { state: 'ready' }
      case 'models.list':
        return [
          { id: 'fixture-small', displayName: 'Fixture small', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', recommended: true },
          { id: 'fixture-large', displayName: 'Fixture large', efforts: ['medium'], recommended: false },
        ]
      case 'auth.prepareDelegation': return { prepared: true }
      case 'auth.delegate':
        this.auth = { state: 'connected', provider: 'codex', method: (params as any).credential.type === 'apiKey' ? 'apiKey' : 'device' }
        return this.auth
      case 'auth.exportLegacy': {
        const credential = { OPENAI_API_KEY: 'fixture-legacy-secret' }
        return { credential, digest: createHash('sha256').update(JSON.stringify(credential)).digest('hex') }
      }
      case 'auth.commitMigration':
        return { committed: true }
      case 'auth.status':
        return this.auth
      case 'auth.start':
        this.auth = (params as any).method === 'apiKey' ? { state: 'connected', provider: 'codex', method: 'apiKey' } : { state: 'connecting', provider: 'codex', pending: { loginId: 'l1', verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-1234', expiresAt: new Date(Date.now() + 600_000).toISOString() } }
        return this.auth
      case 'auth.secret':
        return { stored: true }
      case 'auth.cancel':
      case 'auth.logout':
        this.auth = { state: 'disconnected', provider: 'codex' }
        return {}
      case 'turn.start': {
        const p = params as any
        if (this.turns.has(p.turnId)) return { accepted: true, duplicate: true }
        this.turns.set(p.turnId, { status: 'running', snapshot: p })
        return { accepted: true }
      }
      case 'turn.reconcile': {
        const turn = this.turns.get((params as any).turnId)
        return turn ? { known: true, status: turn.status } : { known: false }
      }
      case 'turn.cancel': {
        const p = params as any
        const turn = this.turns.get(p.turnId)
        if (turn) {
          turn.status = 'cancelled'
          this.emit({ turnId: p.turnId, generation: p.generation, kind: 'turn.status', summary: 'cancelled', detail: { status: 'cancelled' } })
        }
        return { cancelled: !!turn }
      }
      case 'turn.lease':
        return { renewed: true }
      case 'interaction.resolve': {
        const p = params as any
        const resolver = this.interactions.get(p.actionId)
        resolver?.(p.decision, p.answer)
        return { applied: !!resolver }
      }
      case 'policy.update':
        return { applied: true }
      case 'files.list':
        return [...this.files.entries()].map(([path, data]) => ({ path, name: path.split('/').pop(), kind: 'file', size: data.length, digest: sha(data), modifiedAt: new Date().toISOString() }))
      case 'files.stat': {
        const data = this.files.get((params as any).path)
        if (!data) throw new Error('NOT_FOUND')
        return { kind: 'file', size: data.length, digest: sha(data) }
      }
      case 'files.read': {
        const p = params as any
        const data = this.files.get(p.path)
        if (!data) throw new Error('NOT_FOUND')
        return { dataBase64: data.subarray(p.offset, p.offset + p.length).toString('base64'), digest: sha(data) }
      }
      case 'files.write': {
        const p = params as any
        const existing = this.files.get(`${p.path}.part`) ?? Buffer.alloc(0)
        const next = Buffer.concat([existing, Buffer.from(p.dataBase64, 'base64')])
        if (p.final) {
          this.files.delete(`${p.path}.part`)
          this.files.set(p.path, next)
        } else this.files.set(`${p.path}.part`, next)
        return { written: next.length }
      }
      case 'files.abort':
        return {}
    }
    throw new Error(`unhandled ${method}`)
  }
  emit(event: Omit<GuestEvent, 'type' | 'runtimeEventId' | 'createdAt'> & { runtimeEventId?: string }) {
    const full: GuestEvent = { type: 'event', runtimeEventId: event.runtimeEventId ?? randomUUID(), createdAt: new Date().toISOString(), ...event }
    this.queue.push({ event: full, acked: false })
    this.deliver()
  }
  private deliver() {
    const item = this.queue.find((x) => !x.acked)
    if (!item || !this.listeners.size) return
    const ack = () => {
      if (item.acked) return
      item.acked = true
      this.acked.push(item.event.runtimeEventId)
      this.deliver()
    }
    for (const listener of this.listeners) listener(item.event, ack)
  }
  onEvent(listener: (event: GuestEvent, ack: () => void) => void) {
    this.listeners.add(listener)
    this.deliver()
    return () => this.listeners.delete(listener)
  }
  onClose(listener: (error: Error) => void) {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }
  /** Simulate the channel dropping (runtime keeps its journal). */
  drop() {
    if (!this.alive) return
    this.alive = false
    for (const listener of this.closeListeners) listener(new Error('dropped'))
    this.closeListeners.clear()
    this.listeners.clear()
  }
  close() {
    this.drop()
  }
  finish(turnId: string, status = 'succeeded', content = 'done') {
    const turn = this.turns.get(turnId)
    if (turn) turn.status = status
    const generation = turn?.snapshot.generation ?? 1
    if (status === 'succeeded') this.emit({ turnId, generation, kind: 'assistant.message', summary: 'reply', detail: { content } })
    this.emit({ turnId, generation, kind: 'turn.status', summary: status, detail: { status, providerThreadId: 'thread-1' } })
  }
}
export class FakeConnector implements GuestConnector {
  guests = new Map<string, FakeGuest>()
  managed = false
  created: string[] = []
  stopped: string[] = []
  capacity: SessionCapacity = { profileId: 'fixture', evidenceSha256: 'a'.repeat(64), systemMemoryMiB: 384, systemDiskMiB: 1024, maxSessions: 8, perSession: { cpuQuotaPercent: 100, memoryMiB: 640, tasksMax: 128, diskMiB: 1024 } }
  async inspectVm() { return this.managed ? { capabilities: ['account.delegation.v1'], capacity: this.capacity } : {} }
  async createSession(session: BotSession) {
    if (!this.created.includes(session.id)) this.created.push(session.id)
    if (session.transport === 'legacy' && this.guests.has(session.vmId)) this.guests.set(session.id, this.guests.get(session.vmId)!)
    return { id: session.id, botId: session.botId, generation: 1 }
  }
  async stopSession(session: BotSession) { this.stopped.push(session.id); this.guests.get(session.id)?.close() }
  connections = 0
  fail = false
  handler?: Handler
  async connect(input: { vmId: string; sessionId: string; transport: string }): Promise<GuestSession> {
    const vmId = input.vmId
    const key = input.transport === 'legacy' ? vmId : input.sessionId
    this.connections++
    if (this.fail) throw new Error('RUNTIME_UNREACHABLE')
    const previous = this.guests.get(key)
    const guest = new FakeGuest(vmId)
    guest.handler = (method, params, target) => this.handler?.(method, params, target)
    if (previous) {
      guest.turns = previous.turns
      guest.files = previous.files
      guest.auth = previous.auth
      guest.generation = previous.generation + 1
      guest.interactions = previous.interactions
    }
    this.guests.set(key, guest)
    return guest
  }
  guest(vmId: string, sessionId?: string) {
    const guest = this.guests.get(sessionId ?? vmId) ?? [...this.guests.values()].find(g => g.vmId === vmId)
    if (!guest) throw new Error('no guest')
    return guest
  }
}
export const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
export async function directory() {
  return realpath(await mkdtemp('/tmp/mb-'))
}
export const template: BotTemplate = {
  id: 'bot-ready',
  imageId: 'image',
  runtimeId: 'qemu',
  arch: 'arm64',
  runtimeIncluded: true,
  runtimeBundle: { path: '/missing/bundle.tar', sha256: 'd'.repeat(64), version: '0.1.0' },
  minimum: { cpus: 2, memoryMiB: 2048, diskGiB: 12 },
  recommended: { cpus: 2, memoryMiB: 4096, diskGiB: 24 },
  capabilities: ['account.delegation.v1', 'provider.codex'],
}
export async function setup(options: { capacity?: { cpus: number; memoryMiB: number; diskGiB: number }; dir?: string; templates?: BotTemplate[]; connector?: FakeConnector; provider?: FakeProvider; accountProvider?: AccountProviderFactory; imageVirtualSizeGiB?: number } = {}) {
  const dir = options.dir ?? (await directory())
  const asset = `${dir}/image`
  await writeFile(asset, 'image')
  const provider = options.provider ?? new FakeProvider()
  const connector = options.connector ?? new FakeConnector()
  const serviceOptions = {
    stateDirectory: dir,
    accountProvider: options.accountProvider,
    runtimes: [runtime],
    // Virtual size is an injection seam: suites that only exercise Host logic use a small
    // image so they do not depend on the controller having tens of free GiB.
    images: [{ id: 'image', name: 'Bot image', arch: 'arm64' as const, asset: { path: asset, sha256: sha(Buffer.from('image')) }, format: 'raw' as const, virtualSizeGiB: options.imageVirtualSizeGiB ?? 12, guestAgent: true as const }],
    capacity: options.capacity ?? { cpus: 4, memoryMiB: 8192, diskGiB: 40 },
    provider,
    connector,
    templates: options.templates ?? [template],
  }
  const service = new HostService(serviceOptions)
  const call = async (method: string, params: unknown = {}) => {
    const response = await service.dispatch({ version: 1, id: randomUUID(), method, params })
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code })
    return response.result as any
  }
  return { service, provider, connector, dir, call, serviceOptions }
}
export async function until<T>(fn: () => Promise<T> | T, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${JSON.stringify(value).slice(0, 300)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
/** Runs the guided setup through account connection and returns the ready bot. */
export async function readyBot(ctx: Awaited<ReturnType<typeof setup>>, name = 'Assistente') {
  const preview = await ctx.call('bot.setup.preview', {})
  const op = await ctx.call('bot.setup.start', { idempotencyKey: `setup-${name}`, previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name, purpose: 'Ajudar com relatórios', confirmations: { destination: true, permissions: true } })
  const waiting = await until(() => ctx.call('bot.setup.inspect', { operationId: op.id }), (o: any) => ['waiting_user', 'failed'].includes(o.status))
  if (waiting.status !== 'waiting_user') throw new Error(`setup failed: ${JSON.stringify(waiting)}`)
  const bot = (await ctx.call('bot.list')).find((b: any) => b.id === op.botId)
  await ctx.call('bot.auth.start', { botId: bot.id, method: 'device' })
  ctx.connector.guest(bot.vmId, (await ctx.call('bot.session.inspect', { botId: bot.id }))?.id).auth = { state: 'connected', provider: 'codex', method: 'device', account: { email: 'a@b.c', plan: 'plus' } }
  await ctx.call('bot.auth.status', { botId: bot.id })
  return until(() => ctx.call('bot.inspect', { botId: bot.id }), (b: any) => b.status === 'ready')
}
