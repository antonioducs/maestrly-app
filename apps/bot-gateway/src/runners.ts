import { randomBytes } from 'node:crypto'
import {
  FLEET_RUNNER_JOB_FINAL_STATES,
  FLEET_RUNNER_LIMITS,
  fleetRunnerMeets,
  type FleetRunnerAssignedSpec,
  type FleetRunnerCapabilities,
  type FleetRunnerError,
  type FleetRunnerJob,
  type FleetRunnerJobSpec,
  type FleetRunnerJobState,
  type FleetRunnerLink,
  type FleetRunnerLinkView,
  type FleetRunnerStateRequest,
  type FleetRunnerStateResponse,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'
import type { EventHub } from './events.js'
import type { Lifecycle } from './lifecycle.js'
import type { Device, Store, StoredRunnerJob, StoredRunnerLink } from './store.js'

/** What the broker needs of the bots' environments: to tell one where a job of its bot stands. */
export interface RunnerEnvironments {
  /** Posts the job's state to its bot's environment; false when the bot cannot take it now (it is sent again later). */
  notify(job: FleetRunnerJob): Promise<boolean>
}

/** What a gateway's broker reaches its bots' environments through. */
export function lifecycleRunnerEnvironments(lifecycle: Lifecycle): RunnerEnvironments {
  return {
    notify: async (job) => {
      if (!lifecycle.statuses.get(job.botId)?.ready || lifecycle.updatePending(job.botId)) return false
      try {
        await lifecycle.instanceFor(job.botId).runnerJobState(job.jobId, { job })
        return true
      } catch {
        return false
      }
    },
  }
}

/** What a computer last reported while a stream it opened with `runners=1` is open. */
type Presence = { accepting: boolean; capabilities: FleetRunnerCapabilities | null }

const ACTIVE: readonly FleetRunnerJobState[] = ['assigned', 'running', 'finishing']
const isFinal = (state: FleetRunnerJobState) => FLEET_RUNNER_JOB_FINAL_STATES.includes(state)
const mintRunnerId = () => 'rnr_' + randomBytes(16).toString('base64url')
const iso = (ms: number) => new Date(ms).toISOString()
const assigned = ({
  exclude: _exclude,
  queueTimeoutMinutes: _queue,
  ...spec
}: FleetRunnerJobSpec): FleetRunnerAssignedSpec => spec

/**
 * Sends bots' jobs to the computers that run jobs for them.
 *
 * Each computer links a bot on its own and takes jobs only through a stream it opened: nothing ever connects to a
 * computer. A job waits in the queue until a linked runner that meets its requirements has a free slot, goes to that
 * runner's stream alone, and is moved on only by that runner. The gateway keeps which computers run jobs for which
 * bot, what each last reported about itself, and each job's state; a job's command and environment variables only
 * until it ends, and never its files, its log, or the conversation it came from.
 */
export class Runners {
  private readonly presence = new Map<string, Presence>()
  /** Jobs sent to a runner that has not accepted them yet, with when they go back to the queue. */
  private readonly acceptBy = new Map<string, number>()
  /** Runners skipped for one job after they let it go unaccepted, until a time. */
  private readonly skips = new Map<string, Map<string, number>>()
  /** Computers whose runner stream closed while they had jobs, with when those jobs count as lost. */
  private readonly lostAt = new Map<string, number>()
  /** Jobs cancelled while a runner had them, with when they end anyway. */
  private readonly cancelBy = new Map<string, number>()
  /** The delivery of each job's state to its environment in progress, so a job has one at a time. */
  private readonly delivering = new Map<string, Promise<void>>()
  constructor(
    readonly store: Store,
    readonly events: EventHub,
    readonly environments: RunnerEnvironments,
    readonly options: { now?: () => number; tickMs?: number } = {}
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  /** A computer takes jobs while its runner stream is open and its last report accepts them. */
  private online(deviceId: string): boolean {
    return this.events.runnerStreamOpen(deviceId) && (this.presence.get(deviceId)?.accepting ?? false)
  }
  private busy(deviceId: string): number {
    return this.store.runnerJobsOfDevice(deviceId, ACTIVE).length
  }
  private active(botId: string): StoredRunnerLink[] {
    return this.store.runnerLinks(botId).filter((link) => !this.store.deviceRevoked(link.deviceId))
  }
  private link(link: StoredRunnerLink): FleetRunnerLink {
    return {
      runnerId: link.runnerId,
      name: link.name,
      online: this.online(link.deviceId),
      capabilities: this.presence.get(link.deviceId)?.capabilities ?? this.store.runnerDevice(link.deviceId),
      busySlots: this.busy(link.deviceId),
      lastSeenAt: this.store.device(link.deviceId)?.lastSeenAt ?? null,
      linkedAt: link.linkedAt,
    }
  }
  /** The computers that run jobs for a bot, as the bot sees them. */
  links(botId: string): FleetRunnerLink[] {
    return this.active(botId).map((link) => this.link(link))
  }
  /** The same links as one of the owner's computers sees them: its own is `self`. */
  views(botId: string, deviceId: string): FleetRunnerLinkView[] {
    return this.active(botId).map((link) => ({ ...this.link(link), self: link.deviceId === deviceId }))
  }
  /** The asking computer runs jobs for the bot under `name`, or renames its link. */
  linkDevice(botId: string, device: Device, name: string): FleetRunnerLinkView {
    const links = this.store.runnerLinks(botId)
    if (!links.some((link) => link.deviceId === device.id) && links.length >= FLEET_RUNNER_LIMITS.linksPerBotMax)
      throw new GatewayError('CONFLICT', `A bot can have at most ${FLEET_RUNNER_LIMITS.linksPerBotMax} runners.`)
    const saved = this.store.saveRunnerLink(botId, device.id, name, mintRunnerId(), iso(this.now()))
    this.notifyLinks(botId)
    this.schedule()
    return { ...this.link(saved), self: true }
  }
  /** The asking computer stops running jobs for the bot. */
  unlinkDevice(botId: string, deviceId: string) {
    const removed = this.store.deleteRunnerLink(botId, deviceId)
    if (!removed) return
    this.dropLink(removed)
    this.notifyLinks(botId)
  }
  /** Any of the owner's computers removes another computer's link. */
  remove(botId: string, runnerId: string) {
    const link = this.store.runnerLinkById(runnerId)
    if (!link || link.botId !== botId) throw new GatewayError('NOT_FOUND', 'Runner link not found')
    this.unlinkDevice(botId, link.deviceId)
  }
  /** A revoked computer loses every link, and the jobs it had end. */
  revokeDevice(deviceId: string) {
    const removed = this.store.deleteRunnerLinksOfDevice(deviceId)
    this.presence.delete(deviceId)
    this.lostAt.delete(deviceId)
    for (const link of removed) this.dropLink(link)
    for (const botId of new Set(removed.map((link) => link.botId))) this.notifyLinks(botId)
  }
  /** A deleted bot: its links and jobs went with its records; what still waits on them goes too. */
  botPurged(botId: string) {
    for (const timers of [this.acceptBy, this.cancelBy, this.skips])
      for (const jobId of [...timers.keys()]) if (!this.store.runnerJob(jobId)) timers.delete(jobId)
    this.notifyLinks(botId)
  }
  /**
   * What a runner reports on connecting and whenever it changes. Returns the jobs it holds that it must stop; a job the
   * gateway gave it that it no longer holds, once it was running, is lost.
   */
  report(deviceId: string, state: FleetRunnerStateRequest): FleetRunnerStateResponse {
    if (!this.events.runnerStreamOpen(deviceId))
      throw new GatewayError('CONFLICT', 'Open the event stream with runners=1 before reporting runner state')
    this.presence.set(deviceId, { accepting: state.accepting, capabilities: state.capabilities })
    if (state.capabilities) this.store.saveRunnerDevice(deviceId, state.capabilities, iso(this.now()))
    this.lostAt.delete(deviceId)
    const held = new Set(state.jobs)
    const stop: string[] = []
    for (const jobId of held) {
      const job = this.store.runnerJob(jobId)
      if (!job || job.deviceId !== deviceId || isFinal(job.state)) stop.push(jobId)
    }
    // An assigned job may still be on its way to the runner; its accept timeout covers it.
    for (const job of this.store.runnerJobsOfDevice(deviceId, ACTIVE))
      if (!held.has(job.id) && job.state !== 'assigned')
        this.end(job.id, 'lost', {
          code: 'runner_restarted',
          message: `"${this.runnerName(job)}" no longer has this job: it restarted or lost it. Submit it again.`,
        })
    for (const botId of this.botsOf(deviceId)) this.notifyLinks(botId)
    this.schedule()
    return { stop }
  }
  /** A computer opened or closed a runner stream: one that went offline with jobs has the grace period to return. */
  deviceChanged(deviceId: string) {
    if (!this.events.runnerStreamOpen(deviceId)) {
      this.presence.delete(deviceId)
      if (this.busy(deviceId) > 0) this.lostAt.set(deviceId, this.now() + FLEET_RUNNER_LIMITS.lostGraceMs)
    }
    for (const botId of this.botsOf(deviceId)) this.notifyLinks(botId)
  }
  private botsOf(deviceId: string): Set<string> {
    return new Set(this.store.runnerLinksOfDevice(deviceId).map((link) => link.botId))
  }
  private runnerName(job: StoredRunnerJob): string {
    return (job.runnerId && this.store.runnerLinkById(job.runnerId)?.name) || 'The runner'
  }
  /** Tells every computer that reads runner events the links of a bot, each seeing its own as `self`. */
  private notifyLinks(botId: string) {
    const at = iso(this.now())
    this.events.emitToRunnerReaders((deviceId) => ({
      type: 'runner_link.updated',
      at,
      botId,
      links: this.views(botId, deviceId),
    }))
  }
  private view(job: StoredRunnerJob): FleetRunnerJob {
    return {
      jobId: job.id,
      botId: job.botId,
      runnerId: job.runnerId,
      runnerName: job.runnerId ? (this.store.runnerLinkById(job.runnerId)?.name ?? null) : null,
      state: job.state,
      requires: job.requires,
      cancelRequested: job.cancelRequested,
      createdAt: job.createdAt,
      queueDeadline: job.queueDeadline,
      assignedAt: job.assignedAt,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      exitCode: job.exitCode,
      error: job.errorCode ? { code: job.errorCode, message: job.errorMessage ?? '' } : null,
    }
  }
  /** A link went away: the bot's jobs on that runner end, and those queued for that runner alone fail. */
  private dropLink(link: StoredRunnerLink) {
    for (const job of this.store.runnerJobsOfBot(link.botId)) {
      if (isFinal(job.state)) continue
      const message = `"${link.name}" no longer runs jobs for you.`
      if (job.deviceId === link.deviceId) {
        this.events.sendToRunner(link.deviceId, { type: 'runner.cancel', at: iso(this.now()), jobId: job.id })
        this.end(job.id, 'cancelled', { code: 'runner_unlinked', message })
      } else if (job.state === 'queued' && job.requestedRunnerId === link.runnerId)
        this.end(job.id, 'failed', { code: 'runner_unlinked', message })
    }
  }
  private end(
    jobId: string,
    state: FleetRunnerJobState,
    error: FleetRunnerError | null,
    exitCode: number | null = null
  ) {
    this.acceptBy.delete(jobId)
    this.cancelBy.delete(jobId)
    this.skips.delete(jobId)
    this.store.updateRunnerJob(jobId, {
      state,
      endedAt: iso(this.now()),
      exitCode,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
    })
    this.changed(jobId)
  }
  /** Sends each queued job, oldest first, to the matching runner with the most free slots (the oldest link on a tie). */
  schedule() {
    const now = this.now()
    for (const job of this.store.runnerJobsIn(['queued'])) {
      const skipped = this.skips.get(job.id)
      let best: { link: StoredRunnerLink; free: number } | null = null
      for (const link of this.active(job.botId)) {
        if (job.requestedRunnerId && link.runnerId !== job.requestedRunnerId) continue
        if (!this.online(link.deviceId) || (skipped?.get(link.deviceId) ?? 0) > now) continue
        const capabilities = this.presence.get(link.deviceId)?.capabilities
        if (!capabilities || !fleetRunnerMeets(capabilities, job.requires, job.spec?.image)) continue
        const free = capabilities.slots - this.busy(link.deviceId)
        if (free > 0 && (!best || free > best.free)) best = { link, free }
      }
      if (best) this.assign(job, best.link)
    }
  }
  private assign(job: StoredRunnerJob, link: StoredRunnerLink) {
    const now = this.now()
    const acceptBy = now + FLEET_RUNNER_LIMITS.acceptTimeoutMs
    this.store.updateRunnerJob(job.id, {
      state: 'assigned',
      runnerId: link.runnerId,
      deviceId: link.deviceId,
      assignedAt: iso(now),
    })
    this.acceptBy.set(job.id, acceptBy)
    const sent = this.events.sendToRunner(link.deviceId, {
      type: 'runner.job',
      at: iso(now),
      jobId: job.id,
      botId: job.botId,
      runnerId: link.runnerId,
      spec: assigned(job.spec!),
      acceptBy: iso(acceptBy),
    })
    if (!sent) return this.requeue(job.id, link.deviceId)
    this.changed(job.id)
  }
  /** A job its runner did not accept goes back to the queue, and that runner is skipped for it for a while. */
  private requeue(jobId: string, deviceId: string) {
    this.acceptBy.delete(jobId)
    const skips = this.skips.get(jobId) ?? new Map<string, number>()
    skips.set(deviceId, this.now() + FLEET_RUNNER_LIMITS.skipAfterUnacceptedMs)
    this.skips.set(jobId, skips)
    this.store.updateRunnerJob(jobId, { state: 'queued', runnerId: null, deviceId: null, assignedAt: null })
    this.changed(jobId)
  }
  /** Every computer that reads runner events sees the job; its bot's environment is told. */
  private changed(jobId: string) {
    const job = this.store.runnerJob(jobId)
    if (!job) return
    const view = this.view(job)
    const at = iso(this.now())
    this.events.emitToRunnerReaders(() => ({ type: 'runner_job.updated', at, job: view }))
    void this.deliver(jobId)
  }
  /**
   * Sends a job's latest state to its bot's environment until it has it, one delivery per job at a time: a change made
   * meanwhile is sent by the delivery in progress, or by the next retry if that one fails.
   */
  private deliver(jobId: string): Promise<void> {
    const inProgress = this.delivering.get(jobId)
    if (inProgress) return inProgress
    const delivery = this.sendLatest(jobId)
      // The store may close under a delivery that waited on its environment; nothing is left to send then.
      .catch(() => undefined)
      .finally(() => this.delivering.delete(jobId))
    this.delivering.set(jobId, delivery)
    return delivery
  }
  private async sendLatest(jobId: string) {
    for (;;) {
      const job = this.store.runnerJob(jobId)
      if (!job || job.notifiedSeq >= job.seq) return
      if (!(await this.environments.notify(this.view(job)))) return
      this.store.markRunnerJobNotified(jobId, job.seq)
    }
  }
}
