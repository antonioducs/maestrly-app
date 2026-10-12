import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { type McpOAuthBundle, type McpOAuthDescriptor, mcpOAuthClientMetadata } from './mcp-oauth'

/** Why a sign-in did not finish. */
export type McpOAuthConnectError =
  | 'cancelled'
  | 'timeout'
  | 'denied'
  | 'registration-unsupported'
  | 'discovery-failed'
  | 'failed'

export class McpOAuthConnectFailure extends Error {
  constructor(
    readonly code: McpOAuthConnectError,
    detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'McpOAuthConnectFailure'
  }
}

export const MCP_OAUTH_CONNECT_TIMEOUT_MS = 5 * 60_000

const CALLBACK_PAGE = (title: string) =>
  `<!doctype html><meta charset="utf-8"><title>Maestrly</title><body style="font:15px system-ui;padding:3rem;color:#ddd;background:#111"><h1 style="font-size:18px">${title}</h1><p>You can close this tab and return to Maestrly.</p></body>`

interface Callback {
  code: string
}

/**
 * A loopback listener on 127.0.0.1 with a random port for one authorization response. It accepts only `GET /callback`
 * with the expected `state`; anything else gets 404 and is ignored.
 */
async function listenForCallback(state: string): Promise<{
  redirectUri: string
  result: Promise<Callback>
  close: () => void
}> {
  let settle!: { resolve: (value: Callback) => void; reject: (error: Error) => void }
  const result = new Promise<Callback>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // The browser can answer while the SDK is still opening it, before anyone awaits `result`.
  result.catch(() => undefined)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
      res.writeHead(404).end()
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    if (error || !code) {
      res.end(CALLBACK_PAGE('Sign-in was not completed.'))
      settle.reject(new McpOAuthConnectFailure(error === 'access_denied' ? 'denied' : 'failed', error ?? 'no code'))
    } else {
      res.end(CALLBACK_PAGE('Signed in.'))
      settle.resolve({ code })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    result,
    close: () => {
      server.close()
      server.closeAllConnections?.()
    },
  }
}

/**
 * The authorization endpoint comes from the server's own metadata, so only web URLs reach the browser: HTTPS, or plain
 * HTTP on this computer's loopback (local development servers). Never `file:`, custom schemes or other hosts over HTTP.
 */
export function browserSafeUrl(url: URL): boolean {
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(url.hostname)
}

function classify(error: unknown): McpOAuthConnectFailure {
  if (error instanceof McpOAuthConnectFailure) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/dynamic client registration|registration_endpoint|client information must be saveable/i.test(message))
    return new McpOAuthConnectFailure('registration-unsupported', message)
  if (/metadata|discover|well-known/i.test(message)) return new McpOAuthConnectFailure('discovery-failed', message)
  return new McpOAuthConnectFailure('failed', message)
}

/**
 * Signs in to one remote MCP server on this computer: discovery, dynamic client registration and PKCE through the SDK,
 * the browser for consent, and a loopback callback. Returns what the host stores; this computer keeps nothing.
 */
export async function runMcpOAuthConnect(opts: {
  descriptor: McpOAuthDescriptor
  openExternal: (url: string) => Promise<void>
  signal: AbortSignal
  timeoutMs?: number
  fetchFn?: FetchLike
}): Promise<McpOAuthBundle> {
  const { descriptor, signal } = opts
  if (signal.aborted) throw new McpOAuthConnectFailure('cancelled')
  const state = randomBytes(24).toString('base64url')
  const callback = await listenForCallback(state)
  let clientInformation: OAuthClientInformationMixed | undefined
  let tokens: OAuthTokens | undefined
  let verifier: string | undefined
  let discoveryState: OAuthDiscoveryState | undefined
  const provider: OAuthClientProvider = {
    redirectUrl: callback.redirectUri,
    clientMetadata: mcpOAuthClientMetadata(callback.redirectUri, descriptor.scopes),
    state: () => state,
    clientInformation: () => clientInformation,
    saveClientInformation: (value) => {
      clientInformation = value
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value
    },
    redirectToAuthorization: async (url) => {
      if (!browserSafeUrl(url)) throw new McpOAuthConnectFailure('discovery-failed', 'unsafe authorization URL')
      await opts.openExternal(url.toString())
    },
    saveCodeVerifier: (value) => {
      verifier = value
    },
    codeVerifier: () => {
      if (!verifier) throw new McpOAuthConnectFailure('failed', 'missing PKCE verifier')
      return verifier
    },
    discoveryState: () => discoveryState,
    saveDiscoveryState: (value) => {
      discoveryState = value
    },
    ...(descriptor.resource
      ? {
          // A plugin may name its resource indicator explicitly (Codex `oauth_resource`).
          validateResourceURL: async () => new URL(descriptor.resource!),
        }
      : {}),
  }
  const cleanups: Array<() => void> = [callback.close]
  try {
    const stopped = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new McpOAuthConnectFailure('timeout')),
        opts.timeoutMs ?? MCP_OAUTH_CONNECT_TIMEOUT_MS
      )
      const onAbort = () => reject(new McpOAuthConnectFailure('cancelled'))
      signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(
        () => clearTimeout(timer),
        () => signal.removeEventListener('abort', onAbort)
      )
    })
    stopped.catch(() => undefined)
    const scope = descriptor.scopes?.length ? descriptor.scopes.join(' ') : undefined
    const serverUrl = descriptor.url
    const first = await Promise.race([
      auth(provider, { serverUrl, ...(scope ? { scope } : {}), ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) }),
      stopped,
    ])
    if (first !== 'AUTHORIZED') {
      const { code } = await Promise.race([callback.result, stopped])
      const second = await Promise.race([
        auth(provider, {
          serverUrl,
          authorizationCode: code,
          ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
        }),
        stopped,
      ])
      if (second !== 'AUTHORIZED') throw new McpOAuthConnectFailure('failed', 'no tokens')
    }
    if (!clientInformation || !tokens) throw new McpOAuthConnectFailure('failed', 'no tokens')
    return {
      url: descriptor.url,
      redirectUri: callback.redirectUri,
      clientInformation,
      tokens,
      ...(discoveryState ? { discoveryState } : {}),
      ...(descriptor.scopes?.length ? { scopes: descriptor.scopes } : {}),
    }
  } catch (error) {
    throw classify(error)
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
}
