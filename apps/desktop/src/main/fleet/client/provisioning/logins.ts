import { macProvisioningError } from '../../../../shared/fleet-provisioning'
import { fleetTargetKey, type FleetProvisioningTargetInput } from '../../../../shared/fleet-targets'
import { shell } from 'electron'
import {
  fleetLoginAttemptSchema,
  fleetLoginCallbackResponseSchema,
  fleetLoginCallbackRequestSchema,
  fleetLoginCodeRequestSchema,
  fleetLoginStartRequestSchema,
  fleetLoginUrlAllowed,
  fleetLoginCallbackFromAuthUrl,
  FLEET_PROVISIONING_LIMITS,
  type FleetLoginAttempt,
  type FleetLoginStartRequest,
} from '@maestrly/bot-fleet-protocol'
import type { FleetClientService } from '../service'
import { provisioningRoute, resolveProvisioningTarget } from '../targets'
import { getMainLocale, tFor } from '../../../i18n'
import { LoginRelay } from './login-relay'

type ActiveLogin = {
  fleet: FleetClientService
  /** The target's key: an environment and a bot may share an id, and so may their login ids. */
  target: string
  loginId: string
  relay: LoginRelay | null
  timer: ReturnType<typeof setTimeout>
  release: () => void
}
const active = new Set<ActiveLogin>()
const reservations = new Set<() => void>()
// Codex always redirects to port 1455 on this Mac: browser sign-ins run one at a time, whatever their target.
let codexQueue = Promise.resolve()
let generation = 0
const unexpected = 'The bot returned a sign-in page that is not from the provider.'
function validate(attempt: FleetLoginAttempt): void {
  const urls = [attempt.browser?.authUrl, attempt.device?.verificationUrl, attempt.manual?.url]
  if (urls.some((url) => url && !fleetLoginUrlAllowed(attempt.kind, url)))
    throw macProvisioningError('login-unexpected-page', unexpected)
  if (attempt.browser) {
    const callback = fleetLoginCallbackFromAuthUrl(attempt.browser.authUrl)
    if (
      !callback ||
      callback.port !== attempt.browser.callback.port ||
      callback.path !== attempt.browser.callback.path ||
      (attempt.kind === 'codex' && (callback.port !== 1455 || callback.path !== '/auth/callback')) ||
      (attempt.kind === 'claude' && callback.path !== '/callback') ||
      attempt.kind === 'grok'
    )
      throw macProvisioningError('login-unexpected-page', unexpected)
  }
}
async function finish(login: ActiveLogin): Promise<void> {
  active.delete(login)
  clearTimeout(login.timer)
  try {
    await login.relay?.close()
  } finally {
    login.release()
  }
}
function attemptsOf(fleet: FleetClientService, target: string, loginId: string): ActiveLogin[] {
  return [...active].filter((login) => login.fleet === fleet && login.target === target && login.loginId === loginId)
}
async function closeAttempt(fleet: FleetClientService, target: string, loginId: string): Promise<void> {
  await Promise.all(attemptsOf(fleet, target, loginId).map(finish))
}
function relayPage(kind: 'done' | 'failed'): string {
  const locale = getMainLocale()
  const message = tFor(locale, 'fleet')('login.relayPage.' + kind)
  const escaped = message.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  )
  return (
    '<!doctype html><html lang="' +
    locale +
    '"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Maestrly</title><body><p>' +
    escaped +
    '</p></body></html>'
  )
}
/** Starts a sign-in on an environment's Maestrly (shared by its bots) or a bot's; a bare string is a bot id. */
export async function startBotLogin(
  fleet: FleetClientService,
  rawTarget: FleetProvisioningTargetInput,
  request: FleetLoginStartRequest
): Promise<{ attempt: FleetLoginAttempt; relay: 'listening' | 'unavailable' | 'none' }> {
  const target = resolveProvisioningTarget(fleet, rawTarget)
  const body = fleetLoginStartRequestSchema.parse(request)
  const epoch = generation
  let release = (): void => {}
  if (body.kind === 'codex' && body.method === 'browser') {
    const previous = codexQueue
    codexQueue = new Promise<void>((resolve) => {
      release = () => {
        reservations.delete(release)
        resolve()
      }
      reservations.add(release)
    })
    await previous
  }
  let attempt: FleetLoginAttempt | undefined
  let relay: LoginRelay | null = null
  let registered: ActiveLogin | undefined
  const cancelAttempt = (loginId: string) => {
    const route = provisioningRoute(target, 'loginCancel', { lid: loginId })
    return fleet.call(route.key, { params: route.params })
  }
  try {
    if (epoch !== generation) throw macProvisioningError('login-cancelled', 'Sign-in was cancelled.')
    const start = provisioningRoute(target, 'loginStart')
    attempt = fleetLoginAttemptSchema.parse(await fleet.call(start.key, { params: start.params, body }))
    validate(attempt)
    if (attempt.kind !== body.kind) throw macProvisioningError('login-unexpected-page', unexpected)
    if (epoch !== generation) throw macProvisioningError('login-cancelled', 'Sign-in was cancelled.')
    let relayState: 'listening' | 'unavailable' | 'none' = 'none'
    if (attempt.browser) {
      const { callback } = attempt.browser
      const kind = attempt.kind
      const forwardRoute = provisioningRoute(target, 'loginCallback', { lid: attempt.loginId })
      try {
        relay = await LoginRelay.start({
          ...callback,
          ttlMs: Math.min(
            FLEET_PROVISIONING_LIMITS.loginTtlMs,
            Math.max(0, Date.parse(attempt.expiresAt) - Date.now())
          ),
          forward: async (query) =>
            fleetLoginCallbackResponseSchema.parse(
              await fleet.call(forwardRoute.key, {
                params: forwardRoute.params,
                body: fleetLoginCallbackRequestSchema.parse({ path: callback.path, query }),
              })
            ),
          page: relayPage,
          redirectAllowed: (url) => fleetLoginUrlAllowed(kind, url),
        })
        relayState = 'listening'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
        if (attempt.kind === 'codex') {
          await cancelAttempt(attempt.loginId)
          attempt = undefined
          release()
          if (epoch !== generation) throw macProvisioningError('login-cancelled', 'Sign-in was cancelled.')
          return await startBotLogin(fleet, target, { ...body, method: 'device' })
        }
        relayState = 'unavailable'
      }
    }
    if (epoch !== generation) throw macProvisioningError('login-cancelled', 'Sign-in was cancelled.')
    const current = attempt
    const timer = setTimeout(
      () => {
        if (registered) void finish(registered)
      },
      Math.min(FLEET_PROVISIONING_LIMITS.loginTtlMs, Math.max(0, Date.parse(current.expiresAt) - Date.now()))
    )
    timer.unref()
    registered = { fleet, target: fleetTargetKey(target), loginId: current.loginId, relay, timer, release }
    active.add(registered)
    const url = current.browser?.authUrl ?? current.device?.verificationUrl
    if (url) await shell.openExternal(url)
    return { attempt: current, relay: relayState }
  } catch (error) {
    if (registered) await finish(registered)
    else {
      await relay?.close()
      release()
    }
    if (attempt) await cancelAttempt(attempt.loginId).catch(() => {})
    throw error
  }
}
export async function botLoginStatus(
  fleet: FleetClientService,
  rawTarget: FleetProvisioningTargetInput,
  loginId: string
): Promise<FleetLoginAttempt> {
  const target = resolveProvisioningTarget(fleet, rawTarget)
  const route = provisioningRoute(target, 'loginGet', { lid: loginId })
  const attempt = fleetLoginAttemptSchema.parse(await fleet.call(route.key, { params: route.params }))
  if (attempt.state !== 'pending') await closeAttempt(fleet, fleetTargetKey(target), loginId)
  return attempt
}
export async function submitBotLoginCode(
  fleet: FleetClientService,
  rawTarget: FleetProvisioningTargetInput,
  loginId: string,
  code: string
): Promise<FleetLoginAttempt> {
  const target = resolveProvisioningTarget(fleet, rawTarget)
  const route = provisioningRoute(target, 'loginCode', { lid: loginId })
  const attempt = fleetLoginAttemptSchema.parse(
    await fleet.call(route.key, { params: route.params, body: fleetLoginCodeRequestSchema.parse({ code }) })
  )
  if (attempt.state !== 'pending') await closeAttempt(fleet, fleetTargetKey(target), loginId)
  return attempt
}
export async function cancelBotLogin(
  fleet: FleetClientService,
  rawTarget: FleetProvisioningTargetInput,
  loginId: string
): Promise<void> {
  const target = resolveProvisioningTarget(fleet, rawTarget)
  const attempts = attemptsOf(fleet, fleetTargetKey(target), loginId)
  await Promise.all(
    attempts.map(async (login) => {
      await login.relay?.close()
      login.relay = null
    })
  )
  try {
    const route = provisioningRoute(target, 'loginCancel', { lid: loginId })
    await fleet.call(route.key, { params: route.params })
  } finally {
    await Promise.all(attempts.map(finish))
  }
}
export async function reopenBotLogin(
  fleet: FleetClientService,
  rawTarget: FleetProvisioningTargetInput,
  loginId: string,
  page: 'auth' | 'device' | 'manual'
): Promise<void> {
  const attempt = await botLoginStatus(fleet, rawTarget, loginId)
  validate(attempt)
  const url =
    page === 'auth'
      ? attempt.browser?.authUrl
      : page === 'device'
        ? attempt.device?.verificationUrl
        : attempt.manual?.url
  if (!url) throw macProvisioningError('login-page-unavailable', 'This sign-in page is unavailable.')
  await shell.openExternal(url)
}
export async function disposeBotLogins(): Promise<void> {
  generation++
  const pending = [...reservations]
  codexQueue = Promise.resolve()
  await Promise.all([...active].map(finish))
  for (const release of pending) release()
}
