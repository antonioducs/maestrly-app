import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { z } from 'zod'
import { isSecureStorageAvailable, secureGet, secureRemove, secureSet } from '../secure-store'
import { getDb } from '../store/db'
import { McpNeedsAuthError } from './mcp-auth-errors'
import type { McpServer } from './mcp-types'

/**
 * OAuth sign-in of remote MCP servers (Streamable HTTP and legacy SSE), user and plugin servers alike.
 *
 * The host that runs a server keeps its sign-in encrypted under `chat.mcpOAuth.<serverId>`, apart from the server's
 * connection details, so that a token refresh never rewrites them. The interactive part (browser, loopback callback,
 * registration, PKCE) runs on the person's computer (`mcp-oauth-connect.ts`); the host receives only the result and
 * refreshes tokens itself. In the background, the provider here never registers a client and never opens a browser:
 * a server without a usable sign-in fails with `McpNeedsAuthError`.
 */

const KEY_PREFIX = 'chat.mcpOAuth.'
/** Stands in for a redirect URI before the first sign-in; never reached, because the background flow stops first. */
const UNSIGNED_REDIRECT = 'http://127.0.0.1/maestrly-mcp-oauth-callback'

export type McpOAuthStatus = 'none' | 'connected' | 'needs-auth'

/** Credential-free description of a server, enough for this computer to run the sign-in. */
export interface McpOAuthDescriptor {
  serverId: string
  name: string
  url: string
  scopes?: string[]
  resource?: string
}

/** What a finished sign-in hands to the host. */
export interface McpOAuthBundle {
  url: string
  redirectUri: string
  clientInformation: OAuthClientInformationMixed
  tokens: OAuthTokens
  discoveryState?: OAuthDiscoveryState
  scopes?: string[]
}

interface McpOAuthRecord extends McpOAuthBundle {
  v: 1
  savedAt: number
}

const jsonObject = z.record(z.string(), z.unknown())
/** Validates a bundle from another process: known fields typed, provider extras kept, size bounded by the caller. */
export const McpOAuthBundleSchema = z
  .object({
    url: z.string().url().max(4096),
    redirectUri: z
      .string()
      .max(200)
      .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}\/callback$/),
    clientInformation: jsonObject.and(z.object({ client_id: z.string().min(1).max(4096) })),
    tokens: jsonObject.and(
      z.object({
        access_token: z
          .string()
          .min(1)
          .max(64 * 1024),
        token_type: z.string().max(64),
      })
    ),
    discoveryState: jsonObject.optional(),
    scopes: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .strict()

export const MCP_OAUTH_BUNDLE_MAX_BYTES = 256 * 1024

const needsAuth = new Set<string>()
const listeners = new Set<(serverId: string) => void>()

/** Calls `listener` with a server id whenever its sign-in status changes; returns its removal. */
export function onMcpOAuthChanged(listener: (serverId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function changed(serverId: string): void {
  for (const listener of listeners) listener(serverId)
}

// Every request of a signed-in transport reads the record; keep decrypted records in memory. Only this module writes them.
const records = new Map<string, McpOAuthRecord | null>()

function readRecord(serverId: string): McpOAuthRecord | null {
  if (records.has(serverId)) return records.get(serverId) ?? null
  const raw = secureGet(KEY_PREFIX + serverId)
  let record: McpOAuthRecord | null = null
  if (raw) {
    try {
      const value = JSON.parse(raw) as McpOAuthRecord
      record = value?.v === 1 && value.tokens && value.clientInformation ? value : null
    } catch {
      record = null
    }
  }
  records.set(serverId, record)
  return record
}

function writeRecord(serverId: string, record: McpOAuthRecord): boolean {
  const ok = secureSet(KEY_PREFIX + serverId, JSON.stringify(record))
  if (ok) records.set(serverId, record)
  return ok
}

/** The stored sign-in of a server, if it was made for the server's current URL. */
function usableRecord(server: Pick<McpServer, 'id' | 'url'>): McpOAuthRecord | null {
  const record = readRecord(server.id)
  return record && server.url && record.url === server.url ? record : null
}

/** Stores a finished sign-in for `server`. False when secure storage is unavailable or the write fails. */
export function saveMcpOAuth(server: Pick<McpServer, 'id' | 'url'>, bundle: McpOAuthBundle): boolean {
  if (!isSecureStorageAvailable() || !server.url || bundle.url !== server.url) return false
  const ok = writeRecord(server.id, { ...bundle, v: 1, savedAt: Date.now() })
  if (ok) {
    needsAuth.delete(server.id)
    changed(server.id)
  }
  return ok
}

/** Drops a server's sign-in (sign-out, or the server was removed). */
export function forgetMcpOAuth(serverId: string): void {
  const had = readRecord(serverId) !== null || needsAuth.has(serverId)
  secureRemove(KEY_PREFIX + serverId)
  records.set(serverId, null)
  needsAuth.delete(serverId)
  if (had) changed(serverId)
}

/**
 * Sign-in status shown in Settings. `wantsOAuth` is true when the server is known to use OAuth before any request
 * (a plugin server that declares it); otherwise a server needs sign-in only once it answered 401.
 */
export function mcpOAuthStatus(
  server: Pick<McpServer, 'id' | 'url' | 'transport'>,
  wantsOAuth = false
): McpOAuthStatus {
  if (server.transport === 'stdio') return 'none'
  if (needsAuth.has(server.id)) return 'needs-auth'
  if (usableRecord(server)) return 'connected'
  return wantsOAuth ? 'needs-auth' : 'none'
}

/** Records that a server answered with a sign-in requirement this run; its status shows it until someone signs in. */
export function markMcpNeedsAuth(serverId: string): void {
  if (needsAuth.has(serverId)) return
  needsAuth.add(serverId)
  changed(serverId)
}

export function mcpOAuthClientMetadata(redirectUri: string, scopes?: string[]): OAuthClientMetadata {
  return {
    client_name: 'Maestrly',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
  }
}

/**
 * The provider a host's transports use in the background. It reads the stored sign-in on every call, saves refreshed
 * tokens, and stops with `McpNeedsAuthError` where an interactive step would start: it has no `saveClientInformation`,
 * so it can never register a client, and it never redirects.
 */
export function hostMcpOAuthProvider(server: McpServer): OAuthClientProvider {
  const stop = (): never => {
    markMcpNeedsAuth(server.id)
    throw new McpNeedsAuthError(server.id, server.name)
  }
  const update = (patch: (record: McpOAuthRecord) => McpOAuthRecord) => {
    const record = usableRecord(server)
    if (record) writeRecord(server.id, patch(record))
  }
  return {
    get redirectUrl() {
      return usableRecord(server)?.redirectUri ?? UNSIGNED_REDIRECT
    },
    get clientMetadata() {
      const record = usableRecord(server)
      return mcpOAuthClientMetadata(record?.redirectUri ?? UNSIGNED_REDIRECT, record?.scopes)
    },
    clientInformation: () => usableRecord(server)?.clientInformation ?? stop(),
    tokens: () => usableRecord(server)?.tokens,
    saveTokens: (tokens) => update((record) => ({ ...record, tokens, savedAt: Date.now() })),
    redirectToAuthorization: () => stop(),
    saveCodeVerifier: () => stop(),
    codeVerifier: () => stop(),
    discoveryState: () => usableRecord(server)?.discoveryState,
    saveDiscoveryState: (discoveryState) => update((record) => ({ ...record, discoveryState })),
    invalidateCredentials: (scope) => {
      if (scope === 'discovery') return update((record) => ({ ...record, discoveryState: undefined }))
      if (scope === 'verifier') return
      // Tokens or the client were rejected: the sign-in is no longer usable; a new one is needed.
      forgetMcpOAuth(server.id)
      markMcpNeedsAuth(server.id)
    },
  }
}

/**
 * Startup cleanup: drops sign-ins of servers that no longer exist (a removal interrupted before its cleanup).
 * `knownIds` are every server id of this host, user and plugin, enabled or not.
 */
export function sweepOrphanMcpOAuth(knownIds: ReadonlySet<string>): number {
  const rows = getDb()
    .prepare("SELECT key FROM app_settings WHERE key LIKE 'chat.mcpOAuth.%' AND value <> ''")
    .all() as Array<{ key: string }>
  let removed = 0
  for (const { key } of rows) {
    const serverId = key.slice(KEY_PREFIX.length)
    if (knownIds.has(serverId)) continue
    forgetMcpOAuth(serverId)
    removed += 1
  }
  return removed
}

/** Test seam: forgets the in-memory needs-auth marks and cached records (each test has a fresh database). */
export function resetMcpOAuthStatusForTests(): void {
  needsAuth.clear()
  records.clear()
}
