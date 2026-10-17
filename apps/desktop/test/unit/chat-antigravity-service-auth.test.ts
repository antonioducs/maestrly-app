import { describe, expect, it, vi } from 'vitest'
import type { ChatSubscriptionAuthStatus } from '../../src/shared/chat'
import type { AntigravitySubscriptionManager } from '../../src/main/chat/antigravity-subscription/manager'
import { AntigravityServiceAuth } from '../../src/main/chat/antigravity-subscription/service-auth'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A32123%2F'

/** A sign-in that reports Google's page, then waits until the test finishes or cancels it. */
function pendingSignIn() {
  let finish!: (ok: boolean) => void
  const done = new Promise<boolean>((resolve) => {
    finish = resolve
  })
  let signedIn = false
  const login = vi.fn(async (signal?: AbortSignal, onBrowserUrl?: (url: string) => void) => {
    onBrowserUrl?.(AUTH_URL)
    const aborted = new Promise<boolean>((resolve) => signal?.addEventListener('abort', () => resolve(false)))
    signedIn = await Promise.race([done, aborted])
    return signedIn
      ? { ok: true, status: { state: 'signed-in', authenticated: true } as ChatSubscriptionAuthStatus }
      : { ok: false, error: 'Google sign-in was cancelled.' }
  })
  const manager = {
    login,
    cancelLogin: vi.fn(),
    logout: vi.fn(async () => undefined),
    getStatus: (): ChatSubscriptionAuthStatus =>
      signedIn ? { state: 'signed-in', authenticated: true } : { state: 'signed-out', authenticated: false },
    onAuthChanged: () => () => undefined,
  } as unknown as AntigravitySubscriptionManager
  return { manager, login, finish }
}

function setup(platform: NodeJS.Platform) {
  const sign = pendingSignIn()
  const broadcasts: ChatSubscriptionAuthStatus[] = []
  const openBrowser = vi.fn()
  const auth = new AntigravityServiceAuth({
    reset: async () => undefined,
    ensureRuntime: async () => undefined,
    broadcast: (status) => broadcasts.push(status),
    openBrowser,
    manager: () => sign.manager,
    platform,
  })
  return { auth, sign, broadcasts, openBrowser }
}

describe('Google AI sign-in browser', () => {
  it("opens the captured page in the user's browser and offers it for copying until sign-in ends", async () => {
    const { auth, sign, broadcasts, openBrowser } = setup('linux')
    expect(auth.login()).toEqual({ ok: true, status: { state: 'signing-in', authenticated: false } })
    await expect.poll(() => openBrowser.mock.calls.length).toBe(1)
    expect(openBrowser).toHaveBeenCalledWith(AUTH_URL)
    expect(sign.login).toHaveBeenCalledWith(expect.any(AbortSignal), expect.any(Function))
    expect(auth.status()).toEqual({ state: 'signing-in', authenticated: false, authUrl: AUTH_URL })
    expect(broadcasts.at(-1)).toEqual({ state: 'signing-in', authenticated: false, authUrl: AUTH_URL })
    sign.finish(true)
    await expect.poll(() => auth.busy(null)).toBe(false)
    expect(auth.status()).toEqual({ state: 'signed-in', authenticated: true })
    expect(broadcasts.at(-1)).toEqual({ state: 'signed-in', authenticated: true })
  })

  it('forgets the page when the sign-in is cancelled', async () => {
    const { auth, sign, broadcasts } = setup('darwin')
    auth.login('acc_2')
    await expect.poll(() => auth.status('acc_2').authUrl).toBe(AUTH_URL)
    expect(broadcasts.at(-1)).toMatchObject({ accountId: 'acc_2', authUrl: AUTH_URL })
    sign.manager.cancelLogin = () => sign.finish(false)
    await auth.logout('acc_2')
    expect(auth.status('acc_2')).toEqual({ state: 'signed-out', authenticated: false })
    expect(broadcasts.at(-1)).not.toHaveProperty('authUrl')
  })

  it('leaves Windows to the server, which opens the default browser itself', async () => {
    const { auth, sign, openBrowser } = setup('win32')
    auth.login()
    await expect.poll(() => sign.login.mock.calls.length).toBe(1)
    expect(sign.login.mock.calls[0]?.[1]).toBeUndefined()
    expect(openBrowser).not.toHaveBeenCalled()
    sign.finish(true)
    await expect.poll(() => auth.busy(null)).toBe(false)
  })
})
