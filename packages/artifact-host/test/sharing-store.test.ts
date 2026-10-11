import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACCESS_REQUEST_TTL_MS, MAX_EVENTS_PER_ARTIFACT } from '../src/limits.js'
import { ArtifactStore, type NewSession } from '../src/store/artifact-store.js'
import { openDatabase } from '../src/store/db.js'
import { type AccessRequestRecord, type PrincipalRecord, SharingStore } from '../src/store/sharing-store.js'
import { tempDir } from './helpers.js'

let cleanup: () => void
let store: ArtifactStore
let sharing: SharingStore

const sha = (char: string) => char.repeat(64)
const count = (table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

function createArtifact(id: string): void {
  store.createArtifact(
    {
      id,
      title: `Title ${id}`,
      description: '',
      ownerKind: 'local',
      ownerId: 'local',
      workspaceId: null,
      conversationId: null,
      conversationTitle: null,
      createdAt: 1000,
    },
    {
      entry: 'index.html',
      summary: '',
      createdBy: 'agent',
      createdAt: 1000,
      files: [{ path: 'index.html', sha256: sha('a'), bytes: 3, contentType: 'text/html; charset=utf-8' }],
    }
  )
}

function principal(id: string, overrides: Partial<PrincipalRecord> = {}): PrincipalRecord {
  return {
    id,
    artifactId: 'A',
    kind: 'invited',
    name: `Person ${id}`,
    inviteTokenHash: sha(id.slice(-1)),
    inviteExpiresAt: null,
    createdAt: 1000,
    ...overrides,
  }
}

function session(id: string, overrides: Partial<NewSession> = {}): NewSession {
  return {
    id,
    artifactId: 'A',
    principalId: null,
    tokenHash: `token-${id}`,
    deviceLabel: 'Safari/iPhone',
    createdAt: 1000,
    expiresAt: 1_000_000,
    ...overrides,
  }
}

function request(id: string, overrides: Partial<AccessRequestRecord> = {}): AccessRequestRecord {
  return {
    id,
    artifactId: 'A',
    name: 'João',
    message: '',
    browserSecretHash: sha('b'),
    status: 'pending',
    principalId: null,
    createdAt: 1000,
    decidedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  const temp = tempDir()
  cleanup = temp.cleanup
  store = new ArtifactStore(openDatabase(path.join(temp.dir, 'artifacts.sqlite')))
  sharing = new SharingStore(store.db)
  createArtifact('A')
  createArtifact('B')
})
afterEach(() => {
  store.close()
  cleanup()
})

describe('SharingStore', () => {
  it('reads and writes the sharing fields of an artifact', () => {
    expect(sharing.getSharing('A')).toEqual({
      visibility: 'private',
      linkExpiresAt: null,
      accessCodeHash: null,
      commentsEnabled: true,
    })
    sharing.setSharing('A', { visibility: 'link', linkExpiresAt: 5000, accessCodeHash: 'scrypt$a$b' })
    sharing.setSharing('A', { commentsEnabled: false })
    expect(sharing.getSharing('A')).toEqual({
      visibility: 'link',
      linkExpiresAt: 5000,
      accessCodeHash: 'scrypt$a$b',
      commentsEnabled: false,
    })
    sharing.setSharing('A', { linkExpiresAt: null, accessCodeHash: null })
    expect(sharing.getSharing('A')).toMatchObject({ linkExpiresAt: null, accessCodeHash: null })
    expect(sharing.getSharing('B')?.visibility).toBe('private')
    expect(sharing.getSharing('missing')).toBeNull()
  })

  it('finds an invited person by the digest of their link, within one artifact', () => {
    sharing.insertPrincipal(principal('p1'))
    expect(sharing.findPrincipalByInvite(sha('1'), 'A')).toMatchObject({ id: 'p1', name: 'Person p1' })
    expect(sharing.findPrincipalByInvite(sha('1'), 'B')).toBeNull()
    expect(sharing.findPrincipalByInvite(sha('9'), 'A')).toBeNull()
    sharing.setInviteToken('p1', sha('7'))
    expect(sharing.findPrincipalByInvite(sha('1'), 'A')).toBeNull()
    expect(sharing.findPrincipalByInvite(sha('7'), 'A')?.id).toBe('p1')
    sharing.setPrincipalName('p1', 'Maria')
    expect(sharing.getPrincipal('p1')?.name).toBe('Maria')
    expect(sharing.listPrincipals('A').map((person) => person.id)).toEqual(['p1'])
    expect(sharing.listPrincipals('B')).toEqual([])
  })

  it('removes a person together with their devices, and nobody else', () => {
    sharing.insertPrincipal(principal('p1'))
    sharing.insertPrincipal(principal('p2'))
    store.createSession(session('owner'))
    store.createSession(session('s1', { principalId: 'p1' }))
    store.createSession(session('s2', { principalId: 'p1' }))
    store.createSession(session('s3', { principalId: 'p2' }))
    expect(sharing.countSessions('p1', 2000)).toBe(2)
    expect(sharing.listSessions('A', 'p1', 2000).map((item) => item.id)).toEqual(['s1', 's2'])

    sharing.removePrincipal('p1')
    expect(sharing.getPrincipal('p1')).toBeNull()
    expect(sharing.findPrincipalByInvite(sha('1'), 'A')).toBeNull()
    expect(sharing.listPrincipals('A').map((person) => person.id)).toEqual(['p2'])
    expect(sharing.countSessions('p1', 4000)).toBe(0)
    expect(store.findSessionById('s1', 4000)).toBeNull()
    expect(store.findSessionById('owner', 4000)?.id).toBe('owner')
    expect(store.findSessionById('s3', 4000)?.id).toBe('s3')
    expect(count('sessions')).toBe(2)
  })

  it('removes the people an earlier build left marked as revoked', () => {
    sharing.insertPrincipal(principal('p1'))
    sharing.insertPrincipal(principal('p2'))
    store.createSession(session('s1', { principalId: 'p1' }))
    store.createSession(session('s2', { principalId: 'p2' }))
    store.db.prepare("UPDATE principals SET revoked_at = 3000 WHERE id = 'p1'").run()
    sharing.removeRevokedPrincipals()
    expect(sharing.listPrincipals('A').map((person) => person.id)).toEqual(['p2'])
    expect(store.findSessionById('s1', 4000)).toBeNull()
    expect(store.findSessionById('s2', 4000)?.id).toBe('s2')
  })

  it('revokes one device only within its own artifact, and every session of an artifact on request', () => {
    sharing.insertPrincipal(principal('p1'))
    store.createSession(session('owner'))
    store.createSession(session('s1', { principalId: 'p1' }))
    store.createSession(session('other', { artifactId: 'B' }))
    expect(sharing.revokeSessionOf('A', 'other', 2000)).toBe(false)
    expect(store.findSessionById('other', 3000)?.id).toBe('other')
    expect(sharing.revokeSessionOf('A', 's1', 2000)).toBe(true)
    expect(sharing.revokeSessionOf('A', 's1', 2000)).toBe(false)

    sharing.revokeAllSessions('A', 3000)
    expect(store.findSessionById('owner', 4000)).toBeNull()
    expect(store.findSessionById('other', 4000)?.id).toBe('other')
  })

  it('counts signed-in guests and forgets the ones whose device is gone', () => {
    sharing.insertPrincipal(principal('p1'))
    sharing.insertPrincipal(principal('g1', { kind: 'guest', inviteTokenHash: null }))
    sharing.insertPrincipal(principal('g2', { kind: 'guest', inviteTokenHash: null }))
    store.createSession(session('s1', { principalId: 'p1', expiresAt: 1500 }))
    store.createSession(session('s2', { principalId: 'g1', expiresAt: 1500 }))
    store.createSession(session('s3', { principalId: 'g2' }))
    expect(sharing.countGuests('A', 1200)).toBe(2)
    expect(sharing.countGuests('A', 2000)).toBe(1)
    expect(sharing.countGuests('B', 1200)).toBe(0)

    sharing.pruneGuests(2000)
    expect(sharing.listPrincipals('A').map((person) => person.id)).toEqual(['g2', 'p1'])
    // An invited person's expired device is not the prune's business.
    expect(count('sessions')).toBe(2)
  })

  it('keeps a browser’s latest request and expires pending requests after a day', () => {
    sharing.insertRequest(request('r1', { createdAt: 1000 }))
    sharing.insertRequest(request('r2', { createdAt: 2000, name: 'João again' }))
    expect(sharing.findRequestByBrowser('A', sha('b'))?.id).toBe('r2')
    expect(sharing.findRequestByBrowser('B', sha('b'))).toBeNull()
    expect(sharing.listPendingRequests('A', 3000).map((item) => item.id)).toEqual(['r1', 'r2'])
    expect(store.getArtifact('A')).toMatchObject({ pendingRequests: 2 })

    sharing.decideRequest('r1', 'denied', null, 4000)
    expect(sharing.getRequest('r1')).toMatchObject({ status: 'denied', decidedAt: 4000, principalId: null })
    expect(sharing.listPendingRequests('A', 5000).map((item) => item.id)).toEqual(['r2'])

    expect(sharing.listPendingRequests('A', 2000 + ACCESS_REQUEST_TTL_MS + 1)).toEqual([])
    expect(sharing.getRequest('r2')?.status).toBe('expired')
    expect(store.getArtifact('A')).toMatchObject({ pendingRequests: 0 })
  })

  it('counts unseen events per artifact and marks them seen', () => {
    const event = sharing.addEvent('A', 'device_added', { name: 'Maria', device: 'Safari/iPhone' }, 1000)
    sharing.addEvent('A', 'comment_added', { name: 'Maria' }, 2000)
    sharing.addEvent('B', 'invite_declined', { name: 'Ana' }, 3000)
    expect(event).toMatchObject({ artifactId: 'A', kind: 'device_added', seenAt: null })
    expect(store.getArtifact('A')).toMatchObject({ unseenEvents: 2 })
    expect(sharing.listEvents({}).map((item) => item.kind)).toEqual([
      'invite_declined',
      'comment_added',
      'device_added',
    ])
    expect(sharing.listEvents({ artifactId: 'A', limit: 1 })[0]).toMatchObject({
      kind: 'comment_added',
      data: { name: 'Maria' },
    })

    sharing.markSeen('A', 4000)
    expect(store.getArtifact('A')).toMatchObject({ unseenEvents: 0 })
    expect(store.getArtifact('B')).toMatchObject({ unseenEvents: 1 })
    expect(sharing.listEvents({ unseenOnly: true }).map((item) => item.artifactId)).toEqual(['B'])
    sharing.markSeen(undefined, 5000)
    expect(sharing.listEvents({ unseenOnly: true })).toEqual([])
  })

  it('keeps at most the event limit per artifact, dropping the oldest seen events first', () => {
    sharing.addEvent('A', 'device_added', { n: 0 }, 1)
    sharing.addEvent('A', 'device_added', { n: 1 }, 2)
    sharing.markSeen('A', 3)
    store.db.exec('BEGIN')
    for (let n = 2; n < MAX_EVENTS_PER_ARTIFACT; n++) sharing.addEvent('A', 'comment_added', { n }, 10 + n)
    store.db.exec('COMMIT')
    expect(count('events')).toBe(MAX_EVENTS_PER_ARTIFACT)
    // One more than the limit: the oldest seen event goes, the unseen ones stay.
    sharing.addEvent('A', 'comment_added', { n: MAX_EVENTS_PER_ARTIFACT }, 10_000)
    expect(count('events')).toBe(MAX_EVENTS_PER_ARTIFACT)
    const kept = sharing.listEvents({ artifactId: 'A', limit: MAX_EVENTS_PER_ARTIFACT }).map((item) => item.data.n)
    expect(kept).not.toContain(0)
    expect(kept).toContain(1)
    expect(kept).toContain(2)
  })

  it('removes people, requests and events with their artifact', () => {
    sharing.insertPrincipal(principal('p1'))
    sharing.insertRequest(request('r1'))
    sharing.addEvent('A', 'access_requested', { name: 'João' }, 1000)
    store.deleteArtifact('A')
    expect(count('principals')).toBe(0)
    expect(count('access_requests')).toBe(0)
    expect(count('events')).toBe(0)
  })
})
