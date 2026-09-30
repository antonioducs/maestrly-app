// How people other than the owner get in: personal links, access requests, and guest entry on a shared link.
import { z } from 'zod'
import { gateFor } from '../access.js'
import { verifyAccessCode } from '../access-code.js'
import { digest, newSecretToken, randomId } from '../ids.js'
import {
  MAX_ACCESS_CODE_CHARS,
  MAX_DEVICES_PER_PRINCIPAL,
  MAX_GUESTS_PER_ARTIFACT,
  MAX_PENDING_REQUESTS,
  MAX_REQUEST_MESSAGE_CHARS,
  VISITOR_COOKIE_TTL_MS,
} from '../limits.js'
import { personName } from '../schemas.js'
import type { ActivityRecorder } from '../sharing-admin.js'
import { type AccessRequestStatus, VISITOR_COOKIE } from '../shell/contract.js'
import type { PrincipalRecord, SharingStore } from '../store/sharing-store.js'
import type { RateLimiter } from './rate-limit.js'
import {
  type ApiContext,
  apiForbidden,
  apiNotFound,
  cookie,
  type Headers,
  json,
  MAX_COOKIE_TOKEN_CHARS,
  noContent,
} from './respond.js'

export interface VisitorRouteDeps {
  sharing: SharingStore
  limiter: RateLimiter
  ownerName: string
  record: ActivityRecorder
  onChange: (artifactId: string) => void
  /** Creates this browser's session for the person and returns its cookie and the device label. */
  startSession: (ctx: ApiContext, principal: PrincipalRecord) => { cookie: string; device: string }
}

const requestInput = z.object({
  name: personName,
  // A short note may have line breaks, but no other control characters.
  message: z
    .string()
    .trim()
    .max(MAX_REQUEST_MESSAGE_CHARS)
    .regex(/^[\P{Cc}\n]*$/u)
    .default(''),
})
const nameInput = z.object({ name: personName })
const setCookies = (cookies: string[]): Headers => (cookies.length ? { 'set-cookie': cookies } : {})

export function createVisitorRoutes(deps: VisitorRouteDeps): Record<string, (ctx: ApiContext) => void> {
  const { sharing, limiter, record } = deps

  const visitorCookie = (ctx: ApiContext, secret: string) =>
    cookie(VISITOR_COOKIE, ctx.artifactId, ctx.origin, secret, VISITOR_COOKIE_TTL_MS / 1000)

  /** The person a personal link belongs to, while the link works: shared artifact, not revoked, not expired. */
  function invitee(ctx: ApiContext): PrincipalRecord | null {
    const token = ctx.body.token
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_COOKIE_TOKEN_CHARS) return null
    if (ctx.sharing.visibility === 'private') return null
    const principal = sharing.findPrincipalByInvite(digest(token), ctx.artifactId)
    if (!principal || principal.kind === 'guest' || principal.revokedAt !== null) return null
    if (principal.inviteExpiresAt !== null && principal.inviteExpiresAt <= ctx.now) return null
    return principal
  }

  const isDeviceOf = (ctx: ApiContext, principal: PrincipalRecord): boolean =>
    ctx.access?.kind === 'person' && ctx.access.principal.id === principal.id

  /** Adds this browser to the person's devices and tells the owner. */
  function addDevice(ctx: ApiContext, principal: PrincipalRecord): string | null {
    if (sharing.countSessions(principal.id, ctx.now) >= MAX_DEVICES_PER_PRINCIPAL) return null
    const session = deps.startSession(ctx, principal)
    record(ctx.artifactId, 'device_added', { name: principal.name, device: session.device })
    return session.cookie
  }

  return {
    // The viewer shows the name before anything is exchanged, so a scanner that only loads the page joins nothing.
    'invite/preview'(ctx) {
      const principal = invitee(ctx)
      if (!principal) return apiNotFound(ctx.res)
      json(ctx.res, 200, { name: principal.name, ownerName: deps.ownerName })
    },

    // "I'm not Maria": the owner learns that the link reached someone else.
    'invite/decline'(ctx) {
      const principal = invitee(ctx)
      if (!principal) return apiNotFound(ctx.res)
      record(ctx.artifactId, 'invite_declined', { name: principal.name })
      noContent(ctx.res)
    },

    'session/invite'(ctx) {
      const principal = invitee(ctx)
      if (!principal) return apiNotFound(ctx.res)
      if (isDeviceOf(ctx, principal)) return noContent(ctx.res)
      const session = addDevice(ctx, principal)
      if (!session) return json(ctx.res, 409, { error: 'too_many_devices' })
      noContent(ctx.res, { 'set-cookie': session })
    },

    'session/code'(ctx) {
      const gate = gateFor(ctx.sharing, ctx.now)
      if (!gate?.guest) return apiNotFound(ctx.res)
      if (ctx.access) return noContent(ctx.res)
      const cookies: string[] = []
      if (gate.code) {
        // Attempts are counted per browser, so a browser without the visitor cookie gets one with its first answer.
        let secret = ctx.visitor
        if (!secret) {
          secret = newSecretToken()
          cookies.push(visitorCookie(ctx, secret))
        }
        const browser = digest(secret)
        const attempt = limiter.codeAttempt(ctx.artifactId, browser)
        if (!attempt.allowed)
          return json(
            ctx.res,
            429,
            { error: 'too_many_attempts' },
            { 'retry-after': String(Math.ceil(attempt.retryAfterMs / 1000)), ...setCookies(cookies) }
          )
        const code = ctx.body.code
        const stored = ctx.sharing.accessCodeHash
        if (
          typeof code !== 'string' ||
          code.length > MAX_ACCESS_CODE_CHARS ||
          stored === null ||
          !verifyAccessCode(code, stored)
        ) {
          limiter.codeFailed(ctx.artifactId, browser)
          return json(ctx.res, 403, { error: 'wrong_code' }, setCookies(cookies))
        }
      }
      if (sharing.countGuests(ctx.artifactId, ctx.now) >= MAX_GUESTS_PER_ARTIFACT)
        return json(ctx.res, 429, { error: 'too_many_guests' }, setCookies(cookies))
      const guest: PrincipalRecord = {
        id: randomId(),
        artifactId: ctx.artifactId,
        kind: 'guest',
        name: '',
        inviteTokenHash: null,
        inviteExpiresAt: null,
        revokedAt: null,
        createdAt: ctx.now,
      }
      sharing.insertPrincipal(guest)
      cookies.push(deps.startSession(ctx, guest).cookie)
      deps.onChange(ctx.artifactId)
      noContent(ctx.res, setCookies(cookies))
    },

    // A guest's name is whatever they type; it is shown as unverified.
    'session/name'(ctx) {
      if (!ctx.access) return apiNotFound(ctx.res)
      if (ctx.access.kind !== 'person' || ctx.access.principal.kind !== 'guest') return apiForbidden(ctx.res)
      const input = nameInput.safeParse(ctx.body)
      if (!input.success) return json(ctx.res, 400, { error: 'invalid_name' })
      sharing.setPrincipalName(ctx.access.principal.id, input.data.name)
      deps.onChange(ctx.artifactId)
      noContent(ctx.res)
    },

    'access-requests'(ctx) {
      if (!gateFor(ctx.sharing, ctx.now)?.request) return apiNotFound(ctx.res)
      const input = requestInput.safeParse(ctx.body)
      if (!input.success) return json(ctx.res, 400, { error: 'invalid_request' })
      sharing.expireRequests(ctx.now)
      const secret = ctx.visitor ?? newSecretToken()
      const headers = { 'set-cookie': visitorCookie(ctx, secret) }
      const previous = ctx.visitor ? sharing.findRequestByBrowser(ctx.artifactId, digest(secret)) : null
      // One answer per browser: a request that waits or was approved is kept, and a denied one is final.
      if (previous?.status === 'pending') return json(ctx.res, 202, { status: 'pending' }, headers)
      if (previous?.status === 'denied') return json(ctx.res, 403, { error: 'denied' })
      if (previous?.status === 'approved') {
        const person = previous.principalId ? sharing.getPrincipal(previous.principalId) : null
        if (person && person.revokedAt === null) return json(ctx.res, 202, { status: 'pending' }, headers)
        return json(ctx.res, 403, { error: 'denied' })
      }
      if (sharing.listPendingRequests(ctx.artifactId, ctx.now).length >= MAX_PENDING_REQUESTS)
        return json(ctx.res, 429, { error: 'too_many_requests' })
      sharing.insertRequest({
        id: randomId(),
        artifactId: ctx.artifactId,
        name: input.data.name,
        message: input.data.message,
        browserSecretHash: digest(secret),
        status: 'pending',
        principalId: null,
        createdAt: ctx.now,
        decidedAt: null,
      })
      record(ctx.artifactId, 'access_requested', { name: input.data.name })
      json(ctx.res, 202, { status: 'pending' }, headers)
    },

    // The waiting browser asks how its request is doing. Once approved, this is where it becomes a device.
    'access-requests/current'(ctx) {
      if (!ctx.visitor) return apiNotFound(ctx.res)
      sharing.expireRequests(ctx.now)
      const request = sharing.findRequestByBrowser(ctx.artifactId, digest(ctx.visitor))
      if (!request) return apiNotFound(ctx.res)
      const status: AccessRequestStatus = request.status
      if (status !== 'approved') return json(ctx.res, 200, { status })
      const principal = request.principalId ? sharing.getPrincipal(request.principalId) : null
      if (!principal || principal.revokedAt !== null || ctx.sharing.visibility === 'private')
        return apiNotFound(ctx.res)
      if (isDeviceOf(ctx, principal)) return json(ctx.res, 200, { status })
      const session = addDevice(ctx, principal)
      if (!session) return json(ctx.res, 409, { error: 'too_many_devices' })
      json(ctx.res, 200, { status }, { 'set-cookie': session })
    },
  }
}
