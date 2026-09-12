import { promises as fsp } from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  userData: '',
  deleteAllManagedCodexThreads: vi.fn(async () => {}),
  deleteAllManagedGitHubCopilotSessions: vi.fn(async () => {}),
  deleteAllManagedClaudeSessions: vi.fn(async () => {}),
  resetCodexLocalData: vi.fn(async () => {}),
  resetGitHubCopilotLocalData: vi.fn(async () => {}),
  wipeClaudeLocalData: vi.fn(async () => {}),
  resetGrokLocalData: vi.fn(async () => {}),
  stopWorkspaceMemoryIndex: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}))

vi.mock('../../src/main/chat/codex-subscription/lifecycle', () => ({
  deleteAllManagedCodexThreads: h.deleteAllManagedCodexThreads,
}))

vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: () => ({ resetLocalData: h.resetCodexLocalData }),
}))

vi.mock('../../src/main/chat/github-copilot/lifecycle', () => ({
  deleteAllManagedGitHubCopilotSessions: h.deleteAllManagedGitHubCopilotSessions,
}))

vi.mock('../../src/main/chat/github-copilot/manager', () => ({
  getGitHubCopilotSubscriptionManager: () => ({ resetLocalData: h.resetGitHubCopilotLocalData }),
}))

vi.mock('../../src/main/chat/claude-agent-sdk/lifecycle', () => ({
  deleteAllManagedClaudeSessions: h.deleteAllManagedClaudeSessions,
}))

vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  getClaudeSubscriptionManager: () => ({ wipe: h.wipeClaudeLocalData }),
}))

vi.mock('../../src/main/chat/grok-subscription/manager', () => ({
  getGrokSubscriptionManager: () => ({ resetLocalData: h.resetGrokLocalData }),
}))

vi.mock('../../src/main/memory/index', () => ({
  stopWorkspaceMemoryIndex: h.stopWorkspaceMemoryIndex,
}))

import { workspaceDataDir } from '../../src/main/app-paths'
import { resetLocalAppData } from '../../src/main/local-data/local-data-reset'
import {
  listCodexThreadCleanup,
  putCodexThreadBinding,
  queueCodexThreadCleanup,
} from '../../src/main/chat/codex-subscription/thread-store'
import {
  listGitHubCopilotSessionBindings,
  listGitHubCopilotSessionCleanup,
  putGitHubCopilotSessionBinding,
  queueGitHubCopilotSessionCleanup,
} from '../../src/main/chat/github-copilot/session-store'
import { getDb, listAllConversations, listWorkspaces } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

describe('resetLocalAppData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.userData = mkdtempSync(path.join(os.tmpdir(), 'maestrly-local-reset-'))
    freshDb()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDb()
    rmSync(h.userData, { recursive: true, force: true })
  })

  it('finishes independent cleanup and rejects when an isolated runtime cannot be reset', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    getDb()
      .prepare(
        `INSERT INTO chat_usage_ledger (message_id, provider_id, model_id, usage_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('usage-to-wipe', 'p', 'm', JSON.stringify({ input: 1, output: 2 }), Date.now())
    putCodexThreadBinding({
      conversationId: conversation.id,
      threadId: 'thread_bound',
      modelId: 'gpt-test',
      toolSignature: 'tools-test',
      lastMessageId: 'message-test',
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
    })
    queueCodexThreadCleanup('conversation-already-deleted', 'thread_orphan')
    putGitHubCopilotSessionBinding({
      conversationId: conversation.id,
      sessionId: 'copilot-session-bound',
      modelId: 'gpt-test',
      harnessProfile: 'copilot-openai-v1',
      toolSignature: 'tools-test',
      lastMessageId: 'message-test',
      accountFingerprint: 'sha256:test',
    })
    queueGitHubCopilotSessionCleanup('conversation-already-deleted', 'copilot-session-orphan')

    const workspaceDir = workspaceDataDir(workspace.id)
    for (const dir of [workspaceDir]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'owned-data.json'), '{}')
    }

    const codexHomeError = new Error('CODEX_HOME was not removed')
    h.resetCodexLocalData.mockRejectedValueOnce(codexHomeError)
    const stopConversation = vi.fn(async () => {})
    const stopWorkspace = vi.fn(async () => {})

    let failure: unknown
    try {
      await resetLocalAppData({ stopConversation, stopWorkspace })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure).toMatchObject({
      message: 'Local data cleanup was incomplete.',
      errors: [codexHomeError],
    })
    expect(h.deleteAllManagedCodexThreads).toHaveBeenCalledOnce()
    expect(h.deleteAllManagedGitHubCopilotSessions).toHaveBeenCalledOnce()
    expect(h.resetCodexLocalData).toHaveBeenCalledOnce()
    expect(h.resetGitHubCopilotLocalData).toHaveBeenCalledOnce()
    expect(h.resetGrokLocalData).toHaveBeenCalledOnce()
    expect(stopConversation).toHaveBeenCalledWith(conversation.id)
    expect(stopWorkspace).toHaveBeenCalledWith(workspace.id)
    expect(h.stopWorkspaceMemoryIndex).toHaveBeenCalledWith(workspace.id)

    expect(listWorkspaces()).toEqual([])
    expect(listAllConversations()).toEqual([])
    expect(listCodexThreadCleanup()).toEqual([])
    expect(listGitHubCopilotSessionBindings()).toEqual([])
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM chat_usage_ledger').get()).toMatchObject({ n: 0 })
    expect(existsSync(workspaceDir)).toBe(false)
  })

  it('clears cross-workspace conversation dependencies before their workspace owners', async () => {
    const first = makeWorkspace()
    const second = makeWorkspace()
    const conversation = makeConversation(second.id, {})
    getDb()
      .prepare(`INSERT INTO conversation_repos
      (conversation_id, workspace_id, repo_top, branch, base, worktree_path, link_name, position)
      VALUES (?, ?, '/repo', 'branch', 'main', '/worktree', 'linked', 0)`)
      .run(conversation.id, first.id)
    await resetLocalAppData({ stopConversation: vi.fn(), stopWorkspace: vi.fn() })
    expect(listWorkspaces()).toEqual([])
    expect(listAllConversations()).toEqual([])
  })

  it.each([
    'running',
    'recovery-required',
  ])('preserves unresolved %s migration journals and all local data', async (status) => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    getDb()
      .prepare(`INSERT INTO conversation_migrations
      (id, conversation_id, source_workspace_id, source_branch, destination_branch, source_cwd,
       destination_cwd, source_head_oid, changes_json, git_plan_json, phase, status, created_at, updated_at)
      VALUES ('migration', ?, ?, 'main', 'next', '/source', '/destination', 'head', '[]', '{}', 'prepared', ?, 1, 1)`)
      .run(conversation.id, workspace.id, status)
    await expect(resetLocalAppData({ stopConversation: vi.fn(), stopWorkspace: vi.fn() })).rejects.toThrow(/migration/i)
    expect(listAllConversations()).toHaveLength(1)
    expect(getDb().prepare('SELECT id FROM conversation_migrations').all()).toHaveLength(1)
    expect(h.resetCodexLocalData).not.toHaveBeenCalled()
  })

  it('removes attachment images and tool output, including orphaned files', async () => {
    for (const root of ['chat-attachment-images', 'chat-tool-output']) {
      mkdirSync(path.join(h.userData, root), { recursive: true })
      writeFileSync(path.join(h.userData, root, 'orphan'), 'sensitive content')
    }
    await resetLocalAppData({ stopConversation: vi.fn(), stopWorkspace: vi.fn() })
    expect(existsSync(path.join(h.userData, 'chat-attachment-images'))).toBe(false)
    expect(existsSync(path.join(h.userData, 'chat-tool-output'))).toBe(false)
  })

  it('reports database cleanup failures and rolls back owners without removing their files', async () => {
    const workspace = makeWorkspace()
    makeConversation(workspace.id)
    const sidecar = workspaceDataDir(workspace.id)
    mkdirSync(sidecar, { recursive: true })
    writeFileSync(path.join(sidecar, 'note'), 'retained')
    getDb().exec(`
      INSERT INTO app_settings VALUES ('ui.locale', 'en');
      CREATE TRIGGER fail_settings_reset BEFORE DELETE ON app_settings
      BEGIN SELECT RAISE(ABORT, 'settings reset failed'); END;
    `)
    await expect(resetLocalAppData({ stopConversation: vi.fn(), stopWorkspace: vi.fn() })).rejects.toMatchObject({
      message: 'Local data cleanup was incomplete.',
      errors: [expect.objectContaining({ message: 'settings reset failed' })],
    })
    expect(listWorkspaces()).toHaveLength(1)
    expect(listAllConversations()).toHaveLength(1)
    expect(existsSync(path.join(sidecar, 'note'))).toBe(true)
  })

  it.each([
    'chat-generated-images',
    'chat-attachment-images',
    'chat-tool-output',
  ])('reports sensitive file cleanup failures for %s', async (root) => {
    const remove = fsp.rm.bind(fsp)
    vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (String(target).endsWith(root)) throw new Error('image cleanup denied')
      return remove(target, options)
    })
    await expect(resetLocalAppData({ stopConversation: vi.fn(), stopWorkspace: vi.fn() })).rejects.toMatchObject({
      message: 'Local data cleanup was incomplete.',
      errors: [expect.objectContaining({ message: 'image cleanup denied' })],
    })
  })

  it('preserves repositories and worktrees while deleting orphaned app-owned files', async () => {
    const workspace = makeWorkspace()
    const repo = path.join(h.userData, 'repository')
    const worktree = path.join(h.userData, 'worktrees', workspace.id)
    const sidecar = path.join(h.userData, 'workspace-data', 'orphan')
    for (const directory of [repo, worktree, sidecar]) {
      mkdirSync(directory, { recursive: true })
      writeFileSync(path.join(directory, 'keep.txt'), 'user content')
    }
    await resetLocalAppData({ stopConversation: vi.fn(), stopWorkspace: vi.fn() })
    expect(existsSync(path.join(repo, 'keep.txt'))).toBe(true)
    expect(existsSync(path.join(worktree, 'keep.txt'))).toBe(true)
    expect(existsSync(sidecar)).toBe(false)
  })

  it('waits for shutdown and preserves all data if any shutdown fails', async () => {
    const workspace = makeWorkspace()
    makeConversation(workspace.id, {})
    let finish: (() => void) | undefined
    const stopWorkspace = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const result = resetLocalAppData({
      stopConversation: vi.fn(async () => {
        throw new Error('still running')
      }),
      stopWorkspace,
    })
    const rejected = expect(result).rejects.toMatchObject({
      message: 'Local data reset stopped because live work could not be shut down.',
    })
    await vi.waitFor(() => expect(stopWorkspace).toHaveBeenCalledOnce())
    expect(listWorkspaces()).toHaveLength(1)
    expect(h.resetCodexLocalData).not.toHaveBeenCalled()
    finish!()
    await rejected
    expect(listAllConversations()).toHaveLength(1)
    expect(h.resetCodexLocalData).not.toHaveBeenCalled()
  })
})
