import { describe, expect, it } from 'vitest'
import { gateFor, resolveAccess } from '../src/access.js'
import type { SessionRecord, Visibility } from '../src/store/artifact-store.js'
import type { PrincipalKind, PrincipalRecord, SharingFields } from '../src/store/sharing-store.js'

const NOW = 10_000

const sharing = (visibility: Visibility, overrides: Partial<SharingFields> = {}): SharingFields => ({
  visibility,
  linkExpiresAt: null,
  accessCodeHash: null,
  commentsEnabled: true,
  ...overrides,
})

const session = (principalId: string | null): SessionRecord => ({
  id: 's1',
  artifactId: 'A',
  principalId,
  tokenHash: 'hash',
  deviceLabel: 'Safari/iPhone',
  createdAt: 1,
  lastSeenAt: 1,
  expiresAt: 1_000_000,
  revokedAt: null,
})

const person = (kind: PrincipalKind, overrides: Partial<PrincipalRecord> = {}): PrincipalRecord => ({
  id: 'p1',
  artifactId: 'A',
  kind,
  name: 'Maria',
  inviteTokenHash: null,
  inviteExpiresAt: null,
  createdAt: 1,
  ...overrides,
})

const enters = (fields: SharingFields, principal: PrincipalRecord | null, principalId: string | null = 'p1') =>
  resolveAccess(fields, session(principalId), principal, NOW)?.kind ?? null

describe('resolveAccess', () => {
  it('always lets the owner in', () => {
    for (const visibility of ['private', 'people', 'link'] as const)
      expect(enters(sharing(visibility), null, null)).toBe('owner')
    expect(resolveAccess(sharing('link'), null, null, NOW)).toBeNull()
  })

  it('lets invited and approved people in while the artifact is shared and their invitation lasts', () => {
    for (const kind of ['invited', 'approved'] as const) {
      expect(enters(sharing('people'), person(kind))).toBe('person')
      expect(enters(sharing('link'), person(kind))).toBe('person')
      // An expired link only closes the door to guests.
      expect(enters(sharing('link', { linkExpiresAt: NOW - 1 }), person(kind))).toBe('person')
      expect(enters(sharing('private'), person(kind))).toBeNull()
      expect(enters(sharing('people'), person(kind, { inviteExpiresAt: NOW }))).toBeNull()
      expect(enters(sharing('people'), person(kind, { inviteExpiresAt: NOW + 1 }))).toBe('person')
    }
  })

  it('lets guests in only through a link that has not expired', () => {
    expect(enters(sharing('link'), person('guest'))).toBe('person')
    expect(enters(sharing('link', { linkExpiresAt: NOW + 1 }), person('guest'))).toBe('person')
    expect(enters(sharing('link', { linkExpiresAt: NOW }), person('guest'))).toBeNull()
    expect(enters(sharing('people'), person('guest'))).toBeNull()
    expect(enters(sharing('private'), person('guest'))).toBeNull()
  })

  it('refuses a session whose person was removed or is someone else', () => {
    expect(enters(sharing('link'), null)).toBeNull()
    expect(enters(sharing('link'), person('invited', { id: 'other' }))).toBeNull()
    expect(enters(sharing('link'), person('invited', { artifactId: 'B' }))).toBeNull()
  })
})

describe('gateFor', () => {
  it('says what a visitor without access may do, or nothing at all', () => {
    expect(gateFor(sharing('private'), NOW)).toBeNull()
    expect(gateFor(sharing('people'), NOW)).toEqual({ request: true, guest: false, code: false })
    expect(gateFor(sharing('link'), NOW)).toEqual({ request: false, guest: true, code: false })
    expect(gateFor(sharing('link', { accessCodeHash: 'scrypt$a$b', linkExpiresAt: NOW + 1 }), NOW)).toEqual({
      request: false,
      guest: true,
      code: true,
    })
    expect(gateFor(sharing('link', { accessCodeHash: 'scrypt$a$b', linkExpiresAt: NOW }), NOW)).toEqual({
      request: true,
      guest: false,
      code: false,
    })
  })
})
