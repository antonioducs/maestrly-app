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
import { getMainLocale, tFor } from '../../../i18n'
import { LoginRelay } from './login-relay'

type ActiveLogin = {
  fleet: FleetClientService
  botId: string
  loginId: string
  relay: LoginRelay | null
  timer: ReturnType<typeof setTimeout>
  release: () => void
}
const active = new Set<ActiveLogin>()
const reservations = new Set<() => void>()
let codexQueue = Promise.resolve()
let generation = 0
const unexpected = 'The bot returned a sign-in page that is not from the provider.'
function validate(attempt: FleetLoginAttempt): void {
  const urls = [attempt.browser?.authUrl, attempt.device?.verificationUrl, attempt.manual?.url]
  if (urls.some((url) => url && !fleetLoginUrlAllowed(attempt.kind, url))) throw new Error(unexpected)
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
      throw new Error(unexpected)
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
async function closeAttempt(fleet: FleetClientService, botId: string, loginId: string): Promise<void> {
  await Promise.all(
    [...active]
      .filter((login) => login.fleet === fleet && login.botId === botId && login.loginId === loginId)
      .map(finish)
  )
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
export async function startBotLogin(
  fleet: FleetClientService,
  botId: string,
  request: FleetLoginStartRequest
): Promise<{ attempt: FleetLoginAttempt; relay: 'listening' | 'unavailable' | 'none' }> {
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
  const params = { id: botId }
  try {
    if (epoch !== generation) throw new Error('Sign-in was cancelled.')
    attempt = fleetLoginAttemptSchema.parse(await fleet.call('botLoginStart', { params, body }))
    validate(attempt)
    if (attempt.kind !== body.kind) throw new Error(unexpected)
    if (epoch !== generation) throw new Error('Sign-in was cancelled.')
    let relayState: 'listening' | 'unavailable' | 'none' = 'none'
    if (attempt.browser) {
      const { callback } = attempt.browser
      const loginId = attempt.loginId
      try {
        relay = await LoginRelay.start({
          ...callback,
          ttlMs: Math.min(
            FLEET_PROVISIONING_LIMITS.loginTtlMs,
            Math.max(0, Date.parse(attempt.expiresAt) - Date.now())
          ),
          forward: async (query) =>
            fleetLoginCallbackResponseSchema.parse(
              await fleet.call('botLoginCallback', {
                params: { ...params, lid: loginId },
                body: fleetLoginCallbackRequestSchema.parse({ path: callback.path, query }),
              })
            ),
          page: relayPage,
        })
        relayState = 'listening'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
        if (attempt.kind === 'codex') {
          await fleet.call('botLoginCancel', { params: { ...params, lid: attempt.loginId } })
          attempt = undefined
          release()
          if (epoch !== generation) throw new Error('Sign-in was cancelled.')
          return await startBotLogin(fleet, botId, { ...body, method: 'device' })
        }
        relayState = 'unavailable'
      }
    }
    if (epoch !== generation) throw new Error('Sign-in was cancelled.')
    const current = attempt
    const timer = setTimeout(
      () => {
        if (registered) void finish(registered)
      },
      Math.min(FLEET_PROVISIONING_LIMITS.loginTtlMs, Math.max(0, Date.parse(current.expiresAt) - Date.now()))
    )
    timer.unref()
    registered = { fleet, botId, loginId: current.loginId, relay, timer, release }
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
    if (attempt) await fleet.call('botLoginCancel', { params: { ...params, lid: attempt.loginId } }).catch(() => {})
    throw error
  }
}
export async function botLoginStatus(
  fleet: FleetClientService,
  botId: string,
  loginId: string
): Promise<FleetLoginAttempt> {
  const attempt = fleetLoginAttemptSchema.parse(
    await fleet.call('botLoginGet', { params: { id: botId, lid: loginId } })
  )
  if (attempt.state !== 'pending') await closeAttempt(fleet, botId, loginId)
  return attempt
}
export async function submitBotLoginCode(
  fleet: FleetClientService,
  botId: string,
  loginId: string,
  code: string
): Promise<FleetLoginAttempt> {
  const attempt = fleetLoginAttemptSchema.parse(
    await fleet.call('botLoginCode', {
      params: { id: botId, lid: loginId },
      body: fleetLoginCodeRequestSchema.parse({ code }),
    })
  )
  if (attempt.state !== 'pending') await closeAttempt(fleet, botId, loginId)
  return attempt
}
export async function cancelBotLogin(fleet: FleetClientService, botId: string, loginId: string): Promise<void> {
  const attempts = [...active].filter(
    (login) => login.fleet === fleet && login.botId === botId && login.loginId === loginId
  )
  await Promise.all(
    attempts.map(async (login) => {
      await login.relay?.close()
      login.relay = null
    })
  )
  try {
    await fleet.call('botLoginCancel', { params: { id: botId, lid: loginId } })
  } finally {
    await Promise.all(attempts.map(finish))
  }
}
export async function reopenBotLogin(
  fleet: FleetClientService,
  botId: string,
  loginId: string,
  target: 'auth' | 'device' | 'manual'
): Promise<void> {
  const attempt = await botLoginStatus(fleet, botId, loginId)
  validate(attempt)
  const url =
    target === 'auth'
      ? attempt.browser?.authUrl
      : target === 'device'
        ? attempt.device?.verificationUrl
        : attempt.manual?.url
  if (!url) throw new Error('This sign-in page is unavailable.')
  await shell.openExternal(url)
}
export async function disposeBotLogins(): Promise<void> {
  generation++
  const pending = [...reservations]
  codexQueue = Promise.resolve()
  await Promise.all([...active].map(finish))
  for (const release of pending) release()
}
