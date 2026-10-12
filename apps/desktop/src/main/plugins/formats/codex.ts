import { type NormalizedMcp, normalizeCodexMcp } from '../mcp-normalize'
import type { PackageTree } from '../package-tree'
import { scanCommands, scanSkills } from '../skills-scan'
import type { LoadResult } from '../types'
import {
  agentComponents,
  appComponents,
  authorName,
  component,
  findLicenseFile,
  hooksComponent,
  httpsUrl,
  isRecord,
  type LoadState,
  linkComponents,
  manifestPaths,
  mcpComponents,
  parseCodexInterface,
  readJson,
  str,
} from './shared'

export const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Lowercase plugin name usable as a Maestrly key, or null. */
export function pluginNameOrNull(value: unknown): string | null {
  const name = str(value)
  return name && PLUGIN_NAME.test(name) && !name.includes('..') ? name.toLowerCase() : null
}

/**
 * Codex: `.codex-plugin/plugin.json` with optional `skills/`, `.mcp.json`, `.app.json`, `hooks/hooks.json`, `commands/`
 * and `agents/`. Manifest paths replace the default locations.
 */
export async function loadCodexPlugin(
  tree: PackageTree,
  manifest: Record<string, unknown>,
  opts: { rootName?: string } = {}
): Promise<LoadResult> {
  const state: LoadState = { tree, issues: [], components: [] }
  const name = pluginNameOrNull(manifest.name) ?? (str(manifest.name) ? null : pluginNameOrNull(opts.rootName))
  if (!name) return { ok: false, code: 'manifest-invalid', detail: 'name must use letters, digits, dots and dashes' }

  const skillRoots = manifest.skills === undefined ? ['skills'] : manifestPaths(state, manifest.skills, 'skills')
  const { skills, issues: skillIssues } = await scanSkills(tree, skillRoots, {
    strictAgentSkills: false,
    rootName: name,
  })
  const commandSources =
    manifest.commands === undefined ? ['commands'] : manifestPaths(state, manifest.commands, 'commands')
  const commands = await scanCommands(tree, commandSources)
  for (const skill of skills) component(state, 'skill', skill.name, 'supported')
  for (const command of commands.skills) component(state, 'command', command.name, 'adapted')
  for (const issue of [...skillIssues, ...commands.issues]) {
    state.issues.push({ code: issue.code, detail: `${issue.path}: ${issue.detail}` })
    if (issue.code === 'command-invalid')
      component(state, 'command', issue.path, 'invalid', 'entry-invalid', issue.detail)
  }
  const commandNames = new Set(skills.map((s) => s.name))
  const adapted = commands.skills.filter((c) => !commandNames.has(c.name))

  let mcp: NormalizedMcp = { servers: [], inputs: [], issues: [] }
  if (isRecord(manifest.mcpServers)) {
    mcp = normalizeCodexMcp(manifest.mcpServers)
    mcpComponents(state, mcp)
  } else {
    const [path] =
      manifest.mcpServers === undefined ? ['.mcp.json'] : manifestPaths(state, manifest.mcpServers, 'mcpServers')
    if (path !== undefined && tree.entries.has(path)) {
      const json = await readJson(state, path)
      if (json !== undefined) mcp = normalizeCodexMcp(json)
      mcpComponents(state, mcp)
    }
  }

  const [appsPath] = manifest.apps === undefined ? ['.app.json'] : manifestPaths(state, manifest.apps, 'apps')
  if (appsPath !== undefined) await appComponents(state, appsPath)

  if (manifest.hooks !== undefined) {
    const hookPaths = typeof manifest.hooks === 'string' || Array.isArray(manifest.hooks) ? manifest.hooks : null
    const paths = hookPaths ? manifestPaths(state, hookPaths, 'hooks').filter((p) => tree.entries.has(p)) : []
    if (paths.length) for (const path of paths) hooksComponent(state, path)
    else hooksComponent(state, 'plugin.json#hooks')
  } else if (tree.entries.has('hooks/hooks.json')) hooksComponent(state, 'hooks/hooks.json')
  // Codex does not load a root `hooks.json`, but it ships hook code that never runs here: list it too.
  if (tree.entries.has('hooks.json')) hooksComponent(state, 'hooks.json')

  const agents = await agentComponents(state, ['agents'])
  linkComponents(state)

  const display = parseCodexInterface(state, manifest.interface)
  return {
    ok: true,
    pkg: {
      name,
      format: 'codex',
      version: str(manifest.version),
      description: display.shortDescription ?? str(manifest.description),
      displayName: display.displayName,
      publisher: display.developerName ?? authorName(manifest.author),
      license: { spdx: str(manifest.license), file: findLicenseFile(tree) },
      homepage: httpsUrl(manifest.homepage) ?? display.website,
      links: {
        ...(display.privacy ? { privacy: display.privacy } : {}),
        ...(display.terms ? { terms: display.terms } : {}),
        ...(display.support ? { support: display.support } : {}),
        ...(httpsUrl(manifest.repository) ? { repository: httpsUrl(manifest.repository)! } : {}),
      },
      capabilities: display.capabilities,
      category: display.category,
      logoPath: display.logoPath,
      skills: [...skills, ...adapted],
      agents,
      mcpServers: mcp.servers,
      inputs: mcp.inputs,
      components: state.components,
      issues: state.issues,
    },
  }
}
