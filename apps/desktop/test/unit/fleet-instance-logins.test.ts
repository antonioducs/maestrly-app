import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FleetLoginStartRequest } from '@maestrly/bot-fleet-protocol'
import type { CodexSubscriptionLoginAttempt } from '../../src/main/chat/codex-subscription/manager'
import type { GrokLoginAttempt, GrokLoginCompletion } from '../../src/main/chat/grok-subscription/manager'
import type { ClaudeSubscriptionLoginResult } from '../../src/main/chat/claude-agent-sdk/manager'
import { RemoteLogins, type RemoteLoginDeps } from '../../src/main/fleet/instance/provisioning/logins'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const codexUrl =
  'https://auth.openai.com/authorize?redirect_uri=' + encodeURIComponent('http://localhost:1455/auth/callback')
const claudeUrl =
  'https://claude.ai/oauth/authorize?redirect_uri=' + encodeURIComponent('http://localhost:4321/callback')
function fixture() {
  const completion = deferred<{ loginId: string; success: boolean; error: string | null }>()
  const claudeDone = deferred<ClaudeSubscriptionLoginResult>()
  const grokCompletion = deferred<GrokLoginCompletion>()
  const codex = {
    startLogin: vi.fn(
      async ({ method }: { method: 'browser' | 'device' }): Promise<CodexSubscriptionLoginAttempt> => ({
        loginId: 'provider-login',
        method,
        authUrl: method === 'browser' ? codexUrl : null,
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'SYNTHETIC',
        state: 'pending' as const,
        completion: null,
      })
    ),
    waitForLogin: vi.fn(() => completion.promise),
    cancelLogin: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({
      account: { type: 'chatgpt' as const, email: 'synthetic@example.test', planType: 'plus' },
    })),
  }
  const interactive = {
    autoUrl: claudeUrl,
    manualUrl: 'https://claude.ai/oauth/manual',
    submitCode: vi.fn(),
    cancel: vi.fn(),
    done: claudeDone.promise,
  }
  const grok = {
    startLogin: vi.fn(
      async (): Promise<GrokLoginAttempt> => ({
        loginId: 'grok-login',
        method: 'device',
        authUrl: null,
        expiresAt: null,
        state: 'pending',
        completion: null,
        verificationUri: 'https://accounts.x.ai/device',
        verificationUriComplete: 'https://accounts.x.ai/device?code=SYNTHETIC',
        userCode: 'SYNTHETIC',
      })
    ),
    waitForLogin: vi.fn(() => grokCompletion.promise),
    cancelLogin: vi.fn(() => true),
    getStatus: vi.fn(async () => ({ account: { email: 'synthetic@example.test', planType: 'pro', name: null } })),
  }
  const deps = {
    now: () => Date.now(),
    onChanged: vi.fn(),
    isConnected: vi.fn(() => false),
    createSlot: vi.fn(() => 'acc_created'),
    renameSlot: vi.fn(),
    removeSlot: vi.fn(async () => {}),
    slotExists: vi.fn(() => false),
    codex: () => codex,
    claude: () => ({ startInteractiveLogin: vi.fn(async () => interactive) }),
    grok: () => grok,
    forward: vi.fn(async () => ({ status: 200, location: null, contentType: 'text/html', body: 'done' })),
  }
  const logins = new RemoteLogins(deps satisfies RemoteLoginDeps)
  instances.push(logins)
  return { logins, deps, codex, grok, completion, grokCompletion, interactive, claudeDone }
}
const instances: RemoteLogins[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  await Promise.all(instances.splice(0).map((logins) => logins.dispose()))
  vi.useRealTimers()
})
const start: FleetLoginStartRequest = { kind: 'codex', method: 'browser', slot: 'auto' }
it('forwards a Codex callback, observes completion and stops reporting signing in', async () => {
  const f = fixture()
  const attempt = await f.logins.start(start)
  expect(attempt.browser?.callback).toEqual({ port: 1455, path: '/auth/callback' })
  expect(f.logins.signingIn()).toEqual([{ kind: 'codex', accountId: null }])
  await f.logins.callback(attempt.loginId, { path: '/auth/callback', query: 'code=a&state=b' })
  expect(f.deps.forward).toHaveBeenCalledWith({ port: 1455, path: '/auth/callback' }, 'code=a&state=b')
  f.completion.resolve({ loginId: 'provider-login', success: true, error: null })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.logins.get(attempt.loginId)).toMatchObject({
    state: 'completed',
    account: { email: 'synthetic@example.test', plan: 'plus' },
  })
  expect(f.deps.onChanged).toHaveBeenCalled()
  expect(f.logins.signingIn()).toEqual([])
})
it('creates an auto slot for device login and removes it on a failed completion', async () => {
  const f = fixture()
  f.deps.isConnected.mockReturnValue(true)
  const attempt = await f.logins.start({ ...start, method: 'device' })
  expect(attempt.accountId).toBe('acc_created')
  expect(attempt.device).toEqual({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'SYNTHETIC' })
  f.completion.resolve({ loginId: 'provider-login', success: false, error: 'x'.repeat(400) })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.logins.get(attempt.loginId)).toMatchObject({ state: 'failed', error: 'x'.repeat(300) })
  expect(f.deps.removeSlot).toHaveBeenCalledWith('acc_created')
})
it('exposes Claude automatic and manual URLs, submits codes and completes from done', async () => {
  const f = fixture()
  const attempt = await f.logins.start({ kind: 'claude', method: 'browser', slot: 'default' })
  expect(attempt.browser?.callback).toEqual({ port: 4321, path: '/callback' })
  expect(attempt.manual?.url).toBe(f.interactive.manualUrl)
  await f.logins.submitCode(attempt.loginId, 'synthetic-code')
  expect(f.interactive.submitCode).toHaveBeenCalledWith('synthetic-code')
  f.claudeDone.resolve({
    ok: true,
    status: {
      state: 'ready',
      available: true,
      authenticated: true,
      accountFingerprint: null,
      accountEpoch: 0,
      cliVersion: null,
      sdkVersion: 'test',
      error: null,
      account: {
        email: 'synthetic@example.test',
        subscriptionType: 'pro',
        organizationId: null,
        organizationName: null,
        authMethod: null,
        apiProvider: null,
      },
    },
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.logins.get(attempt.loginId)).toMatchObject({ state: 'completed', account: { plan: 'pro' } })
})
it('uses the complete Grok verification URI', async () => {
  const f = fixture()
  const attempt = await f.logins.start({ kind: 'grok', method: 'device', slot: 'default' })
  expect(attempt.device?.verificationUrl).toBe('https://accounts.x.ai/device?code=SYNTHETIC')
})
it('reserves pending kinds before provider startup and refuses a fourth pending login', async () => {
  const f = fixture()
  const first = f.logins.start(start)
  await expect(f.logins.start(start)).rejects.toMatchObject({ status: 409 })
  await first
  await f.logins.start({ kind: 'claude', method: 'browser', slot: 'default' })
  await f.logins.start({ kind: 'grok', method: 'device', slot: 'default' })
  await expect(f.logins.start(start)).rejects.toMatchObject({ status: 409 })
})
it('cancels an unexpected provider URL and removes its created slot', async () => {
  const f = fixture()
  f.deps.isConnected.mockReturnValue(true)
  f.codex.startLogin.mockImplementation(
    async ({ method }) =>
      ({
        loginId: 'provider-login',
        method,
        authUrl: 'https://evil.example/authorize',
        verificationUrl: 'https://auth.openai.com/device',
        userCode: 'SYNTHETIC',
        state: 'pending',
        completion: null,
      }) as Awaited<ReturnType<typeof f.codex.startLogin>>
  )
  await expect(f.logins.start(start)).rejects.toMatchObject({ status: 502 })
  expect(f.codex.cancelLogin).toHaveBeenCalledWith('provider-login')
  expect(f.deps.removeSlot).toHaveBeenCalledWith('acc_created')
})
it('expires after fifteen minutes, cancels, cleans slots and retains polling for ten minutes', async () => {
  const f = fixture()
  f.deps.isConnected.mockReturnValue(true)
  const attempt = await f.logins.start(start)
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  expect(f.codex.cancelLogin).toHaveBeenCalledWith('provider-login')
  expect(f.logins.get(attempt.loginId).state).toBe('expired')
  expect(f.deps.removeSlot).toHaveBeenCalledWith('acc_created')
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(() => f.logins.get(attempt.loginId)).toThrow('does not exist')
})
it('rejects mismatched callbacks, device callbacks and codes for other providers', async () => {
  const f = fixture()
  const attempt = await f.logins.start(start)
  await expect(f.logins.callback(attempt.loginId, { path: '/wrong', query: 'code=a' })).rejects.toMatchObject({
    status: 409,
  })
  await expect(f.logins.submitCode(attempt.loginId, 'code')).rejects.toMatchObject({ status: 409 })
  await f.logins.cancel(attempt.loginId)
  expect(f.logins.get(attempt.loginId).state).toBe('cancelled')
  const device = await f.logins.start({ ...start, method: 'device' })
  await expect(f.logins.callback(device.loginId, { path: '/auth/callback', query: 'code=a' })).rejects.toMatchObject({
    status: 409,
  })
})
it('validates explicit slots and renames successfully created slots from account email', async () => {
  const f = fixture()
  await expect(f.logins.start({ ...start, slot: 'acc_missing' })).rejects.toMatchObject({ status: 404 })
  f.deps.isConnected.mockReturnValue(true)
  const attempt = await f.logins.start(start)
  f.completion.resolve({ loginId: 'provider-login', success: true, error: null })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.deps.renameSlot).toHaveBeenCalledWith('acc_created', 'Codex (synthetic@example.test)')
  expect(f.logins.get(attempt.loginId).state).toBe('completed')
})
it('ignores late success after cancellation and clears timers on disposal', async () => {
  const f = fixture()
  f.deps.isConnected.mockReturnValue(true)
  const attempt = await f.logins.start(start)
  await f.logins.cancel(attempt.loginId)
  f.completion.resolve({ loginId: 'provider-login', success: true, error: null })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.logins.get(attempt.loginId).state).toBe('cancelled')
  expect(f.deps.removeSlot).toHaveBeenCalledOnce()
  await f.logins.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the provider reserved until cancellation releases its helper', async () => {
  const f = fixture()
  const cancelled = deferred<void>()
  f.codex.cancelLogin.mockImplementation(() => cancelled.promise)
  const attempt = await f.logins.start(start)
  const cancellation = f.logins.cancel(attempt.loginId)
  await expect(f.logins.start(start)).rejects.toMatchObject({ status: 409 })
  cancelled.resolve()
  await cancellation
  expect((await f.logins.start(start)).state).toBe('pending')
})
it('cancels both unexpected Claude URLs and disallowed device URLs', async () => {
  const f = fixture()
  f.interactive.manualUrl = 'https://evil.example/manual'
  await expect(f.logins.start({ kind: 'claude', method: 'browser', slot: 'auto' })).rejects.toMatchObject({
    status: 502,
  })
  expect(f.interactive.cancel).toHaveBeenCalledOnce()
  f.codex.startLogin.mockImplementation(async ({ method }) => ({
    loginId: 'bad-device',
    method,
    authUrl: null,
    verificationUrl: 'https://evil.example/device',
    userCode: 'SYNTHETIC',
    state: 'pending',
    completion: null,
  }))
  await expect(f.logins.start({ ...start, method: 'device' })).rejects.toMatchObject({ status: 502 })
  expect(f.codex.cancelLogin).toHaveBeenCalledWith('bad-device')
})
it('preserves an existing explicit slot when cancelled and does not create another', async () => {
  const f = fixture()
  f.deps.slotExists.mockReturnValue(true)
  const attempt = await f.logins.start({ ...start, slot: 'acc_existing' })
  expect(attempt.accountId).toBe('acc_existing')
  await f.logins.cancel(attempt.loginId)
  expect(f.deps.createSlot).not.toHaveBeenCalled()
  expect(f.deps.removeSlot).not.toHaveBeenCalled()
})

it.each(
  (['codex', 'grok'] as const).flatMap((kind) =>
    (['cancel', 'expiry', 'dispose', 'reject'] as const).map((action) => ({ kind, action }))
  )
)('preserves successful $kind sign-ins after $action during metadata lookup', async ({ kind, action }) => {
  const f = fixture()
  f.deps.isConnected.mockReturnValue(true)
  let reject!: (error: Error) => void
  const pending = new Promise<never>((_, no) => {
    reject = no
  })
  f[kind].getStatus.mockImplementation(() => pending)
  const attempt = await f.logins.start({ kind, method: 'device', slot: 'auto' })
  if (kind === 'codex') f.completion.resolve({ loginId: 'provider-login', success: true, error: null })
  else f.grokCompletion.resolve({ loginId: 'grok-login', success: true, error: null })
  await vi.advanceTimersByTimeAsync(0)
  expect(f[kind].getStatus).toHaveBeenCalledOnce()
  if (action === 'cancel') await f.logins.cancel(attempt.loginId)
  if (action === 'expiry') await vi.advanceTimersByTimeAsync(15 * 60_000)
  if (action === 'dispose') await f.logins.dispose()
  reject(new Error('Metadata unavailable'))
  await vi.advanceTimersByTimeAsync(0)
  if (action !== 'dispose')
    expect(f.logins.get(attempt.loginId)).toMatchObject({
      state: 'completed',
      account: { email: null, plan: null },
      error: null,
    })
  expect(f.deps.removeSlot).not.toHaveBeenCalled()
  expect(f[kind].cancelLogin).not.toHaveBeenCalled()
  await f.logins.dispose()
})
