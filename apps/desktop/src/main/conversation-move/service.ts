import { randomUUID } from 'node:crypto'
import {
  canRollbackMovePhase,
  MOVE_PREPARE_TTL_MS,
  type MoveBlocker,
  type MoveChangedEvent,
  type MoveExecuteInput,
  type MovePhase,
  type MovePrepareInput,
  type MovePreview,
  type MoveRecovery,
  type MoveResult,
  type MoveTargetPlan,
  type MoveWarningCode,
} from '../../shared/conversation-move'
import { type HostId, isRemoteHostId } from '../../shared/host-key'
import type { MoveEndpoint } from './endpoint'
import { MoveError, moveErrorCode, moveErrorMessage } from './errors'
import { decideTargetBranch, sameDigest } from './plan'
import type { PackageRelay } from './relay'
import {
  advanceMove,
  type ConversationMoveRecord,
  findIncompleteMoveForConversation,
  getMove,
  insertMove,
  isMoveTerminal,
  listIncompleteMoves,
  markMoveRecoveryRequired,
  type MoveSelection,
  patchMoveState,
} from './store'

export interface ConversationMoveServiceDeps {
  /** The endpoint of a host; throws `host-unavailable` when it cannot be reached. */
  endpoint(hostId: HostId): MoveEndpoint
  hostOnline(hostId: HostId): boolean
  relay: PackageRelay
  /** This computer's staging folder for a move, where a package from a remote source lands. */
  localStagingDirectory(operationId: string): Promise<string>
  /** Removes that folder once a move between two remote hosts no longer needs it. */
  removeLocalStaging?(operationId: string): Promise<void>
  now?: () => number
}

const INTERRUPTED = 'Interrupted; continue or roll back.'

/**
 * Moves a conversation between two hosts, coordinated by this computer: it journals each move and walks it through
 * its phases, calling the source and target endpoints and relaying the package between them. A failure stops the
 * move for recovery: before the source is released it may be rolled back (the target discarded, the source thawed);
 * afterwards it can only go on, since the destination was verified.
 */
export class ConversationMoveService {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly listeners = new Set<(event: MoveChangedEvent) => void>()
  private readonly now: () => number

  constructor(private readonly deps: ConversationMoveServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  onChanged(listener: (event: MoveChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(record: ConversationMoveRecord, extra: Partial<MoveChangedEvent> = {}): void {
    const event: MoveChangedEvent = {
      operationId: record.id,
      conversationId: record.conversationId,
      sourceHostId: record.sourceHostId,
      targetHostId: record.targetHostId,
      phase: record.phase,
      status: record.status,
      ...(record.error ? { error: record.error } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      ...extra,
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[conversation-move] failed to report progress:', error)
      }
    }
  }

  private publishCurrent(id: string): ConversationMoveRecord {
    const record = getMove(id)
    if (!record) throw new Error('Move not found.')
    this.publish(record)
    return record
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

  private recoveryOf(record: ConversationMoveRecord): MoveRecovery {
    const rollingBack = record.phase === 'rolling-back'
    return {
      operationId: record.id,
      conversationId: record.conversationId,
      conversationName: record.conversationName,
      sourceHostId: record.sourceHostId,
      targetHostId: record.targetHostId,
      phase: record.phase,
      status: record.status,
      canContinue:
        !rollingBack &&
        record.phase !== 'prepared' &&
        (record.status === 'recovery-required' || record.status === 'running'),
      canRollback: rollingBack || canRollbackMovePhase(record.phase),
      ...(record.error ? { message: record.error } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    }
  }

  private resultOf(record: ConversationMoveRecord): MoveResult {
    if (record.status === 'completed')
      return {
        operationId: record.id,
        status: 'completed',
        target: { hostId: record.targetHostId, conversationId: record.conversationId },
      }
    if (record.status === 'cancelled' || record.status === 'rolled-back')
      return { operationId: record.id, status: record.status }
    return { operationId: record.id, status: 'recovery-required', recovery: this.recoveryOf(record) }
  }

  private blockedPreview(input: MovePrepareInput, blockers: MoveBlocker[]): MovePreview {
    return {
      operationId: null,
      expiresAt: this.now() + MOVE_PREPARE_TTL_MS,
      conversationId: input.conversationId,
      conversationName: '',
      sourceHostId: input.sourceHostId,
      targetHostId: input.targetHostId,
      source: {
        cwd: '',
        branch: null,
        headOid: '',
        mode: 'worktree',
        commitsAhead: 0,
        changes: { staged: [], unstaged: [], untracked: [] },
      },
      target: null,
      ignored: [],
      transcript: { messages: 0, files: 0, fileBytes: 0 },
      warnings: [],
      blockers,
      fingerprint: '',
    }
  }

  /** A prepared move nobody executed in time stops holding its conversation. */
  private expireStalePreview(record: ConversationMoveRecord | undefined): ConversationMoveRecord | undefined {
    if (record?.phase !== 'prepared' || this.now() - record.createdAt <= MOVE_PREPARE_TTL_MS) return record
    if (advanceMove(record.id, 'prepared', { phase: 'cancelled', status: 'cancelled' })) this.publishCurrent(record.id)
    return undefined
  }

  async prepare(input: MovePrepareInput): Promise<MovePreview> {
    const { sourceHostId, targetHostId, conversationId } = input
    if (sourceHostId === targetHostId)
      return this.blockedPreview(input, [{ code: 'same-host', message: 'The conversation is already on that host.' }])
    const offline = [sourceHostId, targetHostId].filter((hostId) => !this.deps.hostOnline(hostId))
    if (offline.length > 0)
      return this.blockedPreview(input, [
        { code: 'host-unavailable', message: `Not connected to ${offline.join(', ')}.` },
      ])
    if (this.expireStalePreview(findIncompleteMoveForConversation(conversationId)))
      return this.blockedPreview(input, [
        { code: 'incomplete-operation', message: 'Another move of this conversation has not finished.' },
      ])
    const source = this.deps.endpoint(sourceHostId)
    const target = this.deps.endpoint(targetHostId)
    const inspected = await source.inspectSource({ conversationId })
    const blockers: MoveBlocker[] = [...inspected.blockers]
    const warnings: MoveWarningCode[] = [...inspected.warnings]
    let plan: MoveTargetPlan | null = null
    if (blockers.length === 0 && inspected.remoteUrl && inspected.branch) {
      const destination = await target.inspectTarget({
        conversationId,
        remoteUrl: inspected.remoteUrl,
        defaultBranch: inspected.defaultBranch,
        branch: input.targetBranch ?? inspected.branch,
        headOid: inspected.headOid,
      })
      blockers.push(...destination.blockers)
      if (destination.workspace && destination.blockers.length === 0) {
        const { branch } = destination
        // The target cannot tell ancestry without the moved commits; the source can, when it has the target's tip.
        const sourceAncestor =
          branch.state === 'exists' && branch.ancestor === null && branch.tipOid
            ? await source.checkAncestry({ conversationId, ancestorOid: branch.tipOid })
            : null
        const decision = decideTargetBranch({
          source: inspected,
          target: destination,
          explicit: input.targetBranch !== undefined,
          sourceAncestor,
        })
        if ('blocker' in decision) blockers.push(decision.blocker)
        else {
          plan = {
            workspace: destination.workspace,
            branch: decision.branch,
            branchAction: decision.action,
            ...(decision.expectedTipOid ? { expectedTipOid: decision.expectedTipOid } : {}),
          }
          if (decision.renamed) warnings.push('branch-renamed')
          if (destination.workspace.kind === 'clone') warnings.push('clone-required')
        }
      }
    }
    const now = this.now()
    const operationId = blockers.length === 0 && plan ? randomUUID() : null
    const preview: MovePreview = {
      operationId,
      expiresAt: now + MOVE_PREPARE_TTL_MS,
      conversationId,
      conversationName: inspected.conversationName,
      sourceHostId,
      targetHostId,
      source: {
        cwd: inspected.cwd,
        branch: inspected.branch,
        headOid: inspected.headOid,
        mode: inspected.mode,
        commitsAhead: inspected.commitsAhead,
        changes: inspected.changes,
      },
      target: plan,
      ignored: inspected.ignored,
      transcript: inspected.transcript,
      warnings,
      blockers,
      fingerprint: inspected.fingerprint,
    }
    if (operationId) {
      insertMove({
        id: operationId,
        conversationId,
        conversationName: inspected.conversationName,
        sourceHostId,
        targetHostId,
        phase: 'prepared',
        status: 'prepared',
        preview,
        selection: { selectedIgnoredPaths: [], confirmedSensitivePaths: [] },
        state: {},
        createdAt: now,
        updatedAt: now,
      })
      this.publishCurrent(operationId)
    }
    return preview
  }

  async execute(input: MoveExecuteInput): Promise<MoveResult> {
    return this.serialized(input.operationId, async () => {
      const record = getMove(input.operationId)
      if (!record) throw new Error('Move not found.')
      if (record.phase !== 'prepared') return this.resultOf(record)
      if (!this.expireStalePreview(record)) throw new Error('The preview expired; prepare the move again.')
      const selection = this.validateSelection(record, input)
      if (!advanceMove(record.id, 'prepared', { phase: 'freezing', status: 'running', selection }))
        throw new Error('The move changed phase.')
      return this.run(this.publishCurrent(record.id))
    })
  }

  private validateSelection(record: ConversationMoveRecord, input: MoveExecuteInput): MoveSelection {
    const allowed = new Map(record.preview.ignored.map((entry) => [entry.path, entry]))
    const selected = [...new Set(input.selectedIgnoredPaths)]
    const confirmed = [...new Set(input.confirmedSensitivePaths ?? [])]
    for (const path of selected) {
      const entry = allowed.get(path)
      if (!entry?.selectable) throw new Error(`${path} is not in the allowed selection.`)
      if (entry.sensitive && !confirmed.includes(path)) throw new Error(`${path} requires additional confirmation.`)
    }
    return {
      selectedIgnoredPaths: selected,
      confirmedSensitivePaths: confirmed.filter((path) => selected.includes(path)),
    }
  }

  private next(record: ConversationMoveRecord, phase: MovePhase): ConversationMoveRecord {
    if (!advanceMove(record.id, record.phase, { phase, status: phase === 'completed' ? 'completed' : 'running' }))
      throw new Error('The move changed phase.')
    return this.publishCurrent(record.id)
  }

  private async run(initial: ConversationMoveRecord): Promise<MoveResult> {
    let record = initial
    try {
      const source = this.deps.endpoint(record.sourceHostId)
      const target = this.deps.endpoint(record.targetHostId)
      const operationId = record.id
      const conversationId = record.conversationId
      const plan = record.preview.target
      if (!plan) throw new Error('The move has no destination plan.')
      if (record.phase === 'freezing') {
        await source.freezeSource({ operationId, conversationId, fingerprint: record.preview.fingerprint })
        record = this.next(record, 'exporting')
      }
      if (record.phase === 'exporting') {
        const pkg = await source.exportSource({ operationId, ...record.selection })
        patchMoveState(operationId, { package: pkg })
        record = this.next(getMove(operationId)!, 'transferring')
      }
      if (record.phase === 'transferring') {
        const pkg = record.state.package
        if (!pkg) throw new Error('The move has no exported package.')
        const remote = isRemoteHostId(record.sourceHostId) || isRemoteHostId(record.targetHostId)
        const targetDirectory = isRemoteHostId(record.targetHostId)
          ? await target.stagingDirectory({ operationId })
          : null
        const moved = remote
          ? await this.deps.relay({
              operationId,
              from: record.sourceHostId,
              to: record.targetHostId,
              pkg,
              targetDirectory,
              localDirectory: await this.deps.localStagingDirectory(operationId),
              onProgress: (transfer) => this.publish(record, { transfer }),
            })
          : { path: pkg.path, transferIds: [] }
        patchMoveState(operationId, { targetPackagePath: moved.path, transferIds: moved.transferIds })
        record = this.next(getMove(operationId)!, 'preparing-target')
      }
      if (record.phase === 'preparing-target') {
        const current = record
        const off = target.onProgress(operationId, (progress) => {
          if (progress.step === 'clone')
            this.publish(current, {
              clone: {
                phase: progress.phase ?? '',
                ...(progress.percent === undefined ? {} : { percent: progress.percent }),
              },
            })
        })
        try {
          const { workspaceId } = await target.prepareTargetWorkspace({
            operationId,
            conversationId,
            workspace: plan.workspace,
          })
          patchMoveState(operationId, { targetWorkspaceId: workspaceId })
        } finally {
          off()
        }
        record = this.next(getMove(operationId)!, 'importing')
      }
      if (record.phase === 'importing') {
        const { package: pkg, targetPackagePath, targetWorkspaceId } = record.state
        if (!pkg || !targetPackagePath || !targetWorkspaceId) throw new Error('The move lost its import inputs.')
        const imported = await target.importTarget({
          operationId,
          packagePath: targetPackagePath,
          sha256: pkg.sha256,
          workspaceId: targetWorkspaceId,
          plan,
        })
        patchMoveState(operationId, { imported })
        record = this.next(getMove(operationId)!, 'verifying')
      }
      if (record.phase === 'verifying') {
        const pkg = record.state.package
        if (!pkg) throw new Error('The move has no exported package.')
        if (!sameDigest(await target.verifyTarget({ operationId }), pkg.digest))
          throw new MoveError('verification-failed', 'The destination differs from the exported conversation.')
        record = this.next(record, 'releasing-source')
      }
      if (record.phase === 'releasing-source') {
        await source.releaseSource({ operationId })
        record = this.next(record, 'committing')
      }
      if (record.phase === 'committing') {
        await target.commitTarget({ operationId })
        await source.cleanup({ operationId }).catch(() => undefined)
        if (isRemoteHostId(record.sourceHostId))
          await this.deps.removeLocalStaging?.(operationId).catch(() => undefined)
        record = this.next(record, 'completed')
      }
      return this.resultOf(record)
    } catch (error) {
      markMoveRecoveryRequired(record.id, moveErrorMessage(error), moveErrorCode(error))
      return this.resultOf(this.publishCurrent(record.id))
    }
  }

  private async rollback(record: ConversationMoveRecord): Promise<MoveResult> {
    if (record.phase === 'prepared') {
      if (!advanceMove(record.id, 'prepared', { phase: 'cancelled', status: 'cancelled' }))
        throw new Error('The move changed phase.')
      return this.resultOf(this.publishCurrent(record.id))
    }
    if (record.phase !== 'rolling-back') {
      if (!canRollbackMovePhase(record.phase)) throw new Error('The source was already released; continue the move.')
      if (!advanceMove(record.id, record.phase, { phase: 'rolling-back', status: 'running', error: null }))
        throw new Error('The move changed phase.')
      record = this.publishCurrent(record.id)
    } else if (!advanceMove(record.id, 'rolling-back', { phase: 'rolling-back', status: 'running', error: null })) {
      throw new Error('The move changed phase.')
    }
    try {
      await this.deps.endpoint(record.targetHostId).discardTarget({ operationId: record.id })
      await this.deps.endpoint(record.sourceHostId).thawSource({ operationId: record.id })
      if (isRemoteHostId(record.sourceHostId)) await this.deps.removeLocalStaging?.(record.id).catch(() => undefined)
      if (!advanceMove(record.id, 'rolling-back', { phase: 'rolled-back', status: 'rolled-back', error: null }))
        throw new Error('The move changed phase.')
      return this.resultOf(this.publishCurrent(record.id))
    } catch (error) {
      markMoveRecoveryRequired(record.id, moveErrorMessage(error), moveErrorCode(error))
      return this.resultOf(this.publishCurrent(record.id))
    }
  }

  /** A move nobody started yet: nothing was frozen, so it simply ends. */
  async cancel(operationId: string): Promise<void> {
    await this.serialized(operationId, async () => {
      const record = getMove(operationId)
      if (!record) throw new Error('Move not found.')
      if (isMoveTerminal(record)) return
      if (record.phase !== 'prepared') throw new Error('The move already started; roll it back instead.')
      if (!advanceMove(operationId, 'prepared', { phase: 'cancelled', status: 'cancelled' }))
        throw new Error('The move changed phase.')
      this.publishCurrent(operationId)
    })
  }

  async resolve(operationId: string, action: 'continue' | 'rollback'): Promise<MoveResult> {
    return this.serialized(operationId, async () => {
      const record = getMove(operationId)
      if (!record) throw new Error('Move not found.')
      if (isMoveTerminal(record)) return this.resultOf(record)
      if (action === 'rollback') return this.rollback(record)
      if (record.phase === 'prepared') throw new Error('Execute or cancel the prepared move.')
      if (record.phase === 'rolling-back') throw new Error('Finish rolling the move back.')
      if (!advanceMove(record.id, record.phase, { phase: record.phase, status: 'running', error: null }))
        throw new Error('The move changed phase.')
      return this.run(this.publishCurrent(record.id))
    })
  }

  listRecoveries(): MoveRecovery[] {
    return listIncompleteMoves()
      .filter((record) => record.phase !== 'prepared')
      .map((record) => this.recoveryOf(record))
  }

  /**
   * After a restart: a move that was running stopped halfway and waits for the person, and a preview nobody executed
   * is dropped, since its dialog is gone.
   */
  markInterrupted(): void {
    for (const record of listIncompleteMoves()) {
      if (record.phase === 'prepared') {
        if (advanceMove(record.id, 'prepared', { phase: 'cancelled', status: 'cancelled' }))
          this.publishCurrent(record.id)
      } else if (record.status === 'running') {
        markMoveRecoveryRequired(record.id, INTERRUPTED)
        this.publishCurrent(record.id)
      }
    }
  }
}
