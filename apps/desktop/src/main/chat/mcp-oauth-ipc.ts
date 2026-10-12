import { shell, type WebContents } from 'electron'
import { z } from 'zod'
import { isValidHostId, LOCAL_HOST_ID } from '../../shared/host-key'
import type { McpOAuthConnectOptions, McpOAuthConnectResult } from '../../shared/chat'
import type { IpcRegistrar } from '../ipc-registrar'
import { invalidateMcpRuntime, listRuntimeMcpServers } from './mcp'
import {
  forgetMcpOAuth,
  MCP_ACCOUNT_LABEL_MAX,
  MCP_OAUTH_BUNDLE_MAX_BYTES,
  type McpOAuthBundle,
  McpOAuthBundleSchema,
  mcpOAuthClient,
  type McpOAuthDescriptor,
  mcpOAuthField,
  mcpOAuthSummary,
  type McpOAuthTarget,
  type PatchMcpOAuthAccountResult,
  patchMcpOAuthAccount,
  saveMcpOAuthAccount,
  setMcpOAuthClient,
} from './mcp-oauth'
import { McpOAuthConnectFailure, runMcpOAuthConnect } from './mcp-oauth-connect'
import type { McpServer } from './mcp-types'

/**
 * MCP OAuth channels.
 *
 * - `chat:mcp-oauth:descriptor`, `chat:mcp-oauth:store`, `chat:mcp-oauth:forget`, `chat:mcp-oauth:patch-account` and
 *   `chat:mcp-oauth:set-client` are served by the host that runs the server: this computer for its own servers, a
 *   remote workspaces host for its own. Only this computer's main process calls the first two, during a sign-in; the
 *   descriptor holds no header, token or command, only the person's own client when there is one.
 * - `mcp-oauth:connect` and `mcp-oauth:cancel` are local-only: the browser and the loopback callback are this
 *   computer's, whichever host the server runs on.
 *
 * No channel returns a token or a client secret to a window.
 */

const SERVER_ID = /^(mcp_[0-9a-f-]{36}|plg_[0-9a-f]{20})$/
const serverId = z.string().regex(SERVER_ID)
const accountId = z.string().regex(/^acc_[0-9a-f]{12}$/)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const scope = z.union([
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('projects'), workspaceIds: z.array(z.string().regex(UUID)).min(1).max(200) }).strict(),
])
const label = z.string().min(1).max(MCP_ACCOUNT_LABEL_MAX)
const target = z.object({ accountId: accountId.optional(), label: label.optional(), scope: scope.optional() }).strict()
const accountPatch = z
  .object({ label: label.optional(), scope: scope.optional() })
  .strict()
  .refine((patch) => patch.label !== undefined || patch.scope !== undefined)
const ownClient = z
  .object({ clientId: z.string().trim().min(1).max(4096), clientSecret: z.string().min(1).max(4096).optional() })
  .strict()

function remoteServer(id: string): McpServer | null {
  const server = listRuntimeMcpServers({ includeInactivePlugins: true }).find((item) => item.id === id)
  if (!server || server.unavailable || server.transport === 'stdio' || !server.url) return null
  return server
}

/**
 * What this computer needs to sign in to a server of this host, for a new account or (with `account`) to sign one in
 * again; null for unknown, stdio or unreadable servers and unknown accounts.
 */
export function mcpOAuthDescriptor(id: unknown, account?: unknown): McpOAuthDescriptor | null {
  const parsed = serverId.safeParse(id)
  const server = parsed.success ? remoteServer(parsed.data) : null
  if (!server?.url) return null
  const accounts = mcpOAuthSummary(server).accounts
  let loginHint: string | undefined
  if (account !== undefined && account !== null) {
    const parsedAccount = accountId.safeParse(account)
    const existing = parsedAccount.success ? accounts.find((item) => item.id === parsedAccount.data) : undefined
    if (!existing) return null
    loginHint = existing.email ?? undefined
  }
  const client = mcpOAuthClient(server)
  return {
    serverId: server.id,
    name: server.name,
    url: server.url,
    ...(server.oauth?.scopes?.length ? { scopes: server.oauth.scopes } : {}),
    ...(server.oauth?.resource ? { resource: server.oauth.resource } : {}),
    ...(client ? { client } : {}),
    ...(loginHint ? { loginHint } : {}),
    ...(account === undefined || account === null ? (accounts.length ? { selectAccount: true } : {}) : {}),
  }
}

/** Sign-in status of this host's remote servers, user and plugin servers alike; those without one are left out. */
export function mcpOAuthStatuses(): { id: string; status: 'connected' | 'needs-auth' }[] {
  return listRuntimeMcpServers({ includeInactivePlugins: true }).flatMap((server) => {
    const summary = mcpOAuthField(server)
    if (!summary) return []
    const needs = summary.needsAuth || summary.accounts.some((account) => account.status === 'needs-auth')
    if (!needs && !summary.accounts.length) return []
    return [{ id: server.id, status: needs ? ('needs-auth' as const) : ('connected' as const) }]
  })
}

export type McpOAuthStoreResult =
  | { ok: true; accountId: string }
  | { ok: false; error: 'invalid-input' | 'server-changed' | 'storage' | 'label-taken' | 'unknown-account' }

/** Stores a finished sign-in for a server of this host as an account, then reconnects it with the new tokens. */
export function storeMcpOAuth(id: unknown, bundle: unknown, rawTarget: unknown = {}): McpOAuthStoreResult {
  const parsedId = serverId.safeParse(id)
  const parsedTarget = target.safeParse(rawTarget ?? {})
  if (!parsedId.success || !parsedTarget.success) return { ok: false, error: 'invalid-input' }
  let size = 0
  try {
    size = Buffer.byteLength(JSON.stringify(bundle) ?? '')
  } catch {
    return { ok: false, error: 'invalid-input' }
  }
  if (size > MCP_OAUTH_BUNDLE_MAX_BYTES) return { ok: false, error: 'invalid-input' }
  const parsed = McpOAuthBundleSchema.safeParse(bundle)
  if (!parsed.success) return { ok: false, error: 'invalid-input' }
  const server = remoteServer(parsedId.data)
  if (!server || server.url !== parsed.data.url) return { ok: false, error: 'server-changed' }
  const saved = saveMcpOAuthAccount(server, parsed.data as McpOAuthBundle, parsedTarget.data as McpOAuthTarget)
  if (!saved.ok) return saved
  invalidateMcpRuntime(server.id)
  return saved
}

/** Signs out of one account of a server of this host, or of all of them (own client included). */
export function forgetMcpOAuthChannel(id: unknown, account?: unknown): { ok: boolean } {
  const parsed = serverId.safeParse(id)
  const parsedAccount = account === undefined || account === null ? null : accountId.safeParse(account)
  if (!parsed.success || (parsedAccount && !parsedAccount.success)) return { ok: false }
  forgetMcpOAuth(parsed.data, parsedAccount?.data)
  invalidateMcpRuntime(parsed.data)
  return { ok: true }
}

/** Renames an account of a server of this host, or changes the conversations it serves. */
export function patchMcpOAuthAccountChannel(
  id: unknown,
  account: unknown,
  patch: unknown
): PatchMcpOAuthAccountResult | { ok: false; error: 'invalid-input' } {
  const parsedId = serverId.safeParse(id)
  const parsedAccount = accountId.safeParse(account)
  const parsedPatch = accountPatch.safeParse(patch)
  if (!parsedId.success || !parsedAccount.success || !parsedPatch.success) return { ok: false, error: 'invalid-input' }
  return patchMcpOAuthAccount(parsedId.data, parsedAccount.data, parsedPatch.data)
}

/** Sets (or, with null, removes) the person's own OAuth client of a server of this host. The secret never comes back. */
export function setMcpOAuthClientChannel(id: unknown, client: unknown): { ok: boolean } {
  const parsedId = serverId.safeParse(id)
  const parsedClient = client === null ? null : ownClient.safeParse(client)
  if (!parsedId.success || (parsedClient && !parsedClient.success)) return { ok: false }
  const server = remoteServer(parsedId.data)
  if (!server) return { ok: false }
  return { ok: setMcpOAuthClient(server, parsedClient?.data ?? null) }
}

const inFlight = new Map<string, AbortController>()

/** Cancels an unfinished sign-in of a server; `target` names where it runs (a host id, or a bot environment). */
export function cancelMcpOAuth(target: string, id: string): void {
  inFlight.get(`${target}\0${id}`)?.abort()
}

export interface McpOAuthHostCalls {
  descriptor: (serverId: string, accountId?: string) => Promise<McpOAuthDescriptor | null>
  store: (serverId: string, bundle: McpOAuthBundle, target: McpOAuthTarget) => Promise<McpOAuthStoreResult>
}

/** The host side of a sign-in for this computer's own servers. */
export const localMcpOAuthHostCalls: McpOAuthHostCalls = {
  descriptor: async (id, account) => mcpOAuthDescriptor(id, account),
  store: async (id, bundle, storeTarget) => storeMcpOAuth(id, bundle, storeTarget),
}

const STORE_ERRORS: Record<Exclude<McpOAuthStoreResult, { ok: true }>['error'], McpOAuthConnectResult & { ok: false }> =
  {
    'invalid-input': { ok: false, error: 'failed' },
    'server-changed': { ok: false, error: 'server-changed' },
    storage: { ok: false, error: 'storage' },
    'label-taken': { ok: false, error: 'label-taken' },
    'unknown-account': { ok: false, error: 'unavailable' },
  }

/**
 * Runs one sign-in for a server of `hostId`: a new account, or (with `options.accountId`) an account signed in again.
 * One at a time per server; a new one replaces an unfinished one.
 */
export async function connectMcpOAuth(
  calls: McpOAuthHostCalls,
  hostId: string,
  id: string,
  options: McpOAuthConnectOptions = {},
  deps: { openExternal: (url: string) => Promise<void>; timeoutMs?: number } = {
    openExternal: (url) => shell.openExternal(url),
  }
): Promise<McpOAuthConnectResult> {
  const key = `${hostId}\0${id}`
  inFlight.get(key)?.abort()
  const controller = new AbortController()
  inFlight.set(key, controller)
  try {
    const descriptor = await calls.descriptor(id, options.accountId)
    if (!descriptor) return { ok: false, error: 'unavailable' }
    const bundle = await runMcpOAuthConnect({
      descriptor,
      openExternal: deps.openExternal,
      signal: controller.signal,
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    })
    const stored = await calls.store(id, bundle, {
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(options.label ? { label: options.label } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
    })
    return stored.ok ? { ok: true, accountId: stored.accountId } : STORE_ERRORS[stored.error]
  } catch (error) {
    if (error instanceof McpOAuthConnectFailure)
      return { ok: false, error: error.code, ...(error.issuer ? { issuer: error.issuer } : {}) }
    return { ok: false, error: 'failed' }
  } finally {
    if (inFlight.get(key) === controller) inFlight.delete(key)
  }
}

/**
 * `remoteHostCalls` reaches a remote workspaces host through the bridge (null when the host is unknown); it is
 * injected so that this module stays free of the bridge's dependencies.
 */
export function registerMcpOAuthIpc(
  reg: IpcRegistrar,
  deps: { remoteHostCalls: (sender: WebContents, hostId: string) => McpOAuthHostCalls | null }
): void {
  reg.mhandle('chat:mcp-oauth:descriptor', (_event, id: unknown, account?: unknown) => mcpOAuthDescriptor(id, account))
  reg.mhandle('chat:mcp-oauth:store', (_event, id: unknown, bundle: unknown, storeTarget?: unknown) =>
    storeMcpOAuth(id, bundle, storeTarget)
  )
  reg.mhandle('chat:mcp-oauth:forget', (_event, id: unknown, account?: unknown) => forgetMcpOAuthChannel(id, account))
  reg.mhandle('chat:mcp-oauth:patch-account', (_event, id: unknown, account: unknown, patch: unknown) =>
    patchMcpOAuthAccountChannel(id, account, patch)
  )
  reg.mhandle('chat:mcp-oauth:set-client', (_event, id: unknown, client: unknown) =>
    setMcpOAuthClientChannel(id, client)
  )
  reg.mhandle(
    'mcp-oauth:connect',
    async (event, hostId: unknown, id: unknown, rawOptions?: unknown): Promise<McpOAuthConnectResult> => {
      const options = target.safeParse(rawOptions ?? {})
      if (typeof hostId !== 'string' || !isValidHostId(hostId) || !serverId.safeParse(id).success || !options.success)
        return { ok: false, error: 'failed' }
      const calls = hostId === LOCAL_HOST_ID ? localMcpOAuthHostCalls : deps.remoteHostCalls(event.sender, hostId)
      if (!calls) return { ok: false, error: 'unavailable' }
      return connectMcpOAuth(calls, hostId, id as string, options.data)
    }
  )
  reg.mhandle('mcp-oauth:cancel', (_event, hostId: unknown, id: unknown) => {
    if (typeof hostId === 'string' && typeof id === 'string') cancelMcpOAuth(hostId, id)
  })
}
