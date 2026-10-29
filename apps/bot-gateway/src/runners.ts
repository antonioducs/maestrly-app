import { randomBytes } from 'node:crypto'
import {
  FLEET_RUNNER_JOB_FINAL_STATES,
  FLEET_RUNNER_LIMITS,
  fleetRunnerMeets,
  type FleetInternalRunnerJobRequest,
  type FleetRunnerAssignedSpec,
  type FleetRunnerCapabilities,
  type FleetRunnerError,
  type FleetRunnerJob,
  type FleetRunnerJobFinishRequest,
  type FleetRunnerJobLogPage,
  type FleetRunnerJobSpec,
  type FleetRunnerJobState,
  type FleetRunnerJobUsage,
  type FleetRunnerJobUsageRequest,
  type FleetRunnerLink,
  type FleetRunnerLinkView,
  type FleetRunnerStateRequest,
  type FleetRunnerStateResponse,
  type FleetRunnerSubmitResult,
  type FleetRunnerTransferRouteKey,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'
import type { EventHub } from './events.js'
import type { Lifecycle } from './lifecycle.js'
import { runnerJobsEnvironment } from './runner-transfers.js'
import type { Device, Store, StoredRunnerJob, StoredRunnerLink } from './store.js'

/** Which piece of a job's log is wanted: from `offset` on, or the end of the log without it; at most `limit` bytes. */
export type RunnerLogQuery = { offset?: number; limit?: number }

/** What the broker needs of the bots' environments: to tell one where a job of its bot stands, and to read its log. */
export interface RunnerEnvironments {
  /** Posts the job's state to its bot's environment; false when the bot cannot take it now (it is sent again later). */
  notify(job: FleetRunnerJob): Promise<boolean>
  /** A piece of a job's log as the bot's environment holds it; null when the bot cannot serve it now. */
  readLog(botId: string, jobId: string, query: RunnerLogQuery): Promise<FleetRunnerJobLogPage | null>
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
    readLog: async (botId, jobId, query) =>
      runnerJobsEnvironment(lifecycle, botId) ? lifecycle.instanceFor(botId).runnerJobLog(jobId, query) : null,
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
const refused = (code: FleetRunnerError['code'], message: string): FleetRunnerSubmitResult => ({
  ok: false,
  error: { code, message },
})
const summary = (capabilities: FleetRunnerCapabilities) =>
  `${capabilities.os} ${capabilities.arch}, ${capabilities.executor}, ` +
  (capabilities.gpu ? capabilities.gpu.name : 'no GPU')
/** The states in which a runner may move each kind of a job's files. */
const TRANSFER_STATES: Record<FleetRunnerTransferRouteKey, readonly FleetRunnerJobState[]> = {
  runnerJobManifest: ['running'],
  runnerJobBlobs: ['running'],
  runnerJobLog: ['running', 'finishing'],
  runnerJobOutputs: ['running', 'finishing'],
  runnerJobOutputChunk: ['running', 'finishing'],
  runnerJobOutputCommit: ['running', 'finishing'],
}

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
  /** What each running job last used, as its runner sampled it. In memory only: it goes with the job and a restart. */
  private readonly usages = new Map<string, FleetRunnerJobUsage>()
  private timer: NodeJS.Timeout | null = null
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
    for (const job of this.store.runnerJobsOfDevice(deviceId, ACTIVE)) this.usages.delete(job.id)
    for (const link of removed) this.dropLink(link)
    for (const botId of new Set(removed.map((link) => link.botId))) this.notifyLinks(botId)
  }
  /** A deleted bot: its links and jobs went with its records; what still waits on them goes too. */
  botPurged(botId: string) {
    for (const timers of [this.acceptBy, this.cancelBy, this.skips, this.usages])
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
    const usage = isFinal(job.state) ? undefined : this.usages.get(job.id)
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
      ...(usage ? { usage } : {}),
    }
  }
  private ahead(job: StoredRunnerJob): number {
    if (job.state !== 'queued') return 0
    return this.store
      .runnerJobsIn(['queued'])
      .filter((other) => other.createdAt < job.createdAt || (other.createdAt === job.createdAt && other.id < job.id))
      .length
  }
  /** Queues a bot's job, or says at once why no runner can ever take it. A repeated id returns the same job. */
  submit(botId: string, request: FleetInternalRunnerJobRequest): FleetRunnerSubmitResult {
    const existing = this.store.runnerJob(request.jobId)
    if (existing) {
      if (existing.botId !== botId) throw new GatewayError('CONFLICT', 'This job id is taken')
      return { ok: true, job: this.view(existing), queuedAhead: this.ahead(existing) }
    }
    const links = this.active(botId).filter((link) => !request.runnerId || link.runnerId === request.runnerId)
    if (!links.length)
      return refused(
        'runner_not_linked',
        request.runnerId
          ? 'No runner with this runnerId runs jobs for you. Call runner_list for the ones that do.'
          : 'No computer runs jobs for you yet. Tell your owner to turn on Run jobs for bots on a computer and give ' +
              'you access there.'
      )
    const known = links.map((link) => ({ link, capabilities: this.store.runnerDevice(link.deviceId) }))
    // A runner that never reported may meet the job: only runners that all reported can refuse it now.
    if (
      known.every((item) => item.capabilities !== null) &&
      !known.some((item) => fleetRunnerMeets(item.capabilities!, request.requires, request.spec.image))
    )
      return refused(
        'runner_unmatched',
        'None of your runners can run this job: ' +
          known.map((item) => `"${item.link.name}" is ${summary(item.capabilities!)}`).join('; ') +
          '.'
      )
    if (
      this.store.runnerJobsOfBot(botId).filter((job) => !isFinal(job.state)).length >=
      FLEET_RUNNER_LIMITS.activeJobsPerBotMax
    )
      return refused(
        'runner_busy',
        `You already have ${FLEET_RUNNER_LIMITS.activeJobsPerBotMax} jobs queued or running. Wait for some to end.`
      )
    const now = this.now()
    this.store.insertRunnerJob({
      id: request.jobId,
      botId,
      requestedRunnerId: request.runnerId ?? null,
      runnerId: null,
      deviceId: null,
      state: 'queued',
      spec: request.spec,
      requires: request.requires,
      createdAt: iso(now),
      queueDeadline: iso(now + request.spec.queueTimeoutMinutes * 60_000),
      assignedAt: null,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      errorCode: null,
      errorMessage: null,
      cancelRequested: false,
    })
    this.changed(request.jobId)
    this.schedule()
    const job = this.store.runnerJob(request.jobId)!
    return { ok: true, job: this.view(job), queuedAhead: this.ahead(job) }
  }
  /** One of a bot's jobs; another bot's is not found. */
  job(botId: string, jobId: string): FleetRunnerJob {
    const job = this.store.runnerJob(jobId)
    if (!job || job.botId !== botId) throw new GatewayError('NOT_FOUND', 'Runner job not found')
    return this.view(job)
  }
  /** A bot's latest jobs, newest first. */
  jobs(botId: string): FleetRunnerJob[] {
    return this.store
      .runnerJobsOfBot(botId)
      .slice(0, FLEET_RUNNER_LIMITS.jobsListMax)
      .map((job) => this.view(job))
  }
  /** The job a runner names, only if it was assigned to that runner. */
  private owned(jobId: string, deviceId: string): StoredRunnerJob {
    const job = this.store.runnerJob(jobId)
    if (!job) throw new GatewayError('NOT_FOUND', 'Runner job not found')
    if (job.deviceId !== deviceId) throw new GatewayError('FORBIDDEN', 'This job was assigned to another computer')
    return job
  }
  /**
   * What the job uses now, as its runner sampled it, stamped here and kept until the next one or the job's end. Nothing
   * is stored or sent: whoever reads the job sees it.
   */
  usage(jobId: string, deviceId: string, sample: FleetRunnerJobUsageRequest) {
    const job = this.owned(jobId, deviceId)
    if (job.state !== 'running' && job.state !== 'finishing')
      throw new GatewayError('CONFLICT', 'This job is not running')
    this.usages.set(jobId, { ...sample, at: iso(this.now()) })
  }
  /** A piece of a bot's job log, read from the bot's environment now; the gateway keeps none of it. */
  async readLog(botId: string, jobId: string, query: RunnerLogQuery): Promise<FleetRunnerJobLogPage> {
    this.job(botId, jobId)
    const page = await this.environments.readLog(botId, jobId, query)
    if (!page)
      throw new GatewayError('CONFLICT', "The bot's environment is not running, so this job's log cannot be read now.")
    return page
  }
  /** The runner took the job: it is running, from its input transfer to its command's end. */
  accept(jobId: string, deviceId: string) {
    const job = this.owned(jobId, deviceId)
    if (job.state !== 'assigned') throw new GatewayError('CONFLICT', 'This job is not waiting to be accepted')
    this.acceptBy.delete(jobId)
    this.store.updateRunnerJob(jobId, { state: 'running', startedAt: iso(this.now()) })
    this.changed(jobId)
  }
  /** The job's command ended and its runner is sending its outputs. */
  progress(jobId: string, deviceId: string) {
    const job = this.owned(jobId, deviceId)
    if (job.state !== 'running') throw new GatewayError('CONFLICT', 'This job is not running')
    this.store.updateRunnerJob(jobId, { state: 'finishing' })
    this.changed(jobId)
  }
  /** The job ended on its runner; one cancelled meanwhile is cancelled whatever its exit code. */
  finish(jobId: string, deviceId: string, result: FleetRunnerJobFinishRequest) {
    const job = this.owned(jobId, deviceId)
    if (job.state !== 'running' && job.state !== 'finishing')
      throw new GatewayError('CONFLICT', 'This job is not running')
    const error =
      result.error ??
      (result.exitCode === 0
        ? null
        : { code: 'exit_code' as const, message: `The command exited with code ${result.exitCode ?? 'unknown'}.` })
    if (job.cancelRequested) this.end(jobId, 'cancelled', null, result.exitCode)
    else this.end(jobId, error ? 'failed' : 'succeeded', error, result.exitCode)
    this.schedule()
  }
  /** The bot whose job a runner may move these files of now; the transfer relay asks before streaming. */
  authorizeTransfer(jobId: string, deviceId: string, key: FleetRunnerTransferRouteKey): string {
    const job = this.owned(jobId, deviceId)
    if (!TRANSFER_STATES[key].includes(job.state))
      throw new GatewayError('CONFLICT', `This job's files cannot move while it is ${job.state}`)
    return job.botId
  }
  /** A queued or assigned job ends at once; a running one once its runner stops it, or after the grace period. */
  cancel(botId: string, jobId: string): FleetRunnerJob {
    const job = this.store.runnerJob(jobId)
    if (!job || job.botId !== botId) throw new GatewayError('NOT_FOUND', 'Runner job not found')
    if (isFinal(job.state)) return this.view(job)
    if (job.state === 'queued') this.end(jobId, 'cancelled', null)
    else if (job.state === 'assigned') {
      this.events.sendToRunner(job.deviceId!, { type: 'runner.cancel', at: iso(this.now()), jobId })
      this.end(jobId, 'cancelled', null)
      this.schedule()
    } else {
      this.store.updateRunnerJob(jobId, { cancelRequested: true })
      this.cancelBy.set(jobId, this.now() + FLEET_RUNNER_LIMITS.lostGraceMs)
      this.events.sendToRunner(job.deviceId!, { type: 'runner.cancel', at: iso(this.now()), jobId })
      this.changed(jobId)
    }
    return this.view(this.store.runnerJob(jobId)!)
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
    this.usages.delete(jobId)
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
  /** Applies every deadline that passed, forgets old jobs, and serves the queue; runs on a timer and in tests. */
  tick() {
    const now = this.now()
    for (const [jobId, at] of [...this.acceptBy]) {
      if (at > now) continue
      const job = this.store.runnerJob(jobId)
      if (job?.state === 'assigned' && job.deviceId) this.requeue(jobId, job.deviceId)
      else this.acceptBy.delete(jobId)
    }
    for (const [jobId, at] of [...this.cancelBy]) {
      if (at > now) continue
      this.cancelBy.delete(jobId)
      const job = this.store.runnerJob(jobId)
      if (job && !isFinal(job.state)) this.end(jobId, 'cancelled', null)
    }
    for (const [deviceId, at] of [...this.lostAt]) {
      if (at > now) continue
      this.lostAt.delete(deviceId)
      if (this.presence.has(deviceId)) continue
      for (const job of this.store.runnerJobsOfDevice(deviceId, ACTIVE))
        if (job.cancelRequested) this.end(job.id, 'cancelled', null)
        else
          this.end(job.id, 'lost', {
            code: 'runner_lost',
            message: `"${this.runnerName(job)}" went offline and did not come back within ${FLEET_RUNNER_LIMITS.lostGraceMs / 60_000} minutes.`,
          })
    }
    for (const job of this.store.runnerJobsIn(['queued']))
      if (Date.parse(job.queueDeadline) <= now)
        this.end(job.id, 'expired', {
          code: 'queue_timeout',
          message: 'No runner took this job before its queue timeout.',
        })
    this.store.deleteRunnerJobsEndedBefore(iso(now - FLEET_RUNNER_LIMITS.endedRetentionMs))
    this.schedule()
    void this.retry()
  }
  /**
   * After a gateway restart no runner is connected yet: assigned jobs go back to the queue, and the jobs runners had
   * count as lost unless their runner returns in time.
   */
  start() {
    for (const job of this.store.runnerJobsIn(['assigned']))
      this.store.updateRunnerJob(job.id, { state: 'queued', runnerId: null, deviceId: null, assignedAt: null })
    for (const job of this.store.runnerJobsIn(['running', 'finishing']))
      if (job.deviceId && !this.lostAt.has(job.deviceId))
        this.lostAt.set(job.deviceId, this.now() + FLEET_RUNNER_LIMITS.lostGraceMs)
    this.timer ??= setInterval(() => this.tick(), this.options.tickMs ?? 5_000)
    this.timer.unref?.()
    void this.retry()
  }
  close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
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
      // The environment is told where the job stands; what it uses is read from the gateway, never kept there.
      const { usage: _usage, ...state } = this.view(job)
      if (!(await this.environments.notify(state))) return
      this.store.markRunnerJobNotified(jobId, job.seq)
    }
  }
  /** Sends every state a bot's environment missed: when the bot is ready again, and on each tick. */
  async retry(botId?: string) {
    for (const job of this.store.unnotifiedRunnerJobs(botId)) {
      // A delivery in progress may have found the environment unreachable: this one tries again after it.
      await this.delivering.get(job.id)
      await this.deliver(job.id)
    }
  }
}
