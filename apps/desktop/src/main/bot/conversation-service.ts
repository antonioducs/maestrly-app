import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { BotIdentity } from '../../shared/bot'
import type { ProjectConversation } from '../../shared/conversation'
import { getConversation, getWorkspace, insertConversation, transaction } from '../store'
import { externalWorktreeDir } from '../app-paths'
import { createWorktree, listWorktrees } from '../git-service'
import { runGit, runGitOrNull } from '../git-command'
import { broadcast } from '../window-ipc'
import {
  assertBotIdentity,
  bindBotConversation,
  findBotConversation,
  getBotConversationBinding,
  reserveBotConversation,
  setBotAllocationPhase,
  type BotConversationBinding,
} from './store'

export interface BotConversationCreateInput {
  workspaceId: string
  requestId: string
  name: string
  baseBranch: string
  selection?: unknown
}

const pending = new Map<string, Promise<ProjectConversation>>()

function fingerprint(input: BotConversationCreateInput): string {
  // Selection changes have their own command: they do not change an allocation's identity.
  return createHash('sha256')
    .update(JSON.stringify([input.workspaceId, input.name, input.baseBranch]))
    .digest('hex')
}

async function validateWorktree(binding: BotConversationBinding): Promise<void> {
  const workspace = getWorkspace(binding.workspaceId)
  if (!workspace) throw new Error('The bot workspace is missing. Restore it before continuing.')
  const stat = await lstat(binding.cwd).catch(() => null)
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new Error('The bot worktree is missing or replaced. It was not recreated.')
  const canonicalCwd = await realpath(binding.cwd)
  const registered = (
    await Promise.all(
      (
        await listWorktrees(workspace.path)
      ).map(async (tree) => ({
        ...tree,
        canonicalPath: await realpath(tree.path).catch(() => path.resolve(tree.path)),
      }))
    )
  ).find((tree) => tree.canonicalPath === canonicalCwd)
  if (!registered || registered.branch !== binding.branch)
    throw new Error('The bot worktree registration changed. Restore it before continuing.')
  if (canonicalCwd === (await realpath(workspace.path))) throw new Error('A bot cannot use the main checkout.')
  const marker = await runGitOrNull(binding.cwd, ['config', '--worktree', '--get', 'maestrly.botAllocation'])
  if (marker !== binding.allocationId)
    throw new Error('Bot worktree ownership could not be verified; recovery is required.')
}

export async function resumeBotConversation(
  identity: BotIdentity,
  conversationId: string
): Promise<ProjectConversation> {
  const binding = getBotConversationBinding(conversationId)
  if (!binding) throw new Error('The bot conversation binding is missing.')
  assertBotIdentity(identity, binding)
  if (binding.phase !== 'ready') throw new Error('This bot conversation requires recovery before it can resume.')
  const conversation = getConversation(conversationId)
  if (
    conversation?.scope !== 'project' ||
    !conversation.botOrigin ||
    conversation.botOrigin.connectionId !== identity.connectionId ||
    conversation.workspaceId !== binding.workspaceId ||
    conversation.cwd !== binding.cwd ||
    conversation.branch !== binding.branch ||
    conversation.mode !== 'worktree'
  )
    throw new Error('The bot conversation no longer matches its exclusive worktree.')
  if (conversation.archived) throw new Error('The bot conversation is archived. Unarchive it before continuing.')
  if (conversation.botManagementState !== 'active') throw new Error('Bot management is paused or revoked.')
  await validateWorktree(binding)
  return conversation
}

export function createBotConversation(
  identity: BotIdentity,
  input: BotConversationCreateInput
): Promise<ProjectConversation> {
  const key = JSON.stringify([identity.instanceId, identity.connectionId, input.requestId])
  const current = pending.get(key)
  if (current)
    return current.then((conversation) => {
      const binding = findBotConversation(identity, input.requestId)
      if (binding?.fingerprint !== fingerprint(input))
        throw new Error('This bot request was already used with different input.')
      return conversation
    })
  const work = allocate(identity, input).finally(() => {
    if (pending.get(key) === work) pending.delete(key)
  })
  pending.set(key, work)
  return work
}

async function allocate(identity: BotIdentity, input: BotConversationCreateInput): Promise<ProjectConversation> {
  const workspace = getWorkspace(input.workspaceId)
  if (!workspace) throw new Error('The authorized local workspace is unavailable.')
  if (!input.requestId || !input.name.trim() || !input.baseBranch.trim())
    throw new Error('A bot conversation needs an identity, name and base branch.')
  let binding = findBotConversation(identity, input.requestId)
  if (binding) {
    if (binding.fingerprint !== fingerprint(input))
      throw new Error('This bot request was already used with different input.')
    if (binding.phase === 'deleted')
      throw new Error('This bot conversation was deleted and cannot be recreated by a retry.')
    if (binding.conversationId) return resumeBotConversation(identity, binding.conversationId)
  } else {
    const allocationId = randomUUID()
    const branch = `bot/${allocationId}`
    binding = {
      ...identity,
      requestId: input.requestId,
      allocationId,
      conversationId: null,
      workspaceId: workspace.id,
      branch,
      cwd: externalWorktreeDir(workspace.id, branch),
      baseBranch: input.baseBranch,
      name: input.name,
      fingerprint: fingerprint(input),
      phase: 'reserved',
      error: null,
    }
    reserveBotConversation(binding)
  }
  try {
    if (binding.phase === 'reserved') {
      setBotAllocationPhase(binding.allocationId, 'allocating')
      await createWorktree({
        top: workspace.path,
        branch: binding.branch,
        base: binding.baseBranch,
        isNewBranch: true,
        exclusive: true,
        dest: binding.cwd,
      })
      // Git-local metadata is outside the tracked working tree and cannot overwrite a project file.
      await runGit(binding.cwd, ['config', 'extensions.worktreeConfig', 'true'])
      await runGit(binding.cwd, ['config', '--worktree', 'maestrly.botAllocation', binding.allocationId])
      setBotAllocationPhase(binding.allocationId, 'prepared')
    } else {
      // A crash after Git allocation is recoverable only when its durable ownership marker agrees.
      await validateWorktree(binding)
    }
    await validateWorktree(binding)
    const now = Date.now()
    const conversation: ProjectConversation = {
      id: binding.allocationId,
      scope: 'project',
      workspaceId: workspace.id,
      name: binding.name,
      branch: binding.branch,
      cwd: binding.cwd,
      mode: 'worktree',
      experience: 'standard',
      status: 'idle',
      createdAt: now,
      lastActivityAt: now,
      archived: 0,
      pinnedAt: null,
      isMulti: 0,
      botOrigin: { kind: 'bot', connectionId: identity.connectionId, botName: identity.botName },
      botManagementState: 'active',
    }
    transaction(() => {
      insertConversation(conversation)
      bindBotConversation(binding!.allocationId, conversation.id)
    })
    broadcast('conversation:open', { conversation, focus: false })
    return conversation
  } catch (error) {
    // Preserve the journal and any Git work for inspection; never delete a possibly changed checkout.
    setBotAllocationPhase(binding.allocationId, 'recovery', error instanceof Error ? error.message : String(error))
    throw error
  }
}
