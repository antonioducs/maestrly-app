import type { FleetSettingsInput } from '@maestrly/bot-fleet-protocol'
export interface McpSettingsDraft {
  name: string
  transport: 'http' | 'stdio'
  enabled: boolean
  url: string
  command: string
  args: string
  env: string
  headers: string
  removeEnv: string[]
  removeHeaders: string[]
}
export const emptyMcpDraft = (): McpSettingsDraft => ({
  name: '',
  transport: 'http',
  enabled: true,
  url: '',
  command: '',
  args: '',
  env: '',
  headers: '',
  removeEnv: [],
  removeHeaders: [],
})
/** Blank protected fields are omitted, never interpreted as deletion. */
export function mcpSecretValues(text: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined
  const entries = text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const split = line.indexOf('=')
      if (split < 1) throw new Error('invalid-secret-entry')
      return [line.slice(0, split).trim(), line.slice(split + 1)]
    })
  return Object.fromEntries(entries)
}
function replacements(draft: McpSettingsDraft) {
  const args: unknown = draft.transport === 'stdio' && draft.args.trim() ? JSON.parse(draft.args) : undefined
  if (args !== undefined && (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')))
    throw new Error('invalid-args')
  return draft.transport === 'http'
    ? { ...(draft.url.trim() ? { url: draft.url.trim() } : {}) }
    : {
        ...(draft.command.trim() ? { command: draft.command.trim() } : {}),
        ...(args ? { args: args as string[] } : {}),
      }
}
export function mcpCreateInput(draft: McpSettingsDraft): FleetSettingsInput<'createMcpServer'> {
  return {
    name: draft.name.trim(),
    transport: draft.transport,
    enabled: draft.enabled,
    ...replacements(draft),
    ...(draft.transport === 'stdio'
      ? { env: mcpSecretValues(draft.env) }
      : { headers: mcpSecretValues(draft.headers) }),
  }
}
export function mcpPatchInput(
  id: string,
  revision: string,
  draft: McpSettingsDraft,
  originalTransport: 'http' | 'stdio' = draft.transport
): FleetSettingsInput<'patchMcpServer'> {
  const switching = originalTransport !== draft.transport
  if (switching && !(draft.transport === 'http' ? draft.url : draft.command).trim())
    throw new Error('replacement-destination-required')
  return {
    ...(switching ? { transport: draft.transport } : {}),
    id,
    expectedRevision: revision,
    name: draft.name.trim(),
    enabled: draft.enabled,
    replace: replacements(draft),
    ...(draft.transport === 'stdio'
      ? { env: { set: mcpSecretValues(draft.env), remove: draft.removeEnv } }
      : { headers: { set: mcpSecretValues(draft.headers), remove: draft.removeHeaders } }),
  }
}
