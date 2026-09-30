import { hashAccessCode } from './access-code.js'
import { ArtifactHostError } from './errors.js'
import { isArtifactId, digest, newSecretToken, randomId } from './ids.js'
import {
  type AccessRequestView,
  type ArtifactEventView,
  eventsFilter,
  inviteInput,
  type PersonView,
  parseInput,
  requestDecision,
  type SharingPatch,
  type SharingView,
  sharingPatch,
} from './schemas.js'
import type { ArtifactStore } from './store/artifact-store.js'
import { transaction } from './store/db.js'
import type { ArtifactEventKind, EventData, SharingFields, SharingStore } from './store/sharing-store.js'

/** The owner's control over who opens an artifact. Agents and visitors never reach these operations. */
export interface SharingAdmin {
  getSharing(id: string): Promise<SharingView>
  setSharing(id: string, patch: SharingPatch): Promise<SharingView>
  /** Invites a person by name. The token is returned once; the host keeps only its digest. */
  createInvite(
    id: string,
    input: { name: string; expiresAt?: number | null }
  ): Promise<{ principalId: string; token: string }>
  /** Issues a new personal link. The old one stops working; devices that already joined keep their sessions. */
  resetInvite(id: string, principalId: string): Promise<{ token: string }>
  /** Ends the person's link and devices at once, and removes them from the artifact's people. */
  revokePerson(id: string, principalId: string): Promise<void>
  revokeDevice(id: string, sessionId: string): Promise<void>
  revokeAllSessions(id: string): Promise<void>
  decideAccessRequest(id: string, requestId: string, decision: { approve: boolean; name?: string }): Promise<void>
  listEvents(filter?: { artifactId?: string; unseenOnly?: boolean; limit?: number }): Promise<ArtifactEventView[]>
  markEventsSeen(artifactId?: string): Promise<void>
}

export interface SharingAdminDeps {
  store: ArtifactStore
  sharing: SharingStore
  clock: () => number
  onChange?: (artifactId: string) => void
}

export type ActivityRecorder = (artifactId: string, kind: ArtifactEventKind, data: EventData) => void

/** Records an event for the owner and announces it, so the desktop can show and sound it. */
export function createActivityRecorder(deps: {
  sharing: SharingStore
  clock: () => number
  onChange?: (artifactId: string) => void
  onActivity?: (artifactId: string, kind: ArtifactEventKind) => void
}): ActivityRecorder {
  return (artifactId, kind, data) => {
    deps.sharing.addEvent(artifactId, kind, data, deps.clock())
    deps.onActivity?.(artifactId, kind)
    deps.onChange?.(artifactId)
  }
}

const notFound = (what = 'Artifact') => new ArtifactHostError('not_found', `${what} not found`)

export function createSharingAdmin(deps: SharingAdminDeps): SharingAdmin {
  const { store, sharing, clock } = deps

  function fields(id: string): SharingFields {
    const current = isArtifactId(id) ? sharing.getSharing(id) : null
    if (!current) throw notFound()
    return current
  }

  function view(id: string): SharingView {
    const current = fields(id)
    const now = clock()
    const people: PersonView[] = []
    for (const person of sharing.listPrincipals(id)) {
      const devices = sharing.listSessions(id, person.id, now).map((session) => ({
        id: session.id,
        label: session.deviceLabel,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
      }))
      // A guest is one device; once it is gone there is nobody left to show.
      if (person.kind === 'guest' && devices.length === 0) continue
      people.push({
        id: person.id,
        kind: person.kind,
        name: person.name,
        createdAt: person.createdAt,
        inviteExpiresAt: person.inviteExpiresAt,
        devices,
      })
    }
    const requests: AccessRequestView[] = sharing.listPendingRequests(id, now).map((request) => ({
      id: request.id,
      name: request.name,
      message: request.message,
      createdAt: request.createdAt,
    }))
    return {
      visibility: current.visibility,
      linkExpiresAt: current.linkExpiresAt,
      hasAccessCode: current.accessCodeHash !== null,
      commentsEnabled: current.commentsEnabled,
      people,
      requests,
    }
  }

  function person(id: string, principalId: string) {
    fields(id)
    const found = typeof principalId === 'string' ? sharing.getPrincipal(principalId) : null
    if (!found || found.artifactId !== id) throw notFound('Person')
    return found
  }

  const future = (at: number | null | undefined, label: string): void => {
    if (typeof at === 'number' && at <= clock())
      throw new ArtifactHostError('invalid_input', `${label} must be in the future`)
  }

  return {
    async getSharing(id) {
      return view(id)
    },

    async setSharing(id, raw) {
      fields(id)
      const patch = parseInput(sharingPatch, raw)
      future(patch.linkExpiresAt, 'The link expiry')
      const next: Partial<SharingFields> = {}
      if (patch.visibility !== undefined) next.visibility = patch.visibility
      if (patch.linkExpiresAt !== undefined) next.linkExpiresAt = patch.linkExpiresAt
      if (patch.commentsEnabled !== undefined) next.commentsEnabled = patch.commentsEnabled
      if (patch.accessCode !== undefined) {
        next.accessCodeHash = patch.accessCode === null ? null : hashAccessCode(patch.accessCode)
        // Whoever entered with the previous code, or without one, enters again with the new one.
        sharing.revokeGuestSessions(id, clock())
      }
      sharing.setSharing(id, next)
      deps.onChange?.(id)
      return view(id)
    },

    async createInvite(id, raw) {
      fields(id)
      const input = parseInput(inviteInput, raw)
      future(input.expiresAt, 'The invitation expiry')
      const token = newSecretToken()
      const principalId = randomId()
      sharing.insertPrincipal({
        id: principalId,
        artifactId: id,
        kind: 'invited',
        name: input.name,
        inviteTokenHash: digest(token),
        inviteExpiresAt: input.expiresAt ?? null,
        createdAt: clock(),
      })
      deps.onChange?.(id)
      return { principalId, token }
    },

    async resetInvite(id, principalId) {
      const found = person(id, principalId)
      if (found.kind === 'guest') throw notFound('Person')
      const token = newSecretToken()
      sharing.setInviteToken(found.id, digest(token))
      deps.onChange?.(id)
      return { token }
    },

    async revokePerson(id, principalId) {
      sharing.removePrincipal(person(id, principalId).id)
      deps.onChange?.(id)
    },

    async revokeDevice(id, sessionId) {
      fields(id)
      if (typeof sessionId !== 'string' || !sharing.revokeSessionOf(id, sessionId, clock())) throw notFound('Device')
      deps.onChange?.(id)
    },

    async revokeAllSessions(id) {
      fields(id)
      sharing.revokeAllSessions(id, clock())
      deps.onChange?.(id)
    },

    async decideAccessRequest(id, requestId, raw) {
      fields(id)
      const now = clock()
      sharing.expireRequests(now)
      const request = typeof requestId === 'string' ? sharing.getRequest(requestId) : null
      if (!request || request.artifactId !== id || request.status !== 'pending') throw notFound('Access request')
      const decision = parseInput(requestDecision, raw)
      if (!decision.approve) sharing.decideRequest(request.id, 'denied', null, now)
      else {
        // The waiting browser becomes this person's first device the next time it checks its request.
        const principalId = randomId()
        transaction(store.db, () => {
          sharing.insertPrincipal({
            id: principalId,
            artifactId: id,
            kind: 'approved',
            name: decision.name ?? request.name,
            inviteTokenHash: null,
            inviteExpiresAt: null,
            createdAt: now,
          })
          sharing.decideRequest(request.id, 'approved', principalId, now)
        })
      }
      deps.onChange?.(id)
    },

    async listEvents(raw = {}) {
      const filter = parseInput(eventsFilter, raw)
      return sharing.listEvents(filter).map((event) => ({
        id: event.id,
        artifactId: event.artifactId,
        kind: event.kind,
        data: event.data,
        createdAt: event.createdAt,
        seen: event.seenAt !== null,
      }))
    },

    async markEventsSeen(artifactId) {
      if (artifactId !== undefined) fields(artifactId)
      const affected = artifactId === undefined ? sharing.unseenArtifacts() : [artifactId]
      // Announced only when something changed, so a listener that marks events seen on every change settles.
      if (sharing.markSeen(artifactId, clock()) > 0) for (const id of affected) deps.onChange?.(id)
    },
  }
}
