export type McpWarning = 'local-url' | 'mac-path' | 'absolute-command' | 'unsupported-command' | 'unavailable'
export interface MacInventory {
  apiKeys: Array<{
    id: string
    name: string
    kind: 'anthropic' | 'openai' | 'openai-responses'
    host: string
    localOnly: boolean
  }>
  copies: Array<{ id: string; kind: 'github-copilot' | 'cursor'; label: string; expiresAt: string | null }>
  logins: Array<{ id: string; kind: 'codex' | 'claude' | 'grok' | 'antigravity'; label: string; email: string | null }>
  skills: Array<{
    name: string
    description: string
    files: number
    bytes: number
    scripts: boolean
    problem: 'too-large' | 'file-too-large' | 'path-too-long' | 'too-many-files' | 'no-skill-md' | 'unreadable' | null
  }>
  mcpServers: Array<{
    id: string
    name: string
    transport: 'http' | 'stdio'
    target: string
    warnings: McpWarning[]
    recommended: boolean
  }>
}
export interface MacImportSelection {
  apiKeyIds: string[]
  copyIds: string[]
  skillNames: string[]
  mcpServerIds: string[]
}
export interface MacImportItemResult {
  id: string
  name: string
  outcome: 'added' | 'updated' | 'unchanged' | 'failed'
  error: string | null
  errorCode?: MacProvisioningErrorCode
}
export interface MacImportReport {
  accounts: MacImportItemResult[]
  skills: MacImportItemResult[]
  mcpServers: MacImportItemResult[]
}

/** Project an endpoint without credentials into account lists. */
export function provisioningAccountBaseURL(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin + url.pathname
  } catch {
    return null
  }
}

export const macProvisioningErrorCodes = [
  'account-missing',
  'skill-missing',
  'mcp-unavailable',
  'import-failed',
  'missing-result',
  'too-large',
  'file-too-large',
  'path-too-long',
  'too-many-files',
  'no-skill-md',
  'unreadable',
  'login-unexpected-page',
  'login-cancelled',
  'login-page-unavailable',
  'login-port-unavailable',
] as const
export type MacProvisioningErrorCode = (typeof macProvisioningErrorCodes)[number]

/** Electron preserves error messages, but drops custom Error properties across invoke. */
export function macProvisioningError(code: MacProvisioningErrorCode, message: string): Error {
  return new Error(`[fleet:${code}] ${message}`)
}
