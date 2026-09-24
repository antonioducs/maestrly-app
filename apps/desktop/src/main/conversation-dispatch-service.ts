import { createHash, randomUUID } from 'node:crypto'
import type { Conversation, ProjectConversation } from '../shared/conversation'
import {
  conversationDispatchBranchSlug,
  conversationDispatchFingerprintInput,
  type ConversationDispatchBatch,
  type ConversationDispatchBatchResult,
  type ConversationDispatchItemResult,
  type ConversationDispatchModelOption,
  type ConversationDispatchPlacement,
  type ConversationDispatchSettings,
  type ConversationDispatchSettingsRequest,
  type ConversationDispatchSourceRef,
} from '../shared/conversation-dispatch'
import {
  findConversationDispatch,
  getConversationDispatch,
  getConversationDispatchByDestination,
  listConversationDispatchRequestKeys,
  listConversationDispatchesInPhases,
  renewDiscardedConversationDispatch,
  reserveConversationDispatch,
  transitionConversationDispatch,
  type ConversationDispatchRecord,
} from './conversation-dispatch-store'
import { sameDispatchSettings, type ResolvedConversationDispatchSettings } from './conversation-dispatch-settings'
import type { ConversationDispatchGrant } from './chat/conversation-dispatch-authorization'

/**
 * Starts persistent Standard conversations from a source conversation — an approved plan handed off from the Plan
 * panel, or tasks the person explicitly asked the agent to dispatch. Every destination is journaled before any
 * resource is allocated, so retries replay instead of duplicating and a crash can be reconciled.
 *
 * Prepare and start are separate so plan approval can commit its decision between them: a failure before the
 * commit discards only the unstarted destination this allocation owns; a failure to start keeps the destination
 * with a visible, retryable error.
 */

export interface ConversationDispatchServiceDeps {
  getConversation(id: string): Conversation | undefined
  resolveSettings(
    sourceConversationId: string,
    requested: ConversationDispatchSettingsRequest
  ): Promise<ResolvedConversationDispatchSettings>
  /** Commit checked out by `cwd`; null when it cannot be resolved. */
  resolveHead(cwd: string): Promise<string | null>
  hasUncommittedChanges(cwd: string): Promise<boolean>
  createShared(sourceConversationId: string, options: { id: string; name: string }): Promise<ProjectConversation>
  createIsolated(args: {
    id: string
    workspaceId: string
    branch: string
    baseRevision: string
    name: string
  }): Promise<ProjectConversation>
  /** `preserveWorktree` keeps a checkout the destination only borrowed (shared placement). */
  deleteConversation(id: string, options: { preserveWorktree: boolean }): Promise<void>
  /** Remove what a failed isolated allocation may have left (its unique worktree and branch). */
  cleanupIsolated(workspaceId: string, branch: string): Promise<void>
  applySettings(conversationId: string, settings: ConversationDispatchSettings): void
  readSettings(conversationId: string): ConversationDispatchSettings | null
  startTurn(input: {
    conversationId: string
    prompt: string
    dispatchId: string
    sourceConversationId: string
    visible: boolean
  }): Promise<{ ok: true } | { ok: false; error: string }>
  /** A seeded turn persists its first message at admission; used to reconcile an uncertain start. */
  hasPersistedMessages(conversationId: string): boolean
  openConversation(conversation: Conversation, focus: boolean): void
  notifyChanged(conversationId: string): void
  reportStartFailure(conversationId: string, error: string): void
  isReserved(conversationId: string): boolean
  isMigrating(conversationId: string): boolean
  isWebManaged(conversationId: string): boolean
  text(key: string, params?: Record<string, string>): string
}

export type ConversationDispatchErrorCode =
  | 'source-not-found'
  | 'project-required'
  | 'bot-conversation'
  | 'web-managed'
  | 'source-archived'
  | 'conversation-migrating'
  | 'unsupported-layout'
  | 'source-reserved'
  | 'source-revision-unavailable'
  | 'request-conflict'
  | 'destination-deleted'
  | 'recovery-required'
  | 'allocation-failed'
  | 'settings-mismatch'
  | 'not-startable'
  | 'cancelled'
  | 'count-exceeded'
  | 'settings-invalid'
  | 'persistence-failed'

export class ConversationDispatchError extends Error {
  readonly code: ConversationDispatchErrorCode
  constructor(code: ConversationDispatchErrorCode, message: string) {
    super(message)
    this.name = 'ConversationDispatchError'
    this.code = code
  }
}

export interface PrepareDispatchInput {
  sourceConversationId: string
  originKey: string
  requestKey: string
  kind: 'task' | 'plan'
  title: string
  prompt: string
  placement: ConversationDispatchPlacement
  /** Requested settings (fingerprinted). Plans pass fully explicit settings. */
  settings: ConversationDispatchSettingsRequest
  sourceRef?: ConversationDispatchSourceRef
  /** Pre-resolved settings (batch validation happens before any allocation). */
  resolved?: { settings: ConversationDispatchSettings; inherited: string[] }
  /** Pinned base revision for isolated placement, shared by a batch. */
  baseRevision?: string
  signal?: AbortSignal
  /** Rechecked right before each mutation (e.g. the authorizing turn is still live). */
  assertCurrent?: () => void
}

export interface PreparedDispatch {
  record: ConversationDispatchRecord
  conversation: Conversation
  replayed: boolean
}

export interface StartedDispatch {
  record: ConversationDispatchRecord
  status: 'started' | 'start-failed' | 'starting'
  replayed: boolean
  error?: string
}

function fingerprintOf(input: PrepareDispatchInput): string {
  return createHash('sha256')
    .update(
      conversationDispatchFingerprintInput({
        title: input.title,
        prompt: input.prompt,
        placement: input.placement,
        settings: input.settings,
        source: input.sourceRef,
      })
    )
    .update(`\0${input.kind}`)
    .digest('hex')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ConversationDispatchError('cancelled', 'The request was cancelled before it finished.')
}

export function createConversationDispatchService(deps: ConversationDispatchServiceDeps) {
  const inflight = new Map<string, Promise<unknown>>()
  const starting = new Map<string, Promise<unknown>>()

  /** Restrictions of the source conversation; placement-specific ones only where they matter. */
  function assertSource(sourceConversationId: string, placement: ConversationDispatchPlacement): ProjectConversation {
    const source = deps.getConversation(sourceConversationId)
    if (!source) throw new ConversationDispatchError('source-not-found', 'The source conversation no longer exists.')
    if (source.scope !== 'project')
      throw new ConversationDispatchError(
        'project-required',
        'This conversation has no project. Open a project conversation to start development conversations.'
      )
    if (source.botOrigin)
      throw new ConversationDispatchError(
        'bot-conversation',
        "Bot conversations own their worktree exclusively and cannot start other conversations."
      )
    if (deps.isWebManaged(sourceConversationId))
      throw new ConversationDispatchError('web-managed', 'This conversation is managed in the Kanban web chat.')
    if (source.archived === 1)
      throw new ConversationDispatchError('source-archived', 'Unarchive this conversation before starting others from it.')
    if (deps.isMigrating(sourceConversationId))
      throw new ConversationDispatchError(
        'conversation-migrating',
        'This conversation has an unfinished migration. Finish or roll it back first.'
      )
    if (source.isMulti)
      throw new ConversationDispatchError(
        'unsupported-layout',
        'Multi-repository conversations cannot start other conversations yet.'
      )
    if (placement === 'shared' && deps.isReserved(sourceConversationId))
      throw new ConversationDispatchError(
        'source-reserved',
        'A review loop is using this checkout. Use a separate worktree or wait for the loop to finish.'
      )
    return source
  }

  function destinationName(source: ProjectConversation, input: PrepareDispatchInput): string {
    const title = input.title.trim().replace(/\s+/g, ' ').slice(0, 80)
    return input.kind === 'plan' ? `${source.name} · ${title}` : title
  }

  async function allocate(
    record: ConversationDispatchRecord,
    source: ProjectConversation,
    input: PrepareDispatchInput
  ): Promise<PreparedDispatch> {
    input.assertCurrent?.()
    throwIfCancelled(input.signal)
    if (!transitionConversationDispatch(record.dispatchId, ['reserved'], 'allocating')) {
      throw new ConversationDispatchError('recovery-required', 'Another attempt is allocating this conversation.')
    }
    let created: Conversation | null = null
    try {
      created =
        record.placement === 'shared'
          ? await deps.createShared(source.id, { id: record.conversationId, name: record.conversationName })
          : await deps.createIsolated({
              id: record.conversationId,
              workspaceId: record.workspaceId,
              branch: record.branch!,
              baseRevision: record.baseRevision!,
              name: record.conversationName,
            })
      if (created.id !== record.conversationId) throw new Error('The destination was created with another id.')
      deps.applySettings(created.id, record.settings)
      if (!sameDispatchSettings(deps.readSettings(created.id), record.settings)) {
        throw new ConversationDispatchError(
          'settings-mismatch',
          'The new conversation did not keep the selected model settings.'
        )
      }
      throwIfCancelled(input.signal)
      input.assertCurrent?.()
      if (!transitionConversationDispatch(record.dispatchId, ['allocating'], 'prepared'))
        throw new Error('The allocation journal changed during preparation.')
      return { record: getConversationDispatch(record.dispatchId)!, conversation: created, replayed: false }
    } catch (error) {
      await rollbackAllocation(record, created !== null)
      if (error instanceof ConversationDispatchError) throw error
      throw new ConversationDispatchError('allocation-failed', `Could not create the conversation: ${errorText(error)}`)
    }
  }

  /** Remove only what this unstarted allocation owns; a shared checkout is never removed. */
  async function rollbackAllocation(record: ConversationDispatchRecord, rowCreated: boolean): Promise<void> {
    try {
      if (rowCreated || deps.getConversation(record.conversationId)) {
        await deps.deleteConversation(record.conversationId, { preserveWorktree: record.placement === 'shared' })
      } else if (record.placement === 'worktree' && record.branch) {
        await deps.cleanupIsolated(record.workspaceId, record.branch)
      }
      transitionConversationDispatch(
        record.dispatchId,
        ['reserved', 'allocating', 'prepared', 'deleted', 'start-failed'],
        'discarded',
        null
      )
    } catch (cleanupError) {
      transitionConversationDispatch(
        record.dispatchId,
        ['reserved', 'allocating', 'prepared', 'deleted', 'start-failed'],
        'recovery',
        `Cleanup after a failed allocation did not finish: ${errorText(cleanupError)}`
      )
    }
  }

  async function prepareOnce(input: PrepareDispatchInput): Promise<PreparedDispatch> {
    const source = assertSource(input.sourceConversationId, input.placement)
    const fingerprint = fingerprintOf(input)
    const existing = findConversationDispatch(input.sourceConversationId, input.originKey, input.requestKey)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ConversationDispatchError(
          'request-conflict',
          `Request "${input.requestKey}" was already used for different content; use a new request key.`
        )
      if (existing.phase !== 'discarded') return replay(existing, source, input)
    }
    throwIfCancelled(input.signal)
    input.assertCurrent?.()

    let resolved = input.resolved
    if (!resolved) {
      const result = await deps.resolveSettings(input.sourceConversationId, input.settings)
      if (!result.ok) throw new ConversationDispatchError('settings-invalid', result.message)
      resolved = { settings: result.settings, inherited: result.inherited }
    }
    const dispatchId = existing?.dispatchId ?? randomUUID()
    let baseRevision: string | null = null
    let branch: string | null = null
    if (input.placement === 'worktree') {
      baseRevision = input.baseRevision ?? (await deps.resolveHead(source.cwd))
      if (!baseRevision)
        throw new ConversationDispatchError(
          'source-revision-unavailable',
          'The current commit of the source checkout could not be resolved.'
        )
      branch = `task/${conversationDispatchBranchSlug(input.title)}-${randomUUID().slice(0, 8)}`
    } else {
      branch = source.branch
    }
    const next = {
      conversationId: randomUUID(),
      conversationName: destinationName(source, input),
      branch,
      baseRevision,
      settings: resolved.settings,
      inherited: resolved.inherited,
      workspaceId: source.workspaceId,
    }
    let record: ConversationDispatchRecord
    try {
      if (existing) {
        if (!renewDiscardedConversationDispatch(existing.dispatchId, next))
          return prepareOnce(input) // a concurrent attempt renewed it first
        record = getConversationDispatch(existing.dispatchId)!
      } else {
        const reserved = reserveConversationDispatch({
          dispatchId,
          sourceConversationId: input.sourceConversationId,
          originKey: input.originKey,
          requestKey: input.requestKey,
          kind: input.kind,
          fingerprint,
          title: input.title.trim(),
          prompt: input.prompt,
          placement: input.placement,
          sourceRef: input.sourceRef ?? null,
          ...next,
        })
        if (!reserved.created) return prepareOnce(input)
        record = reserved.record
      }
    } catch (error) {
      throw new ConversationDispatchError('persistence-failed', `Could not record the request: ${errorText(error)}`)
    }
    return allocate(record, source, input)
  }

  /** Replay semantics for a request that already has a journal entry. */
  async function replay(
    record: ConversationDispatchRecord,
    source: ProjectConversation,
    input: PrepareDispatchInput
  ): Promise<PreparedDispatch> {
    const conversation = () => deps.getConversation(record.conversationId)
    switch (record.phase) {
      case 'deleted':
        throw new ConversationDispatchError(
          'destination-deleted',
          `The conversation created for "${record.requestKey}" was deleted; it is not recreated by a retry.`
        )
      case 'recovery':
        throw new ConversationDispatchError(
          'recovery-required',
          record.error ?? 'This allocation needs manual recovery before it can continue.'
        )
      case 'reserved':
      case 'allocating': {
        // Only reachable after a crash (in-process attempts are deduplicated by `inflight`).
        const recovered = await reconcileRecord(record)
        if (recovered.phase === 'discarded') return prepareOnce(input)
        return replay(recovered, source, input)
      }
      default: {
        const row = conversation()
        if (!row) {
          transitionConversationDispatch(record.dispatchId, [record.phase], 'deleted')
          throw new ConversationDispatchError(
            'destination-deleted',
            `The conversation created for "${record.requestKey}" no longer exists.`
          )
        }
        return { record: getConversationDispatch(record.dispatchId)!, conversation: row, replayed: true }
      }
    }
  }

  /**
   * Run `operation` after every earlier operation with the same key has settled (success or failure). Identical
   * concurrent requests therefore never observe each other's half-finished allocation or start: each later one
   * applies replay semantics to the settled journal.
   */
  function serialized<T>(queue: Map<string, Promise<unknown>>, key: string, operation: () => Promise<T>): Promise<T> {
    const previous = queue.get(key)
    const work = previous
      ? previous.then(
          () => operation(),
          () => operation()
        )
      : operation()
    const tail = work.catch(() => undefined)
    queue.set(key, tail)
    void tail.then(() => {
      if (queue.get(key) === tail) queue.delete(key)
    })
    return work
  }

  function prepare(input: PrepareDispatchInput): Promise<PreparedDispatch> {
    const key = JSON.stringify([input.sourceConversationId, input.originKey, input.requestKey])
    return serialized(inflight, key, () => prepareOnce(input))
  }

  function seedPrompt(record: ConversationDispatchRecord): string {
    const source = deps.getConversation(record.sourceConversationId)
    const workspace =
      record.placement === 'worktree'
        ? deps.text('conversationDispatch.isolatedWorkspace', {
            branch: record.branch ?? '',
            revision: (record.baseRevision ?? '').slice(0, 12),
          })
        : deps.text('conversationDispatch.sharedWorkspace', { branch: record.branch ?? '' })
    if (record.kind === 'plan') {
      const plan = deps.text('planBroker.implementApprovedPlan', { plan: record.prompt })
      return record.placement === 'worktree' ? `${workspace}\n\n${plan}` : plan
    }
    return deps.text('conversationDispatch.taskSeed', {
      source: source?.name ?? '',
      title: record.title,
      reference: record.sourceRef
        ? deps.text('conversationDispatch.reference', {
            label: record.sourceRef.label,
            url: record.sourceRef.url ?? '',
          }).trim()
        : '',
      workspace,
      prompt: record.prompt,
    })
  }

  async function startOnce(dispatchId: string, options: { focus: boolean }): Promise<StartedDispatch> {
    const record = getConversationDispatch(dispatchId)
    if (!record) throw new ConversationDispatchError('not-startable', 'This conversation request no longer exists.')
    if (record.phase === 'started') return { record, status: 'started', replayed: true }
    if (record.phase === 'starting') return { record, status: 'starting', replayed: true }
    if (record.phase !== 'prepared' && record.phase !== 'start-failed')
      throw new ConversationDispatchError('not-startable', `This conversation cannot be started (${record.phase}).`)
    const conversation = deps.getConversation(record.conversationId)
    if (!conversation) {
      transitionConversationDispatch(dispatchId, [record.phase], 'deleted')
      throw new ConversationDispatchError('destination-deleted', 'The destination conversation no longer exists.')
    }
    // The first start must run exactly what was validated. A retry after a failed start keeps whatever the person
    // chose on the destination meanwhile (they may have switched models to fix the failure).
    if (record.phase === 'prepared' && !sameDispatchSettings(deps.readSettings(conversation.id), record.settings)) {
      deps.applySettings(conversation.id, record.settings)
      if (!sameDispatchSettings(deps.readSettings(conversation.id), record.settings)) {
        transitionConversationDispatch(dispatchId, ['prepared'], 'start-failed', 'settings-mismatch')
        deps.notifyChanged(conversation.id)
        return {
          record: getConversationDispatch(dispatchId)!,
          status: 'start-failed',
          replayed: false,
          error: 'settings-mismatch',
        }
      }
    }
    if (!transitionConversationDispatch(dispatchId, ['prepared', 'start-failed'], 'starting')) {
      const latest = getConversationDispatch(dispatchId)!
      return { record: latest, status: latest.phase === 'started' ? 'started' : 'starting', replayed: true }
    }
    deps.openConversation(conversation, options.focus)
    deps.notifyChanged(conversation.id)
    let result: { ok: true } | { ok: false; error: string }
    try {
      result = await deps.startTurn({
        conversationId: conversation.id,
        prompt: seedPrompt(record),
        dispatchId,
        sourceConversationId: record.sourceConversationId,
        visible: record.kind === 'task',
      })
    } catch (error) {
      result = { ok: false, error: errorText(error) }
    }
    if (result.ok) {
      transitionConversationDispatch(dispatchId, ['starting'], 'started')
      deps.notifyChanged(conversation.id)
      return { record: getConversationDispatch(dispatchId)!, status: 'started', replayed: false }
    }
    // The seed never started: keep the destination and let the person retry the same conversation.
    const failure = result.error
    if (deps.hasPersistedMessages(conversation.id)) {
      transitionConversationDispatch(dispatchId, ['starting'], 'started')
    } else {
      transitionConversationDispatch(dispatchId, ['starting'], 'start-failed', failure)
      deps.reportStartFailure(conversation.id, failure)
    }
    deps.notifyChanged(conversation.id)
    const latest = getConversationDispatch(dispatchId)!
    return latest.phase === 'started'
      ? { record: latest, status: 'started', replayed: false }
      : { record: latest, status: 'start-failed', replayed: false, error: failure }
  }

  function start(dispatchId: string, options: { focus: boolean } = { focus: false }): Promise<StartedDispatch> {
    return serialized(starting, dispatchId, () => startOnce(dispatchId, options))
  }

  /** Undo a prepared, never-started destination (plan decision could not be committed). */
  async function discard(dispatchId: string): Promise<void> {
    const record = getConversationDispatch(dispatchId)
    if (!record || (record.phase !== 'prepared' && record.phase !== 'reserved' && record.phase !== 'allocating')) return
    await rollbackAllocation(record, !!deps.getConversation(record.conversationId))
  }

  /** Crash recovery for one record whose in-process attempt is gone. */
  async function reconcileRecord(record: ConversationDispatchRecord): Promise<ConversationDispatchRecord> {
    const row = deps.getConversation(record.conversationId)
    switch (record.phase) {
      case 'reserved':
        if (!row) transitionConversationDispatch(record.dispatchId, ['reserved'], 'discarded')
        else {
          deps.applySettings(row.id, record.settings)
          transitionConversationDispatch(record.dispatchId, ['reserved'], 'start-failed', 'interrupted-before-start')
        }
        break
      case 'allocating':
        if (row) {
          deps.applySettings(row.id, record.settings)
          transitionConversationDispatch(record.dispatchId, ['allocating'], 'start-failed', 'interrupted-before-start')
        } else if (record.placement === 'shared') {
          transitionConversationDispatch(record.dispatchId, ['allocating'], 'discarded')
        } else {
          // Git work may exist for this branch; never guess. The branch name is unique to this allocation.
          transitionConversationDispatch(
            record.dispatchId,
            ['allocating'],
            'recovery',
            `Interrupted while creating worktree branch ${record.branch}. Remove that branch/worktree if it exists, then retry.`
          )
        }
        break
      case 'prepared':
        transitionConversationDispatch(record.dispatchId, ['prepared'], 'start-failed', 'interrupted-before-start')
        break
      case 'starting':
        if (row && deps.hasPersistedMessages(row.id))
          transitionConversationDispatch(record.dispatchId, ['starting'], 'started')
        else transitionConversationDispatch(record.dispatchId, ['starting'], 'start-failed', 'interrupted-during-start')
        break
      default:
        break
    }
    return getConversationDispatch(record.dispatchId)!
  }

  /** Boot reconciliation: nothing in flight survives a restart, so uncertain records are settled from durable state. */
  async function reconcile(): Promise<void> {
    for (const record of listConversationDispatchesInPhases(['reserved', 'allocating', 'prepared', 'starting'])) {
      try {
        await reconcileRecord(record)
      } catch {
        // One broken record must not block startup; it stays in its phase for the next attempt.
      }
    }
  }

  function itemFromRecord(
    record: ConversationDispatchRecord,
    status: ConversationDispatchItemResult['status'],
    extra: Partial<ConversationDispatchItemResult> = {}
  ): ConversationDispatchItemResult {
    return {
      requestKey: record.requestKey,
      title: record.title,
      status,
      conversationId: record.conversationId,
      conversationName: deps.getConversation(record.conversationId)?.name ?? record.conversationName,
      placement: record.placement,
      ...(record.branch ? { branch: record.branch } : {}),
      settings: record.settings,
      inherited: record.inherited,
      ...extra,
    }
  }

  /**
   * Natural-language batch: validate the whole batch (source, count, settings) before allocating anything, then
   * prepare and start each task in order. Items already started for the same request replay their destination.
   */
  async function dispatchBatch(input: {
    grant: ConversationDispatchGrant
    batch: ConversationDispatchBatch
    signal?: AbortSignal
    assertCurrent: () => void
  }): Promise<ConversationDispatchBatchResult> {
    const { grant, batch } = input
    const sourceId = grant.conversationId
    const defaultPlacement: ConversationDispatchPlacement = batch.placement ?? 'worktree'
    const tasks = batch.tasks.map((task) => ({
      ...task,
      placement: task.placement ?? defaultPlacement,
      settings: { ...(batch.defaults ?? {}), ...(task.settings ?? {}) },
    }))
    try {
      for (const placement of new Set(tasks.map((task) => task.placement))) assertSource(sourceId, placement)
    } catch (error) {
      return { ok: false, error: errorText(error), items: [] }
    }

    // The person's stated scope bounds how many distinct conversations this turn may create.
    const consumed = new Set(listConversationDispatchRequestKeys(sourceId, grant.originKey))
    const total = new Set([...consumed, ...tasks.map((task) => task.requestKey)]).size
    if (grant.maxConversations !== null && total > grant.maxConversations) {
      return {
        ok: false,
        error:
          `The person asked for ${grant.maxConversations} conversation(s) in this turn; this would make ${total}. ` +
          'Do not start more than requested.',
        items: [],
      }
    }

    // Validate every new item's settings before allocating anything.
    const resolved = new Map<string, { settings: ConversationDispatchSettings; inherited: string[] }>()
    const problems: ConversationDispatchItemResult[] = []
    for (const task of tasks) {
      const existing = findConversationDispatch(sourceId, grant.originKey, task.requestKey)
      if (existing && existing.phase !== 'discarded') continue
      const result = await deps.resolveSettings(sourceId, task.settings)
      if (result.ok) resolved.set(task.requestKey, { settings: result.settings, inherited: result.inherited })
      else problems.push({ requestKey: task.requestKey, title: task.title, status: 'failed', error: result.message })
    }
    if (problems.length) {
      return {
        ok: false,
        error: 'No conversation was created: fix the settings below (or ask the person) and call again.',
        items: problems,
      }
    }

    const notes: string[] = []
    let baseRevision: string | undefined
    if (tasks.some((task) => task.placement === 'worktree')) {
      const source = deps.getConversation(sourceId) as ProjectConversation
      baseRevision = (await deps.resolveHead(source.cwd)) ?? undefined
      if (!baseRevision) {
        return { ok: false, error: 'The current commit of the source checkout could not be resolved.', items: [] }
      }
      if (await deps.hasUncommittedChanges(source.cwd).catch(() => false)) {
        notes.push(
          `New worktrees start at commit ${baseRevision.slice(0, 12)}; uncommitted changes in this conversation's ` +
            'checkout are NOT included in them.'
        )
      }
    }

    const items: ConversationDispatchItemResult[] = []
    for (const task of tasks) {
      try {
        input.assertCurrent()
        throwIfCancelled(input.signal)
      } catch (error) {
        items.push({ requestKey: task.requestKey, title: task.title, status: 'skipped', error: errorText(error) })
        continue
      }
      try {
        const prepared = await prepare({
          sourceConversationId: sourceId,
          originKey: grant.originKey,
          requestKey: task.requestKey,
          kind: 'task',
          title: task.title,
          prompt: task.prompt,
          placement: task.placement,
          settings: task.settings,
          ...(task.source ? { sourceRef: task.source } : {}),
          ...(resolved.has(task.requestKey) ? { resolved: resolved.get(task.requestKey) } : {}),
          ...(baseRevision ? { baseRevision } : {}),
          signal: input.signal,
          assertCurrent: input.assertCurrent,
        })
        const started = await start(prepared.record.dispatchId, { focus: false })
        // Only an admitted first turn is reported as started.
        const status = started.status === 'started' ? 'started' : 'start-failed'
        const error =
          started.error ??
          (started.status === 'starting' ? 'The first turn is still being admitted; check the conversation.' : undefined)
        items.push(
          itemFromRecord(started.record, status, {
            ...(prepared.replayed || started.replayed ? { replayed: true } : {}),
            ...(error ? { error } : {}),
          })
        )
      } catch (error) {
        items.push({ requestKey: task.requestKey, title: task.title, status: 'failed', error: errorText(error) })
      }
    }
    return {
      ok: items.some((item) => item.status === 'started'),
      items,
      ...(notes.length ? { notes } : {}),
    }
  }

  /** Retry the first turn of a destination whose start failed (Plan handoff banner). */
  async function retryStart(conversationId: string): Promise<{ ok: boolean; error?: string }> {
    const record = getConversationDispatchByDestination(conversationId)
    if (record?.phase !== 'start-failed') return { ok: false, error: 'not-startable' }
    try {
      const started = await start(record.dispatchId, { focus: false })
      return started.status === 'start-failed' ? { ok: false, error: started.error } : { ok: true }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  function status(conversationId: string): { phase: string; error: string | null; sourceConversationId: string } | null {
    const record = getConversationDispatchByDestination(conversationId)
    return record ? { phase: record.phase, error: record.error, sourceConversationId: record.sourceConversationId } : null
  }

  return { prepare, start, discard, dispatchBatch, retryStart, reconcile, status }
}

export type ConversationDispatchService = ReturnType<typeof createConversationDispatchService>

// ---------------------------------------------------------------------------------------------------------------
// Production wiring. Loaded lazily: chat tools reach this module from inside the chat engine, so static imports of
// the chat service here would form an initialization cycle.
// ---------------------------------------------------------------------------------------------------------------

const MODEL_CATALOG_TTL_MS = 60_000
let modelCatalog: { at: number; value: Promise<ConversationDispatchModelOption[]> } | null = null

/** Executable provider/model pairs with their effort levels and Fast support (includes API-key providers). */
export async function listConversationDispatchModels(): Promise<ConversationDispatchModelOption[]> {
  if (modelCatalog && Date.now() - modelCatalog.at < MODEL_CATALOG_TTL_MS) return modelCatalog.value
  const value = import('./chat/service').then(async ({ listChatRunnerCapabilities }) =>
    (await listChatRunnerCapabilities(true)).map((entry) => ({
      providerId: entry.providerId,
      providerLabel: entry.providerLabel,
      modelId: entry.modelId,
      reasoningEfforts: entry.reasoningEfforts,
      fastMode: entry.fastMode,
    }))
  )
  modelCatalog = { at: Date.now(), value }
  value.catch(() => {
    if (modelCatalog?.value === value) modelCatalog = null
  })
  return value
}

async function buildDefaultConversationDispatchService(): Promise<ConversationDispatchService> {
  const [store, chat, workspace, git, windowIpc, i18n, migration, reviewLoop, remote, settings, dispatchStore] =
    await Promise.all([
      import('./store'),
      import('./chat/service'),
      import('./workspace-service'),
      import('./git-service'),
      import('./window-ipc'),
      import('./i18n'),
      import('./conversation-migration/store'),
      import('./chat/review-loop/registry'),
      import('./chat/remote-policy'),
      import('./conversation-dispatch-settings'),
      import('./conversation-dispatch-store'),
    ])
  return createConversationDispatchService({
    getConversation: (id) => store.getConversation(id),
    resolveSettings: (sourceConversationId, requested) =>
      settings.resolveConversationDispatchSettings(sourceConversationId, requested, {
        sourceSettings: chat.conversationExecutionSettings,
        listModels: listConversationDispatchModels,
        describeModel: chat.describeChatModelForDispatch,
        validateSelection: async (conversationId, selected) => {
          try {
            const result = await chat.resolveReviewLoopSelection(conversationId, {
              providerId: selected.providerId,
              modelId: selected.modelId,
              effort: selected.reasoning,
              fastMode: selected.fastMode,
            })
            return result.ok ? { ok: true } : { ok: false, error: result.error }
          } catch (error) {
            return { ok: false, error: errorText(error) }
          }
        },
      }),
    resolveHead: (cwd) => git.resolveCommit(cwd),
    hasUncommittedChanges: async (cwd) => (await git.gitEnvInfo(cwd))?.dirty === true,
    createShared: (sourceConversationId, options) =>
      workspace.createSiblingConversation(sourceConversationId, {
        experience: 'standard',
        name: options.name,
        id: options.id,
      }),
    createIsolated: (args) =>
      workspace.createConversation({
        id: args.id,
        workspaceId: args.workspaceId,
        branch: args.branch,
        isNewBranch: true,
        baseRevision: args.baseRevision,
        mode: 'worktree',
        experience: 'standard',
        name: args.name,
      }),
    deleteConversation: (id, options) => workspace.deleteConversation(id, options),
    cleanupIsolated: async (workspaceId, branch) => {
      const owner = store.getWorkspace(workspaceId)
      if (!owner) return
      const tree = (await git.listWorktrees(owner.path)).find((item) => item.branch === branch)
      if (tree) await git.removeWorktree(owner.path, tree.path, true)
      if (await git.branchExists(owner.path, branch)) await git.deleteBranch(owner.path, branch)
    },
    applySettings: (conversationId, selected) => {
      chat.primeChatTurnSelection(conversationId, selected)
      chat.setChatMode(conversationId, 'agent')
    },
    readSettings: chat.persistedConversationSettings,
    startTurn: chat.startConversationDispatchTurn,
    hasPersistedMessages: dispatchStore.conversationHasMessages,
    openConversation: (conversation, focus) => windowIpc.broadcast('conversation:open', { conversation, focus }),
    notifyChanged: (conversationId) => windowIpc.broadcast('conversation-dispatch:changed', { conversationId }),
    reportStartFailure: chat.reportConversationDispatchStartFailure,
    isReserved: (conversationId) => !!reviewLoop.lookupReviewLoopByConversation(conversationId),
    isMigrating: (conversationId) => !!migration.incompleteMigrationForConversation(conversationId),
    isWebManaged: remote.isWebManagedConversation,
    text: (key, params) => i18n.tFor(store.getLocale(), 'prompts')(key, params),
  })
}

let defaultService: Promise<ConversationDispatchService> | null = null

export function getConversationDispatchService(): Promise<ConversationDispatchService> {
  defaultService ??= buildDefaultConversationDispatchService().catch((error) => {
    defaultService = null
    throw error
  })
  return defaultService
}
