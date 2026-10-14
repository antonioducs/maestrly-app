import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { assertConversationMigrationMutationAllowed } from '../../src/main/conversation-migration/store'
import { getMoveEndpoint } from '../../src/main/conversation-move/endpoint-store'
import {
  __resetMoveLeasesForTests,
  moveLeaseOwner,
  restoreMoveEndpointLeases,
} from '../../src/main/conversation-move/leases'
import { readMovePackage } from '../../src/main/conversation-move/package'
import {
  checkSourceAncestry,
  exportSource,
  freezeSource,
  inspectSource,
  releaseSource,
  type SourceDeps,
  thawSource,
} from '../../src/main/conversation-move/source'
import {
  __resetCwdActivityForTests,
  cwdLeaseOwner,
  tryAcquireCwdActivity,
} from '../../src/main/cwd-activity-coordinator'
import { createWorktree } from '../../src/main/git-service'
import { getConversation, getDb } from '../../src/main/store'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { dirty, git, type MoveRepo, makeRemoteRepo } from '../helpers/move-repo'

const OP = '5f0c2a8e-1b2c-4d3e-8f90-a1b2c3d4e5f6'
let repo: MoveRepo
let conv: ReturnType<typeof makeConversation>
let deps: { quiesce: Mock<SourceDeps['quiesce']>; appVersion: () => string }

beforeEach(async () => {
  freshDb()
  repo = makeRemoteRepo('maestrly-move-source-')
  git(repo.work, 'checkout', '-q', 'main')
  const cwd = await createWorktree({
    top: repo.work,
    branch: 'feat',
    base: 'main',
    isNewBranch: false,
    dest: path.join(repo.root, 'wt-feat'),
  })
  dirty(cwd)
  const ws = makeWorkspace({ path: repo.work })
  conv = makeConversation(ws.id, { cwd, branch: 'feat', mode: 'worktree', name: 'Fix the parser' })
  const insert = getDb().prepare(
    'INSERT INTO chat_messages (id, conversation_id, role, parts_json, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const seq of [1, 2, 3]) insert.run(`m${seq}-${conv.id}`, conv.id, seq % 2 ? 'user' : 'assistant', '[]', seq, seq)
  deps = { quiesce: vi.fn<SourceDeps['quiesce']>(async () => ({ ok: true, failed: [] })), appVersion: () => '1.0.0' }
})
afterEach(() => {
  __resetMoveLeasesForTests()
  __resetCwdActivityForTests()
  closeDb()
  repo.cleanup()
})

async function freeze(): Promise<string> {
  const { fingerprint } = await inspectSource({ conversationId: conv.id })
  await freezeSource({ operationId: OP, conversationId: conv.id, fingerprint }, deps)
  return fingerprint
}

describe('conversation move source', () => {
  it('reports an eligible conversation with a stable fingerprint', async () => {
    const a = await inspectSource({ conversationId: conv.id })
    const b = await inspectSource({ conversationId: conv.id })
    expect(a.blockers).toEqual([])
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a).toMatchObject({ branch: 'feat', mode: 'worktree', commitsAhead: 1, transcript: { messages: 3 } })
    expect(a.warnings).toEqual(
      expect.arrayContaining(['provider-session-restarts', 'runtime-not-moved', 'project-memory-stays'])
    )
    expect(a.warnings).not.toContain('source-checkout-kept')
    expect(a.ignored.map((entry) => entry.path)).toContain('.env.local')
  })

  it.each(['bot', 'multi', 'archived'])('blocks a %s conversation', async (kind) => {
    const column = { bot: "bot_origin = '{}'", multi: 'is_multi = 1', archived: 'archived = 1' }[kind]
    getDb().prepare(`UPDATE conversations SET ${column} WHERE id = ?`).run(conv.id)
    const result = await inspectSource({ conversationId: conv.id })
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['not-eligible'])
  })

  it('blocks a running conversation', async () => {
    getDb().prepare("UPDATE conversations SET status = 'working' WHERE id = ?").run(conv.id)
    expect((await inspectSource({ conversationId: conv.id })).blockers.map((blocker) => blocker.code)).toEqual([
      'running',
    ])
  })

  it('tells whether a commit is an ancestor of the conversation', async () => {
    const base = git(repo.work, 'rev-parse', 'main')
    expect(await checkSourceAncestry({ conversationId: conv.id, ancestorOid: base })).toBe(true)
    expect(await checkSourceAncestry({ conversationId: conv.id, ancestorOid: 'c'.repeat(40) })).toBe(false)
  })

  it('freezes the source: chat turns cannot start and the conversation cannot be deleted', async () => {
    await freeze()
    expect(deps.quiesce).toHaveBeenCalledWith(conv.id, conv.cwd)
    expect(tryAcquireCwdActivity(conv.cwd, 'chat')).toBeNull()
    expect(() => assertConversationMigrationMutationAllowed(conv.id, 'Delete conversation')).toThrow(/being moved/)
    // Freezing again is a no-op.
    await freezeSource({ operationId: OP, conversationId: conv.id, fingerprint: 'other' }, deps)
    expect(deps.quiesce).toHaveBeenCalledTimes(1)
  })

  it('refuses a stale preview and thaws', async () => {
    const { fingerprint } = await inspectSource({ conversationId: conv.id })
    await writeFile(path.join(conv.cwd, 'b.txt'), 'changed again')
    await expect(freezeSource({ operationId: OP, conversationId: conv.id, fingerprint }, deps)).rejects.toMatchObject({
      code: 'stale',
    })
    expect(getMoveEndpoint(OP, 'source')?.state).toBe('thawed')
    expect(cwdLeaseOwner(conv.cwd)).toBeNull()
  })

  it('refuses to freeze when quiescing fails', async () => {
    deps.quiesce.mockResolvedValueOnce({ ok: false, failed: ['chat'] })
    await expect(freeze()).rejects.toMatchObject({ code: 'running' })
    expect(cwdLeaseOwner(conv.cwd)).toBeNull()
  })

  it('exports once and returns the same package again', async () => {
    await freeze()
    await expect(
      exportSource({ operationId: OP, selectedIgnoredPaths: ['.env.local'], confirmedSensitivePaths: [] }, deps)
    ).rejects.toThrow(/confirmation/)
    const pkg = await exportSource(
      { operationId: OP, selectedIgnoredPaths: ['.env.local'], confirmedSensitivePaths: ['.env.local'] },
      deps
    )
    expect(pkg.name).toBe('fix-the-parser.maestrly-move')
    expect(pkg.digest).toMatchObject({ conversationId: conv.id, messages: 3 })
    await expect(access(pkg.path)).resolves.toBeUndefined()
    const again = await exportSource({ operationId: OP, selectedIgnoredPaths: [], confirmedSensitivePaths: [] }, deps)
    expect(again.sha256).toBe(pkg.sha256)
    const read = await readMovePackage(pkg.path, path.join(repo.root, 'extract'), { appVersion: '1.0.0' })
    expect(read.files.map((file) => `${file.kind}:${file.relative}`)).toEqual([
      'ignored:.env.local',
      'bundle:branch.bundle',
    ])
    expect(await readFile(path.join(conv.cwd, 'b.txt'), 'utf8')).toBe('b.txt unstaged\n')
  })

  it('releases: deletes the conversation and worktree, keeps the branch, backup ref and package', async () => {
    await freeze()
    const pkg = await exportSource({ operationId: OP, selectedIgnoredPaths: [], confirmedSensitivePaths: [] }, deps)
    await releaseSource({ operationId: OP })
    expect(getConversation(conv.id)).toBeUndefined()
    await expect(access(conv.cwd)).rejects.toThrow()
    expect(git(repo.work, 'branch', '--list', 'feat')).toContain('feat')
    expect(git(repo.work, 'rev-parse', `refs/maestrly/moved/${OP}`)).toMatch(/^[0-9a-f]{40}$/)
    expect(git(repo.work, 'for-each-ref', `refs/maestrly/move/${OP}`)).toBe('')
    await expect(access(pkg.path)).resolves.toBeUndefined()
    expect(getMoveEndpoint(OP, 'source')?.state).toBe('released')
    expect(cwdLeaseOwner(conv.cwd)).toBeNull()
    await releaseSource({ operationId: OP })
  })

  it('thaws an exported source and refuses to thaw a released one', async () => {
    await freeze()
    const pkg = await exportSource({ operationId: OP, selectedIgnoredPaths: [], confirmedSensitivePaths: [] }, deps)
    await thawSource({ operationId: OP })
    expect(getMoveEndpoint(OP, 'source')?.state).toBe('thawed')
    expect(cwdLeaseOwner(conv.cwd)).toBeNull()
    expect(git(repo.work, 'for-each-ref', `refs/maestrly/move/${OP}`)).toBe('')
    await expect(access(pkg.path)).rejects.toThrow()
    expect(getConversation(conv.id)).toBeDefined()
    await thawSource({ operationId: OP })

    const other = '6f0c2a8e-1b2c-4d3e-8f90-a1b2c3d4e5f6'
    const { fingerprint } = await inspectSource({ conversationId: conv.id })
    await freezeSource({ operationId: other, conversationId: conv.id, fingerprint }, deps)
    await exportSource({ operationId: other, selectedIgnoredPaths: [], confirmedSensitivePaths: [] }, deps)
    await releaseSource({ operationId: other })
    await expect(thawSource({ operationId: other })).rejects.toMatchObject({ code: 'already-released' })
  })

  it('does nothing when thawing a move that never reached the source', async () => {
    await expect(thawSource({ operationId: OP })).resolves.toBeUndefined()
  })

  it('restores the source lease after a restart', async () => {
    await freeze()
    restartDb()
    __resetMoveLeasesForTests()
    __resetCwdActivityForTests()
    expect(cwdLeaseOwner(conv.cwd)).toBeNull()
    restoreMoveEndpointLeases()
    expect(cwdLeaseOwner(conv.cwd)).toBe(moveLeaseOwner(OP))
  })
})
