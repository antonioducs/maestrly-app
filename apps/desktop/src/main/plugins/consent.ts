import { createHash } from 'node:crypto'
import type { PluginHookSpec } from './hooks-scan'
import type { PluginStdioServerSpec } from './mcp-normalize'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const sorted = (record: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))

export function launchDigest(server: PluginStdioServerSpec): string {
  return sha256(
    JSON.stringify({ command: server.command, args: server.args, cwd: server.cwd, env: sorted(server.env) })
  )
}

/** Digest of a plugin's hooks, in any order: what the person approves to run automatically. */
export function hookDigest(hooks: readonly PluginHookSpec[]): string {
  return sha256(
    JSON.stringify(
      hooks
        .map((hook) => [hook.event, hook.matcher, hook.command, hook.timeoutSec])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    )
  )
}

/**
 * Fingerprint of everything the user approves at install: stdio launch lines, MCP endpoints, executables and, for a
 * plugin with hooks, its hooks (left out otherwise, so plugins without hooks keep their fingerprint).
 */
export function consentFingerprint(input: {
  launch: Record<string, string>
  endpoints: string[]
  executables: string[]
  hooks?: string
}): string {
  return sha256(
    JSON.stringify({
      launch: sorted(input.launch),
      endpoints: [...new Set(input.endpoints)].sort(),
      executables: [...new Set(input.executables)].sort(),
      ...(input.hooks ? { hooks: input.hooks } : {}),
    })
  )
}

export function launchLine(server: PluginStdioServerSpec): string {
  const quote = (value: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : JSON.stringify(value))
  return [server.command, ...server.args].map(quote).join(' ')
}
