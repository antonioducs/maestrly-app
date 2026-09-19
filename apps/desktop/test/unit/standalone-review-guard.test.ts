import { expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ git: vi.fn(), gh: vi.fn() }))
vi.mock('../../src/main/store', () => ({
  getConversation: () => ({ scope: 'standalone', workspaceId: null, branch: null, cwd: '/private/chat' }),
}))
vi.mock('../../src/main/git-service', () => ({
  getToplevel: h.git,
  getDefaultBranch: h.git,
  getDiff: h.git,
  isGitRepo: h.git,
}))
vi.mock('../../src/main/gh-command', () => ({ GhCommandError: Error, runGhCommand: h.gh }))
import { getReviewData } from '../../src/main/gh-service'

it('rejects standalone review before Git or GitHub discovery', async () => {
  await expect(getReviewData('chat')).rejects.toThrow('project-required')
  expect(h.git).not.toHaveBeenCalled()
  expect(h.gh).not.toHaveBeenCalled()
})
