/**
 * A remote MCP server that needs an interactive OAuth sign-in. Background turns never open a browser, so its tools
 * fail with this message until someone signs in from Settings.
 */
export class McpNeedsAuthError extends Error {
  constructor(
    readonly serverId: string,
    serverName: string,
    accountLabel?: string
  ) {
    super(
      `Sign-in required: connect "${serverName}"${accountLabel ? ` (account "${accountLabel}")` : ''} in Settings → Maestrly Chat → Tools, then try again.`
    )
    this.name = 'McpNeedsAuthError'
  }
}

export const isMcpNeedsAuthError = (error: unknown): error is McpNeedsAuthError =>
  error instanceof Error && error.name === 'McpNeedsAuthError'
