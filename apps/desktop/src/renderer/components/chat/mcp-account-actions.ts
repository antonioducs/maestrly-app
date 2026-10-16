import type { McpOAuthConnectOptions, McpOAuthConnectResult } from '../../../shared/chat'
import type { PluginScope } from '../../../shared/plugins'

/**
 * Where a server's sign-in accounts are kept: a host (this computer, a remote workspaces host) or a bot environment.
 * The browser part of a sign-in always runs on this computer.
 */
export interface McpAccountActions {
  connect(serverId: string, options?: McpOAuthConnectOptions): Promise<McpOAuthConnectResult>
  cancel(serverId: string): Promise<void>
  forget(serverId: string, accountId?: string): Promise<unknown>
  patchAccount(
    serverId: string,
    accountId: string,
    patch: { label?: string; scope?: PluginScope }
  ): Promise<{ ok: boolean; error?: string }>
  setClient(serverId: string, client: { clientId: string; clientSecret?: string } | null): Promise<{ ok: boolean }>
  /** Projects of the host for an account's scope; absent = all conversations only (bot environments). */
  listProjects?(): Promise<{ id: string; name: string }[]>
}

// Mirrors the host's rules (main/chat/mcp-oauth.ts), so a label is checked before it is sent.
const LABEL = /^[\p{L}\p{N} ._@+-]+$/u
const LABEL_MAX = 40

/** `Account N` with the lowest N not taken. */
export function nextDefaultLabel(existing: readonly string[]): string {
  const taken = new Set(existing.map((label) => label.toLowerCase()))
  for (let n = 1; ; n += 1) if (!taken.has(`account ${n}`)) return `Account ${n}`
}

/** Whether a label can name a new or renamed account among `existing` (the others of the same server). */
export function validLabel(label: string, existing: readonly string[]): 'ok' | 'invalid' | 'taken' {
  const trimmed = label.trim()
  if (!trimmed || trimmed.length > LABEL_MAX || !LABEL.test(trimmed)) return 'invalid'
  return existing.some((item) => item.toLowerCase() === trimmed.toLowerCase()) ? 'taken' : 'ok'
}
