import type { PluginComponentDto, PluginFormat } from '../../shared/plugins'
import type { PluginInputSpec, PluginMcpServerSpec } from './mcp-normalize'
import type { PluginSkillSpec } from './skills-scan'

export type { PluginInputSpec, PluginMcpServerSpec } from './mcp-normalize'
export type { PluginSkillSpec } from './skills-scan'

export interface PluginIssue {
  code: string
  detail: string
}

/** One plugin normalized from any supported format. Paths are relative to the plugin root. */
export interface PluginPackage {
  name: string
  format: PluginFormat
  version: string | null
  description: string | null
  displayName: string | null
  publisher: string | null
  license: { spdx: string | null; file: string | null }
  homepage: string | null
  links: { privacy?: string; terms?: string; support?: string; repository?: string }
  capabilities: string[]
  category: string | null
  logoPath: string | null
  /** Skills and adapted commands (kind `skill` | `command`). */
  skills: PluginSkillSpec[]
  mcpServers: PluginMcpServerSpec[]
  inputs: PluginInputSpec[]
  /** Every component found, with its support status. */
  components: PluginComponentDto[]
  issues: PluginIssue[]
}

export type LoadResult =
  | { ok: true; pkg: PluginPackage }
  | { ok: false; code: 'manifest-invalid' | 'schema-unsupported' | 'no-manifest'; detail: string }
