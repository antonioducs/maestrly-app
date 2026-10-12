import {
  AGENT_PLUGINS_SUPPORTED_VERSION,
  agentPluginsSchemaVersion,
  type NormalizedMcp,
  normalizeAgentPluginsMcp,
} from '../mcp-normalize'
import type { PackageTree } from '../package-tree'
import { scanSkills } from '../skills-scan'
import type { LoadResult } from '../types'
import {
  appComponents,
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
  parseCodexInterface,
  readJson,
  str,
} from './shared'

/** Agent Plugins 1.0.0: closed manifest (§5.2), fixed locations `skills/` and `mcp.json` (§6.1). */
const MANIFEST_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
])
export const AGENT_PLUGIN_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/
const NAMESPACE_DIR = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/
const OPENAI_NAMESPACE = 'com.openai'

const invalid = (detail: string): LoadResult => ({ ok: false, code: 'manifest-invalid', detail })

export function isAgentPluginName(name: string): boolean {
  return AGENT_PLUGIN_NAME.test(name) && !name.includes('--') && !name.includes('..')
}

export async function loadAgentPlugin(tree: PackageTree, manifest: Record<string, unknown>): Promise<LoadResult> {
  const version = agentPluginsSchemaVersion(manifest.$schema, 'plugin')
  if (version !== AGENT_PLUGINS_SUPPORTED_VERSION)
    return { ok: false, code: 'schema-unsupported', detail: `unsupported Agent Plugins version ${version ?? '?'}` }
  const state: LoadState = { tree, issues: [], components: [] }
  for (const field of Object.keys(manifest))
    if (!MANIFEST_FIELDS.has(field)) state.issues.push({ code: 'unknown-field', detail: field })
  for (const field of ['version', 'description', 'homepage', 'repository', 'license'])
    if (manifest[field] !== undefined && typeof manifest[field] !== 'string')
      return invalid(`${field} must be a string`)
  if (typeof manifest.name !== 'string' || !isAgentPluginName(manifest.name))
    return invalid('name must use lowercase letters, digits, dots and hyphens')
  if (manifest.author !== undefined) {
    if (!isRecord(manifest.author)) return invalid('author must be an object')
    for (const [key, value] of Object.entries(manifest.author))
      if (!['name', 'email', 'url'].includes(key) || typeof value !== 'string')
        return invalid('author accepts only name, email and url strings')
  }
  if (
    manifest.keywords !== undefined &&
    (!Array.isArray(manifest.keywords) || manifest.keywords.some((k) => typeof k !== 'string'))
  )
    return invalid('keywords must be strings')
  let extensions: Record<string, unknown> = {}
  if (manifest.extensions !== undefined) {
    if (isRecord(manifest.extensions)) extensions = manifest.extensions
    else state.issues.push({ code: 'extensions-invalid', detail: 'extensions must be an object; ignored' })
  }
  const openai = isRecord(extensions[OPENAI_NAMESPACE]) ? (extensions[OPENAI_NAMESPACE] as Record<string, unknown>) : {}

  // Skills: fixed location, immediate children only.
  const { skills, issues: skillIssues } = await scanSkills(tree, ['skills'], { strictAgentSkills: true })
  if (tree.entries.has('skills') && !hasDir(tree, 'skills'))
    state.issues.push({ code: 'component-invalid', detail: 'skills is not a directory' })
  for (const skill of skills) component(state, 'skill', skill.name, 'supported')
  for (const issue of skillIssues) {
    component(state, 'skill', issue.path, 'invalid', 'entry-invalid', issue.detail)
    state.issues.push({ code: issue.code, detail: `${issue.path}: ${issue.detail}` })
  }

  // MCP: fixed `mcp.json`, version must match the manifest.
  let mcp: NormalizedMcp = { servers: [], inputs: [], issues: [] }
  if (tree.entries.has('mcp.json')) {
    if (!hasFile(tree, 'mcp.json')) state.issues.push({ code: 'component-invalid', detail: 'mcp.json is not a file' })
    else {
      const json = await readJson(state, 'mcp.json')
      if (json !== undefined) mcp = normalizeAgentPluginsMcp(json, manifest.$schema as string)
    }
    mcpComponents(state, mcp)
  }

  // OpenAI's namespace: interface metadata plus app connectors and hooks that never run here.
  const display = parseCodexInterface(state, openai.interface)
  for (const path of manifestPaths(state, openai.apps, 'extensions.com.openai.apps')) await appComponents(state, path)
  if (openai.hooks !== undefined) hooksComponent(state, 'extensions.com.openai.hooks')

  // Client extension directories (§8.2) of any namespace are not implemented by Maestrly.
  const topDirs = new Set<string>()
  for (const key of tree.entries.keys()) if (key.includes('/')) topDirs.add(key.split('/')[0])
  for (const dir of [...topDirs].sort())
    if (NAMESPACE_DIR.test(dir)) component(state, 'extension', dir, 'not-run', 'component-unsupported')
  for (const namespace of Object.keys(extensions))
    if (namespace !== OPENAI_NAMESPACE && !topDirs.has(namespace))
      component(state, 'extension', namespace, 'not-run', 'component-unsupported')

  linkComponents(state)
  const name = manifest.name
  return {
    ok: true,
    pkg: {
      name,
      format: 'agent-plugins',
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
      skills,
      agents: [],
      mcpServers: mcp.servers,
      inputs: mcp.inputs,
      components: state.components,
      issues: state.issues,
    },
  }
}
