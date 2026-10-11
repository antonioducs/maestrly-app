import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactHostError } from '../src/errors.js'
import { ArtifactStore, type NewArtifact, type NewVersion } from '../src/store/artifact-store.js'
import { openDatabase } from '../src/store/db.js'
import { tempDir } from './helpers.js'

let dir: string
let cleanup: () => void
let store: ArtifactStore

const sha = (char: string) => char.repeat(64)

function artifact(id: string, overrides: Partial<NewArtifact> = {}): NewArtifact {
  return {
    id,
    title: `Title ${id}`,
    description: '',
    ownerKind: 'local',
    ownerId: 'local',
    workspaceId: 'ws1',
    conversationId: 'c1',
    conversationTitle: 'Conversation',
    createdAt: 1000,
    ...overrides,
  }
}

function version(createdAt = 1000, files = [{ path: 'index.html', sha256: sha('a'), bytes: 3 }]): NewVersion {
  return {
    entry: 'index.html',
    summary: '',
    createdBy: 'agent',
    createdAt,
    files: files.map((f) => ({ ...f, contentType: 'text/html; charset=utf-8' })),
  }
}

const count = (table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

beforeEach(() => {
  ;({ dir, cleanup } = tempDir())
  store = new ArtifactStore(openDatabase(path.join(dir, 'artifacts.sqlite')))
})
afterEach(() => {
  store.close()
  cleanup()
})

describe('ArtifactStore', () => {
  it('counts shared files once per artifact and includes thumbnails in its storage', () => {
    store.createArtifact(artifact('A'), version())
    store.addVersion(
      'A',
      version(2000, [
        { path: 'index.html', sha256: sha('a'), bytes: 3 },
        { path: 'app.css', sha256: sha('b'), bytes: 5 },
      ]),
      1
    )
    expect(store.getArtifact('A')).toMatchObject({ storageBytes: 8, thumbnailVersion: null })
    expect(store.setThumbnail('A', 1, { sha256: sha('t1'), contentType: 'image/jpeg', bytes: 7, createdAt: 2 })).toBe(
      null
    )
    expect(store.getArtifact('A')).toMatchObject({ storageBytes: 15, thumbnailVersion: 1 })
    expect(store.getThumbnail('A', 2)).toMatchObject({ version: 1, sha256: sha('t1') })
    expect(store.setThumbnail('A', 1, { sha256: sha('t2'), contentType: 'image/jpeg', bytes: 4, createdAt: 3 })).toBe(
      sha('t1')
    )
    expect(store.blobsOf('A').sort()).toEqual([sha('a'), sha('b'), sha('t2')].sort())
    expect(store.isBlobReferenced(sha('t2'))).toBe(true)
    expect(store.isBlobReferenced(sha('t1'))).toBe(false)
    expect(store.referencedBlobs().has(sha('t2'))).toBe(true)
    store.deleteArtifact('A')
    expect(count('thumbnails')).toBe(0)
  })

  it('creates and reads an artifact', () => {
    store.createArtifact(artifact('A'), version())
    expect(store.getArtifact('A')).toEqual({
      id: 'A',
      title: 'Title A',
      description: '',
      ownerKind: 'local',
      ownerId: 'local',
      workspaceId: 'ws1',
      conversationId: 'c1',
      conversationTitle: 'Conversation',
      currentVersion: 1,
      versionCount: 1,
      visibility: 'private',
      createdAt: 1000,
      updatedAt: 1000,
      storageBytes: 3,
      thumbnailVersion: null,
      unseenEvents: 0,
      pendingRequests: 0,
      openComments: 0,
    })
    expect(store.getArtifact('missing')).toBeNull()
    expect(store.countArtifacts()).toBe(1)
  })

  it('adds versions only on top of the expected version', () => {
    store.createArtifact(artifact('A'), version())
    expect(store.addVersion('A', version(2000), 1, 'Renamed')).toBe(2)
    expect(store.getArtifact('A')).toMatchObject({ currentVersion: 2, updatedAt: 2000, conversationTitle: 'Renamed' })
    try {
      store.addVersion('A', version(3000), 1)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactHostError)
      expect((error as ArtifactHostError).code).toBe('version_conflict')
      expect((error as ArtifactHostError).details?.currentVersion).toBe(2)
    }
    expect(store.addVersion('A', version(3000), 2)).toBe(3)
    expect(store.getArtifact('A')?.conversationTitle).toBe('Renamed')
    expect(() => store.addVersion('missing', version(), 1)).toThrow(ArtifactHostError)
  })

  it('lists versions newest first and files by path', () => {
    store.createArtifact(
      artifact('A'),
      version(1000, [
        { path: 'z.css', sha256: sha('b'), bytes: 1 },
        { path: 'index.html', sha256: sha('a'), bytes: 3 },
      ])
    )
    store.addVersion('A', version(2000), 1)
    expect(store.listVersions('A').map((v) => v.number)).toEqual([2, 1])
    expect(store.getVersion('A', 1)).toMatchObject({ number: 1, fileCount: 2, totalBytes: 4, entry: 'index.html' })
    expect(store.listFiles('A', 1).map((f) => f.path)).toEqual(['index.html', 'z.css'])
    expect(store.getFile('A', 1, 'z.css')).toMatchObject({ sha256: sha('b'), bytes: 1 })
    expect(store.getFile('A', 1, 'missing.css')).toBeNull()
  })

  it('filters listings and orders them by the last update', () => {
    store.createArtifact(artifact('A', { createdAt: 1000 }), version(1000))
    store.createArtifact(artifact('B', { createdAt: 2000, conversationId: 'c2' }), version(2000))
    store.createArtifact(artifact('C', { createdAt: 3000, workspaceId: 'ws2', conversationId: 'c3' }), version(3000))
    store.addVersion('A', version(4000), 1)
    expect(store.listArtifacts({ workspaceId: 'ws1' }).map((a) => a.id)).toEqual(['A', 'B'])
    expect(store.listArtifacts({ conversationId: 'c2' }).map((a) => a.id)).toEqual(['B'])
    expect(store.listArtifacts({}).map((a) => a.id)).toEqual(['A', 'C', 'B'])
    expect(store.listArtifacts({ ownerKind: 'bot' })).toEqual([])
  })

  it('deletes an artifact with everything that belongs to it', () => {
    store.createArtifact(artifact('A'), version())
    store.addVersion('A', version(2000), 1)
    store.insertOwnerTicket(sha('t'), 'A', 5000)
    store.createSession(session('s1', 'A', sha('s')))
    expect(store.deleteArtifact('A')).toBe(true)
    for (const table of ['artifacts', 'versions', 'version_files', 'sessions', 'owner_tickets'])
      expect(count(table)).toBe(0)
    expect(store.deleteArtifact('A')).toBe(false)
  })

  it('reports blob references', () => {
    store.createArtifact(artifact('A'), version())
    store.createArtifact(
      artifact('B'),
      version(1000, [
        { path: 'index.html', sha256: sha('a'), bytes: 3 },
        { path: 'b.css', sha256: sha('b'), bytes: 1 },
      ])
    )
    expect(store.blobsOf('B').sort()).toEqual([sha('a'), sha('b')])
    expect(store.isBlobReferenced(sha('b'))).toBe(true)
    store.deleteArtifact('B')
    expect(store.isBlobReferenced(sha('b'))).toBe(false)
    expect(store.isBlobReferenced(sha('a'))).toBe(true)
    expect([...store.referencedBlobs()]).toEqual([sha('a')])
  })

  it('consumes an owner ticket once and never after it expires', () => {
    store.createArtifact(artifact('A'), version())
    store.insertOwnerTicket(sha('1'), 'A', 5000)
    store.insertOwnerTicket(sha('2'), 'A', 5000)
    expect(store.consumeOwnerTicket(sha('1'), 4000)).toBe('A')
    expect(store.consumeOwnerTicket(sha('1'), 4000)).toBeNull()
    expect(store.consumeOwnerTicket(sha('2'), 5000)).toBeNull()
  })

  it('finds only live sessions of the requested artifact', () => {
    store.createArtifact(artifact('A'), version())
    store.createArtifact(artifact('B'), version())
    store.createSession(session('s1', 'A', sha('1'), 5000))
    store.createSession(session('s2', 'A', sha('2'), 5000))
    store.revokeSession('s2', 1500)
    expect(store.findSessionByToken(sha('1'), 'A', 2000)).toMatchObject({ id: 's1', principalId: null })
    expect(store.findSessionByToken(sha('1'), 'B', 2000)).toBeNull()
    expect(store.findSessionByToken(sha('2'), 'A', 2000)).toBeNull()
    expect(store.findSessionByToken(sha('1'), 'A', 5000)).toBeNull()
    expect(store.findSessionById('s1', 2000)?.artifactId).toBe('A')
    expect(store.findSessionById('s2', 2000)).toBeNull()
    store.touchSession('s1', 4000, 9000)
    expect(store.findSessionByToken(sha('1'), 'A', 8000)).toMatchObject({ lastSeenAt: 4000, expiresAt: 9000 })
  })

  it('keeps data and the capability key across reopening', () => {
    store.createArtifact(artifact('A'), version())
    const key = store.capabilityKey()
    expect(key).toHaveLength(32)
    store.close()
    store = new ArtifactStore(openDatabase(path.join(dir, 'artifacts.sqlite')))
    expect(store.getArtifact('A')?.title).toBe('Title A')
    expect(store.capabilityKey().equals(key)).toBe(true)
  })

  it('writes a consistent snapshot', () => {
    store.createArtifact(artifact('A'), version())
    const file = path.join(dir, 'snapshot.sqlite')
    store.vacuumInto(file)
    const copy = new DatabaseSync(file, { readOnly: true })
    expect(copy.prepare('SELECT id FROM artifacts').all()).toEqual([{ id: 'A' }])
    copy.close()
  })
})

function session(id: string, artifactId: string, tokenHash: string, expiresAt = 5000) {
  return { id, artifactId, principalId: null, tokenHash, deviceLabel: 'Safari/macOS', createdAt: 1000, expiresAt }
}
