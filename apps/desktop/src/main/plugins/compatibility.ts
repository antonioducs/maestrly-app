import type { PluginCompatibility, PluginPolicyDto, PluginReason, PluginReasonCode } from '../../shared/plugins'
import type { PluginMcpServerSpec } from './mcp-normalize'
import type { LoadResult, PluginPackage } from './types'

export interface ClassifyContext {
  sourceSupported: boolean
  installation?: PluginPolicyDto['installation']
}

/** Parts a portable plugin leaves out: each is noted, none makes the plugin incompatible. */
const NOTE_REASONS = new Set<PluginReasonCode>([
  'app-connector',
  'hooks-not-run',
  'agent-not-adapted',
  'component-unsupported',
  'entry-invalid',
  'transport-unsupported',
  'auth-publisher-client',
  'auth-placeholder-client',
  'symlink-skipped',
  'submodule-skipped',
])

/** MCP servers Maestrly can connect to: every normalized server (one with a placeholder OAuth client signs in too). */
export function usableMcpServers(pkg: PluginPackage): PluginMcpServerSpec[] {
  return pkg.mcpServers
}

function componentReasons(pkg: PluginPackage): PluginReason[] {
  const reasons: PluginReason[] = []
  const seen = new Set<string>()
  const add = (reason: PluginReason) => {
    const id = `${reason.code}\0${reason.component ?? ''}\0${reason.subject ?? ''}`
    if (seen.has(id)) return
    seen.add(id)
    reasons.push(reason)
  }
  for (const component of pkg.components) {
    if (!component.reason || !NOTE_REASONS.has(component.reason)) continue
    add({ code: component.reason, component: component.kind, subject: component.name })
  }
  for (const server of pkg.mcpServers) {
    if (server.auth.kind === 'manual')
      add({ code: 'auth-publisher-client', component: 'mcp-server', subject: server.key })
    if (server.auth.kind === 'oauth' && server.auth.placeholderClient)
      add({ code: 'auth-placeholder-client', component: 'mcp-server', subject: server.key })
  }
  return reasons
}

/**
 * Maestrly offers only what works the same with every model. Portable: skills and MCP servers (and parts Maestrly
 * adapts) remain; anything else is noted as not included. Unavailable: the source, policy or manifest rules it out,
 * nothing usable remains, or it relies on ChatGPT app connectors without an MCP server for the same service, in which
 * case its skills would expect tools that only exist inside OpenAI products.
 */
export function classifyPlugin(result: LoadResult, ctx: ClassifyContext): PluginCompatibility {
  if (!ctx.sourceSupported) return { level: 'unavailable', reasons: [{ code: 'source-unsupported' }] }
  if (ctx.installation === 'NOT_AVAILABLE')
    return { level: 'unavailable', reasons: [{ code: 'install-not-available' }] }
  if (!result.ok)
    return {
      level: 'unavailable',
      reasons: [
        {
          code: result.code === 'schema-unsupported' ? 'schema-unsupported' : 'manifest-invalid',
          detail: result.detail,
        },
      ],
    }
  const pkg = result.pkg
  const notes = componentReasons(pkg)
  const servers = usableMcpServers(pkg)
  const connectors = pkg.components.some((c) => c.kind === 'app-connector' && c.status === 'unavailable')
  if (connectors && servers.length === 0)
    return { level: 'unavailable', reasons: [{ code: 'requires-app-connector' }, ...notes] }
  if (pkg.skills.length + servers.length === 0)
    return { level: 'unavailable', reasons: [{ code: 'no-usable-components' }, ...notes] }
  return { level: 'portable', reasons: notes }
}
