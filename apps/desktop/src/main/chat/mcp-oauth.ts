import { randomBytes } from 'node:crypto'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { z } from 'zod'
import type { McpOAuthAccountDto, McpOAuthSummaryDto } from '../../shared/chat'
import type { PluginScope } from '../../shared/plugins'
import { isSecureStorageAvailable, secureGet, secureRemove, secureSet } from '../secure-store'
import { getDb } from '../store/db'
import { McpNeedsAuthError } from './mcp-auth-errors'
import type { McpServer } from './mcp-types'
import { scopeAppliesTo } from './workspace-scope'

/**
 * OAuth sign-in of remote MCP servers (Streamable HTTP and legacy SSE), user and plugin servers alike.
 *
 * The host that runs a server keeps its sign-in encrypted under `chat.mcpOAuth.<serverId>`, apart from the server's
 * connection details, so that a token refresh never rewrites them. One record holds every signed-in account of the
 * server and, optionally, the person's own OAuth client for servers that do not register apps themselves. The
 * interactive part (browser, loopback callback, registration, PKCE) runs on the person's computer
 * (`mcp-oauth-connect.ts`); the host receives only the result and refreshes tokens itself. In the background, the
 * provider here never registers a client and never opens a browser: an account without a usable sign-in fails with
 * `McpNeedsAuthError`.
 */

const KEY_PREFIX = 'chat.mcpOAuth.'
/** Stands in for a redirect URI before the first sign-in; never reached, because the background flow stops first. */
const UNSIGNED_REDIRECT = 'http://127.0.0.1/maestrly-mcp-oauth-callback'

/** Labels name accounts to the model and to people: short, readable, and unique per server (case-insensitive). */
export const MCP_ACCOUNT_LABEL = /^[\p{L}\p{N} ._@+-]+$/u
export const MCP_ACCOUNT_LABEL_MAX = 40

/** Credential-free description of a server, enough for this computer to run the sign-in. */
export interface McpOAuthDescriptor {
  serverId: string
  name: string
  url: string
  scopes?: string[]
  resource?: string
  /** The person's own OAuth client for servers without dynamic registration. Reaches only this computer's main process. */
  client?: McpOAuthClient
  /** E-mail of the account being signed in again, so the provider preselects it. */
  loginHint?: string
  /** Another account is being added: ask the provider to show its account chooser. */
  selectAccount?: boolean
}

/** An OAuth client the person registered with the server's provider (a desktop or native-app client). */
export interface McpOAuthClient {
  clientId: string
  clientSecret?: string
}

/** What a finished sign-in hands to the host. */
export interface McpOAuthBundle {
  url: string
  redirectUri: string
  clientInformation: OAuthClientInformationMixed
  tokens: OAuthTokens
  discoveryState?: OAuthDiscoveryState
  scopes?: string[]
  /** The signed-in account's e-mail, when the provider tells it (OpenID Connect). For display only. */
  email?: string
}

/** Where a finished sign-in goes: an existing account (signed in again) or a new one. */
export interface McpOAuthTarget {
  accountId?: string
  label?: string
  scope?: PluginScope
}

interface McpOAuthAccount extends Omit<McpOAuthBundle, 'url' | 'email'> {
  id: string
  label: string
  email: string | null
  scope: PluginScope
  savedAt: number
  /** The provider rejected its tokens or client: it needs a new sign-in, and keeps its label and scope meanwhile. */
  invalid?: true
}

interface McpOAuthRecord {
  v: 2
  /** The server URL every account and the client were made for; another URL makes the whole record unusable. */
  url: string
  client: McpOAuthClient | null
  accounts: McpOAuthAccount[]
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
    email: z.string().min(1).max(320).optional(),
  })
  .strict()

export const MCP_OAUTH_BUNDLE_MAX_BYTES = 256 * 1024

/** Connection keys (`serverId` or `serverId#accountId`) that answered with a sign-in requirement this run. */
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

const accountKey = (serverId: string, accountId: string) => `${serverId}#${accountId}`
const newAccountId = () => `acc_${randomBytes(6).toString('hex')}`

/** A label people and the model can use, or null. */
export function validMcpAccountLabel(label: string): string | null {
  const trimmed = label.trim()
  return trimmed.length > 0 && trimmed.length <= MCP_ACCOUNT_LABEL_MAX && MCP_ACCOUNT_LABEL.test(trimmed)
    ? trimmed
    : null
}

/** `Account N` with the lowest N not taken. */
export function nextMcpAccountLabel(existing: readonly string[]): string {
  const taken = new Set(existing.map((label) => label.toLowerCase()))
  for (let n = 1; ; n += 1) if (!taken.has(`account ${n}`)) return `Account ${n}`
}

const labelTaken = (record: McpOAuthRecord, label: string, except?: string) =>
  record.accounts.some((account) => account.id !== except && account.label.toLowerCase() === label.toLowerCase())

// Every request of a signed-in transport reads the record; keep decrypted records in memory. Only this module writes them.
const records = new Map<string, McpOAuthRecord | null>()

/** An earlier version kept one sign-in per server; it becomes the first account, for all conversations. */
function fromVersion1(value: Record<string, unknown>): McpOAuthRecord | null {
  if (typeof value.url !== 'string' || !value.tokens || !value.clientInformation) return null
  const { v: _v, savedAt, url, ...bundle } = value as unknown as McpOAuthBundle & { v: 1; savedAt?: number }
  return {
    v: 2,
    url,
    client: null,
    accounts: [
      {
        ...bundle,
        id: newAccountId(),
        label: 'Account 1',
        email: null,
        scope: { kind: 'global' },
        savedAt: typeof savedAt === 'number' ? savedAt : Date.now(),
      },
    ],
  }
}

function readRecord(serverId: string): McpOAuthRecord | null {
  if (records.has(serverId)) return records.get(serverId) ?? null
  const raw = secureGet(KEY_PREFIX + serverId)
  let record: McpOAuthRecord | null = null
  let migrated = false
  if (raw) {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      if (value?.v === 2 && typeof value.url === 'string' && Array.isArray(value.accounts)) {
        record = value as unknown as McpOAuthRecord
      } else if (value?.v === 1) {
        record = fromVersion1(value)
        migrated = record !== null
      }
    } catch {
      record = null
    }
  }
  records.set(serverId, record)
  if (migrated && record) writeRecord(serverId, record)
  return record
}

function writeRecord(serverId: string, record: McpOAuthRecord): boolean {
  if (!record.accounts.length && !record.client) {
    secureRemove(KEY_PREFIX + serverId)
    records.set(serverId, null)
    return true
  }
  const ok = secureSet(KEY_PREFIX + serverId, JSON.stringify(record))
  if (ok) records.set(serverId, record)
  return ok
}

/** The stored sign-in of a server, if it was made for the server's current URL. */
function usableRecord(server: Pick<McpServer, 'id' | 'url'>): McpOAuthRecord | null {
  const record = readRecord(server.id)
  return record && server.url && record.url === server.url ? record : null
}

/** The server's record for its current URL, or a new one (an outdated record is replaced). */
function recordFor(server: Pick<McpServer, 'id' | 'url'>): McpOAuthRecord {
  return usableRecord(server) ?? { v: 2, url: server.url ?? '', client: null, accounts: [] }
}

function accountDto(serverId: string, account: McpOAuthAccount): McpOAuthAccountDto {
  return {
    id: account.id,
    label: account.label,
    email: account.email,
    scope: account.scope,
    status: account.invalid || needsAuth.has(accountKey(serverId, account.id)) ? 'needs-auth' : 'connected',
  }
}

/**
 * Sign-in of a server as Settings shows it. `wantsOAuth` is true when the server is known to use OAuth before any
 * request (a plugin server that declares it); otherwise a server needs sign-in only once it answered 401.
 */
export function mcpOAuthSummary(
  server: Pick<McpServer, 'id' | 'url' | 'transport'>,
  wantsOAuth = false
): McpOAuthSummaryDto {
  const record = server.transport === 'stdio' ? null : usableRecord(server)
  const accounts = (record?.accounts ?? []).map((account) => accountDto(server.id, account))
  return {
    needsAuth: server.transport !== 'stdio' && (needsAuth.has(server.id) || (wantsOAuth && accounts.length === 0)),
    accounts,
    client: record?.client ? { clientId: record.client.clientId } : null,
  }
}

/** The summary when there is anything to show: a sign-in to make, an account, or an own client. */
export function mcpOAuthField(server: McpServer): McpOAuthSummaryDto | undefined {
  if (server.unavailable || server.transport === 'stdio') return undefined
  const summary = mcpOAuthSummary(server, !!server.oauth)
  return summary.needsAuth || summary.accounts.length || summary.client ? summary : undefined
}

/** Accounts of a server that serve a conversation (`undefined`: every account; `null`: those for all conversations). */
export function activeMcpOAuthAccounts(
  server: Pick<McpServer, 'id' | 'url' | 'transport'>,
  conversationId: string | null | undefined
): McpOAuthAccountDto[] {
  return mcpOAuthSummary(server).accounts.filter((account) => scopeAppliesTo(account.scope, conversationId))
}

export type SaveMcpOAuthAccountResult =
  | { ok: true; accountId: string }
  | { ok: false; error: 'storage' | 'server-changed' | 'label-taken' | 'unknown-account' }

/**
 * Stores a finished sign-in. With `target.accountId` it replaces that account's sign-in and keeps its label and scope;
 * a sign-in whose e-mail matches an account does the same. Otherwise it adds an account, labelled by `target.label`,
 * the e-mail, or `Account N`.
 */
export function saveMcpOAuthAccount(
  server: Pick<McpServer, 'id' | 'url'>,
  bundle: McpOAuthBundle,
  target: McpOAuthTarget
): SaveMcpOAuthAccountResult {
  if (!isSecureStorageAvailable()) return { ok: false, error: 'storage' }
  if (!server.url || bundle.url !== server.url) return { ok: false, error: 'server-changed' }
  const record = recordFor(server)
  const { url: _url, email: rawEmail, ...signIn } = bundle
  const email = rawEmail?.trim() || null
  const existing = target.accountId
    ? record.accounts.find((account) => account.id === target.accountId)
    : email
      ? record.accounts.find((account) => account.email?.toLowerCase() === email.toLowerCase())
      : undefined
  if (target.accountId && !existing) return { ok: false, error: 'unknown-account' }
  let account: McpOAuthAccount
  if (existing) {
    account = {
      ...signIn,
      id: existing.id,
      label: existing.label,
      email: email ?? existing.email,
      scope: target.scope ?? existing.scope,
      savedAt: Date.now(),
    }
  } else {
    const asked = target.label ? validMcpAccountLabel(target.label) : null
    if (asked && labelTaken(record, asked)) return { ok: false, error: 'label-taken' }
    const fromEmail = email ? validMcpAccountLabel(email) : null
    const label =
      asked ??
      (fromEmail && !labelTaken(record, fromEmail)
        ? fromEmail
        : nextMcpAccountLabel(record.accounts.map((item) => item.label)))
    account = {
      ...signIn,
      id: newAccountId(),
      label,
      email,
      scope: target.scope ?? { kind: 'global' },
      savedAt: Date.now(),
    }
  }
  const next: McpOAuthRecord = {
    ...record,
    accounts: existing
      ? record.accounts.map((item) => (item.id === existing.id ? account : item))
      : [...record.accounts, account],
  }
  if (!writeRecord(server.id, next)) return { ok: false, error: 'storage' }
  needsAuth.delete(server.id)
  needsAuth.delete(accountKey(server.id, account.id))
  changed(server.id)
  return { ok: true, accountId: account.id }
}

export type PatchMcpOAuthAccountResult =
  | { ok: true }
  | { ok: false; error: 'unknown-account' | 'label-taken' | 'invalid-label' | 'storage' }

/** Renames an account or changes the conversations it serves. */
export function patchMcpOAuthAccount(
  serverId: string,
  accountId: string,
  patch: { label?: string; scope?: PluginScope }
): PatchMcpOAuthAccountResult {
  const record = readRecord(serverId)
  const account = record?.accounts.find((item) => item.id === accountId)
  if (!record || !account) return { ok: false, error: 'unknown-account' }
  let label = account.label
  if (patch.label !== undefined) {
    const valid = validMcpAccountLabel(patch.label)
    if (!valid) return { ok: false, error: 'invalid-label' }
    if (labelTaken(record, valid, accountId)) return { ok: false, error: 'label-taken' }
    label = valid
  }
  const next: McpOAuthRecord = {
    ...record,
    accounts: record.accounts.map((item) =>
      item.id === accountId ? { ...item, label, scope: patch.scope ?? item.scope } : item
    ),
  }
  if (!writeRecord(serverId, next)) return { ok: false, error: 'storage' }
  changed(serverId)
  return { ok: true }
}

/** Signs out of one account, or (without `accountId`) drops the whole sign-in, own client included. */
export function forgetMcpOAuth(serverId: string, accountId?: string): void {
  const record = readRecord(serverId)
  const marked = [...needsAuth].filter((key) => key === serverId || key.startsWith(`${serverId}#`))
  if (accountId) {
    needsAuth.delete(accountKey(serverId, accountId))
    if (record?.accounts.some((account) => account.id === accountId))
      writeRecord(serverId, { ...record, accounts: record.accounts.filter((account) => account.id !== accountId) })
    changed(serverId)
    return
  }
  secureRemove(KEY_PREFIX + serverId)
  records.set(serverId, null)
  for (const key of marked) needsAuth.delete(key)
  if (record || marked.length) changed(serverId)
}

/** Sets or removes the person's own OAuth client of a server. False when secure storage cannot keep it. */
export function setMcpOAuthClient(server: Pick<McpServer, 'id' | 'url'>, client: McpOAuthClient | null): boolean {
  if (!isSecureStorageAvailable() || !server.url) return false
  const next = { ...recordFor(server), client: client ? { ...client } : null }
  if (!writeRecord(server.id, next)) return false
  changed(server.id)
  return true
}

/** The own OAuth client of a server, for its sign-in descriptor only. Never sent to a window. */
export function mcpOAuthClient(server: Pick<McpServer, 'id' | 'url'>): McpOAuthClient | null {
  return usableRecord(server)?.client ?? null
}

/** Records that a connection (`serverId` or `serverId#accountId`) answered with a sign-in requirement this run. */
export function markMcpNeedsAuth(key: string): void {
  if (needsAuth.has(key)) return
  needsAuth.add(key)
  changed(key.split('#')[0])
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

/** The account a connection uses: the one it names, or, without one, the first (the only one, usually). */
function connectionAccount(record: McpOAuthRecord | null, server: McpServer): McpOAuthAccount | undefined {
  if (!record) return undefined
  return server.oauthAccountId
    ? record.accounts.find((account) => account.id === server.oauthAccountId)
    : record.accounts[0]
}

/**
 * The provider a host's transports use in the background, for one account of the server. It reads the stored sign-in
 * on every call, saves refreshed tokens, and stops with `McpNeedsAuthError` where an interactive step would start: it
 * has no `saveClientInformation`, so it can never register a client, and it never redirects.
 */
export function hostMcpOAuthProvider(server: McpServer): OAuthClientProvider {
  const current = () => connectionAccount(usableRecord(server), server)
  const stop = (): never => {
    const account = current()
    markMcpNeedsAuth(account ? accountKey(server.id, account.id) : server.id)
    throw new McpNeedsAuthError(server, account?.label)
  }
  const update = (patch: (account: McpOAuthAccount) => McpOAuthAccount) => {
    const record = usableRecord(server)
    const account = connectionAccount(record, server)
    if (!record || !account) return
    writeRecord(server.id, {
      ...record,
      accounts: record.accounts.map((item) => (item.id === account.id ? patch(item) : item)),
    })
  }
  return {
    get redirectUrl() {
      return current()?.redirectUri ?? UNSIGNED_REDIRECT
    },
    get clientMetadata() {
      const account = current()
      return mcpOAuthClientMetadata(account?.redirectUri ?? UNSIGNED_REDIRECT, account?.scopes)
    },
    clientInformation: () => current()?.clientInformation ?? stop(),
    tokens: () => {
      const account = current()
      return account && !account.invalid ? account.tokens : undefined
    },
    saveTokens: (tokens) => update((account) => ({ ...account, tokens, savedAt: Date.now() })),
    redirectToAuthorization: () => stop(),
    saveCodeVerifier: () => stop(),
    codeVerifier: () => stop(),
    discoveryState: () => current()?.discoveryState,
    saveDiscoveryState: (discoveryState) => update((account) => ({ ...account, discoveryState })),
    invalidateCredentials: (scope) => {
      if (scope === 'discovery') return update((account) => ({ ...account, discoveryState: undefined }))
      if (scope === 'verifier') return
      // Its tokens or client were rejected: this account needs a new sign-in. The other accounts are untouched.
      const account = current()
      if (!account) return markMcpNeedsAuth(server.id)
      update((item) => ({ ...item, invalid: true }))
      markMcpNeedsAuth(accountKey(server.id, account.id))
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
