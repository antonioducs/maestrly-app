import {
  requireProjectConversation,
  permissionScopeKey,
  conversationPermissionScope,
} from '../shared/conversation-scope'
import { removeStandaloneConversationDirectory } from './standalone-conversation-service'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as git from './git-service'
import * as store from './store'
import type { ConversationExperience } from '../shared/conversation-experience'
import type { ProjectConversation, ConversationMode, Workspace } from './store'
import { createAggregator, cleanupAggregator, aggregatorDir, type RepoSpec } from './aggregator-service'
import { externalWorktreeDir } from './app-paths'
import { collectChatToolImageRefs, releaseUnreferencedChatToolImages } from './chat/chat-store'
import { deleteConversationGeneratedImages } from './chat/generated-images'
import { deleteConversationAttachmentImages } from './chat/attachment-artifacts'
import { deleteConversationToolImageMetadata } from './chat/tool-output'

import { tMain } from './i18n'
import { deleteCodexThreadForConversation } from './chat/codex-subscription/lifecycle'
import { deleteGitHubCopilotSessionForConversation } from './chat/github-copilot/lifecycle'
import { deleteCursorAgentForConversation } from './chat/cursor-subscription/lifecycle'
import { deleteClaudeSessionForConversation } from './chat/claude-agent-sdk/lifecycle'
import { assertConversationMigrationMutationAllowed } from './conversation-migration/store'
import { scheduleWorkspaceMemoryIndexWarmup, stopWorkspaceMemoryIndex } from './memory/index'

/** Validate a non-bare Git repository and register its top-level directory as a workspace. */
export async function addWorkspace(
  dir: string,
  options: {
    beforeInsert?: () => void
    validated?: { top: string; defaultBranch: string }
  } = {}
): Promise<Workspace> {
  if (!options.validated && !(await git.isGitRepo(dir))) {
    throw new Error(tMain('main')('workspace.notGitRepo'))
  }
  if (!options.validated && (await git.isBareRepo(dir))) {
    throw new Error(tMain('main')('workspace.bareNotSupported'))
  }
  const top = options.validated?.top ?? (await git.getToplevel(dir))
  if (!top) throw new Error(tMain('main')('workspace.cannotResolveRoot'))

  const existing = store.getWorkspaceByPath(top)
  if (existing) {
    options.beforeInsert?.()
    scheduleWorkspaceMemoryIndexWarmup(existing.id)
    return existing
  }

  const defaultBranch = options.validated?.defaultBranch ?? (await git.getDefaultBranch(top))
  const workspace: Workspace = {
    id: randomUUID(),
    path: top,
    name: path.basename(top),
    defaultBranch,
    addedAt: Date.now(),
  }

  options.beforeInsert?.()
  store.insertWorkspace(workspace)
  const inserted = store.getWorkspaceByPath(top)!
  scheduleWorkspaceMemoryIndexWarmup(inserted.id)
  return inserted
}

export interface WorkspaceWithConversations extends Workspace {
  conversations: ProjectConversation[]
  archivedCount: number

  groupId: string | null

  collapsed: boolean
}

export function listWorkspacesWithConversations(includeArchived = false): WorkspaceWithConversations[] {
  const uiState = new Map(store.listWorkspaceGroupIds().map((r) => [r.id, r]))
  const knownGroups = new Set(store.listWorkspaceGroups().map((g) => g.id))
  return store.listWorkspaces().map((w) => {
    const all = store.listConversations(w.id, true)
    const archivedCount = all.filter((c) => c.archived === 1).length
    const st = uiState.get(w.id)
    const groupId = st?.groupId && knownGroups.has(st.groupId) ? st.groupId : null
    return {
      ...w,
      conversations: includeArchived ? all : all.filter((c) => c.archived === 0),
      archivedCount,
      groupId,
      collapsed: st?.collapsed ?? false,
    }
  })
}

export function renameConversation(id: string, name: string): void {
  const trimmed = name.trim()
  if (trimmed) {
    store.renameConversation(id, trimmed)
    if (store.getConversation(id)?.scope === 'standalone') store.patchConvUiPrefs(id, { autoName: false })
  }
}

export function setConversationArchived(id: string, archived: boolean): void {
  store.setConversationArchived(id, archived)
}

export function removeWorkspace(id: string): void {
  stopWorkspaceMemoryIndex(id)
  store.deleteWorkspace(id)
}

/** Remove the conversation and its owned resources, preserving shared worktrees and referenced images. */
export async function deleteConversation(
  id: string,
  options: { preserveBranch?: boolean; preserveWorktree?: boolean } = {}
): Promise<void> {
  const conv = store.getConversation(id)
  if (!conv) return
  assertConversationMigrationMutationAllowed(id, 'Delete conversation')

  await deleteCursorAgentForConversation(id)
  await deleteCodexThreadForConversation(id)
  await deleteGitHubCopilotSessionForConversation(id, { strict: true })
  await deleteClaudeSessionForConversation(id, { strict: true })

  const deleteRowAndArtifacts = async (): Promise<void> => {
    const toolImageRefs = collectChatToolImageRefs(id)
    store.deleteConversation(id)
    releaseUnreferencedChatToolImages(toolImageRefs)

    deleteConversationToolImageMetadata(id)
    await deleteConversationGeneratedImages(id)
    // Attached images and PDFs, plus any PDF copy opened in the system viewer.
    await deleteConversationAttachmentImages(id)
  }

  if (conv.scope === 'standalone') {
    await removeStandaloneConversationDirectory(conv)
    store
      .getDb()
      .prepare('DELETE FROM permission_saved WHERE project_id = ?')
      .run(permissionScopeKey(conversationPermissionScope(conv)))
    await deleteRowAndArtifacts()
    return
  }

  if (conv.isMulti && conv.repos?.length) {
    await cleanupAggregator(id, conv.repos)
    await deleteRowAndArtifacts()
    return
  }

  const ws = store.listWorkspaces().find((w) => w.id === conv.workspaceId)

  const sharesWorktree = store.countOtherConversationsInCwd(conv.cwd, id) > 0

  // A destination that only borrowed a checkout (shared dispatch rollback) never removes it, even when it is
  // momentarily the last conversation there.
  if (ws && conv.mode === 'worktree' && !sharesWorktree && !options.preserveWorktree) {
    try {
      await git.removeWorktree(ws.path, conv.cwd, true)
    } catch {
      /* The worktree may already have been removed manually. */
    }
    if (!options.preserveBranch) await git.deleteBranch(ws.path, conv.branch)
  }

  await deleteRowAndArtifacts()
}

export async function getBranches(workspaceId: string): Promise<git.BranchInfo & { defaultBranch: string }> {
  const ws = store.listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) throw new Error(tMain('main')('workspace.notFound'))
  const info = await git.listBranches(ws.path)
  return { ...info, defaultBranch: ws.defaultBranch }
}

export async function fetchBranches(workspaceId: string): Promise<git.BranchInfo & { defaultBranch: string }> {
  const ws = store.listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) throw new Error(tMain('main')('workspace.notFound'))
  await git.fetchRemotes(ws.path)
  return getBranches(workspaceId)
}

export interface CreateConvRepo {
  workspaceId: string
  branch: string
  isNewBranch: boolean
  base?: string
}

export interface CreateConversationArgs {
  workspaceId: string
  branch: string
  isNewBranch: boolean
  base?: string
  mode: ConversationMode
  /** Immutable chat experience. Omitted legacy/programmatic callers always create Standard. */
  experience?: ConversationExperience
  name?: string

  repos?: CreateConvRepo[]

  attach?: { cwd: string; branch: string; mode?: ConversationMode }
  /** Main-only: id reserved in advance by a durable allocation journal (never accepted from IPC). */
  id?: string
  /** Main-only: new branches start at this exact commit instead of the freshest base ref. */
  baseRevision?: string
}

/** Prepare a worktree or an explicitly confirmed local attachment before persisting the conversation. */
export async function createConversation(args: CreateConversationArgs): Promise<ProjectConversation> {
  if (args.mode === 'local' && !args.attach) {
    throw new Error('Local creation requires preview and confirmation.')
  }
  const now = Date.now()

  if (args.repos && args.repos.length > 0) {
    const id = randomUUID()
    const specs: RepoSpec[] = args.repos.map((r) => {
      const ws = store.listWorkspaces().find((w) => w.id === r.workspaceId)
      if (!ws) throw new Error(tMain('main')('workspace.notFound'))
      return {
        workspaceId: ws.id,
        repoTop: ws.path,
        branch: r.branch,
        base: r.base || ws.defaultBranch,
        isNewBranch: r.isNewBranch,
      }
    })
    const convRepos = await createAggregator(id, specs)
    const primary = convRepos[0]
    const conversation: ProjectConversation = {
      scope: 'project',
      id,
      workspaceId: primary.workspaceId,
      name: args.name || primary.branch,
      branch: primary.branch,
      mode: 'worktree',
      experience: args.experience ?? 'standard',
      cwd: aggregatorDir(id),
      status: 'idle',
      createdAt: now,
      archived: 0,
      pinnedAt: null,
      lastActivityAt: now,
      isMulti: 1,
    }
    try {
      store.transaction(() => {
        store.insertConversation(conversation)
        store.insertConvRepos(id, convRepos)
      })
    } catch (e) {
      await cleanupAggregator(id, convRepos).catch(() => {})
      throw e
    }
    conversation.repos = convRepos

    return conversation
  }

  const ws = store.listWorkspaces().find((w) => w.id === args.workspaceId)
  if (!ws) throw new Error(tMain('main')('workspace.notFound'))

  const base = args.base || ws.defaultBranch
  let cwd: string
  let branch: string
  if (args.attach) {
    const owners = store.listAllConversations().filter((conversation) => conversation.cwd === args.attach!.cwd)
    if (owners.some((conversation) => conversation.botOrigin))
      throw new Error('Bot conversations own exclusive worktrees and cannot be attached.')
    cwd = args.attach.cwd
    branch = args.attach.branch
  } else if (args.mode === 'worktree') {
    if (args.baseRevision && !args.isNewBranch) throw new Error('A pinned base revision requires a new branch.')
    cwd = await git.createWorktree({
      top: ws.path,
      branch: args.branch,
      base,
      isNewBranch: args.isNewBranch,
      dest: externalWorktreeDir(ws.id, args.branch),
      // A pinned task branch must be new: never attach to an existing branch or checkout.
      ...(args.baseRevision ? { baseRevision: args.baseRevision, exclusive: true } : {}),
    })
    branch = args.branch
  } else {
    throw new Error('Local creation requires preview and confirmation.')
  }

  const conversation: ProjectConversation = {
    scope: 'project',
    id: args.id ?? randomUUID(),
    workspaceId: ws.id,
    name: args.name || branch,
    branch,
    mode: args.attach?.mode ?? (args.attach ? 'worktree' : args.mode),
    experience: args.experience ?? 'standard',
    cwd,
    status: 'idle',
    createdAt: now,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: now,
    isMulti: 0,
  }
  store.insertConversation(conversation)

  return conversation
}

/** Attach a sibling to the original checkout; share its existing worktree rather than creating another. */
export async function createSiblingConversation(
  sourceConversationId: string,
  options: { experience?: ConversationExperience; name?: string; id?: string } = {}
): Promise<ProjectConversation> {
  const source = store.getConversation(sourceConversationId)
  if (!source) throw new Error(tMain('main')('workspace.siblingSourceNotFound'))
  const src = requireProjectConversation(source)
  if (src.botOrigin) throw new Error('Bot conversations own exclusive worktrees and cannot have siblings.')
  assertConversationMigrationMutationAllowed(sourceConversationId, 'Create sibling conversation')

  if (src.isMulti || src.archived === 1) {
    throw new Error(tMain('main')('workspace.siblingSourceInvalid'))
  }

  return createConversation({
    workspaceId: src.workspaceId,
    branch: src.branch,
    isNewBranch: false,
    mode: src.mode,
    experience: options.experience ?? src.experience,
    name: options.name,
    attach: { cwd: src.cwd, branch: src.branch, mode: src.mode },
    ...(options.id ? { id: options.id } : {}),
  })
}
