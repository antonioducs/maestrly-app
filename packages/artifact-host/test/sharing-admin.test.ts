import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ArtifactAdmin, createArtifactAdmin } from '../src/admin.js'
import { ArtifactHostError } from '../src/errors.js'
import { digest } from '../src/ids.js'
import { createActivityRecorder } from '../src/sharing-admin.js'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BlobStore } from '../src/store/blobs.js'
import { openDatabase } from '../src/store/db.js'
import { SharingStore } from '../src/store/sharing-store.js'
import { tempDir, testClock, utf8 } from './helpers.js'

let cleanup: () => void
let store: ArtifactStore
let sharing: SharingStore
let admin: ArtifactAdmin
let clock: ReturnType<typeof testClock>
let onChange: ReturnType<typeof vi.fn>
let onActivity: ReturnType<typeof vi.fn>
let id: string
let other: string

const MISSING = 'A'.repeat(22)

async function errorOf(promise: Promise<unknown>): Promise<ArtifactHostError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ArtifactHostError) return error
    throw error
  }
  throw new Error('expected an error')
}

const create = async (title: string) =>
  (
    await admin.create({
      title,
      owner: { kind: 'local', id: 'local' },
      origin: { workspaceId: null, conversationId: null, conversationTitle: null },
      files: [{ path: 'index.html', bytes: utf8(`<p>${title}</p>`) }],
    })
  ).id

function addSession(sessionId: string, artifactId: string, principalId: string | null): void {
  store.createSession({
    id: sessionId,
    artifactId,
    principalId,
    tokenHash: `token-${sessionId}`,
    deviceLabel: 'Safari/iPhone',
    createdAt: clock.now(),
    expiresAt: clock.now() + 1_000_000,
  })
}

function addRequest(requestId: string, artifactId = id): void {
  sharing.insertRequest({
    id: requestId,
    artifactId,
    name: 'João',
    message: 'Please',
    browserSecretHash: 'b'.repeat(64),
    status: 'pending',
    principalId: null,
    createdAt: clock.now(),
    decidedAt: null,
  })
}

beforeEach(async () => {
  const temp = tempDir()
  cleanup = temp.cleanup
  store = new ArtifactStore(openDatabase(path.join(temp.dir, 'artifacts.sqlite')))
  sharing = new SharingStore(store.db)
  clock = testClock()
  onChange = vi.fn()
  onActivity = vi.fn()
  admin = createArtifactAdmin({
    store,
    blobs: new BlobStore(path.join(temp.dir, 'blobs')),
    clock: clock.now,
    quotaBytes: 1024 * 1024,
    onChange,
    onActivity,
  })
  id = await create('Shared')
  other = await create('Other')
  onChange.mockClear()
})
afterEach(() => {
  store.close()
  cleanup()
})

describe('sharing admin', () => {
  it('invites a person with a link shown once', async () => {
    const { principalId, token } = await admin.createInvite(id, { name: '  Maria  ' })
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(sharing.findPrincipalByInvite(digest(token), id)?.id).toBe(principalId)
    expect(onChange).toHaveBeenCalledWith(id)
    const view = await admin.getSharing(id)
    expect(view).toMatchObject({ visibility: 'private', hasAccessCode: false, commentsEnabled: true, requests: [] })
    expect(view.people).toEqual([
      {
        id: principalId,
        kind: 'invited',
        name: 'Maria',
        createdAt: clock.now(),
        inviteExpiresAt: null,
        revokedAt: null,
        devices: [],
      },
    ])
    expect(JSON.stringify(view)).not.toContain(token)
    expect(JSON.stringify(view)).not.toContain(digest(token))
  })

  it('refuses names that are empty, too long, or not a single line', async () => {
    for (const name of ['', '   ', 'x'.repeat(61), 'Ma\nria', 'Ma\u0000ria'])
      expect((await errorOf(admin.createInvite(id, { name }))).code, JSON.stringify(name)).toBe('invalid_input')
    expect((await errorOf(admin.createInvite(id, { name: 'Maria', expiresAt: clock.now() }))).code).toBe(
      'invalid_input'
    )
    expect((await admin.createInvite(id, { name: 'x'.repeat(60) })).principalId).toBeTruthy()
  })

  it('resets a personal link: the old one stops working and devices stay', async () => {
    const { principalId, token } = await admin.createInvite(id, { name: 'Maria' })
    addSession('s1', id, principalId)
    const next = await admin.resetInvite(id, principalId)
    expect(next.token).not.toBe(token)
    expect(sharing.findPrincipalByInvite(digest(token), id)).toBeNull()
    expect(sharing.findPrincipalByInvite(digest(next.token), id)?.id).toBe(principalId)
    expect((await admin.getSharing(id)).people[0]?.devices).toEqual([
      { id: 's1', label: 'Safari/iPhone', createdAt: clock.now(), lastSeenAt: clock.now() },
    ])
    expect((await errorOf(admin.resetInvite(other, principalId))).code).toBe('not_found')
  })

  it('revokes people and devices only within their own artifact', async () => {
    const { principalId } = await admin.createInvite(id, { name: 'Maria' })
    addSession('s1', id, principalId)
    addSession('s2', id, principalId)
    expect((await errorOf(admin.revokePerson(other, principalId))).code).toBe('not_found')
    expect((await errorOf(admin.revokeDevice(other, 's1'))).code).toBe('not_found')
    expect((await errorOf(admin.revokeDevice(id, 'nope'))).code).toBe('not_found')

    await admin.revokeDevice(id, 's1')
    expect((await admin.getSharing(id)).people[0]?.devices.map((device) => device.id)).toEqual(['s2'])
    await admin.revokePerson(id, principalId)
    const [person] = (await admin.getSharing(id)).people
    expect(person).toMatchObject({ revokedAt: clock.now(), devices: [] })
    expect((await errorOf(admin.resetInvite(id, principalId))).code).toBe('not_found')
  })

  it('ends every session of an artifact, the owner’s included', async () => {
    addSession('owner', id, null)
    addSession('elsewhere', other, null)
    await admin.revokeAllSessions(id)
    expect(store.findSessionById('owner', clock.now())).toBeNull()
    expect(store.findSessionById('elsewhere', clock.now())?.id).toBe('elsewhere')
  })

  it('changes who can open an artifact, and never returns the access code', async () => {
    expect((await errorOf(admin.setSharing(id, { accessCode: '12345' }))).code).toBe('invalid_input')
    expect((await errorOf(admin.setSharing(id, { accessCode: 'x'.repeat(65) }))).code).toBe('invalid_input')
    expect((await errorOf(admin.setSharing(id, { linkExpiresAt: clock.now() }))).code).toBe('invalid_input')
    expect((await errorOf(admin.setSharing(id, { visibility: 'public' as never }))).code).toBe('invalid_input')

    const view = await admin.setSharing(id, {
      visibility: 'link',
      accessCode: '123456',
      linkExpiresAt: clock.now() + 1000,
      commentsEnabled: false,
    })
    expect(view).toMatchObject({
      visibility: 'link',
      hasAccessCode: true,
      linkExpiresAt: clock.now() + 1000,
      commentsEnabled: false,
    })
    expect(JSON.stringify(view)).not.toContain('scrypt')
    expect(sharing.getSharing(id)?.accessCodeHash).toMatch(/^scrypt\$/)
    expect((await admin.get(id))?.visibility).toBe('link')
    expect(await admin.setSharing(id, { accessCode: null, linkExpiresAt: null })).toMatchObject({
      hasAccessCode: false,
      linkExpiresAt: null,
      visibility: 'link',
    })
  })

  it('signs guests out when the access code changes, and keeps invited people', async () => {
    const { principalId } = await admin.createInvite(id, { name: 'Maria' })
    sharing.insertPrincipal({
      id: 'guest',
      artifactId: id,
      kind: 'guest',
      name: '',
      inviteTokenHash: null,
      inviteExpiresAt: null,
      revokedAt: null,
      createdAt: clock.now(),
    })
    addSession('maria', id, principalId)
    addSession('anon', id, 'guest')
    await admin.setSharing(id, { visibility: 'link' })
    expect(store.findSessionById('anon', clock.now())?.id).toBe('anon')
    await admin.setSharing(id, { accessCode: 'new-code' })
    expect(store.findSessionById('anon', clock.now())).toBeNull()
    expect(store.findSessionById('maria', clock.now())?.id).toBe('maria')
  })

  it('lists guests only while they have a device', async () => {
    sharing.insertPrincipal({
      id: 'guest',
      artifactId: id,
      kind: 'guest',
      name: 'Ana',
      inviteTokenHash: null,
      inviteExpiresAt: null,
      revokedAt: null,
      createdAt: clock.now(),
    })
    expect((await admin.getSharing(id)).people).toEqual([])
    addSession('anon', id, 'guest')
    expect((await admin.getSharing(id)).people.map((person) => person.name)).toEqual(['Ana'])
  })

  it('approves a request as a person with the name the owner confirmed, or denies it', async () => {
    addRequest('r1')
    addRequest('r2')
    expect((await admin.getSharing(id)).requests).toEqual([
      { id: 'r1', name: 'João', message: 'Please', createdAt: clock.now() },
      { id: 'r2', name: 'João', message: 'Please', createdAt: clock.now() },
    ])
    expect((await admin.list()).find((item) => item.id === id)?.pendingRequests).toBe(2)

    await admin.decideAccessRequest(id, 'r1', { approve: true, name: 'João Silva' })
    const request = sharing.getRequest('r1')
    expect(request).toMatchObject({ status: 'approved', decidedAt: clock.now() })
    expect(sharing.getPrincipal(request!.principalId!)).toMatchObject({
      kind: 'approved',
      name: 'João Silva',
      inviteTokenHash: null,
    })

    await admin.decideAccessRequest(id, 'r2', { approve: false })
    expect(sharing.getRequest('r2')).toMatchObject({ status: 'denied', principalId: null })
    expect((await admin.getSharing(id)).people.map((person) => person.kind)).toEqual(['approved'])
    expect((await admin.getSharing(id)).requests).toEqual([])

    expect((await errorOf(admin.decideAccessRequest(id, 'r1', { approve: true }))).code).toBe('not_found')
    expect((await errorOf(admin.decideAccessRequest(id, 'missing', { approve: true }))).code).toBe('not_found')
    addRequest('r3')
    expect((await errorOf(admin.decideAccessRequest(other, 'r3', { approve: true }))).code).toBe('not_found')
    expect((await errorOf(admin.decideAccessRequest(id, 'r3', { approve: true, name: ' ' }))).code).toBe(
      'invalid_input'
    )
  })

  it('records events, announces them, and lets the owner mark them seen', async () => {
    const record = createActivityRecorder({ sharing, clock: clock.now, onChange, onActivity })
    record(id, 'access_requested', { name: 'João' })
    record(other, 'device_added', { name: 'Maria', device: 'Safari/iPhone' })
    expect(onActivity).toHaveBeenCalledWith(id, 'access_requested')
    expect(onActivity).toHaveBeenCalledWith(other, 'device_added')
    expect(onChange).toHaveBeenCalledWith(id)

    expect(await admin.listEvents()).toEqual([
      expect.objectContaining({ artifactId: other, kind: 'device_added', seen: false }),
      expect.objectContaining({ artifactId: id, kind: 'access_requested', data: { name: 'João' }, seen: false }),
    ])
    expect((await admin.get(id))?.unseenEvents).toBe(1)
    await admin.markEventsSeen(id)
    expect(await admin.listEvents({ unseenOnly: true })).toEqual([expect.objectContaining({ artifactId: other })])
    expect((await admin.listEvents({ artifactId: id }))[0]?.seen).toBe(true)
    await admin.markEventsSeen()
    expect(await admin.listEvents({ unseenOnly: true })).toEqual([])
    expect((await errorOf(admin.listEvents({ limit: 0 }))).code).toBe('invalid_input')
  })

  it('reports unknown artifacts as not found', async () => {
    const calls: Promise<unknown>[] = [
      admin.getSharing(MISSING),
      admin.setSharing(MISSING, { visibility: 'people' }),
      admin.createInvite(MISSING, { name: 'Maria' }),
      admin.resetInvite(MISSING, 'p'),
      admin.revokePerson(MISSING, 'p'),
      admin.revokeDevice(MISSING, 's'),
      admin.revokeAllSessions(MISSING),
      admin.decideAccessRequest(MISSING, 'r', { approve: true }),
      admin.getSharing('not-an-id'),
      admin.markEventsSeen('not-an-id'),
    ]
    for (const call of calls) expect((await errorOf(call)).code).toBe('not_found')
  })
})
