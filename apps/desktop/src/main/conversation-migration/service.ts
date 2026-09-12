import { randomUUID } from 'node:crypto'
import type {
  ConversationMigrationRecord,
  MigrationChangedEvent,
  MigrationPreview,
  MigrationRecovery,
  MigrationResult,
} from '../../shared/conversation-migration'
import { migrationWorktreeDir } from '../app-paths'
import { deleteConversationGeneratedImages } from '../chat/generated-images'
import { deleteConversationAttachmentImages } from '../chat/attachment-artifacts'
import { inspectCwdActivity } from '../cwd-activity-coordinator'
import { countOtherRunningConversationsInCwd, getConversation, type Conversation } from '../store/conversations'
import { migrationGitAdapter, type MigrationGitAdapter, type MigrationGitPlan } from './git-adapter'
import { quiesceConversation } from './quiesce'
import {
  acquireMigrationLease,
  attachMigrationDestinationLease,
  getMigrationLease,
  restoreMigrationLease,
  type MigrationRuntimeLease,
} from './runtime-lease'
import {
  applyMigrationSidecars,
  inspectMigrationSidecars,
  migrationSidecarsAreRolledBack,
  planMigrationSidecars,
  rollbackMigrationSidecars,
  verifyMigrationSidecars,
} from './sidecars'
import {
  advanceMigration,
  commitConversationLocation,
  completeMigration,
  findIncompleteMigrationForScope,
  getMigration,
  insertMigration,
  isMigrationTerminal,
  listIncompleteMigrations,
  markMigrationRecoveryRequired,
  replaceMigrationSidecars,
  rollbackMigrationIdentity,
  updateMigrationGitState,
} from './store'

const PREPARE_TTL_MS = 15 * 60_000
type MigrationGitPlanRecord = MigrationGitPlan

export interface ConversationMigrationServiceDeps {
  git: MigrationGitAdapter
  destinationPath(workspaceId: string, branch: string, operationId: string): string
  inspectSidecars: typeof inspectMigrationSidecars
  planSidecars: typeof planMigrationSidecars
  applySidecars: typeof applyMigrationSidecars
  verifySidecars: typeof verifyMigrationSidecars
  rollbackSidecars: typeof rollbackMigrationSidecars
  quiesce: typeof quiesceConversation
}

const defaultDeps: ConversationMigrationServiceDeps = {
  git: migrationGitAdapter,
  destinationPath: migrationWorktreeDir,
  inspectSidecars: inspectMigrationSidecars,
  planSidecars: planMigrationSidecars,
  applySidecars: applyMigrationSidecars,
  verifySidecars: verifyMigrationSidecars,
  rollbackSidecars: rollbackMigrationSidecars,
  quiesce: quiesceConversation,
}

function recoveryOf(record: ConversationMigrationRecord, message = record.error): MigrationRecovery {
  const stashCleanupPending = record.phase === 'finalizing-stash'
  return {
    operationId: record.id,
    conversationId: record.conversationId,
    phase: record.phase,
    status: record.status,
    sourceCwd: record.sourceCwd,
    destinationCwd: record.destinationCwd,
    ...(record.stashOid ? { stashOid: record.stashOid } : {}),
    canContinue:
      !isMigrationTerminal(record) &&
      record.phase !== 'prepared' &&
      (record.phase !== 'rolling-back' || !record.legacySuccessorConversationId),
    canRollback: !isMigrationTerminal(record) && !stashCleanupPending,
    ...(message ? { message } : {}),
  }
}

function changedEventOf(record: ConversationMigrationRecord): MigrationChangedEvent {
  return {
    operationId: record.id,
    phase: record.phase,
    status: record.status,
    conversationId: record.conversationId,
    ...(record.error ? { error: record.error } : {}),
  }
}

function resultOf(record: ConversationMigrationRecord): MigrationResult {
  const status =
    record.status === 'prepared' || record.status === 'running' || record.status === 'awaiting-validation'
      ? 'recovery-required'
      : record.status
  return {
    operationId: record.id,
    status: status as MigrationResult['status'],
    conversationId: record.conversationId,
    ...(status === 'recovery-required' ? { recovery: recoveryOf(record) } : {}),
  }
}

function assertEligible(conversationId: string): Conversation {
  const conversation = getConversation(conversationId)
  if (!conversation) throw new Error('Conversation not found.')
  if (conversation.mode !== 'local' || conversation.isMulti !== 0 || conversation.archived !== 0) {
    throw new Error('Migration requires an active local single-repository conversation.')
  }
  const incomplete = findIncompleteMigrationForScope(conversation.id, conversation.cwd)
  if (incomplete) throw new Error(`An incomplete migration (${incomplete.id}) already exists in this scope.`)
  return conversation
}

export class ConversationMigrationService {
  private readonly deps: ConversationMigrationServiceDeps
  private readonly tails = new Map<string, Promise<void>>()
  private readonly changedListeners = new Set<(event: MigrationChangedEvent) => void>()

  constructor(deps: Partial<ConversationMigrationServiceDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps }
  }

  onChanged(listener: (event: MigrationChangedEvent) => void): () => void {
    this.changedListeners.add(listener)
    return () => this.changedListeners.delete(listener)
  }

  private publish(record: ConversationMigrationRecord): void {
    const event = changedEventOf(record)
    for (const listener of this.changedListeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[conversation-migration] failed to emit progress:', error)
      }
    }
  }

  private publishCurrent(operationId: string): ConversationMigrationRecord {
    const record = getMigration(operationId)
    if (!record) throw new Error('Migration not found while reporting progress.')
    this.publish(record)
    return record
  }

  private recoveryRequired(operationId: string, message: string): ConversationMigrationRecord {
    markMigrationRecoveryRequired(operationId, message)
    return this.publishCurrent(operationId)
  }

  private async serialized<T>(operationId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(operationId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.tails.set(operationId, tail)
    await previous
    try {
      return await run()
    } finally {
      release()
      if (this.tails.get(operationId) === tail) this.tails.delete(operationId)
    }
  }

  async prepare(conversationId: string, destinationBranch: string): Promise<MigrationPreview> {
    const conversation = assertEligible(conversationId)
    const branch = destinationBranch.trim()
    if (!branch) throw new Error('A destination branch is required.')
    const operationId = randomUUID()
    let lease: MigrationRuntimeLease | undefined
    let journaled = false
    try {
      const destinationCwd = this.deps.destinationPath(conversation.workspaceId, branch, operationId)
      // Git preview is read-only; acquire leases and quiesce only after it completes.
      const gitPlan = await this.deps.git.prepare({
        cwd: conversation.cwd,
        branch,
        destination: destinationCwd,
        activity: [],
      })
      const blockers = [...gitPlan.source.blockers]
      if (countOtherRunningConversationsInCwd(conversation.cwd, conversation.id) > 0) {
        blockers.push({
          code: 'cwd-active',
          message: 'Another conversation is running in this directory. Wait or stop it before migrating.',
        })
      }
      const sidecars = await this.deps.inspectSidecars(conversation.cwd, gitPlan.source.headOid)
      const now = Date.now()
      const record: ConversationMigrationRecord = {
        id: operationId,
        conversationId: conversation.id,
        sourceWorkspaceId: conversation.workspaceId,
        sourceBranch: gitPlan.source.currentBranch,
        destinationBranch: branch,
        sourceCwd: conversation.cwd,
        destinationCwd,
        sourceHeadOid: gitPlan.source.headOid,
        changes: gitPlan.source.status.changes,
        ignored: sidecars.ignored,
        selectedIgnoredPaths: [],
        confirmedSensitivePaths: [],
        gitPlan,
        sidecars: [],
        phase: 'prepared',
        status: 'prepared',
        stashMarker: gitPlan.stashMarker,
        baselineAssistants: 0,
        ...(blockers.length > 0 ? { error: blockers.map((item) => item.message).join('\n') } : {}),
        createdAt: now,
        updatedAt: now,
      }
      if (blockers.length === 0) {
        lease = acquireMigrationLease(operationId, conversation.id, conversation.cwd) ?? undefined
        if (!lease) throw new Error('The cwd is in use by another exclusive operation.')
        if (!attachMigrationDestinationLease(operationId, destinationCwd))
          throw new Error('The destination is already reserved by another operation.')
      }
      insertMigration(record)
      journaled = true
      this.publish(record)
      if (lease) {
        const quiesced = await this.deps.quiesce(conversation.id, conversation.cwd)
        if (!quiesced.ok) throw new Error(`Could not stop: ${quiesced.failed.join(', ')}.`)
        const residual = inspectCwdActivity(conversation.cwd).filter((item) => item.blocking)
        if (residual.length > 0)
          throw new Error(`The directory still has active execution (${residual.map((item) => item.kind).join(', ')}).`)
      }
      return {
        operationId,
        conversationId: conversation.id,
        sourceBranch: record.sourceBranch,
        sourceHeadOid: record.sourceHeadOid,
        sourceCwd: record.sourceCwd,
        destinationBranch: record.destinationBranch,
        destinationCwd: record.destinationCwd,
        changes: record.changes,
        ignored: record.ignored,
        blockers,
        expiresAt: now + PREPARE_TTL_MS,
      }
    } catch (error) {
      if (journaled) this.recoveryRequired(operationId, error instanceof Error ? error.message : String(error))
      else lease?.release()
      throw error
    }
  }

  async cancel(operationId: string): Promise<void> {
    await this.serialized(operationId, async () => {
      const record = getMigration(operationId)
      if (!record) throw new Error('Migration not found.')
      if (record.phase !== 'prepared')
        throw new Error('The migration has already made changes and cannot be canceled directly.')
      if (!advanceMigration(operationId, 'prepared', { phase: 'cancelled', status: 'cancelled' }))
        throw new Error('The migration phase changed.')
      this.publishCurrent(operationId)
      getMigrationLease(operationId)?.release()
    })
  }

  async execute(
    operationId: string,
    selectedIgnoredPaths: string[],
    confirmedSensitivePaths: string[]
  ): Promise<MigrationResult> {
    return this.serialized(operationId, async () => {
      const record = getMigration(operationId)
      if (!record) throw new Error('Migration not found.')
      if (record.phase !== 'prepared') return resultOf(record)
      if (record.error) throw new Error(record.error)
      if (Date.now() - record.createdAt > PREPARE_TTL_MS)
        throw new Error('O preview expirou; cancele e prepare novamente.')
      const allowed = new Map(record.ignored.map((entry) => [entry.path, entry]))
      const selected = [...new Set(selectedIgnoredPaths)]
      const confirmed = [...new Set(confirmedSensitivePaths)]
      for (const path of selected) {
        const entry = allowed.get(path)
        if (!entry?.selectable) throw new Error(`${path} is not in the allowed selection.`)
        if (entry.sensitive && !confirmed.includes(path)) throw new Error(`${path} requires additional confirmation.`)
      }
      if (
        !advanceMigration(operationId, 'prepared', {
          phase: 'transferring',
          status: 'running',
          selectedIgnoredPaths: selected,
          confirmedSensitivePaths: confirmed,
          error: null,
        })
      )
        throw new Error('The migration phase changed.')
      return this.continueRunning(this.publishCurrent(operationId))
    })
  }

  private ensureLease(record: ConversationMigrationRecord): MigrationRuntimeLease {
    const existing = getMigrationLease(record.id)
    if (existing) return existing
    const restored = restoreMigrationLease(record.id, record.sourceCwd, record.destinationCwd)
    if (!restored) throw new Error('Could not restore the exclusive migration lease.')
    return restored
  }

  private async continueRunning(record: ConversationMigrationRecord): Promise<MigrationResult> {
    this.ensureLease(record)
    let current = record
    try {
      if (current.phase === 'transferring') {
        const transfer = await this.deps.git.continue(current.gitPlan as MigrationGitPlanRecord)
        const stash =
          transfer.status === 'applied' || transfer.status === 'recovery-required'
            ? { stashOid: transfer.stashOid, stashMarker: transfer.marker }
            : {}
        updateMigrationGitState(current.id, {
          ...stash,
          stashMarker: stash.stashMarker ?? (current.gitPlan as MigrationGitPlanRecord).stashMarker,
          error: transfer.status === 'recovery-required' ? transfer.recovery.message : null,
        })
        if (transfer.status !== 'applied') {
          const message =
            transfer.status === 'recovery-required'
              ? transfer.recovery.message
              : transfer.status === 'stale'
                ? 'Git state changed since preview.'
                : 'Git transfer was blocked during revalidation.'
          return resultOf(this.recoveryRequired(current.id, message))
        }
        if (
          !getMigrationLease(current.id)?.destination &&
          !attachMigrationDestinationLease(current.id, current.destinationCwd)
        ) {
          return resultOf(this.recoveryRequired(current.id, 'Could not lock the destination worktree after transfer.'))
        }
        if (!advanceMigration(current.id, 'transferring', { phase: 'sidecars', status: 'running' }))
          throw new Error('The phase changed after Git transfer.')
        current = this.publishCurrent(current.id)
      }

      if (current.phase === 'sidecars') {
        const args = {
          sourceCwd: current.sourceCwd,
          destinationCwd: current.destinationCwd,
          targetOid: current.sourceHeadOid,
          selectedIgnoredPaths: current.selectedIgnoredPaths,
          confirmedSensitivePaths: current.confirmedSensitivePaths,
        }
        if (current.sidecars.length === 0) {
          const planned = await this.deps.planSidecars(args)
          if (planned.mutations.length > 0) {
            replaceMigrationSidecars(current.id, planned.mutations)
            current = getMigration(current.id)!
          }
        }
        if (
          current.sidecars.length > 0 &&
          !(await this.deps.verifySidecars(current.destinationCwd, current.sidecars))
        ) {
          await this.deps.applySidecars(args, current.sidecars)
        }
        if (!(await this.deps.verifySidecars(current.destinationCwd, current.sidecars))) {
          return resultOf(
            this.recoveryRequired(current.id, 'Sidecars differ from the journal; explicit review is required.')
          )
        }
        if (!advanceMigration(current.id, 'sidecars', { phase: 'identity', status: 'running' }))
          throw new Error('The phase changed after sidecar processing.')
        current = this.publishCurrent(current.id)
      }

      if (current.phase === 'identity') {
        const source = getConversation(current.conversationId)
        if (!source) throw new Error('Conversation not found.')
        if (
          !commitConversationLocation(current.id, 'identity', {
            conversationId: source.id,
            branch: current.destinationBranch,
            cwd: current.destinationCwd,
          })
        )
          throw new Error('The phase changed while committing identity.')
        updateMigrationGitState(current.id, { error: null })
        current = this.publishCurrent(current.id)
      }
      if (current.phase === 'awaiting-validation') {
        return this.adoptDestination(current)
      }
      if (current.phase === 'finalizing') return this.finalize(current)
      if (current.phase === 'finalizing-stash') return this.finalizeStash(current)
      return resultOf(current)
    } catch (error) {
      return resultOf(this.recoveryRequired(current.id, error instanceof Error ? error.message : String(error)))
    }
  }

  private async finalize(record: ConversationMigrationRecord): Promise<MigrationResult> {
    // Verify transfer/sidecars before committing identity. Afterward destination changes are legitimate
    // work; repeating snapshot checks would incorrectly force recovery from normal use.
    if (!advanceMigration(record.id, 'finalizing', { phase: 'finalizing-stash', status: 'running', error: null })) {
      throw new Error('The phase changed before dropping the stash.')
    }
    return this.finalizeStash(this.publishCurrent(record.id))
  }

  private async finalizeStash(record: ConversationMigrationRecord): Promise<MigrationResult> {
    let stashCleaned = false
    try {
      stashCleaned = await this.deps.git.finalize(
        record.gitPlan as MigrationGitPlanRecord,
        record.stashOid,
        record.stashMarker
      )
    } catch (error) {
      console.warn(`[conversation-migration] failed to clean protected stash for ${record.id}:`, error)
    }
    if (!stashCleaned) {
      // Once transfer is validated, housekeeping failure must not retain directory/conversation locks.
      // Preserve the marked stash as backup for later manual removal.
      console.warn(`[conversation-migration] protected stash preserved after completing ${record.id}.`)
    }
    if (!completeMigration(record.id)) throw new Error('The migration could not be marked as complete.')
    const completed = this.publishCurrent(record.id)
    getMigrationLease(record.id)?.release()
    return resultOf(completed)
  }

  /**
   * Adopt the current destination without requiring the original snapshot. Supports older journals
   * waiting on a message and aborting rollback before destructive removal.
   */
  private async adoptDestination(record: ConversationMigrationRecord): Promise<MigrationResult> {
    if (record.legacySuccessorConversationId) {
      throw new Error('Legacy migrations with a successor conversation only support safe rollback.')
    }
    const conversation = getConversation(record.conversationId)
    if (
      !conversation ||
      conversation.cwd !== record.destinationCwd ||
      conversation.branch !== record.destinationBranch ||
      conversation.mode !== 'worktree'
    ) {
      return resultOf(
        this.recoveryRequired(record.id, 'The conversation no longer points to the destination worktree.')
      )
    }
    if (!(await this.deps.git.verifyDestination(record.gitPlan as MigrationGitPlanRecord))) {
      return resultOf(this.recoveryRequired(record.id, 'The destination worktree could not be safely adopted.'))
    }
    if (
      !advanceMigration(record.id, record.phase, {
        phase: 'finalizing-stash',
        status: 'running',
        error: null,
      })
    ) {
      throw new Error('The phase changed before adopting the destination worktree.')
    }
    return this.finalizeStash(this.publishCurrent(record.id))
  }

  async resolve(operationId: string, action: 'continue' | 'rollback'): Promise<MigrationResult> {
    return this.serialized(operationId, async () => {
      const record = getMigration(operationId)
      if (!record) throw new Error('Migration not found.')
      if (action === 'rollback') {
        if (record.phase === 'finalizing-stash')
          throw new Error('The stash has entered final cleanup; this migration can only be completed.')
        return this.rollback(record)
      }
      if (record.phase === 'prepared') throw new Error(record.error ?? 'Cancel and prepare the migration again.')
      if (record.phase === 'awaiting-validation' || record.phase === 'rolling-back' || record.phase === 'finalizing') {
        return this.adoptDestination(record)
      }
      return this.continueRunning(getMigration(record.id)!)
    })
  }

  private async rollback(record: ConversationMigrationRecord): Promise<MigrationResult> {
    if (isMigrationTerminal(record)) return resultOf(record)
    if (record.phase === 'prepared') {
      if (!advanceMigration(record.id, 'prepared', { phase: 'cancelled', status: 'cancelled' }))
        throw new Error('The phase changed during cancellation.')
      const cancelled = this.publishCurrent(record.id)
      getMigrationLease(record.id)?.release()
      return resultOf(cancelled)
    }
    if (!advanceMigration(record.id, record.phase, { phase: 'rolling-back', status: 'running', error: null }))
      throw new Error('The phase changed before rollback.')
    const current = this.publishCurrent(record.id)
    try {
      const validationConversationId = current.legacySuccessorConversationId ?? current.conversationId
      const validationConversation = getConversation(validationConversationId)
      if (validationConversation?.cwd === current.destinationCwd) {
        const quiesced = await this.deps.quiesce(validationConversationId, current.destinationCwd)
        if (!quiesced.ok) throw new Error(`Could not stop the validation conversation: ${quiesced.failed.join(', ')}.`)
      }
      if (
        !(await migrationSidecarsAreRolledBack(current.destinationCwd, current.sidecars)) &&
        !(await this.deps.rollbackSidecars(current.destinationCwd, current.sidecars))
      ) {
        throw new Error('Sidecars changed and could not be safely rolled back.')
      }
      const plan = current.gitPlan as MigrationGitPlanRecord
      if (!(await this.deps.git.isRolledBack(plan)) && !(await this.deps.git.rollback(plan, current.stashOid))) {
        throw new Error('Git state could not be safely rolled back.')
      }
      if (!(await this.deps.git.discardStash(plan, current.stashOid, current.stashMarker))) {
        throw new Error('The batch returned to the source, but the operation stash could not be dropped.')
      }
      if (current.legacySuccessorConversationId) {
        // Remove the legacy successor at the journal checkpoint. Perform idempotent disk cleanup beforehand
        // so a crash after SQLite deletion cannot leave cleanup inaccessible.
        await deleteConversationGeneratedImages(current.legacySuccessorConversationId)
        await deleteConversationAttachmentImages(current.legacySuccessorConversationId)
      }
      if (!rollbackMigrationIdentity(current.id)) throw new Error('The phase changed while completing rollback.')
      const rolledBack = this.publishCurrent(current.id)
      getMigrationLease(current.id)?.release()
      return resultOf(rolledBack)
    } catch (error) {
      return resultOf(this.recoveryRequired(current.id, error instanceof Error ? error.message : String(error)))
    }
  }

  async recoverIncomplete(): Promise<MigrationRecovery[]> {
    const recoveries: MigrationRecovery[] = []
    for (const record of listIncompleteMigrations()) {
      const blockedPreview = record.phase === 'prepared' && record.status === 'prepared' && !!record.error
      const lease = blockedPreview
        ? undefined
        : restoreMigrationLease(record.id, record.sourceCwd, record.destinationCwd)
      let published = false
      if (!lease && !blockedPreview) {
        this.recoveryRequired(record.id, 'Could not restore the exclusive lock after restart.')
        published = true
      } else if (record.phase === 'awaiting-validation' && lease) {
        await this.adoptDestination(record)
        const reconciled = getMigration(record.id)!
        if (isMigrationTerminal(reconciled)) continue
        recoveries.push(recoveryOf(reconciled))
        continue
      }
      const recovered = getMigration(record.id)!
      if (!published) this.publish(recovered)
      recoveries.push(recoveryOf(recovered))
    }
    return recoveries.filter((recovery) => !isMigrationTerminal(getMigration(recovery.operationId)!))
  }

  replayIncomplete(): void {
    for (const record of listIncompleteMigrations()) this.publish(record)
  }
  listRecoveries(): MigrationRecovery[] {
    return listIncompleteMigrations().map((record) => recoveryOf(record))
  }
}

export const conversationMigrationService = new ConversationMigrationService()
