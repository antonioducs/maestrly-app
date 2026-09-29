import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ArtifactAdmin, createArtifactAdmin } from '../src/admin.js'
import { ArtifactHostError } from '../src/errors.js'
import { digest } from '../src/ids.js'
import type { CreateArtifactInput } from '../src/schemas.js'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BlobStore } from '../src/store/blobs.js'
import { openDatabase } from '../src/store/db.js'
import { tempDir, testClock, text, utf8 } from './helpers.js'

let dir: string
let cleanup: () => void
let store: ArtifactStore
let blobs: BlobStore
let clock: ReturnType<typeof testClock>
let onChange: ReturnType<typeof vi.fn>

function makeAdmin(options: { quotaBytes?: number; maxVersions?: number } = {}): ArtifactAdmin {
  return createArtifactAdmin({
    store,
    blobs,
    clock: clock.now,
    quotaBytes: options.quotaBytes ?? 1024 * 1024,
    maxVersions: options.maxVersions,
    onChange,
  })
}

function input(overrides: Partial<CreateArtifactInput> = {}): CreateArtifactInput {
  return {
    title: 'Landing page',
    owner: { kind: 'local', id: 'local' },
    origin: { workspaceId: 'ws1', conversationId: 'c1', conversationTitle: 'Chat' },
    files: [
      { path: 'index.html', bytes: utf8('<h1>Hello</h1>') },
      { path: 'app.css', bytes: utf8('h1{color:red}') },
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
  ;({ dir, cleanup } = tempDir())
  store = new ArtifactStore(openDatabase(path.join(dir, 'artifacts.sqlite')))
  blobs = new BlobStore(path.join(dir, 'blobs'))
  clock = testClock()
  onChange = vi.fn()
})
afterEach(() => {
  store.close()
  cleanup()
})

describe('ArtifactAdmin', () => {
  it('creates version 1', async () => {
    const admin = makeAdmin()
    const detail = await admin.create(input())
    expect(detail).toMatchObject({
      title: 'Landing page',
      description: '',
      currentVersion: 1,
      versionCount: 1,
      visibility: 'private',
      workspaceId: 'ws1',
      conversationId: 'c1',
      conversationTitle: 'Chat',
    })
    expect(detail.versions).toEqual([
      expect.objectContaining({ number: 1, entry: 'index.html', fileCount: 2, createdBy: 'agent' }),
    ])
    expect(await admin.listFiles(detail.id)).toEqual([
      { path: 'app.css', bytes: 13, contentType: 'text/css; charset=utf-8', text: true },
      { path: 'index.html', bytes: 14, contentType: 'text/html; charset=utf-8', text: true },
    ])
    expect(onChange).toHaveBeenCalledWith(detail.id)
  })

  it('leaves nothing behind when a path is invalid', async () => {
    const admin = makeAdmin()
    const error = await errorOf(
      admin.create(
        input({
          files: [
            { path: 'index.html', bytes: utf8('x') },
            { path: '../x.css', bytes: utf8('y') },
          ],
        })
      )
    )
    expect(error.code).toBe('invalid_path')
    expect(store.countArtifacts()).toBe(0)
    expect(blobs.listAll()).toHaveLength(0)
  })

  it('rejects invalid input', async () => {
    expect((await errorOf(makeAdmin().create(input({ title: '   ' })))).code).toBe('invalid_input')
  })

  it('creates new versions from edits and keeps earlier versions', async () => {
    const admin = makeAdmin()
    const { id } = await admin.create(input())
    clock.advance(1000)
    const next = await admin.update({
      id,
      baseVersion: 1,
      summary: 'Greeting',
      conversationTitle: 'Renamed chat',
      change: { kind: 'edits', edits: [{ path: 'index.html', oldText: 'Hello', newText: 'Hi' }] },
    })
    expect(next.currentVersion).toBe(2)
    expect(next.conversationTitle).toBe('Renamed chat')
    expect(next.versions[0]).toMatchObject({ number: 2, summary: 'Greeting' })
    expect(text((await admin.readFile(id, 2, 'index.html'))?.bytes)).toBe('<h1>Hi</h1>')
    expect(text((await admin.readFile(id, 1, 'index.html'))?.bytes)).toBe('<h1>Hello</h1>')
  })

  it('merges and deletes files on top of the base version', async () => {
    const admin = makeAdmin()
    const { id } = await admin.create(input())
    await admin.update({
      id,
      baseVersion: 1,
      change: { kind: 'files', files: [{ path: 'js/app.js', bytes: utf8('1') }], delete: ['app.css'] },
    })
    expect((await admin.listFiles(id)).map((f) => f.path)).toEqual(['index.html', 'js/app.js'])
    const error = await errorOf(
      admin.update({ id, baseVersion: 2, change: { kind: 'files', files: [], delete: ['missing.css'] } })
    )
    expect(error.code).toBe('invalid_path')
  })

  it('replaces every file', async () => {
    const admin = makeAdmin()
    const { id } = await admin.create(input())
    await admin.update({
      id,
      baseVersion: 1,
      change: { kind: 'replace', files: [{ path: 'index.html', bytes: utf8('new') }] },
    })
    expect((await admin.listFiles(id)).map((f) => f.path)).toEqual(['index.html'])
  })

  it('refuses a stale base version and too many versions', async () => {
    const admin = makeAdmin({ maxVersions: 3 })
    const { id } = await admin.create(input())
    const edit = (baseVersion: number, newText: string) =>
      admin.update({
        id,
        baseVersion,
        change: { kind: 'files', files: [{ path: 'index.html', bytes: utf8(newText) }], delete: [] },
      })
    await edit(1, 'v2')
    const conflict = await errorOf(edit(1, 'stale'))
    expect(conflict.code).toBe('version_conflict')
    expect(conflict.details?.currentVersion).toBe(2)
    await edit(2, 'v3')
    expect((await errorOf(edit(3, 'v4'))).code).toBe('version_limit')
  })

  it('refuses content above the storage quota without writing it', async () => {
    const admin = makeAdmin({ quotaBytes: 1000 })
    const error = await errorOf(admin.create(input({ files: [{ path: 'index.html', bytes: new Uint8Array(2000) }] })))
    expect(error.code).toBe('quota_exceeded')
    expect(blobs.listAll()).toHaveLength(0)
  })

  it('shares identical content and removes it with its last artifact', async () => {
    const admin = makeAdmin()
    const shared = [{ path: 'index.html', bytes: utf8('same') }]
    const first = await admin.create(input({ files: shared }))
    const second = await admin.create(input({ files: shared }))
    expect(blobs.listAll()).toHaveLength(1)
    expect(await admin.delete(first.id)).toBe(true)
    expect(blobs.listAll()).toHaveLength(1)
    expect(await admin.delete(second.id)).toBe(true)
    expect(blobs.listAll()).toHaveLength(0)
    expect(await admin.get(second.id)).toBeNull()
    expect(await admin.delete(second.id)).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('lists with filters and reports its status', async () => {
    const admin = makeAdmin()
    const a = await admin.create(input())
    await admin.create(input({ origin: { workspaceId: 'ws1', conversationId: 'c2', conversationTitle: null } }))
    expect((await admin.list({ conversationId: 'c1' })).map((item) => item.id)).toEqual([a.id])
    expect(await admin.list()).toHaveLength(2)
    expect(await admin.status()).toEqual({ artifactCount: 2, storageBytes: 27, quotaBytes: 1024 * 1024 })
  })

  it('mints single-use owner tickets for existing artifacts', async () => {
    const admin = makeAdmin()
    const { id } = await admin.create(input())
    expect((await errorOf(admin.mintOwnerTicket('A'.repeat(22)))).code).toBe('not_found')
    const { ticket, expiresAt } = await admin.mintOwnerTicket(id)
    expect(expiresAt).toBe(clock.now() + 60_000)
    expect(store.consumeOwnerTicket(digest(ticket), clock.now())).toBe(id)
    expect(store.consumeOwnerTicket(digest(ticket), clock.now())).toBeNull()
  })

  it('writes a readable snapshot', async () => {
    const admin = makeAdmin()
    const { id } = await admin.create(input())
    const file = path.join(dir, 'snapshot.sqlite')
    await admin.snapshot(file)
    expect(existsSync(file)).toBe(true)
    const copy = new DatabaseSync(file, { readOnly: true })
    expect(copy.prepare('SELECT id FROM artifacts').all()).toEqual([{ id }])
    copy.close()
  })
})
