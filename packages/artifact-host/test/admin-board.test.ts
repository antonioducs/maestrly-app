import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ArtifactAdmin, createArtifactAdmin } from '../src/admin.js'
import { ArtifactHostError } from '../src/errors.js'
import type { CreateBoardInput } from '../src/schemas.js'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BlobStore } from '../src/store/blobs.js'
import { openDatabase } from '../src/store/db.js'
import type { WhiteboardViewer } from '../src/whiteboard-viewer.js'
import { tempDir, testClock, utf8 } from './helpers.js'

let cleanup: () => void
let store: ArtifactStore
let blobs: BlobStore
let clock: ReturnType<typeof testClock>
let onChange: ReturnType<typeof vi.fn>

const viewer: WhiteboardViewer = { file: async () => null }

function makeAdmin(options: { whiteboardViewer?: WhiteboardViewer | null; quotaBytes?: number } = {}): ArtifactAdmin {
  return createArtifactAdmin({
    store,
    blobs,
    clock: clock.now,
    quotaBytes: options.quotaBytes ?? 1024 * 1024,
    onChange,
    whiteboardViewer: options.whiteboardViewer === undefined ? viewer : options.whiteboardViewer,
  })
}

function input(overrides: Partial<CreateBoardInput> = {}): CreateBoardInput {
  return {
    title: 'Architecture',
    owner: { kind: 'bot', id: 'bot1' },
    origin: { workspaceId: null, conversationId: 'c1', conversationTitle: 'Chat' },
    ops: [
      { op: 'section', id: 'api', title: 'API' },
      { op: 'card', id: 'gateway', text: 'Gateway', in: 'api' },
      { op: 'card', id: 'auth', text: 'Auth', in: 'api' },
      { op: 'connect', from: 'gateway', to: 'auth' },
    ],
    ...overrides,
  }
}

async function errorOf(promise: Promise<unknown>): Promise<ArtifactHostError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ArtifactHostError) return error
    throw error
  }
  throw new Error('expected an error')
}

beforeEach(() => {
  const temp = tempDir()
  cleanup = temp.cleanup
  store = new ArtifactStore(openDatabase(path.join(temp.dir, 'artifacts.sqlite')))
  blobs = new BlobStore(path.join(temp.dir, 'blobs'))
  clock = testClock()
  onChange = vi.fn()
})
afterEach(() => {
  store.close()
  cleanup()
})

describe('whiteboards through the admin', () => {
  it('creates a whiteboard with no files and reads it back as an outline', async () => {
    const admin = makeAdmin()
    const created = await admin.createBoard(input())
    expect(created.detail.kind).toBe('whiteboard')
    expect(created.detail.versions).toHaveLength(1)
    expect(created.created).toEqual(expect.arrayContaining(['api', 'gateway', 'auth']))
    expect(await admin.listFiles(created.detail.id)).toEqual([])
    const read = await admin.readBoard(created.detail.id)
    expect(read).toMatchObject({ id: created.detail.id, title: 'Architecture', revision: created.revision })
    expect(read.editors).toBe('owner')
    expect(read.outline.revision).toBe(created.revision)
    expect(read.outline.cards.map((card) => card.id).sort()).toEqual(['auth', 'gateway'])
    expect(Array.isArray(read.warnings)).toBe(true)
    expect(onChange).toHaveBeenCalledWith(created.detail.id)
  })

  it('creates an empty whiteboard without ops', async () => {
    const created = await makeAdmin().createBoard(input({ ops: undefined }))
    expect(created.revision).toBe(0)
    expect(created.created).toEqual([])
  })

  it('applies agent ops from a revision and reports what a person changed meanwhile', async () => {
    const admin = makeAdmin()
    const { detail, revision } = await admin.createBoard(input())
    const applied = await admin.applyBoard({
      id: detail.id,
      baseRevision: revision,
      ops: [{ op: 'card', id: 'db', text: 'Database', at: { near: 'auth', side: 'below' } }],
    })
    expect(applied.revision).toBe(revision + 1)
    expect(applied.applied).toEqual([0])
    expect(applied.created).toEqual(['db'])
    expect((await admin.readBoard(detail.id, { since: revision })).outline.changes?.changed).toContain('db')
  })

  it('refuses to change a whiteboard as files, and an op the core refuses', async () => {
    const admin = makeAdmin()
    const { detail, revision } = await admin.createBoard(input())
    const update = await errorOf(
      admin.update({
        id: detail.id,
        baseVersion: 1,
        change: { kind: 'files', files: [{ path: 'index.html', bytes: utf8('<p>x</p>') }] },
      })
    )
    expect(update.code).toBe('unsupported_type')
    const op = await errorOf(
      admin.applyBoard({ id: detail.id, baseRevision: revision, ops: [{ op: 'move', id: 'nope', to: { x: 0, y: 0 } }] })
    )
    expect(op.code).toBe('invalid_input')
    expect(op.details).toMatchObject({ op: 0, code: 'unknown_element' })
  })

  it('creates no whiteboard when an op is refused', async () => {
    const admin = makeAdmin()
    const error = await errorOf(admin.createBoard(input({ ops: [{ op: 'card', id: 'a', text: 'A', in: 'nope' }] })))
    expect(error.code).toBe('invalid_input')
    expect(await admin.list()).toEqual([])
  })

  it('does not read a page as a whiteboard', async () => {
    const admin = makeAdmin()
    const page = await admin.create({
      title: 'Page',
      owner: { kind: 'bot', id: 'bot1' },
      origin: { workspaceId: null, conversationId: 'c1', conversationTitle: null },
      files: [{ path: 'index.html', bytes: utf8('<p>x</p>') }],
    })
    expect(page.kind).toBe('page')
    expect((await errorOf(admin.readBoard(page.id))).code).toBe('unsupported_type')
    expect(
      (await errorOf(admin.applyBoard({ id: page.id, baseRevision: 0, ops: [{ op: 'card', id: 'a', text: '' }] }))).code
    ).toBe('unsupported_type')
  })

  it('needs the whiteboard viewer on this host', async () => {
    const error = await errorOf(makeAdmin({ whiteboardViewer: null }).createBoard(input()))
    expect(error.code).toBe('unsupported_type')
  })

  it('counts whiteboards in the storage of the host and forgets them when deleted', async () => {
    const admin = makeAdmin()
    const { detail } = await admin.createBoard(input())
    const status = await admin.status()
    expect(status.storageBytes).toBeGreaterThan(0)
    expect((await admin.get(detail.id))?.storageBytes).toBe(status.storageBytes)
    expect(await admin.delete(detail.id)).toBe(true)
    expect((await admin.status()).storageBytes).toBe(0)
    expect((await errorOf(admin.readBoard(detail.id))).code).toBe('not_found')
  })

  it('refuses a page that would not fit beside the whiteboards', async () => {
    await makeAdmin().createBoard(input())
    const used = (await makeAdmin().status()).storageBytes
    const admin = makeAdmin({ quotaBytes: used + 100 })
    const page = (size: number) =>
      admin.create({
        title: 'Page',
        owner: { kind: 'bot', id: 'bot1' },
        origin: { workspaceId: null, conversationId: 'c1', conversationTitle: null },
        files: [{ path: 'index.html', bytes: utf8('x'.repeat(size)) }],
      })
    expect((await errorOf(page(101))).code).toBe('quota_exceeded')
    expect((await page(100)).kind).toBe('page')
  })
})
