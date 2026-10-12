import type { McpOAuthConnectResult } from '../../../shared/chat'

/** Where a server's sign-in is kept: a host (this computer, a remote workspaces host) or a bot environment. */
export interface McpSignInActions {
  connect(serverId: string): Promise<McpOAuthConnectResult>
  cancel(serverId: string): Promise<void>
  forget(serverId: string): Promise<unknown>
}
