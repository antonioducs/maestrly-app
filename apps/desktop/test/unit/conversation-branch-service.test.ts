import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  getConversation: vi.fn(),
  currentGitHead: vi.fn(),
}))

vi.mock('../../src/main/store', () => ({ getConversation: h.getConversation }))
vi.mock('../../src/main/git-service', () => ({ currentGitHead: h.currentGitHead }))

import { getConversationBranchInfo } from '../../src/main/conversation-branch-service'

describe('getConversationBranchInfo', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves cwd by ID and exposes the actual branch without changing the persisted branch', async () => {
    h.getConversation.mockReturnValue({
      id: 'assistant-1',
      cwd: '/workspace/from-store',
      branch: 'main',
      isMulti: 0,
    })
    h.currentGitHead.mockResolvedValue({ kind: 'branch', name: 'feature/checked-out' })

    await expect(getConversationBranchInfo('assistant-1')).resolves.toEqual({
      conversationId: 'assistant-1',
      isMulti: false,
      repos: [
        {
          name: '',
          assignedBranch: 'main',
          head: { kind: 'branch', name: 'feature/checked-out' },
          diverged: true,
        },
      ],
    })
    expect(h.getConversation).toHaveBeenCalledWith('assistant-1')
    expect(h.currentGitHead).toHaveBeenCalledWith('/workspace/from-store')
  })

  it('resolves every worktree in a multi-repository conversation and preserves detached HEAD', async () => {
    h.getConversation.mockReturnValue({
      id: 'multi-1',
      cwd: '/aggregator',
      branch: 'feature/coordinated',
      isMulti: 1,
      repos: [
        {
          linkName: 'frontend',
          repoTop: '/repos/frontend',
          worktreePath: '/worktrees/frontend',
          branch: 'feature/coordinated',
        },
        {
          linkName: 'backend',
          repoTop: '/repos/backend',
          worktreePath: '/worktrees/backend',
          branch: 'feature/coordinated',
        },
      ],
    })
    h.currentGitHead
      .mockResolvedValueOnce({ kind: 'branch', name: 'feature/coordinated' })
      .mockResolvedValueOnce({ kind: 'detached', commit: 'abc1234' })

    const info = await getConversationBranchInfo('multi-1')

    expect(info?.isMulti).toBe(true)
    expect(info?.repos).toEqual([
      {
        name: 'frontend',
        assignedBranch: 'feature/coordinated',
        head: { kind: 'branch', name: 'feature/coordinated' },
        diverged: false,
      },
      {
        name: 'backend',
        assignedBranch: 'feature/coordinated',
        head: { kind: 'detached', commit: 'abc1234' },
        diverged: true,
      },
    ])
    expect(h.currentGitHead.mock.calls).toEqual([['/worktrees/frontend'], ['/worktrees/backend']])
  })

  it('returns null for a missing conversation', async () => {
    h.getConversation.mockReturnValue(undefined)

    await expect(getConversationBranchInfo('missing')).resolves.toBeNull()
    expect(h.currentGitHead).not.toHaveBeenCalled()
  })

  it('does not report divergence when Git is unavailable and no actual HEAD can be compared', async () => {
    h.getConversation.mockReturnValue({
      id: 'no-git-1',
      cwd: '/workspace/no-git',
      branch: 'main',
      isMulti: 0,
    })
    h.currentGitHead.mockResolvedValue({ kind: 'unavailable' })

    const info = await getConversationBranchInfo('no-git-1')

    expect(info?.repos).toEqual([
      {
        name: '',
        assignedBranch: 'main',
        head: { kind: 'unavailable' },
        diverged: false,
      },
    ])
  })
})
