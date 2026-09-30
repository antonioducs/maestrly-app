import type { SessionRecord } from './store/artifact-store.js'
import type { PrincipalRecord, SharingFields } from './store/sharing-store.js'

/** Who a valid session acts as on its artifact. */
export type Access =
  | { kind: 'owner'; session: SessionRecord }
  | { kind: 'person'; session: SessionRecord; principal: PrincipalRecord }

const expired = (at: number | null, now: number): boolean => at !== null && at <= now

/**
 * The single rule for who may view an artifact. The owner always may. `private` blocks everyone else without
 * forgetting them. Invited and approved people need `people` or `link`; guests need a `link` that has not expired.
 */
export function resolveAccess(
  sharing: SharingFields,
  session: SessionRecord | null,
  principal: PrincipalRecord | null,
  now: number
): Access | null {
  if (!session) return null
  if (session.principalId === null) return { kind: 'owner', session }
  if (!principal || principal.id !== session.principalId || principal.artifactId !== session.artifactId) return null
  if (principal.revokedAt !== null || sharing.visibility === 'private') return null
  if (principal.kind === 'guest') {
    if (sharing.visibility !== 'link' || expired(sharing.linkExpiresAt, now)) return null
  } else if (expired(principal.inviteExpiresAt, now)) return null
  return { kind: 'person', session, principal }
}

export interface Gate {
  /** The visitor may ask the owner for access. */
  request: boolean
  /** The visitor may enter as a guest. */
  guest: boolean
  /** Entering as a guest needs the access code. */
  code: boolean
}

/** What a visitor without access may do. `null` means the artifact answers like one that does not exist. */
export function gateFor(sharing: SharingFields, now: number): Gate | null {
  if (sharing.visibility === 'private') return null
  if (sharing.visibility === 'link' && !expired(sharing.linkExpiresAt, now))
    return { request: false, guest: true, code: sharing.accessCodeHash !== null }
  return { request: true, guest: false, code: false }
}
