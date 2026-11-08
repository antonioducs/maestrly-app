import { createHash, randomBytes } from 'node:crypto'
import { McpOAuthConnectFailure, listenForCallback } from '../../chat/mcp-oauth-connect'

/** `drive.file` reaches only the files this app creates: the backups, never the rest of the owner's Drive. */
export const GOOGLE_DRIVE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'] as const
export type GoogleDriveClient = { clientId: string; clientSecret: string }
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

/**
 * The Google client this build signs in with: the build's own, or outside a packaged app the developer's. Desktop
 * clients' secrets are not confidential (Google's installed-app flow); the build ships them like the client id.
 */
export function resolveGoogleDriveClient(options: {
  buildClientId?: string
  buildClientSecret?: string
  developmentClientId?: string
  developmentClientSecret?: string
  packaged: boolean
}): GoogleDriveClient | null {
  const build = { clientId: options.buildClientId?.trim(), clientSecret: options.buildClientSecret?.trim() }
  if (build.clientId) return build.clientSecret ? { clientId: build.clientId, clientSecret: build.clientSecret } : null
  if (options.packaged) return null
  const clientId = options.developmentClientId?.trim()
  const clientSecret = options.developmentClientSecret?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}
/** The client of this build, from its build variables or, in development, the environment. */
export function configuredGoogleDriveClient(packaged: boolean): GoogleDriveClient | null {
  const buildEnv = import.meta.env as Record<string, string | undefined>
  return resolveGoogleDriveClient({
    buildClientId: buildEnv.MAIN_VITE_GOOGLE_DRIVE_CLIENT_ID,
    buildClientSecret: buildEnv.MAIN_VITE_GOOGLE_DRIVE_CLIENT_SECRET,
    developmentClientId: process.env.MAESTRLY_GOOGLE_DRIVE_CLIENT_ID,
    developmentClientSecret: process.env.MAESTRLY_GOOGLE_DRIVE_CLIENT_SECRET,
    packaged,
  })
}

export class DriveSignInFailure extends Error {
  constructor(
    readonly code: 'cancelled' | 'timeout' | 'denied' | 'failed',
    message?: string
  ) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'DriveSignInFailure'
  }
}

const base64url = (bytes: Buffer) => bytes.toString('base64url')
/** The account an ID token names, read without checking its signature: it came straight from Google over TLS. */
function emailOf(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      email?: unknown
    }
    return typeof payload.email === 'string' ? payload.email.slice(0, 320) : null
  } catch {
    return null
  }
}

/**
 * Signs in to Google Drive in the browser with PKCE, through a loopback listener on this computer, and exchanges the
 * code for tokens. Only a refresh token lets the server's backups keep reaching the Drive, so a sign-in without one
 * fails.
 */
export async function runGoogleDriveSignIn(options: {
  client: GoogleDriveClient
  openExternal: (url: string) => Promise<void>
  signal: AbortSignal
  timeoutMs?: number
  fetchFn?: typeof fetch
  now?: () => number
}): Promise<{ accessToken: string; refreshToken: string; expiry: string; email: string | null }> {
  const fetchFn = options.fetchFn ?? fetch
  const now = options.now ?? Date.now
  if (options.signal.aborted) throw new DriveSignInFailure('cancelled')
  const state = base64url(randomBytes(24))
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const callback = await listenForCallback(state)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const url = new URL(AUTHORIZE_URL)
    url.search = new URLSearchParams({
      client_id: options.client.clientId,
      redirect_uri: callback.redirectUri,
      response_type: 'code',
      scope: GOOGLE_DRIVE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString()
    await options.openExternal(url.toString())
    const { code } = await Promise.race([
      callback.result.catch((error: unknown) => {
        if (error instanceof McpOAuthConnectFailure && error.code === 'denied') throw new DriveSignInFailure('denied')
        throw new DriveSignInFailure('failed', error instanceof Error ? error.message : undefined)
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DriveSignInFailure('timeout')), options.timeoutMs ?? SIGN_IN_TIMEOUT_MS)
      }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DriveSignInFailure('cancelled'))
        if (options.signal.aborted) onAbort()
        else options.signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    let response: Response
    try {
      response = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: options.client.clientId,
          client_secret: options.client.clientSecret,
          redirect_uri: callback.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }).toString(),
        signal: options.signal,
      })
    } catch {
      throw new DriveSignInFailure(options.signal.aborted ? 'cancelled' : 'failed', 'token request failed')
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok || !body) throw new DriveSignInFailure('failed', `token request answered ${response.status}`)
    const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = body
    if (typeof accessToken !== 'string' || !accessToken || typeof expiresIn !== 'number')
      throw new DriveSignInFailure('failed', 'no access token')
    if (typeof refreshToken !== 'string' || !refreshToken) throw new DriveSignInFailure('failed', 'no refresh token')
    return {
      accessToken,
      refreshToken,
      expiry: new Date(now() + expiresIn * 1000).toISOString(),
      email: emailOf(body.id_token),
    }
  } finally {
    clearTimeout(timer)
    if (onAbort) options.signal.removeEventListener('abort', onAbort)
    callback.close()
  }
}
