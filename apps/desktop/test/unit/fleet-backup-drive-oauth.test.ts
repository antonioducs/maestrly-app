import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DriveSignInFailure,
  resolveGoogleDriveClient,
  runGoogleDriveSignIn,
} from '../../src/main/fleet/client/backup-drive-oauth'

const client = { clientId: 'synthetic-client.apps.googleusercontent.com', clientSecret: 'synthetic-secret' }
const idToken = (payload: object) =>
  ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.')

/** A browser that follows the authorization URL to the loopback listener with `answer` as its query. */
function browser(answer: (state: string) => string) {
  const opened: URL[] = []
  return {
    opened,
    openExternal: async (href: string) => {
      const url = new URL(href)
      opened.push(url)
      const redirect = url.searchParams.get('redirect_uri')!
      // The page answers while the sign-in still waits for it, as a browser would.
      setTimeout(() => void fetch(redirect + '?' + answer(url.searchParams.get('state')!)).catch(() => {}), 10)
    },
  }
}
function tokenEndpoint(body: Record<string, unknown>, status = 200) {
  const requests: Array<{ url: string; form: URLSearchParams }> = []
  const fetchFn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), form: new URLSearchParams(String(init.body)) })
    return Response.json(body, { status })
  }) as typeof fetch
  return { fetchFn, requests }
}

describe('Google Drive sign-in', () => {
  it('signs in with PKCE and keeps a refresh token and the account', async () => {
    const page = browser((state) => `code=abc&state=${state}`)
    const token = tokenEndpoint({
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      expires_in: 3600,
      id_token: idToken({ email: 'owner@example.com' }),
    })
    const result = await runGoogleDriveSignIn({
      client,
      openExternal: page.openExternal,
      signal: new AbortController().signal,
      fetchFn: token.fetchFn,
      now: () => Date.parse('2026-11-07T03:00:00.000Z'),
    })
    expect(result).toEqual({
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      expiry: '2026-11-07T04:00:00.000Z',
      email: 'owner@example.com',
    })
    const [url] = page.opened
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/drive.file')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const [exchange] = token.requests
    expect(exchange.url).toBe('https://oauth2.googleapis.com/token')
    expect(exchange.form.get('code')).toBe('abc')
    expect(exchange.form.get('grant_type')).toBe('authorization_code')
    expect(exchange.form.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'))
    const verifier = exchange.form.get('code_verifier')!
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'))
  })

  it('tells a refused sign-in', async () => {
    const page = browser((state) => `error=access_denied&state=${state}`)
    await expect(
      runGoogleDriveSignIn({ client, openExternal: page.openExternal, signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: 'denied' })
  })

  it('stops when cancelled or when the browser never answers', async () => {
    const controller = new AbortController()
    const cancelled = runGoogleDriveSignIn({
      client,
      openExternal: async () => void setTimeout(() => controller.abort(), 10),
      signal: controller.signal,
    })
    await expect(cancelled).rejects.toBeInstanceOf(DriveSignInFailure)
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    await expect(
      runGoogleDriveSignIn({
        client,
        openExternal: async () => {},
        signal: new AbortController().signal,
        timeoutMs: 20,
      })
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('fails without a refresh token', async () => {
    const page = browser((state) => `code=abc&state=${state}`)
    const token = tokenEndpoint({ access_token: 'synthetic-access', expires_in: 3600 })
    await expect(
      runGoogleDriveSignIn({
        client,
        openExternal: page.openExternal,
        signal: new AbortController().signal,
        fetchFn: token.fetchFn,
      })
    ).rejects.toMatchObject({ code: 'failed' })
  })

  it("uses the build's client, and the developer's only outside a packaged app", () => {
    const development = { developmentClientId: 'dev-id', developmentClientSecret: 'dev-secret' }
    expect(
      resolveGoogleDriveClient({
        buildClientId: 'build-id',
        buildClientSecret: 'build-secret',
        ...development,
        packaged: false,
      })
    ).toEqual({ clientId: 'build-id', clientSecret: 'build-secret' })
    expect(resolveGoogleDriveClient({ ...development, packaged: false })).toEqual({
      clientId: 'dev-id',
      clientSecret: 'dev-secret',
    })
    expect(resolveGoogleDriveClient({ ...development, packaged: true })).toBeNull()
    expect(resolveGoogleDriveClient({ buildClientId: 'build-id', packaged: true })).toBeNull()
    expect(resolveGoogleDriveClient({ developmentClientId: 'dev-id', packaged: false })).toBeNull()
  })
})
