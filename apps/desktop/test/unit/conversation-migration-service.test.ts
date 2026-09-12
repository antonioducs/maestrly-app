import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getConversation, getDb } from '../../src/main/store'
import { __resetCwdActivityForTests } from '../../src/main/cwd-activity-coordinator'
import { __resetMigrationLeasesForTests, getMigrationLease } from '../../src/main/conversation-migration/runtime-lease'
import {
  ConversationMigrationService,
  type ConversationMigrationServiceDeps,
} from '../../src/main/conversation-migration/service'
import { getMigration } from '../../src/main/conversation-migration/store'
import type { SidecarMutation } from '../../src/shared/conversation-migration'

function gitPlan(cwd: string, branch: string, destination: string) {
  return {
    source: {
      cwd,
      currentBranch: 'main',
      headOid: 'a'.repeat(40),
      target: { branch, oid: 'a'.repeat(40) },
      status: { raw: 'dirty', changes: { staged: ['tracked.ts'], unstaged: [], untracked: [] } },
      blockers: [],
      activity: [],
      fingerprint: 'fingerprint',
    },
    destination,
    preservationFingerprint: 'preserved',
    ignoredPaths: [],
    stashMarker: 'maestrly-migration:test',
  } as any
}

function harness() {
  const workspace = makeWorkspace({ id: 'ws', path: '/repo' })
  const source = makeConversation(workspace.id, { id: 'source', cwd: '/repo', branch: 'main', mode: 'local' })
  const git = {
    prepare: vi.fn(async ({ cwd, branch, destination }) => gitPlan(cwd, branch, destination)),
    execute: vi.fn(),
    continue: vi.fn(async () => ({
      status: 'applied' as const,
      stashOid: 'b'.repeat(40),
      marker: 'maestrly-migration:test',
    })),
    verify: vi.fn(async () => true),
    verifyDestination: vi.fn(async () => true),
    finalize: vi.fn(async () => true),
    discardStash: vi.fn(async () => true),
    findStash: vi.fn(async () => 'b'.repeat(40)),
    rollback: vi.fn(async () => true),
    isRolledBack: vi.fn(async () => false),
  }
  const deps: Partial<ConversationMigrationServiceDeps> = {
    git: git as any,
    destinationPath: (_workspaceId, branch, operationId) => `/migrations/${branch}-${operationId}`,
    inspectSidecars: vi.fn(async () => ({ ignored: [], warnings: [] })),
    planSidecars: vi.fn(async () => ({ mutations: [], warnings: [] })),
    applySidecars: vi.fn(async () => ({ mutations: [], warnings: [] })),
    verifySidecars: vi.fn(async (_cwd, _mutations: SidecarMutation[]) => true),
    rollbackSidecars: vi.fn(async () => true),
    quiesce: vi.fn(async () => ({ ok: true, failed: [] })),
  }
  return {
    source,
    git,
    deps,
    service: new ConversationMigrationService(deps),
  }
}

beforeEach(() => {
  freshDb()
  __resetCwdActivityForTests()
})
afterEach(() => {
  __resetMigrationLeasesForTests()
  __resetCwdActivityForTests()
  closeDb()
})

describe('conversation migration saga Chat-only', () => {
  it('follows preview, lease, quiesce, transfer and sidecars while preserving identity', async () => {
    const { source, service, deps } = harness()
    const preview = await service.prepare(source.id, 'feature/chat-only')
    expect(preview).not.toHaveProperty('continuation')
    expect(getMigrationLease(preview.operationId)).toBeDefined()
    expect(deps.quiesce).toHaveBeenCalledWith(source.id, '/repo')

    const result = await service.execute(preview.operationId, [], [])
    expect(result).toMatchObject({ status: 'completed', conversationId: source.id })
    expect(getConversation(source.id)).toMatchObject({
      id: source.id,
      cwd: preview.destinationCwd,
      branch: 'feature/chat-only',
      mode: 'worktree',
    })
    expect(getMigration(preview.operationId)).toMatchObject({ conversationId: source.id, phase: 'completed' })
    expect(getMigrationLease(preview.operationId)).toBeUndefined()
  })

  it('drops the stash and completes without waiting for a Chat turn', async () => {
    const { source, service, git } = harness()
    const preview = await service.prepare(source.id, 'feature/validate')
    await expect(service.execute(preview.operationId, [], [])).resolves.toMatchObject({
      status: 'completed',
    })
    expect(git.finalize).toHaveBeenCalledWith(expect.anything(), 'b'.repeat(40), 'maestrly-migration:test')
    expect(getMigrationLease(preview.operationId)).toBeUndefined()
  })

  it('completes migration when only stash cleanup fails', async () => {
    const { source, service, git } = harness()
    vi.mocked(git.finalize).mockResolvedValueOnce(false)
    const preview = await service.prepare(source.id, 'feature/stash-cleanup')

    await expect(service.execute(preview.operationId, [], [])).resolves.toMatchObject({ status: 'completed' })
    expect(getMigration(preview.operationId)).toMatchObject({ phase: 'completed', status: 'completed' })
    expect(getMigrationLease(preview.operationId)).toBeUndefined()
  })

  it('allows keeping the worktree when rollback enters recovery before destination removal', async () => {
    const { source, service, git } = harness()
    const preview = await service.prepare(source.id, 'feature/adopt')
    getDb()
      .prepare(
        "UPDATE conversation_migrations SET phase = 'rolling-back', status = 'recovery-required', stash_oid = ? WHERE id = ?"
      )
      .run('b'.repeat(40), preview.operationId)
    getDb()
      .prepare("UPDATE conversations SET branch = ?, mode = 'worktree', cwd = ? WHERE id = ?")
      .run(preview.destinationBranch, preview.destinationCwd, source.id)

    await expect(service.resolve(preview.operationId, 'continue')).resolves.toMatchObject({ status: 'completed' })
    expect(git.verifyDestination).toHaveBeenCalled()
    expect(git.rollback).not.toHaveBeenCalled()
    expect(getConversation(source.id)).toMatchObject({
      cwd: preview.destinationCwd,
      branch: preview.destinationBranch,
      mode: 'worktree',
    })
  })

  it('preserves stash and journal when sidecars cannot be verified', async () => {
    const { source, service, git, deps } = harness()
    vi.mocked(deps.verifySidecars!).mockResolvedValue(false)
    const preview = await service.prepare(source.id, 'feature/diverged')
    await expect(service.execute(preview.operationId, [], [])).resolves.toMatchObject({
      status: 'recovery-required',
    })
    expect(git.finalize).not.toHaveBeenCalled()
    expect(getMigration(preview.operationId)).toMatchObject({ phase: 'sidecars', stashOid: 'b'.repeat(40) })
  })

  it('rollback quiesces validation and restores Git, sidecars and the same conversation', async () => {
    const { source, service, git, deps } = harness()
    const preview = await service.prepare(source.id, 'feature/rollback')
    vi.mocked(deps.verifySidecars!).mockResolvedValue(false)
    await expect(service.execute(preview.operationId, [], [])).resolves.toMatchObject({
      status: 'recovery-required',
    })
    await expect(service.resolve(preview.operationId, 'rollback')).resolves.toMatchObject({
      status: 'rolled-back',
      conversationId: source.id,
    })
    expect(deps.rollbackSidecars).not.toHaveBeenCalled() // An empty journal is already rolled back.
    expect(git.rollback).toHaveBeenCalled()
    expect(git.discardStash).toHaveBeenCalled()
    expect(getConversation(source.id)).toMatchObject({ id: source.id, cwd: '/repo', branch: 'main', mode: 'local' })
  })

  it('a blocked preview remains cancellable without quiescing or acquiring a lease', async () => {
    const { source, service, git, deps } = harness()
    vi.mocked(git.prepare).mockImplementationOnce(async ({ cwd, branch, destination }) => {
      const plan = gitPlan(cwd, branch, destination)
      plan.source.blockers = [{ code: 'git-operation', message: 'Git ocupado' }]
      return plan
    })
    const preview = await service.prepare(source.id, 'feature/blocked')
    expect(preview.blockers).toHaveLength(1)
    expect(deps.quiesce).not.toHaveBeenCalled()
    expect(getMigrationLease(preview.operationId)).toBeUndefined()
    await expect(service.resolve(preview.operationId, 'rollback')).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('restart adopts and completes an old journal awaiting validation', async () => {
    const { source, service, deps } = harness()
    const preview = await service.prepare(source.id, 'feature/restart')
    getDb()
      .prepare(
        "UPDATE conversation_migrations SET phase = 'awaiting-validation', status = 'awaiting-validation', stash_oid = ? WHERE id = ?"
      )
      .run('b'.repeat(40), preview.operationId)
    getDb()
      .prepare("UPDATE conversations SET branch = ?, mode = 'worktree', cwd = ? WHERE id = ?")
      .run(preview.destinationBranch, preview.destinationCwd, source.id)
    __resetMigrationLeasesForTests()
    restartDb()
    const recovered = new ConversationMigrationService(deps)
    await expect(recovered.recoverIncomplete()).resolves.toEqual([])
    expect(getMigration(preview.operationId)).toMatchObject({
      phase: 'completed',
      status: 'completed',
      conversationId: source.id,
    })
  })

  it('restart and rollback quiesce and remove the legacy successor', async () => {
    const { source, service, deps, git } = harness()
    const preview = await service.prepare(source.id, 'feature/legacy-successor')
    const successor = makeConversation(source.workspaceId, {
      id: 'legacy-successor',
      cwd: preview.destinationCwd,
      branch: preview.destinationBranch,
      mode: 'worktree',
    })
    getDb()
      .prepare(
        "UPDATE conversation_migrations SET legacy_successor_conversation_id = ?, phase = 'rolling-back', status = 'recovery-required', stash_oid = ?, error = ? WHERE id = ?"
      )
      .run(successor.id, 'b'.repeat(40), 'Legacy CLI migration: only safe rollback is available.', preview.operationId)

    __resetMigrationLeasesForTests()
    restartDb()
    const restarted = new ConversationMigrationService(deps)
    await restarted.recoverIncomplete()

    await expect(restarted.resolve(preview.operationId, 'rollback')).resolves.toMatchObject({
      status: 'rolled-back',
      conversationId: source.id,
    })
    expect(deps.quiesce).toHaveBeenCalledWith(successor.id, preview.destinationCwd)
    expect(git.rollback).toHaveBeenCalled()
    expect(getConversation(successor.id)).toBeUndefined()
    expect(getConversation(source.id)).toMatchObject({ cwd: '/repo', branch: 'main', mode: 'local' })
  })

  it('blocks migration of a legacy successor in recovery until the journal becomes terminal', async () => {
    const { source, service } = harness()
    const preview = await service.prepare(source.id, 'feature/legacy-guard')
    const successor = makeConversation(source.workspaceId, {
      id: 'legacy-guard-successor',
      cwd: preview.destinationCwd,
      branch: preview.destinationBranch,
      mode: 'local',
    })
    getDb()
      .prepare(
        "UPDATE conversation_migrations SET legacy_successor_conversation_id = ?, phase = 'rolling-back', status = 'recovery-required' WHERE id = ?"
      )
      .run(successor.id, preview.operationId)

    await expect(service.prepare(successor.id, 'feature/should-block')).rejects.toThrow(
      `An incomplete migration (${preview.operationId}) already exists in this scope.`
    )

    getDb()
      .prepare("UPDATE conversation_migrations SET phase = 'rolled-back', status = 'rolled-back' WHERE id = ?")
      .run(preview.operationId)
    getMigrationLease(preview.operationId)?.release()

    const released = await service.prepare(successor.id, 'feature/after-legacy-terminal')
    expect(getMigration(released.operationId)).not.toHaveProperty('legacySuccessorConversationId')
    await service.cancel(released.operationId)
  })
})
