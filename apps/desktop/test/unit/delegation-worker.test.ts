import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  admitChatTurn,
  admitDelegationAttempt,
  bindDelegationWorkspace,
  bindChatConversation,
  chatConversation,
  delegationAttemptFor,
  delegationWorkspace,
  finishDelegationAttempt,
  pendingDelegationReceipts,
  recordDelegationReceipt,
} from '../../src/main/platform/project-chat-store'
import { DelegationWorkspaces, isReadOnlyStage } from '../../src/main/platform/delegation-workspace'
import { DelegationWorker } from '../../src/main/platform/delegation-worker'
import { buildDelegationCatalog } from '../../src/main/platform/delegation-catalog'
import { desktopExecutorSettingsSchema } from '../../src/main/platform/executor-settings'
import { chatWorkspaceKey } from '../../src/main/platform/project-chat-projection'
import { ProjectChatWorker } from '../../src/main/platform/project-chat-worker'
import { buildStageReceipt, selectionHonored } from '../../src/main/platform/delegation-receipt'
import type { ProjectChatDelegationClaim, ProjectChatSession } from '@maestrly/protocol'
import type { PlatformProjectBinding } from '../../src/shared/platform'

let scratch = ''
beforeEach(() => {
  freshDb()
  scratch = mkdtempSync(path.join(os.tmpdir(), 'delegation-worker-'))
})
afterEach(() => {
  closeDb()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})
const dir = (name: string) => mkdtempSync(path.join(scratch, name))

const settings = {
  selectionId: 'sel-opus',
  reasoning: 'high' as string | null,
  fastMode: false,
  executionMode: 'standard' as const,
  delegationProfiles: [] as string[],
}

/** Key the workspace manager under test advertises for its binding; the real identity, not a stub. */
let advertisedKey = ''

const session = (overrides: Partial<ProjectChatSession> = {}) =>
  ({
    id: overrides.id ?? crypto.randomUUID(),
    organizationId: 'org-1',
    projectId: 'project-1',
    ownerUserId: 'owner',
    runnerId: 'runner-1',
    workspaceKey: advertisedKey,
    title: 'Delegated work',
    model: 'sel-opus',
    mode: 'agent',
    reasoning: 'high',
    fastMode: false,
    permMode: 'full',
    baseBranch: 'main',
    boardId: 'board-1',
    cardId: 'card-1',
    version: 1,
    archivedAt: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  }) as ProjectChatSession

const delegation = (overrides: Partial<ProjectChatDelegationClaim> = {}): ProjectChatDelegationClaim => ({
  taskId: 'task-1',
  stageId: overrides.stageId ?? 'stage-1',
  attemptId: overrides.attemptId ?? 'attempt-1',
  attempt: 1,
  stageType: overrides.stageType ?? 'implement',
  snapshot: { settings, catalogRevision: 'rev', stageType: overrides.stageType ?? 'implement' },
  catalogRevision: 'rev',
  workspaceKey: advertisedKey,
  baseBranch: 'main',
  repositoryBindingId: null,
  cardId: 'card-1',
  boardId: 'board-1',
  ...overrides,
})

let taskCwd = ''
let reviewCwd = ''
function workspaces(workspaceId: string, created: { worktrees: string[]; siblings: string[]; attached: string[]; reviews: number }) {
  const binding = {
    connectionId: 'conn-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    workspaceId,
    repositoryBindingId: null,
  } as unknown as PlatformProjectBinding
  // No stubbed identity: the sessions below carry exactly the key the inventory would advertise.
  advertisedKey = chatWorkspaceKey(binding)
  return new DelegationWorkspaces({
    instanceId: 'instance',
    bindings: [binding],
    createWorktree: async (input) => {
      created.worktrees.push(input.branch)
      taskCwd = taskCwd || dir('task-')
      const conversation = makeConversation(workspaceId, { cwd: taskCwd, branch: input.branch })
      return { id: conversation.id, cwd: conversation.cwd }
    },
    createSibling: async (source, name) => {
      created.siblings.push(name)
      const conversation = makeConversation(workspaceId, { cwd: taskCwd, branch: 'sibling-' + source })
      return { id: conversation.id, cwd: conversation.cwd }
    },
    attachConversation: async (input) => {
      created.attached.push(input.cwd)
      const conversation = makeConversation(workspaceId, { cwd: input.cwd, branch: input.branch })
      return { id: conversation.id, cwd: conversation.cwd }
    },
    reviewCopy: async () => {
      created.reviews += 1
      reviewCwd = dir('review-')
      return {
        path: reviewCwd,
        revision: {
          id: 'revision-' + created.reviews,
          baseCommit: 'abc',
          headCommit: 'abc',
          contentDigest: 'digest-' + created.reviews,
          snapshotArtifactId: null,
          capturedAt: '2026-09-20T00:00:00.000Z',
        },
        dispose: async () => {
          created.reviews -= 1
        },
      }
    },
  })
}

it('reuses one task worktree for write stages and gives each read-only stage a stable copy', async () => {
  const workspace = makeWorkspace()
  const created = { worktrees: [] as string[], siblings: [] as string[], attached: [] as string[], reviews: 0 }
  taskCwd = ''
  const manager = workspaces(workspace.id, created)

  const implement = session()
  const first = await manager.prepare(implement, delegation({ stageType: 'implement' }))
  expect(created.worktrees).toEqual(['delegation/task-1'])
  expect(first.cwd).toBe(taskCwd)
  expect(first.readOnly).toBe(false)
  expect(delegationWorkspace('instance', 'task-1')).toBe(first.conversationId)

  const fix = session()
  const second = await manager.prepare(fix, delegation({ stageType: 'fix', stageId: 'stage-2', attemptId: 'attempt-2' }))
  // No second worktree: the fix stage shares the task workspace through a sibling conversation.
  expect(created.worktrees).toEqual(['delegation/task-1'])
  expect(created.siblings).toHaveLength(1)
  expect(second.cwd).toBe(taskCwd)
  expect(second.conversationId).not.toBe(first.conversationId)

  const review = session()
  const third = await manager.prepare(
    review,
    delegation({ stageType: 'review', stageId: 'stage-3', attemptId: 'attempt-3' })
  )
  expect(third.readOnly).toBe(true)
  expect(third.cwd).toBe(reviewCwd)
  expect(created.attached).toEqual([reviewCwd])
  expect(third.revision?.contentDigest).toBe('digest-1')
  expect(third.conversationId).not.toBe(first.conversationId)

  // Re-preparing the same stage reuses its bound conversation instead of copying again.
  const again = await manager.prepare(review, delegation({ stageType: 'review', stageId: 'stage-3' }))
  expect(again.conversationId).toBe(third.conversationId)
  expect(created.reviews).toBe(1)

  await third.dispose()
  expect(created.reviews).toBe(0)
  expect(isReadOnlyStage('review')).toBe(true)
  expect(isReadOnlyStage('implement')).toBe(false)
})

it('prepares a stage created from the key the real catalog advertised', async () => {
  // The whole path: the inventory publishes a workspace key, the server copies it into the session, and this
  // computer has to resolve the same binding back. One identity function published and another one resolved
  // would fail every first preparation with "no longer bound to this executor".
  const workspace = makeWorkspace()
  const binding = {
    connectionId: 'conn-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    workspaceId: workspace.id,
    repositoryBindingId: null,
  } as unknown as PlatformProjectBinding
  const catalog = await buildDelegationCatalog({
    catalog: { selections: async () => [] },
    settings: desktopExecutorSettingsSchema.parse({ providerIds: ['codex-subscription'] }),
    bindings: [binding],
    workspacePathFor: () => workspace.path,
    inspect: async () => [{ bindingId: 'binding', available: true, branches: ['main'] }],
    probes: {
      profiles: async () => [],
      github: async () => ({ available: true, login: 'octocat', issue: null }),
      checks: async () => [],
    },
  })
  const advertised = catalog.workspaces[0]!.key

  taskCwd = ''
  const created = { worktrees: [] as string[], siblings: [] as string[], attached: [] as string[], reviews: 0 }
  const manager = workspaces(workspace.id, created)
  const prepared = await manager.prepare(
    session({ workspaceKey: advertised }),
    delegation({ stageType: 'implement' })
  )
  expect(created.worktrees).toEqual(['delegation/task-1'])
  expect(prepared.cwd).toBe(taskCwd)

  // A session pointing at another workspace is still refused.
  await expect(
    manager.prepare(
      session({ id: 'other-session', workspaceKey: 'some-other-key' }),
      delegation({ taskId: 'task-2', stageType: 'implement', stageId: 'stage-9', attemptId: 'attempt-9' })
    )
  ).rejects.toThrow(/no longer bound to this executor/)
})

it('reports a missing stage workspace instead of silently creating another one', async () => {
  const workspace = makeWorkspace()
  const created = { worktrees: [] as string[], siblings: [] as string[], attached: [] as string[], reviews: 0 }
  taskCwd = ''
  const manager = workspaces(workspace.id, created)
  const stage = session()
  bindChatConversation('instance', stage.id, crypto.randomUUID())
  await expect(manager.prepare(stage, delegation())).rejects.toThrow(/stage conversation is missing/)

  const other = session()
  bindDelegationWorkspace('instance', 'task-1', crypto.randomUUID())
  await expect(manager.prepare(other, delegation())).rejects.toThrow(/workspace conversation is missing/)
  expect(created.worktrees).toEqual([])
})

it('admits an attempt once and keeps an unacknowledged receipt across a restart', () => {
  const admit = () =>
    admitDelegationAttempt({
      instanceId: 'instance',
      attemptId: 'attempt-1',
      taskId: 'task-1',
      stageId: 'stage-1',
      turnId: 'turn-1',
      leaseId: 'lease-1',
    })
  expect(admit()).toBe(true)
  expect(admit()).toBe(false)
  expect(delegationAttemptFor('turn-1')?.attempt_id).toBe('attempt-1')

  const receipt = buildStageReceipt({
    requested: settings,
    admitted: settings,
    observed: {
      selectionId: 'sel-opus',
      modelId: 'claude-opus-5',
      accountLabel: 'Claude · personal',
      reasoning: 'high',
      fastMode: false,
      harnessProfileId: null,
      harnessHash: null,
    },
    conversationId: 'conversation',
    result: 'succeeded',
    summary: 'done',
  })
  recordDelegationReceipt('attempt-1', receipt)
  restartDb()
  const pending = pendingDelegationReceipts('instance')
  expect(pending.map((row) => row.attempt_id)).toEqual(['attempt-1'])
  expect(JSON.parse(pending[0]!.receipt!)).toMatchObject({ selectionHonored: true, result: 'succeeded' })
  finishDelegationAttempt('attempt-1')
  expect(pendingDelegationReceipts('instance')).toEqual([])
})

it('marks the selection as not honored when the runtime used something else', () => {
  const observed = {
    selectionId: 'sel-astra',
    modelId: 'gpt-6-astra',
    accountLabel: 'Codex',
    reasoning: 'high',
    fastMode: false,
    harnessProfileId: null,
    harnessHash: null,
  }
  expect(selectionHonored(settings, observed)).toBe(false)
  expect(selectionHonored(settings, { ...observed, selectionId: 'sel-opus' })).toBe(true)
  expect(selectionHonored(settings, { ...observed, selectionId: 'sel-opus', reasoning: 'medium' })).toBe(false)
  expect(selectionHonored(settings, { ...observed, selectionId: 'sel-opus', fastMode: true })).toBe(false)
  // An unreported identity is not evidence of compliance.
  expect(selectionHonored(settings, { ...observed, selectionId: null })).toBe(false)
  expect(selectionHonored(settings, null)).toBe(false)
  // Host stages carry no agent settings and are always consistent.
  expect(selectionHonored(null, null)).toBe(true)

  const receipt = buildStageReceipt({
    requested: settings,
    admitted: settings,
    observed,
    conversationId: 'conversation',
    result: 'succeeded',
  })
  expect(receipt.selectionHonored).toBe(false)
  // Unknown consumption stays unknown instead of being reported as zero.
  expect(receipt.tokensObserved).toBe(false)
  expect(receipt.tokens).toBeNull()
  expect(receipt.costUsd).toBeNull()
  const measured = buildStageReceipt({
    requested: settings,
    admitted: settings,
    observed: { ...observed, selectionId: 'sel-opus' },
    conversationId: 'conversation',
    result: 'succeeded',
    tokens: 1234,
  })
  expect(measured.tokensObserved).toBe(true)
  expect(measured.tokens).toBe(1234)
})

it('keeps the stage conversation binding stable across a restart', () => {
  const workspace = makeWorkspace()
  const conversation = makeConversation(workspace.id)
  bindChatConversation('instance', 'session-1', conversation.id)
  bindDelegationWorkspace('instance', 'task-1', conversation.id)
  restartDb()
  expect(chatConversation('instance', 'session-1')).toBe(conversation.id)
  expect(delegationWorkspace('instance', 'task-1')).toBe(conversation.id)
})

it('recovers only the turns it started, so two loops on one computer never interrupt each other', async () => {
  // Both workers share the local journal. A chat turn that is still running must survive a delegation
  // recovery pass, and a stage attempt must survive a chat recovery pass.
  const chatTurn = crypto.randomUUID()
  const stageTurn = crypto.randomUUID()
  admitChatTurn('instance', chatTurn, crypto.randomUUID())
  admitChatTurn('instance', stageTurn, crypto.randomUUID())
  admitDelegationAttempt({
    instanceId: 'instance',
    attemptId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    stageId: crypto.randomUUID(),
    turnId: stageTurn,
    leaseId: crypto.randomUUID(),
  })

  const completed: string[] = []
  const client = {
    complete: async (turnId: string) => {
      completed.push(turnId)
    },
    inventory: async () => ({ accepted: true }),
    delegationInventory: async () => ({ accepted: true }),
    claim: async () => null,
    claimDelegationStage: async () => null,
  } as unknown as ConstructorParameters<typeof ProjectChatWorker>[0]
  const catalog = { chatModels: async () => [], selections: async () => [] } as never
  const executor = { interactiveChat: true } as never

  const delegation = new DelegationWorker({
    client: client as never,
    catalog,
    settings: executor,
    bindings: [],
    instanceId: 'instance',
    url: 'http://instance.test',
    workspaces: new DelegationWorkspaces({ bindings: [], instanceId: 'instance' } as never),
  })
  await delegation.recover()
  expect(completed).toEqual([stageTurn])

  completed.length = 0
  const chat = new ProjectChatWorker(client, catalog, executor, [], 'instance', 'http://instance.test')
  await chat.recover()
  expect(completed).toEqual([chatTurn])
})
