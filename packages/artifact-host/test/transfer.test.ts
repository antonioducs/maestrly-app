import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ArtifactAdmin, createArtifactAdmin } from '../src/admin.js'
import { createCommentService } from '../src/comments.js'
import { ArtifactHostError } from '../src/errors.js'
import { digest, randomId } from '../src/ids.js'
import { MAX_FILE_BYTES, MAX_VERSION_BYTES } from '../src/limits.js'
import { callAdmin, createRemoteAdmin, UPLOAD_METHODS } from '../src/remote-admin.js'
import { ADMIN_METHODS } from '../src/rpc.js'
import { type ArtifactExport, sameContent } from '../src/schemas.js'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BlobStore } from '../src/store/blobs.js'
import { CommentStore } from '../src/store/comment-store.js'
import { openDatabase } from '../src/store/db.js'
import { SharingStore } from '../src/store/sharing-store.js'
import { tempDir, testClock, text, utf8 } from './helpers.js'

interface Host {
  admin: ArtifactAdmin
  store: ArtifactStore
  blobs: BlobStore
  sharing: SharingStore
  comments: CommentStore
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9])
const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 1, 128])
const DEVICE = { kind: 'device' as const, id: 'device-1' }

const cleanups: (() => void)[] = []
let clock: ReturnType<typeof testClock>

function host(quotaBytes = 8 * 1024 * 1024): Host {
  const { dir, cleanup } = tempDir()
  const store = new ArtifactStore(openDatabase(path.join(dir, 'artifacts.sqlite')))
  const blobs = new BlobStore(path.join(dir, 'blobs'))
  const sharing = new SharingStore(store.db)
  cleanups.push(() => {
    store.close()
    cleanup()
  })
  return {
    admin: createArtifactAdmin({ store, blobs, clock: clock.now, quotaBytes, sharing, ownerName: 'Owner' }),
    store,
    blobs,
    sharing,
    comments: new CommentStore(store.db),
  }
}

beforeEach(() => {
  clock = testClock()
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function errorOf(promise: Promise<unknown>): Promise<ArtifactHostError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ArtifactHostError) return error
    throw error
  }
  throw new Error('expected an error')
}

/**
 * Three versions that share files, an image, a preview of version 2, a comment by an invited person answered by the
 * owner, a resolved thread, and a link share with that person's session.
 */
async function richArtifact(source: Host): Promise<string> {
  const css = utf8('h1{color:rgb(1,2,3)}')
  const created = await source.admin.create({
    title: 'Quarterly report',
    description: 'Sales by month',
    owner: { kind: 'local', id: 'local' },
    origin: { workspaceId: 'ws-1', conversationId: 'conv-1', conversationTitle: 'Report chat' },
    files: [
      { path: 'index.html', bytes: utf8('<h1>v1</h1>') },
      { path: 'app.css', bytes: css },
      { path: 'img/logo.png', bytes: IMAGE },
    ],
  })
  const id = created.id
  clock.advance(1000)
  await source.admin.update({
    id,
    baseVersion: 1,
    summary: 'Second',
    change: { kind: 'files', files: [{ path: 'index.html', bytes: utf8('<h1>v2</h1>') }], delete: [] },
  })
  clock.advance(1000)
  await source.admin.update({
    id,
    baseVersion: 2,
    summary: 'Third',
    createdBy: 'owner',
    change: { kind: 'edits', edits: [{ path: 'index.html', oldText: 'v2', newText: 'v3' }] },
  })
  await source.admin.setThumbnail(id, 2, PNG)
  await source.admin.setSharing(id, { visibility: 'link', commentsEnabled: false })
  const invite = await source.admin.createInvite(id, { name: 'Maria' })
  source.store.createSession({
    id: randomId(),
    artifactId: id,
    principalId: invite.principalId,
    tokenHash: digest('session'),
    deviceLabel: 'Safari/Mac',
    createdAt: clock.now(),
    expiresAt: clock.now() + 1_000_000,
  })
  const service = createCommentService({ store: source.store, comments: source.comments, clock: clock.now })
  clock.advance(1000)
  const question = service.add(
    id,
    { kind: 'invited', name: 'Maria', principalId: invite.principalId },
    {
      version: 2,
      body: 'Is this right?',
      anchor: { quote: { exact: 'v2', prefix: '', suffix: '' } },
    }
  )
  clock.advance(1000)
  await source.admin.addComment(id, { author: 'owner', body: 'Yes', parentId: question.id })
  const done = await source.admin.addComment(id, { author: 'agent', version: 3, body: 'Fixed the title' })
  await source.admin.setCommentResolved(id, done.id, true)
  const gone = await source.admin.addComment(id, { author: 'owner', version: 3, body: 'Draft note' })
  await source.admin.deleteComment(id, gone.id)
  return id
}

/** Sends the blobs a manifest needs, the way a transfer does. */
async function sendBlobs(source: Host, target: ArtifactAdmin, manifest: ArtifactExport): Promise<string[]> {
  const shas = [
    ...new Set([
      ...manifest.versions.flatMap((v) => v.files.map((f) => f.sha256)),
      ...manifest.thumbnails.map((t) => t.sha256),
    ]),
  ]
  const bytes = await Promise.all(shas.map(async (sha) => (await source.blobs.read(sha))!))
  return (await target.putBlobs(bytes)).sha256
}

describe('artifact transfer', () => {
  it('exports an artifact and imports it elsewhere with the same ID, privately', async () => {
    const source = host()
    const target = host()
    const id = await richArtifact(source)
    const manifest = await source.admin.exportArtifact(id)
    expect(manifest).toMatchObject({
      id,
      title: 'Quarterly report',
      description: 'Sales by month',
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      conversationTitle: 'Report chat',
      commentsEnabled: false,
    })
    expect(manifest.versions.map((v) => v.number)).toEqual([1, 2, 3])
    expect(manifest.thumbnails).toEqual([expect.objectContaining({ version: 2, contentType: 'image/png' })])
    // The deleted comment stays behind.
    expect(manifest.comments.map((c) => c.body)).toEqual(['Is this right?', 'Yes', 'Fixed the title'])

    const sent = await sendBlobs(source, target.admin, manifest)
    expect(new Set(sent).size).toBe(sent.length)
    const imported = await target.admin.importArtifact({ ...manifest, owner: DEVICE })

    const original = (await source.admin.get(id))!
    expect(imported).toMatchObject({
      id,
      title: original.title,
      ownerKind: 'device',
      ownerId: 'device-1',
      currentVersion: 3,
      versionCount: 3,
      visibility: 'private',
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
      thumbnailVersion: 2,
      openComments: 1,
    })
    expect(imported.versions).toEqual(original.versions)
    for (const version of [1, 2, 3]) {
      const files = await source.admin.listFiles(id, version)
      expect(await target.admin.listFiles(id, version)).toEqual(files)
      for (const file of files)
        expect((await target.admin.readFile(id, version, file.path))?.bytes).toEqual(
          (await source.admin.readFile(id, version, file.path))?.bytes
        )
    }
    expect(text((await target.admin.readFile(id, 3, 'index.html'))?.bytes)).toBe('<h1>v3</h1>')
    expect(await target.admin.getThumbnail(id)).toEqual(await source.admin.getThumbnail(id))

    const sourceComments = (await source.admin.listComments(id, { status: 'all' })).comments
    const targetComments = (await target.admin.listComments(id, { status: 'all' })).comments
    expect(targetComments).toEqual(
      sourceComments.map((comment) => ({ ...comment, author: { ...comment.author, principalId: null } }))
    )

    const sharing = await target.admin.getSharing(id)
    expect(sharing).toMatchObject({ visibility: 'private', hasAccessCode: false, commentsEnabled: false, people: [] })
    expect(target.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
    expect(sameContent(await target.admin.exportArtifact(id), manifest)).toBe(true)
  })

  it('answers a repeated import with the same artifact, and refuses a different one with that ID', async () => {
    const source = host()
    const target = host()
    const id = await richArtifact(source)
    const manifest = await source.admin.exportArtifact(id)
    await sendBlobs(source, target.admin, manifest)
    const first = await target.admin.importArtifact({ ...manifest, owner: DEVICE })
    expect(await target.admin.importArtifact({ ...manifest, owner: DEVICE })).toEqual(first)
    expect(target.store.countArtifacts()).toBe(1)

    expect((await errorOf(target.admin.importArtifact({ ...manifest, title: 'Other', owner: DEVICE }))).code).toBe(
      'already_exists'
    )
    expect(
      (await errorOf(target.admin.importArtifact({ ...manifest, owner: { kind: 'device', id: 'device-2' } }))).code
    ).toBe('already_exists')
  })

  it('refuses an import whose files are not stored, and keeps nothing', async () => {
    const source = host()
    const target = host()
    const id = await richArtifact(source)
    const manifest = await source.admin.exportArtifact(id)
    const error = await errorOf(target.admin.importArtifact({ ...manifest, owner: DEVICE }))
    expect(error.code).toBe('storage')
    expect(error.details).toMatchObject({ reason: 'missing_blob' })
    expect(target.store.countArtifacts()).toBe(0)
  })

  it('stores blobs once, within the storage limit and the size of a version', async () => {
    const target = host(64)
    const first = utf8('a'.repeat(40))
    expect((await target.admin.putBlobs([first, first])).sha256).toEqual([
      BlobStore.sha256(first),
      BlobStore.sha256(first),
    ])
    expect((await target.admin.status()).storageBytes).toBe(40)
    expect((await errorOf(target.admin.putBlobs([utf8('b'.repeat(40))]))).code).toBe('quota_exceeded')
    // Bytes already stored are not counted again.
    expect((await target.admin.putBlobs([first])).sha256).toEqual([BlobStore.sha256(first)])
    const big = host(200 * 1024 * 1024)
    const files = Array.from({ length: 6 }, (_, index) =>
      new Uint8Array(Math.ceil(MAX_VERSION_BYTES / 6) + 1).fill(index)
    )
    expect((await errorOf(big.admin.putBlobs(files))).code).toBe('bundle_too_large')
    expect((await errorOf(big.admin.putBlobs([new Uint8Array(MAX_FILE_BYTES + 1)]))).code).toBe('file_too_large')
    expect((await big.admin.status()).storageBytes).toBe(0)
    expect((await errorOf(big.admin.putBlobs([]))).code).toBe('invalid_input')
    expect((await errorOf(big.admin.putBlobs(['text' as unknown as Uint8Array]))).code).toBe('invalid_input')
  })

  it('validates what it imports again, and writes nothing when it refuses', async () => {
    const source = host()
    const target = host()
    const id = await richArtifact(source)
    const manifest = await source.admin.exportArtifact(id)
    await sendBlobs(source, target.admin, manifest)
    const withVersion = (patch: Partial<ArtifactExport['versions'][number]>) => ({
      ...manifest,
      owner: DEVICE,
      versions: manifest.versions.map((version, index) => (index === 0 ? { ...version, ...patch } : version)),
    })
    const file = manifest.versions[0]!.files[0]!
    const cases: [unknown, string][] = [
      [withVersion({ files: [{ ...file, path: '../escape.html' }] }), 'invalid_path'],
      [withVersion({ files: [{ ...file, path: 'notes.exe' }] }), 'unsupported_type'],
      [withVersion({ entry: 'app.css' }), 'entry_not_html'],
      [withVersion({ number: 5 }), 'invalid_input'],
      [{ ...manifest, owner: DEVICE, id: 'not-an-id' }, 'invalid_input'],
      [
        { ...manifest, owner: DEVICE, comments: [{ ...manifest.comments[1]!, parentId: 'A'.repeat(22) }] },
        'invalid_input',
      ],
      [{ ...manifest, owner: DEVICE, comments: [{ ...manifest.comments[0]!, version: 9 }] }, 'invalid_input'],
      [{ ...manifest, owner: DEVICE, thumbnails: [{ ...manifest.thumbnails[0]!, version: 9 }] }, 'invalid_input'],
      [
        {
          ...manifest,
          owner: DEVICE,
          comments: [{ ...manifest.comments[0]!, anchor: { quote: { exact: '' } } }],
        },
        'invalid_input',
      ],
    ]
    for (const [input, code] of cases) {
      expect((await errorOf(target.admin.importArtifact(input as never))).code, JSON.stringify(code)).toBe(code)
    }
    expect(target.store.countArtifacts()).toBe(0)
    expect(target.store.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 0 })
  })

  it('takes its sizes and types from the stored files, not from the manifest', async () => {
    const source = host()
    const target = host()
    const id = await richArtifact(source)
    const manifest = await source.admin.exportArtifact(id)
    await sendBlobs(source, target.admin, manifest)
    const lying = {
      ...manifest,
      owner: DEVICE,
      versions: manifest.versions.map((version) => ({
        ...version,
        files: version.files.map((file) => ({ ...file, bytes: 1, contentType: 'text/html' })),
      })),
    }
    await target.admin.importArtifact(lying)
    expect(await target.admin.listFiles(id, 1)).toEqual(await source.admin.listFiles(id, 1))
  })

  it('crosses a JSON transport, with the new methods on the upload path', async () => {
    const source = host()
    const target = host()
    const id = await richArtifact(source)
    expect(UPLOAD_METHODS).toEqual(expect.arrayContaining(['putBlobs', 'importArtifact']))
    expect(ADMIN_METHODS).toEqual(expect.arrayContaining(['exportArtifact', 'putBlobs', 'importArtifact']))
    const routes: string[] = []
    const remote = (admin: ArtifactAdmin) =>
      createRemoteAdmin(async (method, args) => {
        const upload = (UPLOAD_METHODS as readonly string[]).includes(method)
        routes.push(`${upload ? 'upload' : 'admin'}:${method}`)
        // A real JSON round trip, as over HTTP.
        const result = await callAdmin(admin, method, JSON.parse(JSON.stringify(args)), { allowed: ADMIN_METHODS })
        return JSON.parse(JSON.stringify(result))
      })
    const from = remote(source.admin)
    const to = remote(target.admin)
    const manifest = await from.exportArtifact(id)
    const shas = [...new Set(manifest.versions.flatMap((v) => v.files.map((f) => f.sha256)))]
    const bytes = await Promise.all(
      manifest.versions.flatMap((v) =>
        v.files
          .filter((f) => shas.includes(f.sha256))
          .map(async (f) => (await from.readFile(id, v.number, f.path))!.bytes)
      )
    )
    await to.putBlobs([...bytes, PNG])
    await to.importArtifact({ ...manifest, owner: DEVICE })
    expect(sameContent(await to.exportArtifact(id), manifest)).toBe(true)
    const error = await errorOf(to.importArtifact({ ...manifest, title: 'Other', owner: DEVICE }))
    expect(error.code).toBe('already_exists')
    expect(routes).toEqual(expect.arrayContaining(['admin:exportArtifact', 'upload:putBlobs', 'upload:importArtifact']))
  })
})
