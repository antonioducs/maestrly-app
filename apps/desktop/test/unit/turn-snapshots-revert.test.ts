import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeStandaloneConversation } from '../helpers/factories'
import { getDb } from '../../src/main/store'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { forgetCapturedTreesForTests } from '../../src/main/turn-snapshots/capture'
import {
  beginTurnSnapshot,
  configureTurnSnapshotLifecycle,
  resetTurnSnapshotLifecycleForTests,
  setTurnSnapshotsEnabled,
} from '../../src/main/turn-snapshots/lifecycle'
import { RETENTION_MS, runTurnSnapshotMaintenance } from '../../src/main/turn-snapshots/maintenance'
import { getSnapshotRecord } from '../../src/main/turn-snapshots/records'
import {
  confirmTurnRevert,
  forgetRevertTokensForTests,
  listTurnSnapshots,
  prepareTurnRevert,
  turnFilePatch,
  turnSnapshotDetail,
  TOKEN_TTL_MS,
} from '../../src/main/turn-snapshots/revert'
import { setTurnSnapshotsRoot } from '../../src/main/turn-snapshots/store'
import type { TurnRevertPreview } from '../../src/shared/turn-snapshots'
import type { StandaloneConversation } from '../../src/shared/conversation'

const temps: string[] = []
function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  temps.push(dir)
  return dir
}
function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), content)
}
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8')

const notified: string[] = []
const idle = { isRunning: () => false }

beforeEach(() => {
  freshDb()
  setTurnSnapshotsRoot(tempDir('turn-revert-root-'))
  configureTurnSnapshotLifecycle({ notify: (id) => notified.push(id) })
  forgetCapturedTreesForTests()
  forgetRevertTokensForTests()
  notified.length = 0
})
afterEach(() => {
  vi.restoreAllMocks()
  resetTurnSnapshotLifecycleForTests()
  setTurnSnapshotsRoot(null)
  closeDb()
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function userMessage(conversationId: string): string {
  const id = randomUUID()
  upsertChatMessage({
    id,
    conversationId,
    role: 'user',
    createdAt: Date.now(),
    parts: [{ type: 'text', id: `${id}_t`, text: 'go' }],
  })
  return id
}

/** One turn: snapshot at admission, the agent's changes, snapshot at the end. */
async function runTurn(conversation: StandaloneConversation, changes: () => void): Promise<string> {
  const handle = beginTurnSnapshot({ conversation })
  if (!handle) throw new Error('not snapshotted')
  await handle.attach(userMessage(conversation.id))
  changes()
  handle.end(`assistant-${randomUUID()}`)
  await vi.waitFor(() => expect(getSnapshotRecord(handle.recordId)?.status).toBe('ready'), { timeout: 15_000 })
  return handle.recordId
}

const allFiles = (preview: TurnRevertPreview) => preview.files.map(({ root, path }) => ({ root, path }))

describe('turn snapshots', { timeout: 60_000 }, () => {
  it('undoes a turn exactly, then redoes it', async () => {
    const work = tempDir('turn-revert-work-')
    write(work, 'keep.txt', 'keep\n')
    write(work, 'edit.txt', 'before\n')
    write(work, 'remove.txt', 'removed by the turn\n')
    const conversation = makeStandaloneConversation({ cwd: work })
    const recordId = await runTurn(conversation, () => {
      write(work, 'edit.txt', 'after\n')
      fs.rmSync(path.join(work, 'remove.txt'))
      write(work, 'created/new.txt', 'new\n')
    })

    const detail = turnSnapshotDetail(conversation.id, recordId)!
    expect(detail.totals).toEqual({ files: 3, additions: 2, deletions: 2 })
    expect(detail.files.map((file) => [file.path, file.status])).toEqual([
      ['created/new.txt', 'added'],
      ['edit.txt', 'modified'],
      ['remove.txt', 'deleted'],
    ])
    expect(notified).toContain(conversation.id)
    const patch = await turnFilePatch({ conversationId: conversation.id, recordId, root: 0, path: 'edit.txt' })
    expect(patch?.patch).toContain('+after')

    const prepared = await prepareTurnRevert({ conversationId: conversation.id, recordId, action: 'undo' }, idle)
    if (prepared.status !== 'ready') throw new Error(prepared.status)
    expect(prepared.preview.files.map((file) => [file.path, file.effect, file.conflict])).toEqual([
      ['created/new.txt', 'delete', undefined],
      ['edit.txt', 'restore', undefined],
      ['remove.txt', 'recreate', undefined],
    ])
    const confirmed = await confirmTurnRevert(
      { token: prepared.token, files: allFiles(prepared.preview), overwrite: [] },
      idle
    )
    expect(confirmed).toMatchObject({ status: 'reverted', failed: [] })
    expect(read(work, 'edit.txt')).toBe('before\n')
    expect(read(work, 'remove.txt')).toBe('removed by the turn\n')
    expect(fs.existsSync(path.join(work, 'created'))).toBe(false)
    expect(read(work, 'keep.txt')).toBe('keep\n')
    expect(listTurnSnapshots(conversation.id).records[0]?.undone).toBe(3)

    const redo = await prepareTurnRevert({ conversationId: conversation.id, recordId, action: 'redo' }, idle)
    if (redo.status !== 'ready') throw new Error(redo.status)
    await confirmTurnRevert({ token: redo.token, files: allFiles(redo.preview), overwrite: [] }, idle)
    expect(read(work, 'edit.txt')).toBe('after\n')
    expect(fs.existsSync(path.join(work, 'remove.txt'))).toBe(false)
    expect(read(work, 'created/new.txt')).toBe('new\n')
    expect(listTurnSnapshots(conversation.id).records[0]?.undone).toBe(0)
  })

  it('never overwrites a later change unless the person chooses to', async () => {
    const work = tempDir('turn-revert-conflict-')
    write(work, 'a.txt', 'a0\n')
    write(work, 'b.txt', 'b0\n')
    const conversation = makeStandaloneConversation({ cwd: work })
    const recordId = await runTurn(conversation, () => {
      write(work, 'a.txt', 'a1\n')
      write(work, 'b.txt', 'b1\n')
    })
    // The person edits a.txt after the turn.
    write(work, 'a.txt', 'a-user\n')

    const prepared = await prepareTurnRevert({ conversationId: conversation.id, recordId, action: 'undo' }, idle)
    if (prepared.status !== 'ready') throw new Error(prepared.status)
    expect(prepared.preview.files.find((file) => file.path === 'a.txt')?.conflict).toBe('outside')
    const preview = await turnFilePatch({
      conversationId: conversation.id,
      recordId,
      root: 0,
      path: 'a.txt',
      token: prepared.token,
    })
    expect(preview?.patch).toContain('-a-user')
    expect(preview?.patch).toContain('+a0')

    const kept = await confirmTurnRevert(
      { token: prepared.token, files: allFiles(prepared.preview), overwrite: [] },
      idle
    )
    expect(kept).toMatchObject({ status: 'reverted', files: [{ root: 0, path: 'b.txt' }] })
    expect(read(work, 'a.txt')).toBe('a-user\n')
    expect(read(work, 'b.txt')).toBe('b0\n')

    const again = await prepareTurnRevert({ conversationId: conversation.id, recordId, action: 'undo' }, idle)
    if (again.status !== 'ready') throw new Error(again.status)
    expect(again.preview.files.map((file) => file.path)).toEqual(['a.txt'])
    await confirmTurnRevert(
      { token: again.token, files: allFiles(again.preview), overwrite: allFiles(again.preview) },
      idle
    )
    expect(read(work, 'a.txt')).toBe('a0\n')
  })

  it('names a later turn of the conversation as the source of a conflict', async () => {
    const work = tempDir('turn-revert-later-')
    write(work, 'a.txt', 'v0\n')
    const conversation = makeStandaloneConversation({ cwd: work })
    const first = await runTurn(conversation, () => write(work, 'a.txt', 'v1\n'))
    await runTurn(conversation, () => write(work, 'a.txt', 'v2\n'))
    const prepared = await prepareTurnRevert({ conversationId: conversation.id, recordId: first, action: 'undo' }, idle)
    if (prepared.status !== 'ready') throw new Error(prepared.status)
    expect(prepared.preview.files[0]).toMatchObject({ path: 'a.txt', conflict: 'later-turn' })
  })

  it('plans again when a chosen file changes between review and confirmation', async () => {
    const work = tempDir('turn-revert-stale-')
    write(work, 'a.txt', 'v0\n')
    const conversation = makeStandaloneConversation({ cwd: work })
    const recordId = await runTurn(conversation, () => write(work, 'a.txt', 'v1\n'))
    const prepared = await prepareTurnRevert({ conversationId: conversation.id, recordId, action: 'undo' }, idle)
    if (prepared.status !== 'ready') throw new Error(prepared.status)
    write(work, 'a.txt', 'v-meanwhile\n')
    const stale = await confirmTurnRevert(
      { token: prepared.token, files: allFiles(prepared.preview), overwrite: [] },
      idle
    )
    if (stale.status !== 'stale') throw new Error(stale.status)
    expect(stale.preview.files[0]).toMatchObject({ path: 'a.txt', conflict: 'outside' })
    expect(read(work, 'a.txt')).toBe('v-meanwhile\n')
    // The reviewed token was used up; the fresh one works.
    expect(
      await confirmTurnRevert({ token: prepared.token, files: allFiles(prepared.preview), overwrite: [] }, idle)
    ).toEqual({ status: 'invalid-token' })
    await confirmTurnRevert(
      { token: stale.token, files: allFiles(stale.preview), overwrite: allFiles(stale.preview) },
      idle
    )
    expect(read(work, 'a.txt')).toBe('v0\n')
  })

  it('rejects expired tokens and refuses while the conversation runs', async () => {
    const work = tempDir('turn-revert-token-')
    write(work, 'a.txt', 'v0\n')
    const conversation = makeStandaloneConversation({ cwd: work })
    const recordId = await runTurn(conversation, () => write(work, 'a.txt', 'v1\n'))
    expect(
      await prepareTurnRevert({ conversationId: conversation.id, recordId, action: 'undo' }, { isRunning: () => true })
    ).toEqual({ status: 'busy' })
    const prepared = await prepareTurnRevert({ conversationId: conversation.id, recordId, action: 'undo' }, idle)
    if (prepared.status !== 'ready') throw new Error(prepared.status)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + TOKEN_TTL_MS + 1)
    expect(
      await confirmTurnRevert({ token: prepared.token, files: allFiles(prepared.preview), overwrite: [] }, idle)
    ).toEqual({ status: 'expired-token' })
    expect(read(work, 'a.txt')).toBe('v1\n')
  })

  it('undoes one file of a turn on its own', async () => {
    const work = tempDir('turn-revert-file-')
    write(work, 'a.txt', 'a0\n')
    write(work, 'b.txt', 'b0\n')
    const conversation = makeStandaloneConversation({ cwd: work })
    const recordId = await runTurn(conversation, () => {
      write(work, 'a.txt', 'a1\n')
      write(work, 'b.txt', 'b1\n')
    })
    const prepared = await prepareTurnRevert(
      { conversationId: conversation.id, recordId, action: 'undo', files: [{ root: 0, path: 'b.txt' }] },
      idle
    )
    if (prepared.status !== 'ready') throw new Error(prepared.status)
    expect(prepared.preview.files.map((file) => file.path)).toEqual(['b.txt'])
    await confirmTurnRevert({ token: prepared.token, files: allFiles(prepared.preview), overwrite: [] }, idle)
    expect(read(work, 'a.txt')).toBe('a1\n')
    expect(read(work, 'b.txt')).toBe('b0\n')
    const detail = turnSnapshotDetail(conversation.id, recordId)!
    expect(detail.files.map((file) => [file.path, file.revert])).toEqual([
      ['a.txt', undefined],
      ['b.txt', 'undone'],
    ])
  })

  it('records other conversations sharing the folder and attributes their changes', async () => {
    const work = tempDir('turn-revert-overlap-')
    write(work, 'shared.txt', 's0\n')
    const mine = makeStandaloneConversation({ cwd: work, name: 'Mine' })
    const theirs = makeStandaloneConversation({ cwd: work, name: 'Theirs' })
    const a = beginTurnSnapshot({ conversation: mine })!
    await a.attach(userMessage(mine.id))
    const b = beginTurnSnapshot({ conversation: theirs })!
    await b.attach(userMessage(theirs.id))
    write(work, 'shared.txt', 's1\n')
    a.end('assistant-a')
    await vi.waitFor(() => expect(getSnapshotRecord(a.recordId)?.status).toBe('ready'), { timeout: 15_000 })
    write(work, 'shared.txt', 's2\n')
    b.end('assistant-b')
    await vi.waitFor(() => expect(getSnapshotRecord(b.recordId)?.status).toBe('ready'), { timeout: 15_000 })
    expect(getSnapshotRecord(a.recordId)?.overlap).toEqual([theirs.id])

    const prepared = await prepareTurnRevert({ conversationId: mine.id, recordId: a.recordId, action: 'undo' }, idle)
    if (prepared.status !== 'ready') throw new Error(prepared.status)
    expect(prepared.preview.overlap).toEqual([{ conversationId: theirs.id, name: 'Theirs' }])
    expect(prepared.preview.files[0]).toMatchObject({
      path: 'shared.txt',
      conflict: 'outside',
      maybeFrom: [{ conversationId: theirs.id, name: 'Theirs' }],
    })
  })

  it('leaves bot turns and disabled snapshots out', () => {
    const conversation = makeStandaloneConversation({ cwd: tempDir('turn-revert-bot-') })
    expect(beginTurnSnapshot({ conversation, botTurn: true })).toBeNull()
    setTurnSnapshotsEnabled(false)
    expect(beginTurnSnapshot({ conversation })).toBeNull()
    expect(listTurnSnapshots(conversation.id).enabled).toBe(false)
  })

  it('forgets a turn that never stored its message', async () => {
    const conversation = makeStandaloneConversation({ cwd: tempDir('turn-revert-abandon-') })
    const handle = beginTurnSnapshot({ conversation })!
    handle.abandon()
    handle.end(null)
    expect(listTurnSnapshots(conversation.id).records).toEqual([])
  })

  it('deletes records with their messages and expires them after the retention period', async () => {
    const work = tempDir('turn-revert-retention-')
    write(work, 'a.txt', 'v0\n')
    const conversation = makeStandaloneConversation({ cwd: work })
    const kept = await runTurn(conversation, () => write(work, 'a.txt', 'v1\n'))
    const dropped = await runTurn(conversation, () => write(work, 'a.txt', 'v2\n'))
    getDb().prepare('DELETE FROM chat_messages WHERE id = ?').run(getSnapshotRecord(dropped)!.userMessageId)
    expect(getSnapshotRecord(dropped)).toBeNull()

    await runTurnSnapshotMaintenance(Date.now() + RETENTION_MS + 60_000)
    expect(getSnapshotRecord(kept)?.status).toBe('expired')
    // The summary stays visible; the undo does not.
    expect(turnSnapshotDetail(conversation.id, kept)?.totals?.files).toBe(1)
    expect(await prepareTurnRevert({ conversationId: conversation.id, recordId: kept, action: 'undo' }, idle)).toEqual({
      status: 'unavailable',
      reason: 'expired',
    })
  })
})
