import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Attach-only integration without mocking Git: the real predicate, prepare, and coordinator run together
// through the service. Service unit tests mock the entire Git module and cannot cover this interaction.
const h = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  insertConversation: vi.fn(),
}))
vi.mock('../../src/main/store', () => ({
  getWorkspace: h.getWorkspace,
  insertConversation: h.insertConversation,
}))

import { __resetCwdActivityForTests, tryAcquireCwdActivity } from '../../src/main/cwd-activity-coordinator'
import {
  __resetLocalConversationTokensForTests,
  confirmLocalConversation,
  prepareLocalConversation,
} from '../../src/main/local-conversation/service'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

let repo: string
beforeEach(() => {
  vi.clearAllMocks()
  __resetLocalConversationTokensForTests()
  __resetCwdActivityForTests()
  repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'local-conv-attach-int-')))
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@test'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  git(repo, ['branch', '-M', 'main'])
  h.getWorkspace.mockReturnValue({ id: 'ws', path: repo })
})
afterEach(() => {
  __resetCwdActivityForTests()
  rmSync(repo, { recursive: true, force: true })
})

const intent = {
  type: 'switch-existing' as const,
  branch: 'main',
  ref: { kind: 'local' as const, name: 'main' },
}

describe('local conversation attach-only (real service and Git integration)', () => {
  it('creates on the current branch with a dirty tree and real blocking activity without modifying Git', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n')
    const release = tryAcquireCwdActivity(repo, 'chat')
    try {
      const prepared = await prepareLocalConversation({ workspaceId: 'ws', intent })
      if (prepared.status !== 'ready') throw new Error(`prepare failed: ${prepared.status}`)
      expect(prepared.requiresConfirmation).toBe(false)

      const result = await confirmLocalConversation(prepared.token)

      expect(result.status).toBe('created')
      expect(h.insertConversation).toHaveBeenCalledWith(
        expect.objectContaining({ branch: 'main', mode: 'local', cwd: repo })
      )
      expect(git(repo, ['branch', '--show-current'])).toBe('main')
      expect(git(repo, ['stash', 'list'])).toBe('')
      expect(git(repo, ['status', '--porcelain'])).toContain('tracked.txt')
    } finally {
      release?.()
    }
  })

  it('becomes stale if checkout leaves the target branch between preview and confirmation', async () => {
    const prepared = await prepareLocalConversation({ workspaceId: 'ws', intent })
    if (prepared.status !== 'ready') throw new Error(`prepare failed: ${prepared.status}`)

    git(repo, ['switch', '-q', '-c', 'other'])
    const result = await confirmLocalConversation(prepared.token)

    expect(result.status).toBe('stale')
    expect(h.insertConversation).not.toHaveBeenCalled()
    // The refreshed preview reflects the mutating operation that confirmation would now require.
    if (result.status !== 'stale') throw new Error('missing stale result')
    expect(result.preview).toMatchObject({ currentBranch: 'other', targetBranch: 'main' })
    expect(git(repo, ['branch', '--show-current'])).toBe('other')
  })
})
