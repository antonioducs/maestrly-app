import { normalizeCommandName } from '../../chat/commands'
import { parseSkillFrontmatter } from '../../chat/skills'
import { type ClaudeUserConfigOption, type PluginInputSpec, normalizeClaudeMcp } from '../mcp-normalize'
import type { PackageTree } from '../package-tree'
import { parsePluginRelativePath } from '../paths'
import { type PluginSkillSpec, scanCommands, scanSkills } from '../skills-scan'
import type { LoadResult } from '../types'
import { pluginNameOrNull } from './codex'
import {
  agentComponents,
  authorName,
  component,
  findLicenseFile,
  hasDir,
  hasFile,
  hooksComponent,
  httpsUrl,
  isRecord,
  type LoadState,
  linkComponents,
  manifestPaths,
  mcpComponents,
  readJson,
  str,
} from './shared'

/** Marketplace entry fields used when the entry acts as, or adds to, the manifest. */
export interface ClaudeEntryOverlay {
  strict: boolean
  fields: Record<string, unknown>
}

const COMPONENT_FIELDS = ['commands', 'agents', 'skills', 'hooks', 'outputStyles', 'themes'] as const
const DISPLAY_FIELDS = [
  'displayName',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
] as const
const COMMAND_TEXT_MAX_BYTES = 1024 * 1024

const asList = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value])

/** Merges a marketplace entry into the manifest following Claude Code's `strict` rules. */
function mergeEntry(
  manifest: Record<string, unknown> | null,
  entry: ClaudeEntryOverlay | undefined
): { ok: true; merged: Record<string, unknown> } | { ok: false; detail: string } {
  if (!entry) return manifest ? { ok: true, merged: manifest } : { ok: false, detail: 'no manifest' }
  if (!manifest) return { ok: true, merged: { ...entry.fields } }
  const declares = COMPONENT_FIELDS.filter((field) => entry.fields[field] !== undefined)
  if (!entry.strict && declares.length)
    return { ok: false, detail: 'conflicting manifests: both plugin.json and the marketplace entry declare components' }
  const merged: Record<string, unknown> = { ...manifest }
  for (const field of DISPLAY_FIELDS) if (entry.fields[field] !== undefined) merged[field] = entry.fields[field]
  for (const field of ['commands', 'agents', 'skills', 'outputStyles', 'themes'] as const) {
    if (entry.fields[field] === undefined) continue
    if (isRecord(manifest[field]) || isRecord(entry.fields[field])) merged[field] = entry.fields[field]
    else merged[field] = [...asList(manifest[field]), ...asList(entry.fields[field])]
  }
  if (entry.fields.hooks !== undefined) merged.hooks = [...asList(manifest.hooks), entry.fields.hooks]
  return { ok: true, merged }
}

function userConfigOptions(state: LoadState, value: unknown): Record<string, ClaudeUserConfigOption> {
  const options: Record<string, ClaudeUserConfigOption> = {}
  if (!isRecord(value)) return options
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !isRecord(raw)) {
      state.issues.push({ code: 'user-config-invalid', detail: key })
      continue
    }
    const type = raw.type
    if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'directory' && type !== 'file') {
      state.issues.push({ code: 'user-config-invalid', detail: key })
      continue
    }
    options[key] = {
      type,
      title: str(raw.title) ?? key,
      description: str(raw.description) ?? '',
      required: raw.required === true,
      sensitive: raw.sensitive === true,
      ...(raw.default !== undefined ? { default: raw.default } : {}),
    }
  }
  return options
}

/** Commands declared as a map (`{ name: { source | content, description } }`). */
async function commandMap(state: LoadState, map: Record<string, unknown>): Promise<PluginSkillSpec[]> {
  const out: PluginSkillSpec[] = []
  for (const [rawName, value] of Object.entries(map)) {
    const name = normalizeCommandName(rawName)
    if (!name || !isRecord(value)) {
      component(state, 'command', rawName, 'invalid', 'entry-invalid')
      continue
    }
    let body: string | null = null
    let dirPath = ''
    let fmDescription = ''
    if (typeof value.content === 'string' && value.source === undefined) {
      body = value.content
      const parsed = parseSkillFrontmatter(body)
      fmDescription = parsed.fields.description ?? ''
    } else if (typeof value.source === 'string' && value.content === undefined) {
      const parsed = parsePluginRelativePath(value.source)
      const file = parsed.ok ? parsed.segments.join('/') : ''
      const raw = file && hasFile(state.tree, file) ? await state.tree.read(file, COMMAND_TEXT_MAX_BYTES) : null
      if (raw) {
        dirPath = file
        const fm = parseSkillFrontmatter(raw.toString('utf8'))
        fmDescription = fm.fields.description ?? ''
        body = fm.body
      }
    }
    const description = str(value.description) ?? str(fmDescription)
    if (!body?.trim() || !description) {
      component(state, 'command', rawName, 'invalid', 'entry-invalid', 'needs a source or content and a description')
      continue
    }
    out.push({
      name,
      dirPath,
      description,
      kind: 'command',
      hasScripts: false,
      ...(dirPath ? {} : { inlineBody: body }),
    })
  }
  return out
}

function listed(
  state: LoadState,
  kind: Parameters<typeof component>[1],
  fieldValue: unknown,
  defaults: string[]
): void {
  const paths = fieldValue === undefined ? defaults : manifestPaths(state, fieldValue, kind)
  for (const path of paths)
    if (state.tree.entries.has(path) || hasDir(state.tree, path))
      component(state, kind, path, 'not-run', 'component-unsupported')
}

/**
 * Claude Code: `.claude-plugin/plugin.json` (optional; a marketplace entry can act as the manifest). `skills` adds to
 * `skills/`; `commands`, `agents` and `outputStyles` replace their defaults; `hooks`, `mcpServers` and `lspServers`
 * merge with their default files.
 */
export async function loadClaudePlugin(
  tree: PackageTree,
  manifest: Record<string, unknown> | null,
  opts: { entry?: ClaudeEntryOverlay; rootName?: string } = {}
): Promise<LoadResult> {
  const mergedResult = mergeEntry(manifest, opts.entry)
  if (!mergedResult.ok) return { ok: false, code: 'manifest-invalid', detail: mergedResult.detail }
  const m = mergedResult.merged
  const state: LoadState = { tree, issues: [], components: [] }
  const name = pluginNameOrNull(m.name) ?? (m.name === undefined ? pluginNameOrNull(opts.rootName) : null)
  if (!name) return { ok: false, code: 'manifest-invalid', detail: 'name must use letters, digits, dots and dashes' }
  const userConfig = userConfigOptions(state, m.userConfig)

  // Skills: `skills/` plus manifest paths; a lone root SKILL.md is one skill.
  const extraSkillRoots = m.skills === undefined ? [] : manifestPaths(state, m.skills, 'skills')
  const skillRoots = ['skills', ...extraSkillRoots]
  if (!hasDir(tree, 'skills') && !extraSkillRoots.length && hasFile(tree, 'SKILL.md')) skillRoots.splice(0, 1, '')
  const { skills, issues: skillIssues } = await scanSkills(tree, skillRoots, {
    strictAgentSkills: false,
    rootName: name,
  })
  for (const skill of skills) component(state, 'skill', skill.name, 'supported')

  // Commands: a map, paths replacing `commands/`, or the default directory.
  let commands: PluginSkillSpec[] = []
  if (isRecord(m.commands)) commands = await commandMap(state, m.commands)
  else {
    const scanned = await scanCommands(
      tree,
      m.commands === undefined ? ['commands'] : manifestPaths(state, m.commands, 'commands')
    )
    commands = scanned.skills
    for (const issue of scanned.issues)
      component(state, 'command', issue.path, 'invalid', 'entry-invalid', issue.detail)
  }
  const skillNames = new Set(skills.map((s) => s.name))
  commands = commands.filter((c) => !skillNames.has(c.name))
  for (const command of commands) component(state, 'command', command.name, 'adapted')
  for (const issue of skillIssues) state.issues.push({ code: issue.code, detail: `${issue.path}: ${issue.detail}` })

  // MCP: `.mcp.json` first, then each manifest declaration; later names replace earlier ones.
  const merged: Record<string, unknown> = {}
  const bundles: string[] = []
  const addMap = (json: unknown) => {
    if (!isRecord(json)) return
    Object.assign(merged, isRecord(json.mcpServers) ? json.mcpServers : json)
  }
  if (tree.entries.has('.mcp.json')) addMap(await readJson(state, '.mcp.json'))
  for (const item of asList(m.mcpServers)) {
    if (isRecord(item)) addMap(item)
    else if (typeof item === 'string' && (/\.(mcpb|dxt)$/i.test(item) || /^https?:/i.test(item))) bundles.push(item)
    else if (typeof item === 'string') {
      const [path] = manifestPaths(state, item, 'mcpServers')
      if (path !== undefined) addMap(await readJson(state, path))
    }
  }
  const mcp = normalizeClaudeMcp({ mcpServers: merged }, userConfig)
  for (const bundle of bundles) mcp.issues.push(...normalizeClaudeMcp(bundle, userConfig).issues)
  if (Object.keys(merged).length || bundles.length) mcpComponents(state, mcp)

  // User options not referenced by an MCP server still show in the plugin's settings.
  const inputs: PluginInputSpec[] = [...mcp.inputs]
  for (const [key, option] of Object.entries(userConfig)) {
    if (inputs.some((input) => input.id === `config:${key}`)) continue
    inputs.push({
      id: `config:${key}`,
      label: option.title,
      description: option.description || null,
      sensitive: option.sensitive === true,
      required: option.required === true,
      defaultValue: option.default === undefined || option.default === null ? null : String(option.default),
      target: { kind: 'config', key },
    })
  }

  // Hooks merge with `hooks/hooks.json`; none of them runs here.
  if (tree.entries.has('hooks/hooks.json')) hooksComponent(state, 'hooks/hooks.json')
  for (const item of asList(m.hooks)) {
    if (typeof item === 'string') {
      for (const path of manifestPaths(state, item, 'hooks')) hooksComponent(state, path)
    } else hooksComponent(state, 'plugin.json#hooks')
  }

  agentComponents(state, m.agents === undefined ? ['agents'] : manifestPaths(state, m.agents, 'agents'))

  // Components outside the portable core: listed, never run.
  if (m.lspServers !== undefined || tree.entries.has('.lsp.json'))
    component(state, 'lsp', 'lspServers', 'not-run', 'component-unsupported')
  const experimental = isRecord(m.experimental) ? m.experimental : {}
  listed(state, 'output-style', m.outputStyles, ['output-styles'])
  listed(state, 'theme', experimental.themes ?? m.themes, ['themes'])
  listed(state, 'workflow', m.workflows, ['workflows'])
  if (experimental.monitors !== undefined || m.monitors !== undefined || tree.entries.has('monitors/monitors.json'))
    component(state, 'monitor', 'monitors', 'not-run', 'component-unsupported')
  if (hasDir(tree, 'bin')) component(state, 'bin', 'bin', 'not-run', 'component-unsupported')
  if (tree.entries.has('settings.json') || m.settings !== undefined)
    component(state, 'settings', 'settings', 'not-run', 'component-unsupported')
  if (Array.isArray(m.channels) && m.channels.length)
    component(state, 'channel', 'channels', 'not-run', 'component-unsupported')
  linkComponents(state)

  return {
    ok: true,
    pkg: {
      name,
      format: 'claude',
      version: str(m.version),
      description: str(m.description),
      displayName: str(m.displayName),
      publisher: authorName(m.author),
      license: { spdx: str(m.license), file: findLicenseFile(tree) },
      homepage: httpsUrl(m.homepage),
      links: {
        ...(httpsUrl(m.privacyPolicyUrl) ? { privacy: httpsUrl(m.privacyPolicyUrl)! } : {}),
        ...(httpsUrl(m.termsOfServiceUrl) ? { terms: httpsUrl(m.termsOfServiceUrl)! } : {}),
        ...(httpsUrl(m.supportUrl) ? { support: httpsUrl(m.supportUrl)! } : {}),
        ...(httpsUrl(m.repository) ? { repository: httpsUrl(m.repository)! } : {}),
      },
      capabilities: [],
      category: str(m.category),
      logoPath: null,
      skills: [...skills, ...commands],
      mcpServers: mcp.servers,
      inputs,
      components: state.components,
      issues: state.issues,
    },
  }
}
