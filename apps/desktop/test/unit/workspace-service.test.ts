import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/conversation-migration/store', () => ({
  assertConversationMigrationMutationAllowed: vi.fn(),
}))

vi.mock('../../src/main/git-service', () => ({
  isGitRepo: vi.fn(),
  isBareRepo: vi.fn(),
  getToplevel: vi.fn(),
  getDefaultBranch: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  deleteBranch: vi.fn(),
}))

const lifecycle = vi.hoisted(() => ({ removeDirectory: vi.fn(), deletePermission: vi.fn() }))
vi.mock('../../src/main/standalone-conversation-service', () => ({
  removeStandaloneConversationDirectory: lifecycle.removeDirectory,
}))

vi.mock('../../src/main/store', () => ({
  getDb: () => ({ prepare: () => ({ run: lifecycle.deletePermission }) }),
  getConversation: vi.fn(),
  getWorkspaceByPath: vi.fn(),
  listConversations: vi.fn(),
  listWorkspaces: vi.fn(),
  insertWorkspace: vi.fn(),
  insertConversation: vi.fn(),
  countOtherConversationsInCwd: vi.fn(),
  deleteConversation: vi.fn(),
  deleteWorkspace: vi.fn(),
  setConversationArchived: vi.fn(),
  transaction: vi.fn((fn: () => void) => fn()),
}))

vi.mock('../../src/main/memory/index', () => ({
  scheduleWorkspaceMemoryIndexWarmup: vi.fn(),
  stopWorkspaceMemoryIndex: vi.fn(),
}))

vi.mock('../../src/main/chat/codex-subscription/lifecycle', () => ({
  deleteCodexThreadForConversation: vi.fn().mockResolvedValue({
    conversationId: '',
    threadId: null,
    remoteDeleted: false,
  }),
}))

vi.mock('../../src/main/chat/github-copilot/lifecycle', () => ({
  deleteGitHubCopilotSessionForConversation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/main/chat/cursor-subscription/lifecycle', () => ({
  deleteCursorAgentForConversation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/main/chat/claude-agent-sdk/lifecycle', () => ({
  deleteClaudeSessionForConversation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/main/chat/chat-store', () => ({
  collectChatToolImageRefs: vi.fn(() => new Set()),
  releaseUnreferencedChatToolImages: vi.fn(),
}))

vi.mock('../../src/main/aggregator-service', () => ({
  cleanupAggregator: vi.fn(),
  createAggregator: vi.fn(),
  aggregatorDir: vi.fn(),
}))

vi.mock('../../src/main/i18n', () => ({
  tMain: () => (key: string) => key,
}))

import * as git from '../../src/main/git-service'
import * as store from '../../src/main/store'
import * as codexLifecycle from '../../src/main/chat/codex-subscription/lifecycle'
import * as githubCopilotLifecycle from '../../src/main/chat/github-copilot/lifecycle'
import * as cursorLifecycle from '../../src/main/chat/cursor-subscription/lifecycle'
import * as claudeLifecycle from '../../src/main/chat/claude-agent-sdk/lifecycle'
import * as memoryIndex from '../../src/main/memory/index'
import {
  addWorkspace,
  createSiblingConversation,
  deleteConversation,
  removeWorkspace,
} from '../../src/main/workspace-service'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(store.listWorkspaces).mockReturnValue([
    { id: 'ws-1', path: '/repo', name: 'repo', defaultBranch: 'main', addedAt: 1 },
  ] as never)
  vi.mocked(store.countOtherConversationsInCwd).mockReturnValue(0)
})

describe('workspace-service addWorkspace memory warm-up', () => {
  it('schedules warm-up after adding a workspace without waiting for index work', async () => {
    const inserted = { id: 'ws-new', path: '/repo-new', name: 'repo-new', defaultBranch: 'main', addedAt: 1 }
    vi.mocked(git.isGitRepo).mockResolvedValue(true)
    vi.mocked(git.isBareRepo).mockResolvedValue(false)
    vi.mocked(git.getToplevel).mockResolvedValue('/repo-new')
    vi.mocked(git.getDefaultBranch).mockResolvedValue('main')
    vi.mocked(store.getWorkspaceByPath)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(inserted as never)

    await expect(addWorkspace('/repo-new')).resolves.toEqual(inserted)

    expect(store.insertWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }))
    expect(memoryIndex.scheduleWorkspaceMemoryIndexWarmup).toHaveBeenCalledWith('ws-new')
  })

  it('schedules the same background warm-up when rediscovering an existing workspace', async () => {
    const existing = { id: 'ws-existing', path: '/repo', name: 'repo', defaultBranch: 'main', addedAt: 1 }
    vi.mocked(store.getWorkspaceByPath).mockReturnValue(existing as never)

    await expect(addWorkspace('/repo', { validated: { top: '/repo', defaultBranch: 'main' } })).resolves.toEqual(
      existing
    )

    expect(store.insertWorkspace).not.toHaveBeenCalled()
    expect(memoryIndex.scheduleWorkspaceMemoryIndexWarmup).toHaveBeenCalledWith('ws-existing')
  })
})

describe('workspace-service removeWorkspace', () => {
  it('closes the transient memory index before deleting durable workspace data', () => {
    removeWorkspace('ws-1')

    expect(memoryIndex.stopWorkspaceMemoryIndex).toHaveBeenCalledWith('ws-1')
    expect(store.deleteWorkspace).toHaveBeenCalledWith('ws-1')
    expect(vi.mocked(memoryIndex.stopWorkspaceMemoryIndex).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.deleteWorkspace).mock.invocationCallOrder[0]!
    )
  })
})

describe('workspace-service createSiblingConversation', () => {
  it('creates a Local sibling in the same cwd and branch without touching Git', async () => {
    vi.mocked(store.getConversation).mockReturnValue({
      id: 'local-source',
      scope: 'project',
      workspaceId: 'ws-1',
      name: 'main',
      branch: 'main',
      mode: 'local',
      cwd: '/repo',
      status: 'idle',
      createdAt: 1,
      archived: 0,
      lastActivityAt: 1,
      isMulti: 0,
    } as never)

    const created = await createSiblingConversation('local-source')

    expect(git.createWorktree).not.toHaveBeenCalled()
    expect(store.insertConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'project',
        workspaceId: 'ws-1',
        branch: 'main',
        mode: 'local',
        cwd: '/repo',
      })
    )
    expect(created).toMatchObject({ branch: 'main', mode: 'local', cwd: '/repo' })
  })

  it('preserves a worktree sibling attachment in the same cwd and branch', async () => {
    vi.mocked(store.getConversation).mockReturnValue({
      id: 'worktree-source',
      scope: 'project',
      workspaceId: 'ws-1',
      name: 'feature',
      branch: 'feature',
      mode: 'worktree',
      cwd: '/worktrees/feature',
      status: 'idle',
      createdAt: 1,
      archived: 0,
      lastActivityAt: 1,
      isMulti: 0,
    } as never)

    const created = await createSiblingConversation('worktree-source')

    expect(git.createWorktree).not.toHaveBeenCalled()
    expect(created).toMatchObject({
      branch: 'feature',
      mode: 'worktree',
      cwd: '/worktrees/feature',
    })
  })

  it('siblings inherit Maestro and allow an explicit override', async () => {
    vi.mocked(store.getConversation).mockReturnValue({
      id: 'maestro-source',
      scope: 'project',
      workspaceId: 'ws-1',
      name: 'feature',
      branch: 'feature',
      mode: 'worktree',
      experience: 'maestro',
      cwd: '/worktrees/feature',
      status: 'idle',
      createdAt: 1,
      archived: 0,
      lastActivityAt: 1,
      isMulti: 0,
    } as never)
    expect((await createSiblingConversation('maestro-source')).experience).toBe('maestro')
    expect((await createSiblingConversation('maestro-source', { experience: 'standard' })).experience).toBe('standard')
  })

  it('accepts a name and Maestro experience without creating another worktree', async () => {
    vi.mocked(store.getConversation).mockReturnValue({
      id: 'standard-source',
      scope: 'project',
      workspaceId: 'ws-1',
      name: 'Feature checkout',
      branch: 'feat/checkout',
      mode: 'worktree',
      experience: 'standard',
      cwd: '/worktrees/checkout',
      status: 'idle',
      createdAt: 1,
      archived: 0,
      lastActivityAt: 1,
      isMulti: 0,
    } as never)

    const created = await createSiblingConversation('standard-source', {
      experience: 'maestro',
      name: 'Feature checkout · Maestro',
    })

    expect(git.createWorktree).not.toHaveBeenCalled()
    expect(created).toMatchObject({
      name: 'Feature checkout · Maestro',
      experience: 'maestro',
      branch: 'feat/checkout',
      cwd: '/worktrees/checkout',
    })
  })
})

describe('workspace-service deleteConversation', () => {
  it('deletes Local conversations without touching the main checkout or user branches', async () => {
    vi.mocked(store.getConversation).mockReturnValue({
      id: 'c-local',
      scope: 'project',
      workspaceId: 'ws-1',
      mode: 'local',
      isMulti: 0,
      cwd: '/repo',
      branch: 'preexisting',
    } as never)

    await deleteConversation('c-local')

    expect(git.removeWorktree).not.toHaveBeenCalled()
    expect(git.deleteBranch).not.toHaveBeenCalled()
    expect(cursorLifecycle.deleteCursorAgentForConversation).toHaveBeenCalledWith('c-local')
    expect(codexLifecycle.deleteCodexThreadForConversation).toHaveBeenCalledWith('c-local')
    expect(githubCopilotLifecycle.deleteGitHubCopilotSessionForConversation).toHaveBeenCalledWith('c-local', {
      strict: true,
    })
    expect(claudeLifecycle.deleteClaudeSessionForConversation).toHaveBeenCalledWith('c-local', { strict: true })
    expect(store.deleteConversation).toHaveBeenCalledWith('c-local')
  })

  it('cleans up worktree and branch for an exclusive worktree conversation', async () => {
    vi.mocked(store.getConversation).mockReturnValue({
      id: 'c-worktree',
      scope: 'project',
      workspaceId: 'ws-1',
      mode: 'worktree',
      isMulti: 0,
      cwd: '/worktrees/feature',
      branch: 'feature',
    } as never)

    await deleteConversation('c-worktree')

    expect(git.removeWorktree).toHaveBeenCalledWith('/repo', '/worktrees/feature', true)
    expect(git.deleteBranch).toHaveBeenCalledWith('/repo', 'feature')
    expect(codexLifecycle.deleteCodexThreadForConversation).toHaveBeenCalledWith('c-worktree')
    expect(githubCopilotLifecycle.deleteGitHubCopilotSessionForConversation).toHaveBeenCalledWith('c-worktree', {
      strict: true,
    })
    expect(claudeLifecycle.deleteClaudeSessionForConversation).toHaveBeenCalledWith('c-worktree', {
      strict: true,
    })
    expect(store.deleteConversation).toHaveBeenCalledWith('c-worktree')
  })

  it('removes the worktree while preserving a preexisting branch when requested', async () => {
    vi.mocked(store.getConversation).mockReturnValue({
      id: 'c-runner-existing-branch',
      scope: 'project',
      workspaceId: 'ws-1',
      mode: 'worktree',
      isMulti: 0,
      cwd: '/worktrees/existing',
      branch: 'existing',
    } as never)

    await deleteConversation('c-runner-existing-branch', { preserveBranch: true })

    expect(git.removeWorktree).toHaveBeenCalledWith('/repo', '/worktrees/existing', true)
    expect(git.deleteBranch).not.toHaveBeenCalled()
    expect(store.deleteConversation).toHaveBeenCalledWith('c-runner-existing-branch')
  })

  it('keeps a shared worktree while sibling conversations use the same directory', async () => {
    vi.mocked(store.countOtherConversationsInCwd).mockReturnValue(1)
    vi.mocked(store.getConversation).mockReturnValue({
      id: 'c-shared-2',
      scope: 'project',
      workspaceId: 'ws-1',
      mode: 'worktree',
      isMulti: 0,
      cwd: '/worktrees/shared-feature',
      branch: 'shared-feature',
    } as never)

    await deleteConversation('c-shared-2')

    expect(git.removeWorktree).not.toHaveBeenCalled()
  })
})

describe('standalone lifecycle', () => {
  const standalone = {
    id: 'standalone',
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    isMulti: 0,
    cwd: '/private/chat',
  } as const
  beforeEach(() => {
    vi.mocked(store.getConversation).mockReturnValue(standalone as never)
    lifecycle.removeDirectory.mockReset().mockResolvedValue(undefined)
  })
  it('rejects standalone siblings before touching Git', async () => {
    await expect(createSiblingConversation('standalone')).rejects.toThrow('project-required')
    expect(git.createWorktree).not.toHaveBeenCalled()
  })
  it('cleans provider sessions, then the managed directory, permission key and row', async () => {
    await deleteConversation('standalone')
    expect(lifecycle.removeDirectory).toHaveBeenCalledWith(standalone)
    expect(lifecycle.deletePermission).toHaveBeenCalledWith('conversation:standalone')
    expect(store.deleteConversation).toHaveBeenCalledWith('standalone')
    expect(vi.mocked(claudeLifecycle.deleteClaudeSessionForConversation).mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.removeDirectory.mock.invocationCallOrder[0]
    )
    expect(lifecycle.removeDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.deleteConversation).mock.invocationCallOrder[0]
    )
    expect(git.removeWorktree).not.toHaveBeenCalled()
    expect(git.deleteBranch).not.toHaveBeenCalled()
  })
  it('preserves the row and permissions when directory cleanup fails', async () => {
    lifecycle.removeDirectory.mockRejectedValueOnce(new Error('unsafe directory'))
    await expect(deleteConversation('standalone')).rejects.toThrow('unsafe directory')
    expect(store.deleteConversation).not.toHaveBeenCalled()
    expect(lifecycle.deletePermission).not.toHaveBeenCalled()
  })
  it('preserves the directory and row when provider cleanup fails', async () => {
    vi.mocked(claudeLifecycle.deleteClaudeSessionForConversation).mockRejectedValueOnce(new Error('provider failed'))
    await expect(deleteConversation('standalone')).rejects.toThrow('provider failed')
    expect(lifecycle.removeDirectory).not.toHaveBeenCalled()
    expect(store.deleteConversation).not.toHaveBeenCalled()
  })
})
