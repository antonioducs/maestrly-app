import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ArtifactAdmin, createArtifactAdmin } from '../src/admin.js'
import { createCommentService } from '../src/comments.js'
import { ArtifactHostError } from '../src/errors.js'
import { COMMENTS_PAGE_SIZE, MAX_COMMENT_CHARS } from '../src/limits.js'
import { createActivityRecorder } from '../src/sharing-admin.js'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BlobStore } from '../src/store/blobs.js'
import { CommentStore } from '../src/store/comment-store.js'
import { openDatabase } from '../src/store/db.js'
import { SharingStore } from '../src/store/sharing-store.js'
import { tempDir, testClock, utf8 } from './helpers.js'

let cleanup: () => void
let store: ArtifactStore
let blobs: BlobStore
let admin: ArtifactAdmin
let clock: ReturnType<typeof testClock>
let onChange: ReturnType<typeof vi.fn>
let id: string
let other: string

const MISSING = 'A'.repeat(22)
const quote = { exact: 'quick brown fox', prefix: 'The ', suffix: ' jumps' }

async function errorOf(promise: Promise<unknown>): Promise<ArtifactHostError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ArtifactHostError) return error
    throw error
  }
  throw new Error('expected an error')
}

const makeAdmin = (maxComments?: number) =>
  createArtifactAdmin({
    store,
    blobs,
    clock: clock.now,
    quotaBytes: 1024 * 1024,
    onChange,
    ownerName: 'Antonio',
    maxComments,
  })

const create = async (title: string) =>
  (
    await admin.create({
      title,
      owner: { kind: 'local', id: 'local' },
      origin: { workspaceId: null, conversationId: null, conversationTitle: null },
      files: [{ path: 'index.html', bytes: utf8(`<p>${title}: The quick brown fox jumps.</p>`) }],
    })
  ).id

const comment = (body: string, extra: Record<string, unknown> = {}) =>
  admin.addComment(id, { author: 'owner', version: 1, body, ...extra })

const openComments = async () => (await admin.get(id))?.openComments

beforeEach(async () => {
  const temp = tempDir()
  cleanup = temp.cleanup
  store = new ArtifactStore(openDatabase(path.join(temp.dir, 'artifacts.sqlite')))
  blobs = new BlobStore(path.join(temp.dir, 'blobs'))
  clock = testClock()
  onChange = vi.fn()
  admin = makeAdmin()
  id = await create('Commented')
  other = await create('Other')
  onChange.mockClear()
})
afterEach(() => {
  store.close()
  cleanup()
})

describe('comments', () => {
  it('stores a comment anchored to text and a version, and reads it back', async () => {
    const created = await comment('  Is this right?  ', { anchor: { quote, hint: { selector: 'p:nth-of-type(1)' } } })
    expect(created).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      version: 1,
      parentId: null,
      author: { kind: 'owner', name: 'Antonio', verified: true, principalId: null },
      body: 'Is this right?',
      anchor: { quote, hint: { selector: 'p:nth-of-type(1)' } },
      status: 'open',
      createdAt: clock.now(),
    })
    expect(onChange).toHaveBeenCalledWith(id)
    expect(await admin.listComments(id)).toEqual({ comments: [created], nextCursor: null })
    expect(await openComments()).toBe(1)
    expect((await admin.get(other))?.openComments).toBe(0)
    expect((await admin.listComments(other)).comments).toEqual([])
  })

  it('records the agent as its own kind of author, under the owner’s name', async () => {
    const created = await admin.addComment(id, { author: 'agent', version: 1, body: 'Fixed in the next version.' })
    expect(created.author).toEqual({ kind: 'agent', name: 'Antonio', verified: true, principalId: null })
    expect(created.anchor).toBeNull()
  })

  it('validates the body and the anchor', async () => {
    const bad: Record<string, unknown>[] = [
      { body: '' },
      { body: '   ' },
      { body: 'x'.repeat(MAX_COMMENT_CHARS + 1) },
      { body: 'ok', anchor: { quote: { ...quote, exact: 'x'.repeat(501) } } },
      { body: 'ok', anchor: { quote: { ...quote, exact: '' } } },
      { body: 'ok', anchor: { quote: { ...quote, prefix: 'x'.repeat(65) } } },
      { body: 'ok', anchor: { quote: { ...quote, suffix: 'x'.repeat(65) } } },
      { body: 'ok', anchor: { hint: { selector: 'x'.repeat(301) } } },
      { body: 'ok', anchor: { quote, extra: true } },
      { body: 'ok', version: 0 },
      { body: 'ok', version: 1.5 },
      { body: 'ok', author: 'guest' },
    ]
    for (const input of bad)
      expect((await errorOf(comment('ok', input))).code, JSON.stringify(input).slice(0, 60)).toBe('invalid_input')
    expect((await comment('x'.repeat(MAX_COMMENT_CHARS))).body).toHaveLength(MAX_COMMENT_CHARS)
    expect(await openComments()).toBe(1)
  })

  it('needs an existing artifact and version', async () => {
    expect((await errorOf(comment('ok', { version: 2 }))).code).toBe('not_found')
    expect((await errorOf(admin.addComment(MISSING, { author: 'owner', version: 1, body: 'ok' }))).code).toBe(
      'not_found'
    )
    expect((await errorOf(admin.listComments(MISSING))).code).toBe('not_found')
    expect((await errorOf(admin.listComments('nope'))).code).toBe('not_found')
  })

  it('replies to a top-level comment of the same artifact, inheriting its version', async () => {
    const top = await comment('Question')
    await admin.update({
      id,
      baseVersion: 1,
      change: { kind: 'edits', edits: [{ path: 'index.html', oldText: 'quick', newText: 'slow' }] },
    })
    clock.advance(1000)
    const reply = await admin.addComment(id, { author: 'agent', version: 2, body: 'Answer', parentId: top.id })
    expect(reply).toMatchObject({ parentId: top.id, version: 1, anchor: null, author: { kind: 'agent' } })
    expect((await admin.listComments(id)).comments.map((item) => item.id)).toEqual([top.id, reply.id])
    // Replies do not count as open threads.
    expect(await openComments()).toBe(1)

    const elsewhere = await admin.addComment(other, { author: 'owner', version: 1, body: 'Elsewhere' })
    for (const parentId of [reply.id, elsewhere.id, MISSING])
      expect((await errorOf(comment('Nested', { parentId }))).code, parentId).toBe('not_found')
    expect((await errorOf(comment('Anchored reply', { parentId: top.id, anchor: { quote } }))).code).toBe(
      'invalid_input'
    )
  })

  it('resolves and reopens threads, never replies', async () => {
    const top = await comment('Question')
    const reply = await comment('Answer', { parentId: top.id })
    await admin.setCommentResolved(id, top.id, true)
    expect((await admin.listComments(id)).comments[0]?.status).toBe('resolved')
    expect(await openComments()).toBe(0)
    await admin.setCommentResolved(id, top.id, false)
    expect(await openComments()).toBe(1)

    expect((await errorOf(admin.setCommentResolved(id, reply.id, true))).code).toBe('invalid_input')
    expect((await errorOf(admin.setCommentResolved(id, MISSING, true))).code).toBe('not_found')
    expect((await errorOf(admin.setCommentResolved(other, top.id, true))).code).toBe('not_found')
  })

  it('lists only open threads on request, and one version on request', async () => {
    const open = await comment('Open')
    const openReply = await comment('Reply to open', { parentId: open.id })
    const done = await comment('Done')
    await comment('Reply to done', { parentId: done.id })
    await admin.setCommentResolved(id, done.id, true)
    expect((await admin.listComments(id, { status: 'open' })).comments.map((item) => item.id)).toEqual([
      open.id,
      openReply.id,
    ])
    expect((await admin.listComments(id, { status: 'all' })).comments).toHaveLength(4)
    expect((await admin.listComments(id)).comments).toHaveLength(4)
    expect((await admin.listComments(id, { version: 1 })).comments).toHaveLength(4)
    expect((await admin.listComments(id, { version: 2 })).comments).toEqual([])
    expect((await errorOf(admin.listComments(id, { limit: 0 }))).code).toBe('invalid_input')
    expect((await errorOf(admin.listComments(id, { cursor: 'x' }))).code).toBe('invalid_input')
  })

  it('deletes a comment, and a thread together with its replies', async () => {
    const top = await comment('Question')
    const reply = await comment('Answer', { parentId: top.id })
    const second = await comment('Another answer', { parentId: top.id })
    await admin.deleteComment(id, reply.id)
    expect((await admin.listComments(id)).comments.map((item) => item.id)).toEqual([top.id, second.id])
    expect((await errorOf(admin.deleteComment(id, reply.id))).code).toBe('not_found')
    expect((await errorOf(admin.deleteComment(other, top.id))).code).toBe('not_found')

    await admin.deleteComment(id, top.id)
    expect((await admin.listComments(id)).comments).toEqual([])
    expect(await openComments()).toBe(0)
    expect((await errorOf(comment('Late', { parentId: top.id }))).code).toBe('not_found')
  })

  it('pages long lists', async () => {
    store.db.exec('BEGIN')
    for (let n = 0; n <= COMMENTS_PAGE_SIZE; n++) await comment(`Comment ${n}`)
    store.db.exec('COMMIT')
    const first = await admin.listComments(id)
    expect(first.comments).toHaveLength(COMMENTS_PAGE_SIZE)
    expect(first.nextCursor).toEqual(expect.any(String))
    const rest = await admin.listComments(id, { cursor: first.nextCursor! })
    expect(rest.comments.map((item) => item.body)).toEqual([`Comment ${COMMENTS_PAGE_SIZE}`])
    expect(rest.nextCursor).toBeNull()
    const small = await admin.listComments(id, { limit: 2 })
    expect(small.comments.map((item) => item.body)).toEqual(['Comment 0', 'Comment 1'])
  })

  it('stops at the comment limit, and makes room when comments are deleted', async () => {
    admin = makeAdmin(3)
    const first = await comment('One')
    await comment('Two', { parentId: first.id })
    const third = await comment('Three')
    expect((await errorOf(comment('Four'))).code).toBe('limit_reached')
    await admin.deleteComment(id, third.id)
    expect((await comment('Four')).body).toBe('Four')
  })

  it('removes comments with their artifact', async () => {
    const top = await comment('Question')
    await comment('Answer', { parentId: top.id })
    await admin.delete(id)
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(0)
  })
})

describe('comments from visitors', () => {
  it('tells the owner about them, under the name the visitor goes by', async () => {
    const sharing = new SharingStore(store.db)
    const onActivity = vi.fn()
    const service = createCommentService({
      store,
      comments: new CommentStore(store.db),
      clock: clock.now,
      onChange,
      record: createActivityRecorder({ sharing, clock: clock.now, onActivity }),
    })
    const created = service.add(
      id,
      { kind: 'guest', name: 'Ana', principalId: 'p1' },
      { version: 1, body: 'From a guest' }
    )
    expect(created.author).toEqual({ kind: 'guest', name: 'Ana', verified: false, principalId: 'p1' })
    service.add(id, { kind: 'invited', name: 'Maria', principalId: 'p2' }, { version: 1, body: 'From Maria' })
    expect(onActivity.mock.calls).toEqual([
      [id, 'comment_added'],
      [id, 'comment_added'],
    ])
    expect((await admin.listEvents({ artifactId: id })).map((event) => event.data)).toEqual([
      { name: 'Maria' },
      { name: 'Ana' },
    ])
    // The owner's and the agent's own comments are not news to the owner.
    await comment('From the owner')
    expect(onActivity).toHaveBeenCalledTimes(2)
  })
})
