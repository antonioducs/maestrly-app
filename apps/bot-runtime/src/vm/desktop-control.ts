import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  DESKTOP_LIMITS,
  MEDIA_VIEWERS_PER_BOT,
  mediaOpenSchema,
  vmDesktopCaptureSchema,
  vmDesktopInfoSchema,
  vmDesktopViewerSchema,
  type VmDesktopInfo,
  type VmRequest,
} from '@maestrly/host-protocol'
import type { MediaStream } from '@maestrly/guest-transport'
import { LineRpcClient, servicesInspectSchema, type ServicesInspect } from '../desktop/service-protocol.js'
import type { DesktopHold, SessionRecord, VmCatalog } from './catalog.js'
import { sessionPaths } from './session-profile.js'
import type { UnitState } from './supervisor.js'

type DesktopRequest = Extract<VmRequest, { method: `desktop.${string}` }>
export interface DesktopDriver {
  stopAutomation(record: SessionRecord): Promise<void>
  startAutomation(record: SessionRecord): Promise<void>
  units(record: SessionRecord): Promise<{ desktop: UnitState; services: UnitState; automation: UnitState }>
  desktopGeneration(record: SessionRecord): Promise<string>
}
export interface AdminChannel {
  request(op: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  close(): void
}
const fail = (code: string, message = code) => Object.assign(new Error(message), { code })
const stable = (error: unknown, fallback: string) => {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : fallback
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Grant = { sessionId: string; generation: number; expiresAt: number; stream?: MediaStream }

/**
 * Guest-side authority for desktop handoff. The hold and its epoch are durable in the
 * root catalogue; a person's control lease is a monotonic deadline in memory, so no
 * restart can resurrect a controller. Human input is applied only while mode, epoch,
 * lease, desktop generation and sequence all match.
 */
export class DesktopControl {
  private admins = new Map<string, AdminChannel>()
  private leases = new Map<string, { deadline: number; sequence: number }>()
  private grants = new Map<string, Grant>()
  private running = new Map<string, { print: string; promise: Promise<unknown> }>()
  private busy = new Set<string>()
  private timer: NodeJS.Timeout
  private readonly clock: () => number
  constructor(
    private readonly catalog: VmCatalog,
    private readonly driver: DesktopDriver,
    private readonly options: {
      admin?: (record: SessionRecord) => AdminChannel
      connectRfb?: (record: SessionRecord) => Promise<Duplex>
      now?: () => number
      capabilities?: () => Promise<string[]>
    } = {}
  ) {
    this.clock = options.now ?? (() => performance.now())
    this.timer = setInterval(() => void this.expire(), 250)
    this.timer.unref?.()
  }
  hold(sessionId: string): DesktopHold {
    return this.catalog.desktopHold(sessionId)
  }
  held(sessionId: string) {
    return this.hold(sessionId).mode !== 'bot'
  }
  capabilities() {
    return this.options.capabilities?.() ?? Promise.resolve([])
  }
  private admin(record: SessionRecord): AdminChannel {
    let channel = this.admins.get(record.id)
    if (!channel) {
      channel = this.options.admin?.(record) ?? new LineRpcClient(sessionPaths(record).adminSocket, 30_000)
      this.admins.set(record.id, channel)
    }
    return channel
  }
  private record(sessionId: string, generation?: number) {
    const record = this.catalog.get(sessionId)
    if (!record?.provisioned || (generation !== undefined && record.generation !== generation))
      throw fail('SESSION_GENERATION_CHANGED', 'The desktop session changed')
    return record
  }
  private save(record: SessionRecord, mode: DesktopHold['mode'], epoch: number) {
    return this.catalog.saveDesktopHold(record.id, { mode, epoch })
  }
  async info(record: SessionRecord): Promise<VmDesktopInfo> {
    const hold = this.hold(record.id)
    const units = await this.driver.units(record).catch(() => ({ desktop: 'unknown' as const, services: 'unknown' as const, automation: 'unknown' as const }))
    let inspected: ServicesInspect | undefined
    if (units.services === 'running')
      inspected = await this.admin(record).request('inspect', {}, 5_000).then((value) => servicesInspectSchema.parse(value)).catch(() => undefined)
    return vmDesktopInfoSchema.parse({
      sessionId: record.id,
      mode: hold.mode,
      epoch: hold.epoch,
      ...(inspected ? { desktopGeneration: inspected.desktopGeneration } : {}),
      width: inspected?.width ?? 0,
      height: inspected?.height ?? 0,
      automation: units.automation,
      services: units.services,
      viewers: [...this.grants.values()].filter((grant) => grant.sessionId === record.id).length,
      capabilities: inspected?.capabilities ?? [],
    })
  }
  /** Idempotent by key; an interrupted effect is reported as uncertain, never replayed. */
  private once(key: string, request: DesktopRequest, run: () => Promise<unknown>) {
    const print = fingerprint({ method: request.method, params: request.params })
    const catalogKey = `desktop:${key}`
    const running = this.running.get(catalogKey)
    if (running) {
      if (running.print !== print) throw fail('IDEMPOTENCY_CONFLICT')
      return running.promise
    }
    const previous = this.catalog.operation(catalogKey)
    if (previous) {
      if (previous.fingerprint !== print) throw fail('IDEMPOTENCY_CONFLICT')
      if (previous.status === 'succeeded') return Promise.resolve(JSON.parse(previous.result!))
      throw fail('HANDOFF_UNCERTAIN', 'A previous handoff step was interrupted; inspect before continuing')
    }
    const sessionId = (request.params as { sessionId: string }).sessionId
    if (this.busy.has(sessionId)) throw fail('SESSION_BUSY', 'Another handoff step is running')
    this.busy.add(sessionId)
    this.catalog.begin(catalogKey, print)
    const promise = run()
      .then((result) => {
        this.catalog.finish(catalogKey, result)
        return result
      })
      .finally(() => {
        this.busy.delete(sessionId)
        this.running.delete(catalogKey)
      })
    this.running.set(catalogKey, { print, promise })
    return promise
  }
  async handle(request: DesktopRequest): Promise<unknown> {
    switch (request.method) {
      case 'desktop.inspect':
        return this.info(this.record(request.params.sessionId, request.params.generation))
      case 'desktop.hold': {
        const { sessionId, generation, epoch, idempotencyKey, network } = request.params
        const record = this.record(sessionId, generation)
        return this.once(idempotencyKey, request, async () => {
          if (epoch <= this.hold(sessionId).epoch) throw fail('STALE_DESKTOP', 'A newer control epoch exists')
          // Durable first: from here on nothing restarts automation without a return.
          this.save(record, 'acquiring', epoch)
          this.leases.delete(sessionId)
          const admin = this.admin(record)
          await admin.request('gate', { epoch, allowed: false }, 10_000).catch(() => {})
          await admin.request('network.policy', { network }, 10_000).catch(() => {})
          return this.info(record)
        })
      }
      case 'desktop.acquire': {
        const { sessionId, generation, epoch, idempotencyKey } = request.params
        const record = this.record(sessionId, generation)
        return this.once(idempotencyKey, request, async () => {
          const hold = this.hold(sessionId)
          if (hold.mode !== 'acquiring' || hold.epoch !== epoch) throw fail('STALE_DESKTOP', 'The handoff intent changed')
          try {
            await this.driver.stopAutomation(record)
          } catch (error) {
            throw fail(stable(error, 'HANDOFF_UNCERTAIN') === 'HANDOFF_UNCERTAIN' ? 'HANDOFF_UNCERTAIN' : 'HANDOFF_UNCERTAIN', 'Automation stop was not confirmed')
          }
          const admin = this.admin(record)
          try {
            await admin.request('quiesce', { epoch, timeoutMs: 15_000 }, 20_000)
            await admin.request('human.enable', { epoch }, 15_000)
          } catch {
            throw fail('HANDOFF_UNCERTAIN', 'Graphical work was not drained')
          }
          this.save(record, 'human', epoch)
          this.leases.set(sessionId, { deadline: this.clock() + DESKTOP_LIMITS.controlLeaseMs, sequence: -1 })
          return this.info(record)
        })
      }
      case 'desktop.lease': {
        const { sessionId, generation, epoch, leaseMs } = request.params
        this.record(sessionId, generation)
        const hold = this.hold(sessionId)
        const lease = this.leases.get(sessionId)
        if (hold.mode !== 'human' || hold.epoch !== epoch || !lease || lease.deadline <= this.clock()) throw fail('CONTROL_EXPIRED')
        lease.deadline = this.clock() + leaseMs
        return { renewed: true, leaseMs }
      }
      case 'desktop.pause': {
        const { sessionId, generation, epoch } = request.params
        const record = this.record(sessionId, generation)
        const hold = this.hold(sessionId)
        if (epoch < hold.epoch) throw fail('STALE_DESKTOP')
        if (hold.mode === 'bot') throw fail('STALE_DESKTOP', 'The bot is not held')
        await this.pause(record, epoch)
        return this.info(record)
      }
      case 'desktop.input': {
        const { sessionId, generation, epoch, desktopGeneration, sequence, events } = request.params
        const record = this.record(sessionId, generation)
        const hold = this.hold(sessionId)
        const lease = this.leases.get(sessionId)
        if (hold.mode !== 'human' || hold.epoch !== epoch || !lease) throw fail('CONTROL_EXPIRED')
        if (lease.deadline <= this.clock()) {
          await this.pause(record, hold.epoch)
          throw fail('CONTROL_EXPIRED')
        }
        if ((await this.driver.desktopGeneration(record)) !== desktopGeneration) throw fail('STALE_DESKTOP')
        if (sequence <= lease.sequence) throw fail('INPUT_SEQUENCE_INVALID')
        // Recorded before the effect: the same sequence can never be applied twice.
        lease.sequence = sequence
        const result = (await this.admin(record).request('human.input', { epoch, events }, 10_000)) as { applied: number }
        return { sequence, applied: result.applied }
      }
      case 'desktop.release': {
        const { sessionId, generation, epoch, idempotencyKey } = request.params
        const record = this.record(sessionId, generation)
        return this.once(idempotencyKey, request, async () => {
          const hold = this.hold(sessionId)
          if (epoch <= hold.epoch) throw fail('STALE_DESKTOP')
          if (hold.mode === 'bot') throw fail('STALE_DESKTOP', 'The bot is not held')
          // Input is revoked before anything else; keys and buttons are released.
          this.save(record, 'resuming', epoch)
          this.leases.delete(sessionId)
          await this.admin(record).request('human.disable', { epoch }, 10_000).catch(() => {})
          return this.info(record)
        })
      }
      case 'desktop.capture': {
        const { sessionId, generation, epoch, observationId } = request.params
        const record = this.record(sessionId, generation)
        const hold = this.hold(sessionId)
        if (hold.epoch !== epoch || !['resuming', 'human', 'paused'].includes(hold.mode)) throw fail('STALE_DESKTOP')
        return vmDesktopCaptureSchema.parse(await this.admin(record).request('capture', { observationId }, 30_000))
      }
      case 'desktop.resume': {
        const { sessionId, generation, epoch, idempotencyKey } = request.params
        const record = this.record(sessionId, generation)
        return this.once(idempotencyKey, request, async () => {
          const hold = this.hold(sessionId)
          if (hold.mode !== 'resuming' || hold.epoch !== epoch) throw fail('STALE_DESKTOP')
          const admin = this.admin(record)
          await admin.request('reset', {}, 10_000)
          await admin.request('gate', { epoch, allowed: true }, 10_000)
          try {
            await this.driver.startAutomation(record)
          } catch {
            await admin.request('gate', { epoch, allowed: false }, 10_000).catch(() => {})
            throw fail('HANDOFF_UNCERTAIN', 'Automation did not restart')
          }
          this.save(record, 'bot', epoch)
          return this.info(record)
        })
      }
      case 'desktop.policy': {
        const { sessionId, generation, network } = request.params
        await this.admin(this.record(sessionId, generation)).request('network.policy', { network }, 10_000)
        return { applied: true }
      }
      case 'desktop.viewer.open': {
        const { sessionId, generation, grantId } = request.params
        const record = this.record(sessionId, generation)
        if (this.grants.has(grantId)) throw fail('GRANT_INVALID')
        if ([...this.grants.values()].filter((grant) => grant.sessionId === sessionId).length >= MEDIA_VIEWERS_PER_BOT)
          throw fail('VIEWER_LIMIT', 'Too many viewers for this bot')
        const viewer = vmDesktopViewerSchema.parse(await this.admin(record).request('viewer.open', { grantId }, 15_000))
        this.grants.set(grantId, { sessionId, generation, expiresAt: this.clock() + DESKTOP_LIMITS.ticketMs })
        return viewer
      }
      case 'desktop.viewer.close': {
        const { sessionId, grantId } = request.params
        const grant = this.grants.get(grantId)
        if (grant?.sessionId === sessionId) await this.closeGrant(grantId, grant)
        return { closed: true }
      }
    }
  }
  private async pause(record: SessionRecord, epoch: number) {
    this.save(record, 'paused', epoch)
    this.leases.delete(record.id)
    await this.admin(record).request('human.disable', { epoch }, 10_000).catch(() => {})
  }
  private async closeGrant(grantId: string, grant: Grant) {
    if (this.grants.get(grantId) !== grant) return
    this.grants.delete(grantId)
    grant.stream?.destroy()
    const record = this.catalog.get(grant.sessionId)
    if (record) await this.admin(record).request('viewer.close', { grantId }, 10_000).catch(() => {})
  }
  /** Media lane OPEN: only a fresh, unused grant for the exact session generation. */
  async attach(stream: MediaStream, payload: unknown) {
    const open = mediaOpenSchema.safeParse(payload)
    const grant = open.success ? this.grants.get(open.data.grantId) : undefined
    const record = open.success ? this.catalog.get(open.data.sessionId) : undefined
    if (!open.success || !grant || grant.stream || !record?.provisioned || grant.sessionId !== open.data.sessionId ||
      grant.generation !== open.data.generation || record.generation !== open.data.generation || grant.expiresAt <= this.clock())
      return stream.refuse('GRANT_INVALID')
    grant.stream = stream
    let rfb: Duplex
    try {
      rfb = await (this.options.connectRfb ?? connectRfb)(record)
    } catch {
      grant.stream = undefined
      await this.closeGrant(open.data.grantId, grant)
      return stream.refuse('DESKTOP_UNAVAILABLE')
    }
    if (stream.destroyed || this.grants.get(open.data.grantId) !== grant) {
      rfb.destroy()
      return
    }
    stream.accept()
    rfb.on('error', () => rfb.destroy())
    rfb.pipe(stream).pipe(rfb)
    const finish = () => {
      rfb.destroy()
      stream.destroy()
      void this.closeGrant(open.data.grantId, grant)
    }
    stream.once('close', finish)
    rfb.once('close', finish)
  }
  async expire() {
    const now = this.clock()
    for (const [sessionId, lease] of [...this.leases]) {
      if (lease.deadline > now) continue
      const record = this.catalog.get(sessionId)
      const hold = this.hold(sessionId)
      this.leases.delete(sessionId)
      // A lost controller pauses the bot; it never resumes automatically.
      if (record && hold.mode === 'human') await this.pause(record, hold.epoch).catch(() => {})
    }
    for (const [grantId, grant] of [...this.grants]) if (!grant.stream && grant.expiresAt <= now) await this.closeGrant(grantId, grant)
  }
  /** Pushes the durable hold to (possibly restarted) services; skipped during handoff steps. */
  async synchronize(record: SessionRecord) {
    if (this.busy.has(record.id)) return
    const hold = this.hold(record.id)
    const admin = this.admin(record)
    const state = servicesInspectSchema.parse(await admin.request('inspect', {}, 5_000))
    if (hold.mode === 'bot') {
      if (!state.gate.allowed && !state.human.enabled) await admin.request('gate', { epoch: hold.epoch, allowed: true }, 5_000)
      return
    }
    if (state.gate.allowed) await admin.request('gate', { epoch: hold.epoch, allowed: false }, 5_000)
    if (hold.mode === 'human' && !state.human.enabled) await this.pause(record, hold.epoch)
    else if (hold.mode !== 'human' && state.human.enabled) await admin.request('human.disable', { epoch: hold.epoch }, 5_000)
  }
  /** Supervisor restart: controllers are gone; any active control becomes a pause. */
  recover() {
    for (const record of this.catalog.list()) {
      const hold = this.hold(record.id)
      if (record.provisioned && hold.mode === 'human') this.save(record, 'paused', hold.epoch)
    }
  }
  revokeSession(sessionId: string) {
    for (const [grantId, grant] of [...this.grants]) if (grant.sessionId === sessionId) void this.closeGrant(grantId, grant)
    this.leases.delete(sessionId)
    this.admins.get(sessionId)?.close()
    this.admins.delete(sessionId)
  }
  close() {
    clearInterval(this.timer)
    for (const [grantId, grant] of [...this.grants]) void this.closeGrant(grantId, grant)
    for (const admin of this.admins.values()) admin.close()
    this.admins.clear()
  }
}
function connectRfb(record: SessionRecord): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: sessionPaths(record).rfbSocket })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}
