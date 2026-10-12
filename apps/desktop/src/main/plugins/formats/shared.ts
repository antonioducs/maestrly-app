import type { PluginComponentDto, PluginComponentKind } from '../../../shared/plugins'
import { PLUGIN_LIMITS } from '../limits'
import type { NormalizedMcp } from '../mcp-normalize'
import type { PackageTree } from '../package-tree'
import { parsePluginRelativePath } from '../paths'
import type { PluginIssue } from '../types'

/** Mutable accumulator a format loader fills while it walks one plugin. */
export interface LoadState {
  tree: PackageTree
  issues: PluginIssue[]
  components: PluginComponentDto[]
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Trimmed non-empty string, or null. */
export const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

const MAX_LISTED_LINKS = 100
const LICENSE_FILE = /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)

export function hasFile(tree: PackageTree, path: string): boolean {
  const entry = tree.entries.get(path)
  return entry?.mode === 'file' || entry?.mode === 'executable'
}

export function hasDir(tree: PackageTree, path: string): boolean {
  const prefix = path ? `${path}/` : ''
  for (const key of tree.entries.keys()) if (key.startsWith(prefix)) return true
  return false
}

/** Reads and parses a JSON file of the plugin. `undefined` when absent or unreadable (with an issue). */
export async function readJson(state: LoadState, path: string): Promise<unknown | undefined> {
  const entry = state.tree.entries.get(path)
  if (!entry) return undefined
  if (entry.mode !== 'file' && entry.mode !== 'executable') {
    state.issues.push({ code: 'path-unsafe', detail: `${path} is not a regular file` })
    return undefined
  }
  const raw = await state.tree.read(path, PLUGIN_LIMITS.jsonBytes)
  if (!raw) {
    state.issues.push({ code: 'too-large', detail: `${path} is larger than ${PLUGIN_LIMITS.jsonBytes} bytes` })
    return undefined
  }
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    state.issues.push({ code: 'json-invalid', detail: `${path} is not valid JSON` })
    return undefined
  }
}

/** Plugin-relative manifest paths (`./x`) as tree paths; invalid ones become `path-unsafe` issues. */
export function manifestPaths(state: LoadState, value: unknown, field: string): string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') {
      state.issues.push({ code: 'path-unsafe', detail: `${field} entries must be paths` })
      continue
    }
    const parsed = parsePluginRelativePath(item)
    if (!parsed.ok) {
      state.issues.push({ code: 'path-unsafe', detail: `${field}: ${item} is not a ./ path inside the plugin` })
      continue
    }
    out.push(parsed.segments.join('/'))
  }
  return out
}

export function component(
  state: LoadState,
  kind: PluginComponentKind,
  name: string,
  status: PluginComponentDto['status'],
  reason?: PluginComponentDto['reason'],
  detail?: string
): void {
  state.components.push({ kind, name, status, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) })
}

/** Symlinks and submodules are never installed; each one is listed so nothing disappears silently. */
export function linkComponents(state: LoadState): void {
  let listed = 0
  let extra = 0
  for (const entry of state.tree.entries.values()) {
    if (entry.mode !== 'symlink' && entry.mode !== 'submodule') continue
    if (listed >= MAX_LISTED_LINKS) {
      extra += 1
      continue
    }
    listed += 1
    if (entry.mode === 'symlink') component(state, 'symlink', entry.path, 'not-run', 'symlink-skipped')
    else component(state, 'submodule', entry.path, 'not-run', 'submodule-skipped')
  }
  if (extra) state.issues.push({ code: 'links-truncated', detail: `${extra} more links are not listed` })
}

export function findLicenseFile(tree: PackageTree): string | null {
  for (const key of [...tree.entries.keys()].sort())
    if (!key.includes('/') && LICENSE_FILE.test(key) && hasFile(tree, key)) return key
  return null
}

/** Components for normalized MCP servers and the entries that were skipped. */
export function mcpComponents(state: LoadState, mcp: NormalizedMcp): void {
  for (const server of mcp.servers) {
    if (server.auth.kind === 'oauth' && server.auth.placeholderClient)
      component(state, 'mcp-server', server.key, 'supported', 'auth-placeholder-client')
    else if (server.auth.kind === 'manual')
      component(state, 'mcp-server', server.key, 'supported', 'auth-publisher-client')
    else component(state, 'mcp-server', server.key, 'supported')
  }
  for (const issue of mcp.issues) {
    if (issue.code === 'transport-unsupported')
      component(state, 'mcp-server', issue.subject, 'unavailable', 'transport-unsupported', issue.detail)
    else if (issue.code === 'mcp-bundle')
      component(state, 'mcp-bundle', issue.subject, 'not-run', 'component-unsupported', issue.detail)
    else component(state, 'mcp-server', issue.subject, 'invalid', 'entry-invalid', issue.detail)
  }
}

/** App connectors are hosted by OpenAI and never run outside it; each declared app is listed. */
export async function appComponents(state: LoadState, path: string): Promise<void> {
  if (!state.tree.entries.has(path)) return
  const json = await readJson(state, path)
  if (!isRecord(json) || !isRecord(json.apps)) {
    component(state, 'app-connector', path, 'invalid', 'entry-invalid')
    return
  }
  // An empty `apps` map declares no connector: the plugin is its skills and servers alone.
  for (const app of Object.keys(json.apps)) component(state, 'app-connector', app, 'unavailable', 'app-connector')
}

export function hooksComponent(state: LoadState, name: string): void {
  component(state, 'hooks', name, 'not-run', 'hooks-not-run')
}

/** Markdown agents in a directory (immediate `*.md` children) or listed files; none run until adapted. */
export function agentComponents(state: LoadState, sources: readonly string[]): void {
  const files = new Set<string>()
  for (const source of sources) {
    if (/\.md$/i.test(source)) {
      if (hasFile(state.tree, source)) files.add(source)
      continue
    }
    const prefix = source ? `${source}/` : ''
    for (const key of state.tree.entries.keys()) {
      const rel = key.slice(prefix.length)
      if (key.startsWith(prefix) && !rel.includes('/') && /\.md$/i.test(rel) && !/\.md\.tmpl$/i.test(rel))
        files.add(key)
    }
  }
  for (const file of [...files].sort()) component(state, 'agent', file, 'not-run', 'agent-not-adapted')
}

export interface DisplayInterface {
  displayName: string | null
  shortDescription: string | null
  developerName: string | null
  category: string | null
  capabilities: string[]
  website: string | null
  privacy: string | null
  terms: string | null
  support: string | null
  logoPath: string | null
}

/** Codex `interface` (also `extensions["com.openai"].interface` of an Agent Plugins manifest). */
export function parseCodexInterface(state: LoadState, raw: unknown): DisplayInterface {
  const value = isRecord(raw) ? raw : {}
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, 20)
    : []
  let logoPath: string | null = null
  for (const field of ['logo', 'composerIcon']) {
    const logo = value[field]
    if (logoPath || typeof logo !== 'string') continue
    const parsed = parsePluginRelativePath(logo)
    if (parsed.ok && parsed.segments.length && hasFile(state.tree, parsed.segments.join('/')))
      logoPath = parsed.segments.join('/')
    else if (!parsed.ok) state.issues.push({ code: 'path-unsafe', detail: `interface.${field}: ${logo}` })
  }
  return {
    displayName: str(value.displayName),
    shortDescription: str(value.shortDescription),
    developerName: str(value.developerName),
    category: str(value.category),
    capabilities,
    website: httpsUrl(value.websiteURL ?? value.websiteUrl),
    privacy: httpsUrl(value.privacyPolicyURL ?? value.privacyPolicyUrl),
    terms: httpsUrl(value.termsOfServiceURL ?? value.termsOfServiceUrl),
    support: httpsUrl(value.supportURL ?? value.supportUrl),
    logoPath,
  }
}

/** An http(s) URL suitable to show as a link, or null. */
export function httpsUrl(value: unknown): string | null {
  const text = str(value)
  if (!text) return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

export function authorName(value: unknown): string | null {
  if (typeof value === 'string') return str(value)
  return isRecord(value) ? str(value.name) : null
}

export { join as joinTree }
