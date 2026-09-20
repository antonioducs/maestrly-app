import { randomUUID } from 'node:crypto'
import { estimateTextTokens } from '../portable-context'
import {
  backgroundCompactionConfigIdentity,
  effectiveBackgroundCompactionInterval,
  parseBackgroundCompactionConfig,
} from './config'
import {
  backgroundCompactionHistory,
  backgroundCompactionSourceHash,
  selectBackgroundCompactionTarget,
  validateBackgroundCompactionCandidate,
} from './policy'
import { BackgroundCompactionStore, persistedBackgroundCompactionSelection } from './store'
import {
  BACKGROUND_COMPACTION_PERSISTENCE_VERSION,
  type BackgroundCompactionAttemptHandle,
  type BackgroundCompactionAttemptResult,
  type BackgroundCompactionCandidate,
  type BackgroundCompactionCoordinatorDeps,
  type BackgroundCompactionNotification,
  type BackgroundCompactionPauseReason,
  type BackgroundCompactionRecord,
  type BackgroundCompactionWork,
} from './types'

const MAX_SUMMARY_TOKENS = 8_000
const STAGE_TIMEOUT_MS = 3 * 60_000
const RETRY_DELAY_MS = 30_000

class BackgroundCompactionInvariantError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'BackgroundCompactionInvariantError'
  }
}

interface ActiveRound {
  conversationId: string
  controller: AbortController
}

export interface BackgroundCompactionConsumeResult<T> {
  candidate: BackgroundCompactionCandidate
  value: T
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

function failureCode(error: unknown): string {
  if (error instanceof BackgroundCompactionInvariantError) return error.code
  const detail = error as { name?: string; message?: string; status?: unknown; statusCode?: unknown } | null
  const message = `${detail?.name ?? ''} ${detail?.message ?? String(error)}`.toLowerCase()
  const status = Number(detail?.statusCode ?? detail?.status)
  if (status === 401 || status === 403 || /auth|credential|unauthorized|forbidden|no[ -]key/.test(message)) {
    return 'summarizer-authentication-required'
  }
  if (/identity|account changed|fingerprint/.test(message)) return 'summarizer-identity-changed'
  if (/model.+(?:missing|unknown|unsupported|unavailable|not found)/.test(message)) {
    return 'summarizer-model-unavailable'
  }
  if (/timed out|timeout|time budget/.test(message)) return 'summarizer-timeout'
  if (/empty|oversized|invalid output/.test(message)) return 'summarizer-invalid-output'
  return 'background-compaction-failed'
}

/**
 * Durable policy/scheduler for optional preparation. Construction is deliberately inert: persisted
 * work is resumed only by notify/retry, never by a startup scan.
 */
export class ChatBackgroundCompactionCoordinator {
  readonly store: BackgroundCompactionStore
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  private readonly notifications = new Map<string, BackgroundCompactionNotification>()
  private active: ActiveRound | null = null
  private pumpPromise: Promise<void> | null = null
  private disposed = false

  constructor(
    private readonly deps: BackgroundCompactionCoordinatorDeps,
    store = new BackgroundCompactionStore()
  ) {
    this.store = store
  }

  status(conversationId: string) {
    return this.store.get(conversationId)?.state ?? { revision: 0, status: 'idle' as const }
  }

  record(conversationId: string): BackgroundCompactionRecord | null {
    return this.store.get(conversationId)
  }

  getCandidate(conversationId: string): BackgroundCompactionCandidate | null {
    const config = parseBackgroundCompactionConfig(this.deps.getConfig())
    const record = this.store.get(conversationId)
    const candidate = record?.ready
    if (!config?.enabled || !candidate || !record) return null
    const configIdentity = backgroundCompactionConfigIdentity(config)
    if (
      record.generation !== candidate.generation ||
      candidate.configIdentity !== configIdentity ||
      record.configIdentity !== configIdentity ||
      !validateBackgroundCompactionCandidate(this.deps.getMessages(conversationId), candidate) ||
      !this.deps.revalidate(candidate.selection)
    ) {
      return null
    }
    return candidate
  }

  notify(conversationId: string, notification: BackgroundCompactionNotification): void {
    if (this.disposed || !Number.isFinite(notification.conversationWindow) || notification.conversationWindow <= 0)
      return
    const conversation = this.deps.getConversation(conversationId)
    if (!conversation) return
    const boundary =
      notification.boundary ??
      (typeof notification.messageId === 'string' && typeof notification.partId === 'string'
        ? { messageId: notification.messageId, partId: notification.partId }
        : undefined)
    this.notifications.set(conversationId, {
      conversationWindow: Math.max(1, Math.floor(notification.conversationWindow)),
      ...(boundary ? { boundary: { ...boundary } } : {}),
    })
    if (conversation.archived) {
      this.stop(conversationId, 'archived')
      return
    }
    const config = parseBackgroundCompactionConfig(this.deps.getConfig())
    if (!config?.enabled) return
    const record = this.store.get(conversationId)
    if (
      record?.state.status === 'failed' ||
      record?.pauseReason === 'selection' ||
      record?.pauseReason === 'disabled'
    ) {
      return
    }
    this.enqueue(conversationId)
  }

  touch(conversationId: string, notification: BackgroundCompactionNotification): void {
    this.notify(conversationId, notification)
  }

  retry(conversationId: string, notification?: BackgroundCompactionNotification): boolean {
    if (this.disposed || !this.deps.getConversation(conversationId)) return false
    const config = parseBackgroundCompactionConfig(this.deps.getConfig())
    if (!config?.enabled) return false
    const record = this.store.get(conversationId)
    const use = notification ?? this.notifications.get(conversationId)
    const recoveredUse =
      use ??
      (record?.work
        ? { conversationWindow: record.work.conversationWindow }
        : record?.conversationWindow
          ? { conversationWindow: record.conversationWindow }
          : undefined)
    if (!recoveredUse) return false
    this.notifications.set(conversationId, recoveredUse)
    if (record) {
      const identityChanged = Boolean(
        (record.work && !this.deps.revalidate(record.work.selection)) ||
          (record.ready && !this.deps.revalidate(record.ready.selection))
      )
      const next = this.store.write(
        conversationId,
        {
          generation: record.generation + (identityChanged ? 1 : 0),
          configIdentity: backgroundCompactionConfigIdentity(config),
          conversationWindow: recoveredUse.conversationWindow,
          status: identityChanged ? 'idle' : record.work ? 'queued' : record.ready ? 'ready' : 'idle',
          ready: identityChanged ? null : record.ready,
          work: identityChanged ? null : record.work,
        },
        this.now()
      )
      this.deps.publish(conversationId, next.state)
    }
    this.enqueue(conversationId)
    return true
  }

  stop(conversationId: string, reason: BackgroundCompactionPauseReason = 'stopped'): void {
    this.removeQueued(conversationId)
    this.notifications.delete(conversationId)
    const record = this.store.get(conversationId)
    const conversation = this.deps.getConversation(conversationId)
    if (conversation) {
      const config = parseBackgroundCompactionConfig(this.deps.getConfig())
      const next = this.store.write(
        conversationId,
        {
          generation: record?.generation ?? 0,
          ...(record?.configIdentity
            ? { configIdentity: record.configIdentity }
            : config
              ? { configIdentity: backgroundCompactionConfigIdentity(config) }
              : {}),
          pauseReason: reason,
          status: 'paused',
          ready: record?.ready ?? null,
          work: record?.work ?? null,
        },
        this.now()
      )
      this.deps.publish(conversationId, next.state)
    }
    if (this.active?.conversationId === conversationId) {
      this.active.controller.abort(abortError('Background compaction stopped'))
    }
  }

  suspend(conversationId: string): void {
    this.stop(conversationId, 'archived')
  }

  invalidate(conversationId: string): void {
    this.removeQueued(conversationId)
    this.notifications.delete(conversationId)
    const record = this.store.get(conversationId)
    if (!record || !this.deps.getConversation(conversationId)) return
    const config = parseBackgroundCompactionConfig(this.deps.getConfig())
    const next = this.store.write(
      conversationId,
      {
        generation: record.generation + 1,
        ...(config ? { configIdentity: backgroundCompactionConfigIdentity(config) } : {}),
        ...(config?.enabled ? {} : { pauseReason: 'disabled' as const }),
        status: 'idle',
        ready: null,
        work: null,
      },
      this.now()
    )
    if (this.active?.conversationId === conversationId) {
      this.active.controller.abort(abortError('Background compaction invalidated'))
    }
    this.deps.publish(conversationId, next.state)
  }

  manualCompaction(conversationId: string): void {
    this.invalidate(conversationId)
  }

  delete(conversationId: string): void {
    this.removeQueued(conversationId)
    this.notifications.delete(conversationId)
    if (this.active?.conversationId === conversationId) {
      this.active.controller.abort(abortError('Conversation deleted'))
    }
    this.store.remove(conversationId)
  }

  /** Call only after the new config has been durably saved by the owner. */
  configureChanged(): void {
    const config = parseBackgroundCompactionConfig(this.deps.getConfig())
    this.queue.length = 0
    this.queued.clear()
    this.notifications.clear()
    this.active?.controller.abort(abortError('Background compaction configuration changed'))
    for (const record of this.store.list()) {
      if (!this.deps.getConversation(record.conversationId)) continue
      const next = this.store.write(
        record.conversationId,
        {
          generation: record.generation + 1,
          ...(config ? { configIdentity: backgroundCompactionConfigIdentity(config) } : {}),
          ...(config?.enabled ? {} : { pauseReason: 'disabled' as const }),
          status: 'idle',
          ready: null,
          work: null,
        },
        this.now()
      )
      this.deps.publish(record.conversationId, next.state)
    }
  }

  consume<T>(
    conversationId: string,
    candidateId: string,
    commit: (candidate: BackgroundCompactionCandidate) => T
  ): BackgroundCompactionConsumeResult<T> | null {
    let committedRecord: BackgroundCompactionRecord | null = null
    const result = this.store.transaction(() => {
      const config = parseBackgroundCompactionConfig(this.deps.getConfig())
      const record = this.store.get(conversationId)
      const candidate = record?.ready
      if (!config?.enabled || !record || !candidate || candidate.id !== candidateId) return null
      const configIdentity = backgroundCompactionConfigIdentity(config)
      if (
        record.generation !== candidate.generation ||
        record.configIdentity !== configIdentity ||
        candidate.configIdentity !== configIdentity ||
        !validateBackgroundCompactionCandidate(this.deps.getMessages(conversationId), candidate) ||
        !this.deps.revalidate(candidate.selection)
      ) {
        return null
      }
      const value = commit(candidate)
      committedRecord = this.store.write(
        conversationId,
        {
          generation: record.generation + 1,
          configIdentity,
          status: 'idle',
          ready: null,
          work: null,
        },
        this.now()
      )
      return { candidate, value }
    })
    if (!result || !committedRecord) return null
    this.removeQueued(conversationId)
    this.notifications.delete(conversationId)
    if (this.active?.conversationId === conversationId) {
      this.active.controller.abort(abortError('Prepared compaction consumed'))
    }
    this.deps.publish(conversationId, (committedRecord as BackgroundCompactionRecord).state)
    return result
  }

  consumeCandidate<T>(
    conversationId: string,
    candidateId: string,
    commit: (candidate: BackgroundCompactionCandidate) => T
  ): BackgroundCompactionConsumeResult<T> | null {
    return this.consume(conversationId, candidateId, commit)
  }

  getStatus(conversationId: string) {
    return this.status(conversationId)
  }

  async settled(): Promise<void> {
    while (this.pumpPromise) {
      const current = this.pumpPromise
      await current
      if (this.pumpPromise === current) return
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queue.length = 0
    this.queued.clear()
    this.notifications.clear()
    if (this.active) this.stop(this.active.conversationId)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private randomId(): string {
    return this.deps.randomId?.() ?? randomUUID()
  }

  private enqueue(conversationId: string): void {
    if (this.disposed || this.queued.has(conversationId)) return
    this.queued.add(conversationId)
    this.queue.push(conversationId)
    if (!this.pumpPromise) {
      this.pumpPromise = Promise.resolve()
        .then(() => this.pump())
        .finally(() => {
          this.pumpPromise = null
          if (!this.disposed && this.queue.length > 0) this.enqueuePump()
        })
    }
  }

  private enqueuePump(): void {
    if (this.pumpPromise || this.disposed) return
    this.pumpPromise = Promise.resolve()
      .then(() => this.pump())
      .finally(() => {
        this.pumpPromise = null
        if (!this.disposed && this.queue.length > 0) this.enqueuePump()
      })
  }

  private removeQueued(conversationId: string): void {
    this.queued.delete(conversationId)
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index] === conversationId) this.queue.splice(index, 1)
    }
  }

  private async pump(): Promise<void> {
    while (!this.disposed && this.queue.length > 0) {
      const conversationId = this.queue.shift()!
      this.queued.delete(conversationId)
      let anotherRound = false
      try {
        anotherRound = await this.processRound(conversationId)
      } catch (error) {
        this.failUnexpected(conversationId, error)
      }
      if (anotherRound && this.notifications.has(conversationId)) this.enqueue(conversationId)
    }
  }

  private async processRound(conversationId: string): Promise<boolean> {
    const notification = this.notifications.get(conversationId)
    const conversation = this.deps.getConversation(conversationId)
    const config = parseBackgroundCompactionConfig(this.deps.getConfig())
    if (!notification || !conversation || !config?.enabled || !config.selection) return false
    if (conversation.archived) {
      this.stop(conversationId, 'archived')
      return false
    }
    const configIdentity = backgroundCompactionConfigIdentity(config)
    let record = this.store.get(conversationId)
    if (record && record.configIdentity !== configIdentity) {
      record = this.store.write(
        conversationId,
        {
          generation: record.generation + 1,
          configIdentity,
          status: 'idle',
          ready: null,
          work: null,
        },
        this.now()
      )
      this.deps.publish(conversationId, record.state)
    }
    if (
      record?.state.status === 'failed' ||
      record?.pauseReason === 'selection' ||
      record?.pauseReason === 'disabled'
    ) {
      return false
    }

    const messages = this.deps.getMessages(conversationId)
    let ready = record?.ready ?? null
    if (ready) {
      const sourceValid =
        ready.generation === record!.generation &&
        ready.configIdentity === configIdentity &&
        validateBackgroundCompactionCandidate(messages, ready)
      if (!sourceValid) {
        record = this.discardWork(conversationId, record!, null, configIdentity, 'candidate-source-changed')
        ready = null
      } else if (!this.deps.revalidate(ready.selection)) {
        this.markFailed(conversationId, record!, 'summarizer-identity-changed')
        return false
      }
    }

    if (record?.work) {
      const work = record.work
      const workValid =
        work.generation === record.generation &&
        work.configIdentity === configIdentity &&
        backgroundCompactionSourceHash(messages, work.boundary) === work.sourceHash &&
        (!work.baseCandidateId || ready?.id === work.baseCandidateId)
      if (!workValid) {
        record = this.discardWork(conversationId, record, ready, configIdentity, 'work-source-changed')
        ready = record.ready
      } else if (!this.deps.revalidate(work.selection)) {
        this.markFailed(conversationId, record, 'summarizer-identity-changed')
        return false
      } else {
        return this.execute(conversationId, record, work)
      }
    }

    const intervalTokens = effectiveBackgroundCompactionInterval(config.intervalTokens, notification.conversationWindow)
    const target = selectBackgroundCompactionTarget(messages, intervalTokens, notification.boundary, ready)
    if (!target) {
      if (
        record?.state.status === 'paused' ||
        record?.state.status === 'queued' ||
        record?.state.status === 'running'
      ) {
        const normalized = this.store.write(
          conversationId,
          {
            generation: record.generation,
            configIdentity,
            status: ready ? 'ready' : 'idle',
            ready,
            work: null,
          },
          this.now()
        )
        this.deps.publish(conversationId, normalized.state)
      }
      return false
    }

    const controller = new AbortController()
    this.active = { conversationId, controller }
    try {
      const resolved = await this.deps.resolveSelection(conversationId, config.selection, controller.signal)
      controller.signal.throwIfAborted()
      if (!resolved || !Number.isFinite(resolved.contextWindow) || resolved.contextWindow <= 0) {
        const current = this.store.get(conversationId) ?? record
        const paused = this.store.write(
          conversationId,
          {
            generation: current?.generation ?? 0,
            configIdentity,
            conversationWindow: notification.conversationWindow,
            pauseReason: 'selection',
            status: 'paused',
            error: 'summarizer-selection-unknown',
            ready,
            work: null,
          },
          this.now()
        )
        this.deps.publish(conversationId, paused.state)
        return false
      }
      const selection = persistedBackgroundCompactionSelection(resolved.selection)
      if (!this.deps.revalidate(selection)) {
        this.failUnexpected(conversationId, new BackgroundCompactionInvariantError('summarizer-identity-changed'))
        return false
      }
      const current = this.store.get(conversationId)
      const generation = (current?.generation ?? 0) + 1
      const rebasedReady = ready ? { ...ready, generation } : null
      const now = this.now()
      const contextWindow = Math.max(1, Math.floor(resolved.contextWindow))
      const work: BackgroundCompactionWork = {
        version: BACKGROUND_COMPACTION_PERSISTENCE_VERSION,
        id: this.randomId(),
        generation,
        configIdentity,
        boundary: target.boundary,
        sourceHash: target.sourceHash,
        selection,
        ...(rebasedReady ? { baseCandidateId: rebasedReady.id } : {}),
        coveredTokens: target.coveredTokens,
        newTokens: target.newTokens,
        intervalTokens,
        conversationWindow: notification.conversationWindow,
        contextWindow,
        maxSummaryTokens: Math.max(1, Math.min(MAX_SUMMARY_TOKENS, Math.floor(contextWindow * 0.1))),
        attemptSequence: 0,
        createdAt: now,
        updatedAt: now,
      }
      const queued = this.store.write(
        conversationId,
        {
          generation,
          configIdentity,
          conversationWindow: notification.conversationWindow,
          status: 'queued',
          ready: rebasedReady,
          work,
        },
        now
      )
      this.deps.publish(conversationId, queued.state)
      this.deps.diagnostic?.({
        kind: 'scheduled',
        conversationId,
        coveredTokens: work.coveredTokens,
        newTokens: work.newTokens,
        reusedTokens: rebasedReady?.coveredTokens ?? 0,
      })
      return await this.executeWithActive(conversationId, queued, work, controller)
    } catch (error) {
      if (!controller.signal.aborted) this.failUnexpected(conversationId, error)
      return false
    } finally {
      if (this.active?.controller === controller) this.active = null
    }
  }

  private async execute(
    conversationId: string,
    record: BackgroundCompactionRecord,
    work: BackgroundCompactionWork
  ): Promise<boolean> {
    const controller = new AbortController()
    this.active = { conversationId, controller }
    try {
      return await this.executeWithActive(conversationId, record, work, controller)
    } finally {
      if (this.active?.controller === controller) this.active = null
    }
  }

  private async executeWithActive(
    conversationId: string,
    record: BackgroundCompactionRecord,
    initialWork: BackgroundCompactionWork,
    controller: AbortController
  ): Promise<boolean> {
    let work = initialWork
    const running = this.store.write(
      conversationId,
      {
        generation: record.generation,
        configIdentity: work.configIdentity,
        status: 'running',
        ready: record.ready,
        work,
      },
      this.now()
    )
    this.deps.publish(conversationId, running.state)
    const startedAt = this.now()
    this.deps.diagnostic?.({ kind: 'started', conversationId })
    try {
      controller.signal.throwIfAborted()
      const messages = this.deps.getMessages(conversationId)
      if (backgroundCompactionSourceHash(messages, work.boundary) !== work.sourceHash) {
        throw new BackgroundCompactionInvariantError('background-source-changed')
      }
      const base = work.baseCandidateId ? running.ready : null
      if (work.baseCandidateId && base?.id !== work.baseCandidateId) {
        throw new BackgroundCompactionInvariantError('background-base-changed')
      }
      const history = backgroundCompactionHistory(conversationId, messages, work.boundary, base)
      if (!history) throw new BackgroundCompactionInvariantError('background-source-changed')
      if (!this.deps.revalidate(work.selection)) {
        throw new BackgroundCompactionInvariantError('summarizer-identity-changed')
      }

      const summarized = await this.deps.summarize({
        conversationId,
        history,
        selection: work.selection,
        contextWindow: work.contextWindow,
        maxSummaryTokens: work.maxSummaryTokens,
        stepTimeoutMs: STAGE_TIMEOUT_MS,
        retryDelayMs: RETRY_DELAY_MS,
        maxRetries: 1,
        signal: controller.signal,
        onAttempt: (phase) => {
          controller.signal.throwIfAborted()
          const current = this.store.get(conversationId)
          if (
            !current?.work ||
            current.generation !== work.generation ||
            current.work.id !== work.id ||
            current.state.status !== 'running'
          ) {
            throw new BackgroundCompactionInvariantError('background-work-replaced')
          }
          work = {
            ...current.work,
            attemptSequence: current.work.attemptSequence + 1,
            updatedAt: this.now(),
          }
          this.store.write(
            conversationId,
            {
              generation: current.generation,
              configIdentity: current.configIdentity,
              status: 'running',
              ready: current.ready,
              work,
            },
            work.updatedAt
          )
          return this.attemptHandle(conversationId, work, phase)
        },
        onCheckpoint: (checkpoint) => {
          controller.signal.throwIfAborted()
          const current = this.store.get(conversationId)
          if (
            !current?.work ||
            current.generation !== work.generation ||
            current.work.id !== work.id ||
            backgroundCompactionSourceHash(this.deps.getMessages(conversationId), work.boundary) !== work.sourceHash
          ) {
            throw new BackgroundCompactionInvariantError('background-source-changed')
          }
          work = { ...current.work, resume: checkpoint, updatedAt: this.now() }
          this.store.write(
            conversationId,
            {
              generation: current.generation,
              configIdentity: current.configIdentity,
              status: 'running',
              ready: current.ready,
              work,
            },
            work.updatedAt
          )
        },
        ...(work.resume ? { resume: work.resume } : {}),
      })
      controller.signal.throwIfAborted()
      const summary = summarized.summary.trim()
      if (!summary) throw new BackgroundCompactionInvariantError('summarizer-invalid-output')
      const summaryTokens = estimateTextTokens(summary)
      if (summaryTokens > work.maxSummaryTokens) {
        throw new BackgroundCompactionInvariantError('summarizer-invalid-output')
      }
      const config = parseBackgroundCompactionConfig(this.deps.getConfig())
      const current = this.store.get(conversationId)
      if (
        !config?.enabled ||
        backgroundCompactionConfigIdentity(config) !== work.configIdentity ||
        !current?.work ||
        current.generation !== work.generation ||
        current.work.id !== work.id ||
        backgroundCompactionSourceHash(this.deps.getMessages(conversationId), work.boundary) !== work.sourceHash ||
        !this.deps.revalidate(work.selection)
      ) {
        throw new BackgroundCompactionInvariantError('background-work-replaced')
      }
      const candidate: BackgroundCompactionCandidate = {
        version: BACKGROUND_COMPACTION_PERSISTENCE_VERSION,
        id: this.randomId(),
        generation: work.generation,
        configIdentity: work.configIdentity,
        boundary: work.boundary,
        sourceHash: work.sourceHash,
        summary,
        summaryTokens,
        coveredTokens: work.coveredTokens,
        selection: work.selection,
        createdAt: this.now(),
      }
      const completed = this.store.write(
        conversationId,
        {
          generation: work.generation,
          configIdentity: work.configIdentity,
          status: 'ready',
          ready: candidate,
          work: null,
        },
        this.now()
      )
      this.deps.publish(conversationId, completed.state)
      this.deps.diagnostic?.({
        kind: 'completed',
        conversationId,
        durationMs: Math.max(0, this.now() - startedAt),
        coveredTokens: work.coveredTokens,
        newTokens: work.newTokens,
        reusedTokens: record.ready?.coveredTokens ?? 0,
      })
      return true
    } catch (error) {
      const current = this.store.get(conversationId)
      if (controller.signal.aborted) return false
      if (!current?.work || current.generation !== work.generation || current.work.id !== work.id) return false
      if (
        error instanceof BackgroundCompactionInvariantError &&
        (error.code === 'background-source-changed' ||
          error.code === 'background-base-changed' ||
          error.code === 'background-work-replaced')
      ) {
        this.discardWork(
          conversationId,
          current,
          this.validPreservedReady(conversationId, current),
          work.configIdentity,
          error.code
        )
        return false
      }
      this.markFailed(conversationId, current, failureCode(error))
      this.deps.diagnostic?.({
        kind: 'failed',
        conversationId,
        durationMs: Math.max(0, this.now() - startedAt),
        reason: failureCode(error),
      })
      return false
    }
  }

  private attemptHandle(
    conversationId: string,
    work: BackgroundCompactionWork,
    _phase?: 'chunk' | 'consolidate'
  ): BackgroundCompactionAttemptHandle {
    const id = `background-compaction:${work.id}:${work.attemptSequence}`
    let settled = false
    return {
      id,
      settle: (attempt: BackgroundCompactionAttemptResult) => {
        if (settled) return
        settled = true
        try {
          const recorded = this.deps.recordAttempt(id, work.selection, attempt)
          void Promise.resolve(recorded).catch(() => {
            this.deps.diagnostic?.({ kind: 'attempt-accounting-failed', conversationId, reason: id })
          })
        } catch {
          this.deps.diagnostic?.({ kind: 'attempt-accounting-failed', conversationId, reason: id })
        }
      },
    }
  }

  private validPreservedReady(
    conversationId: string,
    record: BackgroundCompactionRecord
  ): BackgroundCompactionCandidate | null {
    const ready = record.ready
    if (!ready || !validateBackgroundCompactionCandidate(this.deps.getMessages(conversationId), ready)) return null
    return ready
  }

  private discardWork(
    conversationId: string,
    record: BackgroundCompactionRecord,
    ready: BackgroundCompactionCandidate | null,
    configIdentity: string,
    reason: string
  ): BackgroundCompactionRecord {
    const generation = record.generation + 1
    const rebasedReady = ready ? { ...ready, generation } : null
    const discarded = this.store.write(
      conversationId,
      {
        generation,
        configIdentity,
        status: rebasedReady ? 'ready' : 'idle',
        ready: rebasedReady,
        work: null,
      },
      this.now()
    )
    this.deps.publish(conversationId, discarded.state)
    this.deps.diagnostic?.({ kind: 'discarded', conversationId, reason })
    return discarded
  }

  private markFailed(conversationId: string, record: BackgroundCompactionRecord, error: string): void {
    const failed = this.store.write(
      conversationId,
      {
        generation: record.generation,
        configIdentity: record.configIdentity,
        status: 'failed',
        error,
        ready: record.ready,
        work: record.work,
      },
      this.now()
    )
    this.deps.publish(conversationId, failed.state)
  }

  private failUnexpected(conversationId: string, error: unknown): void {
    if (!this.deps.getConversation(conversationId)) return
    let record = this.store.get(conversationId)
    if (!record) {
      const config = parseBackgroundCompactionConfig(this.deps.getConfig())
      record = this.store.write(
        conversationId,
        {
          generation: 0,
          ...(config ? { configIdentity: backgroundCompactionConfigIdentity(config) } : {}),
          conversationWindow: this.notifications.get(conversationId)?.conversationWindow,
          status: 'failed',
          ready: null,
          work: null,
        },
        this.now()
      )
    }
    this.markFailed(conversationId, record, failureCode(error))
    this.deps.diagnostic?.({ kind: 'failed', conversationId, reason: failureCode(error) })
  }
}

export function createChatBackgroundCompactionCoordinator(
  deps: BackgroundCompactionCoordinatorDeps,
  store?: BackgroundCompactionStore
): ChatBackgroundCompactionCoordinator {
  return new ChatBackgroundCompactionCoordinator(deps, store)
}

export { ChatBackgroundCompactionCoordinator as BackgroundCompactionCoordinator }
export const createBackgroundCompactionCoordinator = createChatBackgroundCompactionCoordinator
