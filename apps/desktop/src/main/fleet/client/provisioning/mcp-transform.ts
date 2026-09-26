import path from 'node:path'
import type { FleetMcpServerImport } from '@maestrly/bot-fleet-protocol'
import type { McpServer } from '../../../chat/mcp-types'
import type { McpWarning } from '../../../../shared/fleet-provisioning'

const runtimes = new Set('node npx npm pnpm yarn corepack uv uvx python python3 pip pip3 git mise'.split(' '))
const unsupported = new Set('docker podman bun bunx deno'.split(' '))
export function localHost(host: string): boolean {
  return (
    ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(host.toLowerCase()) || host.toLowerCase().endsWith('.local')
  )
}
export function transformMcpServerForBot(
  server: McpServer,
  home: string
): { payload: FleetMcpServerImport | null; warnings: McpWarning[]; recommended: boolean; target: string } {
  if (server.unavailable) return { payload: null, warnings: ['unavailable'], recommended: false, target: '' }
  const warnings: McpWarning[] = []
  let command = server.command
  let target = command ?? ''
  if (server.transport === 'http') {
    try {
      const url = new URL(server.url ?? '')
      target = url.host
      if (localHost(url.hostname)) warnings.push('local-url')
    } catch {
      return { payload: null, warnings: ['unavailable'], recommended: false, target: '' }
    }
  } else if (command) {
    const basename = path.basename(command)
    if (path.isAbsolute(command)) {
      if (runtimes.has(basename)) command = basename
      else warnings.push('absolute-command')
    }
    if (unsupported.has(basename)) warnings.push('unsupported-command')
    target = command
  }
  if (
    [...(server.args ?? []), ...Object.values(server.env ?? {})].some(
      (value) => (home && value.includes(home)) || value.startsWith('~/')
    )
  )
    warnings.push('mac-path')
  const payload = {
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    url: server.url,
    headers: server.headers,
    command,
    args: server.args,
    env: server.env,
  }
  return { payload, warnings, recommended: warnings.length === 0, target }
}
