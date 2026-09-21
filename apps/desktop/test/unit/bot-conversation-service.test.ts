import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { freshDb, closeDb, restartDb } from '../helpers/db'
import { makeWorkspace } from '../helpers/factories'
import { runGit } from '../../src/main/git-command'
import { createWorktree } from '../../src/main/git-service'
import { createBotConversation, resumeBotConversation } from '../../src/main/bot/conversation-service'
import { findBotConversation, setBotManagementState } from '../../src/main/bot/store'
import { getConversation, deleteConversation, getDb } from '../../src/main/store'
import type { BotIdentity } from '../../src/shared/bot'

let root: string
let workspaceId: string
let repo: string
const identity: BotIdentity = {
  instanceId: 'bridge',
  ownerUserId: 'owner',
  desktopId: 'desktop',
  connectionId: 'grok',
  botName: 'Grok Bot',
}
const input = () => ({ workspaceId, requestId: randomUUID(), name: 'Bot task', baseBranch: 'main' })

beforeEach(async () => {
  freshDb()
  root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-bot-worktree-'))
  repo = path.join(root, 'repo')
  await mkdir(repo)
  vi.spyOn(app, 'getPath').mockReturnValue(path.join(root, 'user-data'))
  await runGit(repo, ['init', '-b', 'main'])
  await writeFile(path.join(repo, 'source.txt'), 'initial\n')
  await runGit(repo, ['add', '.'])
  await runGit(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'])
  workspaceId = makeWorkspace({ path: repo }).id
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  await rm(root, { recursive: true, force: true })
})

it('allocates exclusive worktrees for new conversations and reuses only the same conversation on resume', async () => {
  const request = input()
  const first = await createBotConversation(identity, request)
  const second = await createBotConversation(identity, input())
  expect(first.id).not.toBe(second.id)
  expect(first.cwd).not.toBe(second.cwd)
  expect(first.branch).not.toBe(second.branch)
  expect(first.cwd).not.toBe(repo)
  await writeFile(path.join(first.cwd, 'source.txt'), 'bot-only\n')
  expect(await runGit(repo, ['status', '--porcelain'])).toBe('')
  expect(await createBotConversation(identity, request)).toMatchObject({ id: first.id, cwd: first.cwd })
  restartDb()
  expect(await resumeBotConversation(identity, first.id)).toMatchObject({
    id: first.id,
    cwd: first.cwd,
    botOrigin: { kind: 'bot', botName: 'Grok Bot' },
  })
})

it('deduplicates concurrent creation and rejects a changed payload', async () => {
  const request = input()
  const [a, b] = await Promise.all([createBotConversation(identity, request), createBotConversation(identity, request)])
  expect(a.id).toBe(b.id)
  await expect(createBotConversation(identity, { ...request, name: 'Another task' })).rejects.toThrow(/different input/)
  const row = getDb().prepare('SELECT count(*) AS n FROM bot_conversation_allocations').get() as { n: number }
  expect(row.n).toBe(1)
})

it('recovers its allocated worktree after a SQLite failure without allocating another one', async () => {
  const request = input()
  getDb().exec(`CREATE TRIGGER bot_fixture_fail_insert BEFORE INSERT ON conversations
    WHEN NEW.bot_origin IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END;`)
  await expect(createBotConversation(identity, request)).rejects.toThrow('fixture insert failure')
  const allocation = findBotConversation(identity, request.requestId)!
  expect(allocation.phase).toBe('recovery')
  expect(allocation.conversationId).toBeNull()
  getDb().exec('DROP TRIGGER bot_fixture_fail_insert')
  restartDb()
  const recovered = await createBotConversation(identity, request)
  expect(recovered.id).toBe(allocation.allocationId)
  expect(recovered.cwd).toBe(allocation.cwd)
  expect((await runGit(repo, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(2)
})

it('refuses another bot, owner, desktop and modified workspace binding', async () => {
  const conversation = await createBotConversation(identity, input())
  for (const changed of [
    { connectionId: 'other' },
    { ownerUserId: 'other' },
    { desktopId: 'other' },
    { instanceId: 'other' },
  ])
    await expect(resumeBotConversation({ ...identity, ...changed }, conversation.id)).rejects.toThrow(/another bot/)
  getDb().prepare('UPDATE conversations SET workspace_id=? WHERE id=?').run(makeWorkspace().id, conversation.id)
  await expect(resumeBotConversation(identity, conversation.id)).rejects.toThrow(/no longer matches/)
})

it('preserves deletion tombstones and refuses to recreate a missing worktree', async () => {
  const request = input()
  const conversation = await createBotConversation(identity, request)
  await rm(conversation.cwd, { recursive: true, force: true })
  await expect(resumeBotConversation(identity, conversation.id)).rejects.toThrow(/missing or replaced/)
  deleteConversation(conversation.id)
  restartDb()
  expect(findBotConversation(identity, request.requestId)?.phase).toBe('deleted')
  await expect(createBotConversation(identity, request)).rejects.toThrow(/deleted/)
})

it('honors persisted owner pause and never treats an archived chat as resumable', async () => {
  const conversation = await createBotConversation(identity, input())
  setBotManagementState(conversation.id, 'paused')
  restartDb()
  expect(getConversation(conversation.id)?.botManagementState).toBe('paused')
  await expect(resumeBotConversation(identity, conversation.id)).rejects.toThrow(/paused/)
  setBotManagementState(conversation.id, 'active')
  getDb().prepare('UPDATE conversations SET archived=1 WHERE id=?').run(conversation.id)
  await expect(resumeBotConversation(identity, conversation.id)).rejects.toThrow(/archived/)
})

it('refuses an existing branch in exclusive mode but preserves the legacy human behavior', async () => {
  const conversation = await createBotConversation(identity, input())
  await expect(
    createWorktree({
      top: repo,
      branch: conversation.branch,
      base: 'main',
      isNewBranch: true,
      exclusive: true,
      dest: path.join(root, 'other'),
    })
  ).rejects.toThrow(/already exists/)
  await expect(
    createWorktree({ top: repo, branch: conversation.branch, base: 'main', isNewBranch: false })
  ).rejects.toThrow(/owned exclusively/)
  const human = await createWorktree({
    top: repo,
    branch: 'human',
    base: 'main',
    isNewBranch: true,
    dest: path.join(root, 'human'),
  })
  const reused = await createWorktree({ top: repo, branch: 'human', base: 'main', isNewBranch: false })
  expect(await realpath(reused)).toBe(await realpath(human))
})
