/**
 * Workspace layout for delegation stages.
 *
 * A task owns one worktree on this computer. Write stages (implement, fix, qa, deliver) share it through
 * sibling conversations so the work accumulates; read-only stages (plan, review, inspect) get their own
 * conversation attached to a stable copy of a captured revision, so a later edit in the implementer's
 * workspace cannot change what was reviewed.
 */
import { access } from 'node:fs/promises'
import type { CodeRevision, ProjectChatDelegationClaim, ProjectChatSession } from '@maestrly/protocol'
import { getConversation, getWorkspace } from '../store'
import type { PlatformProjectBinding } from '../../shared/platform'
import { materializeReviewCopy, type ReviewCopy } from './delegation-snapshot'
import * as journal from './project-chat-store'

export const READ_ONLY_STAGE_TYPES = ['plan', 'review', 'inspect'] as const

export function isReadOnlyStage(stageType: string): boolean {
  return (READ_ONLY_STAGE_TYPES as readonly string[]).includes(stageType)
}

export interface ConversationHandle {
  id: string
  cwd: string
}

export interface DelegationWorkspaceDeps {
  instanceId: string
  bindings: PlatformProjectBinding[]
  workspaceKeyFor(binding: PlatformProjectBinding): string
  /** Injected for tests; production uses the real conversation service. */
  createWorktree?(input: {
    workspaceId: string
    branch: string
    base: string
    name: string
  }): Promise<ConversationHandle>
  createSibling?(sourceConversationId: string, name: string): Promise<ConversationHandle>
  attachConversation?(input: {
    workspaceId: string
    cwd: string
    branch: string
    name: string
  }): Promise<ConversationHandle>
  reviewCopy?(input: { cwd: string; baseDirectory?: string }): Promise<ReviewCopy>
  reviewBaseDirectory?: string
}

export interface PreparedStageWorkspace {
  conversationId: string
  cwd: string
  readOnly: boolean
  /** Present for read-only stages: the exact revision the copy represents. */
  revision: CodeRevision | null
  dispose(): Promise<void>
}

async function defaultWorktree(input: { workspaceId: string; branch: string; base: string; name: string }) {
  const { createConversation } = await import('../workspace-service')
  const conversation = await createConversation({
    workspaceId: input.workspaceId,
    branch: input.branch,
    isNewBranch: true,
    base: input.base,
    mode: 'worktree',
    name: input.name,
  })
  return { id: conversation.id, cwd: conversation.cwd }
}

async function defaultSibling(sourceConversationId: string, name: string) {
  const { createSiblingConversation } = await import('../workspace-service')
  const conversation = await createSiblingConversation(sourceConversationId, { name })
  return { id: conversation.id, cwd: conversation.cwd }
}

async function defaultAttach(input: { workspaceId: string; cwd: string; branch: string; name: string }) {
  const { createConversation } = await import('../workspace-service')
  const conversation = await createConversation({
    workspaceId: input.workspaceId,
    branch: input.branch,
    isNewBranch: false,
    mode: 'worktree',
    name: input.name,
    attach: { cwd: input.cwd, branch: input.branch, mode: 'worktree' },
  })
  return { id: conversation.id, cwd: conversation.cwd }
}

export class DelegationWorkspaces {
  constructor(private readonly deps: DelegationWorkspaceDeps) {}

  private binding(session: ProjectChatSession) {
    const found = this.deps.bindings.find(
      (candidate) =>
        candidate.projectId === session.projectId &&
        candidate.organizationId === session.organizationId &&
        this.deps.workspaceKeyFor(candidate) === session.workspaceKey
    )
    if (!found) throw new Error('The delegation workspace is no longer bound to this executor.')
    return found
  }

  /** Task worktree, created once and reused. A missing directory is reported, never silently recreated. */
  private async taskWorkspace(
    session: ProjectChatSession,
    delegation: ProjectChatDelegationClaim
  ): Promise<ConversationHandle & { created: boolean }> {
    const existingId = journal.delegationWorkspace(this.deps.instanceId, delegation.taskId)
    if (existingId) {
      const conversation = getConversation(existingId)
      if (!conversation || conversation.scope === 'standalone')
        throw new Error('The delegation workspace conversation is missing. Restore it before continuing.')
      await access(conversation.cwd)
      return { id: conversation.id, cwd: conversation.cwd, created: false }
    }
    const binding = this.binding(session)
    if (!getWorkspace(binding.workspaceId)) throw new Error('The bound local workspace no longer exists.')
    const created = await (this.deps.createWorktree ?? defaultWorktree)({
      workspaceId: binding.workspaceId,
      branch: `delegation/${delegation.taskId}`,
      base: session.baseBranch,
      name: `Delegation ${delegation.taskId.slice(0, 8)}`,
    })
    journal.bindDelegationWorkspace(this.deps.instanceId, delegation.taskId, created.id)
    return { ...created, created: true }
  }

  /**
   * Resolve the conversation and directory for one stage. Each stage keeps its own conversation so a
   * reviewer never inherits the implementer's private reasoning.
   */
  async prepare(
    session: ProjectChatSession,
    delegation: ProjectChatDelegationClaim
  ): Promise<PreparedStageWorkspace> {
    const readOnly = isReadOnlyStage(delegation.stageType)
    const bound = journal.chatConversation(this.deps.instanceId, session.id)
    if (bound) {
      const conversation = getConversation(bound)
      if (!conversation || conversation.scope === 'standalone')
        throw new Error('The stage conversation is missing. Restore it before continuing.')
      await access(conversation.cwd)
      return { conversationId: conversation.id, cwd: conversation.cwd, readOnly, revision: null, dispose: async () => {} }
    }
    const task = await this.taskWorkspace(session, delegation)
    if (!readOnly) {
      const handle = task.created
        ? task
        : await (this.deps.createSibling ?? defaultSibling)(
            task.id,
            `${delegation.stageType} · ${delegation.taskId.slice(0, 8)}`
          )
      journal.bindChatConversation(this.deps.instanceId, session.id, handle.id)
      return { conversationId: handle.id, cwd: handle.cwd, readOnly, revision: null, dispose: async () => {} }
    }
    const copy = await (this.deps.reviewCopy ?? materializeReviewCopy)({
      cwd: task.cwd,
      baseDirectory: this.deps.reviewBaseDirectory,
    })
    try {
      const binding = this.binding(session)
      const handle = await (this.deps.attachConversation ?? defaultAttach)({
        workspaceId: binding.workspaceId,
        cwd: copy.path,
        branch: `review/${delegation.stageId}`,
        name: `${delegation.stageType} · ${delegation.taskId.slice(0, 8)}`,
      })
      journal.bindChatConversation(this.deps.instanceId, session.id, handle.id)
      return {
        conversationId: handle.id,
        cwd: copy.path,
        readOnly,
        revision: copy.revision,
        dispose: () => copy.dispose(),
      }
    } catch (error) {
      await copy.dispose()
      throw error
    }
  }
}
