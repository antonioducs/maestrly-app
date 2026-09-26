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
  logins: Array<{ id: string; kind: 'codex' | 'claude' | 'grok'; label: string; email: string | null }>
  skills: Array<{
    name: string
    description: string
    files: number
    bytes: number
    scripts: boolean
    problem: 'too-large' | 'too-many-files' | 'no-skill-md' | null
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
}
export interface MacImportReport {
  accounts: MacImportItemResult[]
  skills: MacImportItemResult[]
  mcpServers: MacImportItemResult[]
}
