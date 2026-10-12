import { shell, type WebContents } from 'electron'
import { z } from 'zod'
import { isValidHostId, LOCAL_HOST_ID } from '../../shared/host-key'
import type { McpOAuthConnectResult } from '../../shared/chat'
import type { IpcRegistrar } from '../ipc-registrar'
import { invalidateMcpRuntime, listRuntimeMcpServers } from './mcp'
import {
  forgetMcpOAuth,
  MCP_OAUTH_BUNDLE_MAX_BYTES,
  type McpOAuthBundle,
  McpOAuthBundleSchema,
  type McpOAuthDescriptor,
  saveMcpOAuth,
} from './mcp-oauth'
import { McpOAuthConnectFailure, runMcpOAuthConnect } from './mcp-oauth-connect'
import type { McpServer } from './mcp-types'

/**
 * MCP OAuth channels.
 *
 * - `chat:mcp-oauth:descriptor`, `chat:mcp-oauth:store` and `chat:mcp-oauth:forget` are served by the host that runs
 *   the server: this computer for its own servers, a remote workspaces host for its own. Only this computer's main
 *   process calls the first two, during a sign-in; the descriptor holds no header, token or command.
 * - `mcp-oauth:connect` and `mcp-oauth:cancel` are local-only: the browser and the loopback callback are this
 *   computer's, whichever host the server runs on.
 */

const SERVER_ID = /^(mcp_[0-9a-f-]{36}|plg_[0-9a-f]{20})$/
const serverId = z.string().regex(SERVER_ID)

function remoteServer(id: string): McpServer | null {
  const server = listRuntimeMcpServers({ includeInactivePlugins: true }).find((item) => item.id === id)
  if (!server || server.unavailable || server.transport === 'stdio' || !server.url) return null
  return server
}

/** What this computer needs to sign in to a server of this host; null for unknown, stdio or unreadable servers. */
export function mcpOAuthDescriptor(id: unknown): McpOAuthDescriptor | null {
  const parsed = serverId.safeParse(id)
  const server = parsed.success ? remoteServer(parsed.data) : null
  if (!server?.url) return null
  return {
    serverId: server.id,
    name: server.name,
    url: server.url,
    ...(server.oauth?.scopes?.length ? { scopes: server.oauth.scopes } : {}),
    ...(server.oauth?.resource ? { resource: server.oauth.resource } : {}),
  }
}

export type McpOAuthStoreResult = { ok: true } | { ok: false; error: 'invalid-input' | 'server-changed' | 'storage' }

/** Stores a finished sign-in for a server of this host, then reconnects it with the new tokens. */
export function storeMcpOAuth(id: unknown, bundle: unknown): McpOAuthStoreResult {
  const parsedId = serverId.safeParse(id)
  if (!parsedId.success) return { ok: false, error: 'invalid-input' }
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
  if (!saveMcpOAuth(server, parsed.data as McpOAuthBundle)) return { ok: false, error: 'storage' }
  invalidateMcpRuntime(server.id)
  return { ok: true }
}

/** Signs out of a server of this host. */
export function forgetMcpOAuthChannel(id: unknown): { ok: boolean } {
  const parsed = serverId.safeParse(id)
  if (!parsed.success) return { ok: false }
  forgetMcpOAuth(parsed.data)
  invalidateMcpRuntime(parsed.data)
  return { ok: true }
}

const inFlight = new Map<string, AbortController>()

export interface McpOAuthHostCalls {
  descriptor: (serverId: string) => Promise<McpOAuthDescriptor | null>
  store: (serverId: string, bundle: McpOAuthBundle) => Promise<McpOAuthStoreResult>
}

/** The host side of a sign-in for this computer's own servers. */
export const localMcpOAuthHostCalls: McpOAuthHostCalls = {
  descriptor: async (id) => mcpOAuthDescriptor(id),
  store: async (id, bundle) => storeMcpOAuth(id, bundle),
}

/** Runs one sign-in for a server of `hostId`. One at a time per server; a new one replaces an unfinished one. */
export async function connectMcpOAuth(
  calls: McpOAuthHostCalls,
  hostId: string,
  id: string,
  deps: { openExternal: (url: string) => Promise<void>; timeoutMs?: number } = {
    openExternal: (url) => shell.openExternal(url),
  }
): Promise<McpOAuthConnectResult> {
  const key = `${hostId}\0${id}`
  inFlight.get(key)?.abort()
  const controller = new AbortController()
  inFlight.set(key, controller)
  try {
    const descriptor = await calls.descriptor(id)
    if (!descriptor) return { ok: false, error: 'unavailable' }
    const bundle = await runMcpOAuthConnect({
      descriptor,
      openExternal: deps.openExternal,
      signal: controller.signal,
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    })
    const stored = await calls.store(id, bundle)
    if (!stored.ok) return { ok: false, error: stored.error === 'storage' ? 'storage' : 'server-changed' }
    return { ok: true }
  } catch (error) {
    if (error instanceof McpOAuthConnectFailure) return { ok: false, error: error.code }
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
  reg.mhandle('chat:mcp-oauth:descriptor', (_event, id: unknown) => mcpOAuthDescriptor(id))
  reg.mhandle('chat:mcp-oauth:store', (_event, id: unknown, bundle: unknown) => storeMcpOAuth(id, bundle))
  reg.mhandle('chat:mcp-oauth:forget', (_event, id: unknown) => forgetMcpOAuthChannel(id))
  reg.mhandle('mcp-oauth:connect', async (event, hostId: unknown, id: unknown): Promise<McpOAuthConnectResult> => {
    if (typeof hostId !== 'string' || !isValidHostId(hostId) || !serverId.safeParse(id).success)
      return { ok: false, error: 'failed' }
    const calls = hostId === LOCAL_HOST_ID ? localMcpOAuthHostCalls : deps.remoteHostCalls(event.sender, hostId)
    if (!calls) return { ok: false, error: 'unavailable' }
    return connectMcpOAuth(calls, hostId, id as string)
  })
  reg.mhandle('mcp-oauth:cancel', (_event, hostId: unknown, id: unknown) => {
    if (typeof hostId !== 'string' || typeof id !== 'string') return
    inFlight.get(`${hostId}\0${id}`)?.abort()
  })
}
