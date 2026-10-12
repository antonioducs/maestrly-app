import type { PluginCompatibility, PluginPolicyDto, PluginReason, PluginReasonCode } from '../../shared/plugins'
import type { PluginMcpServerSpec } from './mcp-normalize'
import type { LoadResult, PluginPackage } from './types'

export interface ClassifyContext {
  sourceSupported: boolean
  installation?: PluginPolicyDto['installation']
}

/** Reasons that downgrade a plugin with a usable core to Partial. */
const PARTIAL_REASONS = new Set<PluginReasonCode>([
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

/** MCP servers Maestrly can connect to. Servers with a placeholder OAuth client cannot be. */
export function usableMcpServers(pkg: PluginPackage): PluginMcpServerSpec[] {
  return pkg.mcpServers.filter((server) => server.auth.kind !== 'unusable')
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
    if (!component.reason || !PARTIAL_REASONS.has(component.reason)) continue
    add({ code: component.reason, component: component.kind, subject: component.name })
  }
  for (const server of pkg.mcpServers) {
    if (server.auth.kind === 'manual')
      add({ code: 'auth-publisher-client', component: 'mcp-server', subject: server.key })
    if (server.auth.kind === 'unusable')
      add({ code: 'auth-placeholder-client', component: 'mcp-server', subject: server.key })
  }
  return reasons
}

/**
 * Portable: only skills and MCP. Partial: a usable core plus anything that needs adaptation or cannot run here.
 * Unavailable: nothing usable remains, or the source, policy or manifest rules it out. OAuth never downgrades a plugin.
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
  const reasons = componentReasons(pkg)
  const usable = pkg.skills.length > 0 || usableMcpServers(pkg).length > 0
  if (!usable) return { level: 'unavailable', reasons: [{ code: 'no-usable-components' }, ...reasons] }
  return { level: reasons.length ? 'partial' : 'portable', reasons }
}
