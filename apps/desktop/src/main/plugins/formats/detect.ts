import { AGENT_PLUGINS_SCHEMA_PREFIX } from '../mcp-normalize'
import type { PackageTree } from '../package-tree'
import type { LoadResult } from '../types'
import { loadAgentPlugin } from './agent-plugins'
import { type ClaudeEntryOverlay, loadClaudePlugin } from './claude'
import { loadCodexPlugin } from './codex'
import { isRecord, type LoadState, readJson } from './shared'

export type { ClaudeEntryOverlay } from './claude'

export const MANIFEST_PATHS = ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json'] as const

export interface LoadOptions {
  /** A Claude marketplace entry: acts as the manifest when there is none, or adds components (`strict`). */
  claudeEntry?: ClaudeEntryOverlay
  /** Marketplace display fields, which win over the manifest's. */
  displayOverrides?: { displayName?: string; description?: string; category?: string }
  /** Directory name of the plugin, used when a manifest omits its name. */
  rootName?: string
}

/**
 * Detects the format of a plugin root and loads it. The first match wins, in Codex's order: an Agent Plugins
 * `plugin.json` (by `$schema`), `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, then a Claude marketplace
 * entry acting as the manifest.
 */
export async function loadPluginPackage(tree: PackageTree, opts: LoadOptions = {}): Promise<LoadResult> {
  const probe: LoadState = { tree, issues: [], components: [] }
  const result = await detect(tree, probe, opts)
  if (!result.ok) return result
  const pkg = result.pkg
  pkg.issues.unshift(...probe.issues)
  const overrides = opts.displayOverrides ?? {}
  if (overrides.displayName) pkg.displayName = overrides.displayName
  if (overrides.description) pkg.description = overrides.description
  if (overrides.category) pkg.category = overrides.category
  return result
}

async function detect(tree: PackageTree, probe: LoadState, opts: LoadOptions): Promise<LoadResult> {
  const root = await readJson(probe, 'plugin.json')
  if (isRecord(root) && typeof root.$schema === 'string' && root.$schema.startsWith(AGENT_PLUGINS_SCHEMA_PREFIX))
    return loadAgentPlugin(tree, root)
  if (tree.entries.has('.codex-plugin/plugin.json')) {
    const manifest = await readJson(probe, '.codex-plugin/plugin.json')
    if (!isRecord(manifest))
      return { ok: false, code: 'manifest-invalid', detail: '.codex-plugin/plugin.json is invalid' }
    return loadCodexPlugin(tree, manifest, opts)
  }
  if (tree.entries.has('.claude-plugin/plugin.json')) {
    const manifest = await readJson(probe, '.claude-plugin/plugin.json')
    if (!isRecord(manifest))
      return { ok: false, code: 'manifest-invalid', detail: '.claude-plugin/plugin.json is invalid' }
    return loadClaudePlugin(tree, manifest, { entry: opts.claudeEntry, rootName: opts.rootName })
  }
  if (opts.claudeEntry) return loadClaudePlugin(tree, null, { entry: opts.claudeEntry, rootName: opts.rootName })
  return { ok: false, code: 'no-manifest', detail: 'no plugin manifest found' }
}
