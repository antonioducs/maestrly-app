import type { PluginPolicyDto } from '../../shared/plugins'
import type { ClaudeEntryOverlay } from './formats/claude'
import { pluginNameOrNull } from './formats/codex'
import { isRecord, str } from './formats/shared'
import { PLUGIN_LIMITS } from './limits'
import { AGENT_PLUGINS_SCHEMA_PREFIX } from './mcp-normalize'
import type { PackageTree } from './package-tree'
import { isSafeTreePath, parsePluginRelativePath } from './paths'

export type PluginEntrySource =
  /** Repo-relative, normalized, inside the marketplace root. */
  | { kind: 'path'; path: string }
  | { kind: 'git'; url: string; ref: string | null; sha: string | null; path: string | null }
  | { kind: 'unsupported'; type: string }
export interface MarketplaceEntry {
  name: string
  source: PluginEntrySource
  policy: PluginPolicyDto
  category: string | null
  display: { displayName?: string; description?: string; version?: string }
  claude?: ClaudeEntryOverlay
}
export interface ParsedMarketplace {
  name: string
  displayName: string | null
  format: 'codex' | 'claude' | 'single-plugin'
  /** Repo-relative root (`''` = repository root). */
  root: string
  entries: MarketplaceEntry[]
  issues: { code: string; detail: string }[]
}
export const MARKETPLACE_FILES = [
  '.agents/plugins/marketplace.json',
  '.agents/plugins/api_marketplace.json',
  '.claude-plugin/marketplace.json',
] as const

export interface ReadMarketplaceOptions {
  /** Validates a Git URL of an entry; defaults to `normalizeGitUrl`. */
  acceptUrl?: (url: string) => string | null
  /** Name of a single-plugin source (usually the repository slug). */
  fallbackName?: string
}

const SHA = /^[0-9a-f]{40}$/
const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const CLAUDE_ENTRY_RESERVED = new Set([
  'name',
  'source',
  'strict',
  'category',
  'tags',
  'relevance',
  'dependencies',
  'metadata',
  'defaultEnabled',
  'headers',
  'headersHelper',
])
const DEFAULT_POLICY: PluginPolicyDto = { installation: 'AVAILABLE', authentication: null, products: [] }

/** Accepts `owner/repo` (GitHub) and https URLs without credentials or fragment; null otherwise. */
export function normalizeGitUrl(input: string): string | null {
  const value = typeof input === 'string' ? input.trim() : ''
  if (!value || value.length > 2048) return null
  if (OWNER_REPO.test(value) && !value.endsWith('.git.git')) {
    const [owner, repo] = value.split('/')
    return `https://github.com/${owner}/${repo.replace(/\.git$/, '')}.git`
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('#')) return null
  if (!url.hostname || url.search) return null
  return value.replace(/\/+$/, '')
}

const join = (root: string, segments: readonly string[]): string => [root, ...segments].filter(Boolean).join('/')

async function readJsonFile(tree: PackageTree, path: string, issues: ParsedMarketplace['issues']): Promise<unknown> {
  if (!tree.entries.has(path)) return undefined
  const raw = await tree.read(path, PLUGIN_LIMITS.marketplaceBytes)
  if (!raw) {
    issues.push({ code: 'marketplace-invalid', detail: `${path} is unreadable or larger than 1 MiB` })
    return undefined
  }
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    issues.push({ code: 'marketplace-invalid', detail: `${path} is not valid JSON` })
    return undefined
  }
}

function policyOf(value: unknown, codex: boolean): PluginPolicyDto {
  if (!codex) return { ...DEFAULT_POLICY }
  const raw = isRecord(value) ? value : {}
  const installation =
    raw.installation === 'NOT_AVAILABLE' || raw.installation === 'INSTALLED_BY_DEFAULT' ? raw.installation : 'AVAILABLE'
  const authentication = raw.authentication === 'ON_USE' ? 'ON_USE' : 'ON_INSTALL'
  const products = Array.isArray(raw.products)
    ? raw.products.filter((p): p is string => typeof p === 'string').slice(0, 20)
    : []
  return { installation, authentication, products }
}

/** Resolves a relative entry path inside the marketplace root; null (with an issue) when it escapes. */
function relativeSource(
  root: string,
  value: string,
  issues: ParsedMarketplace['issues'],
  name: string
): PluginEntrySource | null {
  const parsed = parsePluginRelativePath(value)
  if (!parsed.ok) {
    issues.push({ code: 'entry-invalid', detail: `${name}: ${value} is not a ./ path inside the marketplace` })
    return null
  }
  const path = join(root, parsed.segments)
  if (path && !isSafeTreePath(path)) {
    issues.push({ code: 'entry-invalid', detail: `${name}: unsafe path ${value}` })
    return null
  }
  return { kind: 'path', path }
}

function gitSource(
  raw: Record<string, unknown>,
  url: unknown,
  path: unknown,
  accept: (url: string) => string | null,
  issues: ParsedMarketplace['issues'],
  name: string
): PluginEntrySource | null {
  const canonical = typeof url === 'string' ? accept(url) : null
  if (!canonical) {
    issues.push({ code: 'entry-invalid', detail: `${name}: unsupported Git URL` })
    return null
  }
  const sha = raw.sha === undefined ? null : typeof raw.sha === 'string' && SHA.test(raw.sha) ? raw.sha : undefined
  if (sha === undefined) {
    issues.push({ code: 'entry-invalid', detail: `${name}: sha must be a full 40-character commit` })
    return null
  }
  let subPath: string | null = null
  if (path !== undefined) {
    const parsed = typeof path === 'string' ? parsePluginRelativePath(path.startsWith('./') ? path : `./${path}`) : null
    if (!parsed?.ok || !parsed.segments.length) {
      issues.push({ code: 'entry-invalid', detail: `${name}: invalid subdirectory` })
      return null
    }
    subPath = parsed.segments.join('/')
  }
  const ref = str(raw.ref)
  if (ref && (ref.startsWith('-') || /[\s~^:?*[\\]/.test(ref) || ref.includes('..'))) {
    issues.push({ code: 'entry-invalid', detail: `${name}: invalid ref` })
    return null
  }
  return { kind: 'git', url: canonical, ref, sha, path: subPath }
}

function codexEntry(
  root: string,
  raw: Record<string, unknown>,
  name: string,
  accept: (url: string) => string | null,
  issues: ParsedMarketplace['issues']
): MarketplaceEntry | null {
  const sourceValue = raw.source
  let source: PluginEntrySource | null
  if (typeof sourceValue === 'string') source = relativeSource(root, sourceValue, issues, name)
  else if (isRecord(sourceValue)) {
    const type = typeof sourceValue.source === 'string' ? sourceValue.source : 'unknown'
    if (type === 'local')
      source = typeof sourceValue.path === 'string' ? relativeSource(root, sourceValue.path, issues, name) : null
    else if (type === 'url') source = gitSource(sourceValue, sourceValue.url, sourceValue.path, accept, issues, name)
    else if (type === 'git-subdir')
      source = gitSource(sourceValue, sourceValue.url, sourceValue.path ?? null, accept, issues, name)
    else source = { kind: 'unsupported', type }
    if (type === 'git-subdir' && source?.kind === 'git' && !source.path) {
      issues.push({ code: 'entry-invalid', detail: `${name}: git-subdir needs a path` })
      source = null
    }
  } else source = null
  if (!source) {
    if (!issues.some((issue) => issue.detail.startsWith(`${name}:`)))
      issues.push({ code: 'entry-invalid', detail: `${name}: invalid source` })
    return null
  }
  const iface = isRecord(raw.interface) ? raw.interface : {}
  const displayName = str(iface.displayName)
  return {
    name,
    source,
    policy: policyOf(raw.policy, true),
    category: str(raw.category),
    display: displayName ? { displayName } : {},
  }
}

function claudeEntry(
  root: string,
  pluginRoot: string | null,
  raw: Record<string, unknown>,
  name: string,
  accept: (url: string) => string | null,
  issues: ParsedMarketplace['issues']
): MarketplaceEntry | null {
  const sourceValue = raw.source
  let source: PluginEntrySource | null
  if (typeof sourceValue === 'string') {
    if (sourceValue === '.' || sourceValue.startsWith('./')) source = relativeSource(root, sourceValue, issues, name)
    else if (pluginRoot !== null && /^[A-Za-z0-9._-]+$/.test(sourceValue) && sourceValue !== '..')
      source = relativeSource(join(root, pluginRoot ? pluginRoot.split('/') : []), `./${sourceValue}`, issues, name)
    else {
      issues.push({ code: 'entry-invalid', detail: `${name}: relative sources must start with ./` })
      source = null
    }
  } else if (isRecord(sourceValue)) {
    const type = typeof sourceValue.source === 'string' ? sourceValue.source : 'unknown'
    if (type === 'github') {
      const repo = typeof sourceValue.repo === 'string' && OWNER_REPO.test(sourceValue.repo) ? sourceValue.repo : null
      if (repo) source = gitSource(sourceValue, normalizeGitUrl(repo) ?? '', undefined, accept, issues, name)
      else {
        issues.push({ code: 'entry-invalid', detail: `${name}: invalid GitHub repository` })
        source = null
      }
    } else if (type === 'url') source = gitSource(sourceValue, sourceValue.url, undefined, accept, issues, name)
    else if (type === 'git-subdir') {
      const url =
        typeof sourceValue.url === 'string' && OWNER_REPO.test(sourceValue.url)
          ? normalizeGitUrl(sourceValue.url)
          : sourceValue.url
      source = gitSource(sourceValue, url, sourceValue.path, accept, issues, name)
    } else source = { kind: 'unsupported', type }
  } else {
    issues.push({ code: 'entry-invalid', detail: `${name}: invalid source` })
    source = null
  }
  if (!source) return null
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) if (!CLAUDE_ENTRY_RESERVED.has(key)) fields[key] = value
  const display: MarketplaceEntry['display'] = {}
  if (str(raw.displayName)) display.displayName = str(raw.displayName)!
  if (str(raw.description)) display.description = str(raw.description)!
  if (str(raw.version)) display.version = str(raw.version)!
  return {
    name,
    source,
    policy: policyOf(undefined, false),
    category: str(raw.category),
    display,
    claude: { strict: raw.strict !== false, fields },
  }
}

function entriesOf(
  list: unknown,
  file: string,
  issues: ParsedMarketplace['issues'],
  build: (raw: Record<string, unknown>, name: string) => MarketplaceEntry | null,
  seen: Set<string>,
  out: MarketplaceEntry[],
  reportDuplicates: boolean
): void {
  if (!Array.isArray(list)) {
    issues.push({ code: 'marketplace-invalid', detail: `${file}: plugins must be an array` })
    return
  }
  if (list.length > PLUGIN_LIMITS.marketplaceEntries)
    issues.push({
      code: 'marketplace-invalid',
      detail: `${file}: only ${PLUGIN_LIMITS.marketplaceEntries} entries read`,
    })
  for (const raw of list.slice(0, PLUGIN_LIMITS.marketplaceEntries)) {
    if (!isRecord(raw)) continue
    const name = pluginNameOrNull(raw.name)
    if (!name) {
      issues.push({ code: 'entry-invalid', detail: `${file}: invalid plugin name ${String(raw.name)}` })
      continue
    }
    if (seen.has(name)) {
      if (reportDuplicates) issues.push({ code: 'entry-duplicate', detail: `${file}: duplicate plugin ${name}` })
      continue
    }
    const entry = build(raw, name)
    if (!entry) continue
    seen.add(name)
    out.push(entry)
  }
}

async function singlePluginName(tree: PackageTree, root: string): Promise<string | null | undefined> {
  const prefix = root ? `${root}/` : ''
  const read = async (path: string) => {
    const raw = tree.entries.has(prefix + path) ? await tree.read(prefix + path, PLUGIN_LIMITS.jsonBytes) : null
    if (!raw) return undefined
    try {
      return JSON.parse(raw.toString('utf8')) as unknown
    } catch {
      return undefined
    }
  }
  const agent = await read('plugin.json')
  if (isRecord(agent) && typeof agent.$schema === 'string' && agent.$schema.startsWith(AGENT_PLUGINS_SCHEMA_PREFIX))
    return pluginNameOrNull(agent.name)
  for (const path of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    if (!tree.entries.has(prefix + path)) continue
    const manifest = await read(path)
    return isRecord(manifest) ? pluginNameOrNull(manifest.name) : null
  }
  return undefined
}

async function readAt(
  tree: PackageTree,
  root: string,
  opts: ReadMarketplaceOptions
): Promise<ParsedMarketplace | null> {
  const accept = opts.acceptUrl ?? normalizeGitUrl
  const prefix = root ? `${root}/` : ''
  const issues: ParsedMarketplace['issues'] = []
  const [codexMain, codexApi, claude] = MARKETPLACE_FILES.map((file) => prefix + file)
  if (tree.entries.has(codexMain) || tree.entries.has(codexApi)) {
    const entries: MarketplaceEntry[] = []
    const seen = new Set<string>()
    let name: string | null = null
    let displayName: string | null = null
    for (const [index, file] of [codexMain, codexApi].entries()) {
      const json = await readJsonFile(tree, file, issues)
      if (!isRecord(json)) continue
      name ??= str(json.name)
      displayName ??= isRecord(json.interface) ? str(json.interface.displayName) : null
      entriesOf(
        json.plugins,
        file,
        issues,
        (raw, entryName) => codexEntry(root, raw, entryName, accept, issues),
        seen,
        entries,
        index === 0
      )
    }
    return { name: name ?? opts.fallbackName ?? 'marketplace', displayName, format: 'codex', root, entries, issues }
  }
  if (tree.entries.has(claude)) {
    const json = await readJsonFile(tree, claude, issues)
    if (!isRecord(json))
      return {
        name: opts.fallbackName ?? 'marketplace',
        displayName: null,
        format: 'claude',
        root,
        entries: [],
        issues,
      }
    const metadata = isRecord(json.metadata) ? json.metadata : {}
    let pluginRoot: string | null = null
    if (typeof metadata.pluginRoot === 'string') {
      const value = metadata.pluginRoot.startsWith('./') ? metadata.pluginRoot : `./${metadata.pluginRoot}`
      const parsed = parsePluginRelativePath(value)
      if (parsed.ok) pluginRoot = parsed.segments.join('/')
      else issues.push({ code: 'marketplace-invalid', detail: 'metadata.pluginRoot leaves the marketplace' })
    }
    const entries: MarketplaceEntry[] = []
    entriesOf(
      json.plugins,
      claude,
      issues,
      (raw, entryName) => claudeEntry(root, pluginRoot, raw, entryName, accept, issues),
      new Set(),
      entries,
      true
    )
    return {
      name: str(json.name) ?? opts.fallbackName ?? 'marketplace',
      displayName: str(json.displayName),
      format: 'claude',
      root,
      entries,
      issues,
    }
  }
  const single = await singlePluginName(tree, root)
  if (single === undefined) return null
  const name = single ?? pluginNameOrNull(opts.fallbackName?.split('/').pop())
  if (!name) return null
  return {
    name: opts.fallbackName ?? name,
    displayName: null,
    format: 'single-plugin',
    root,
    entries: [
      { name, source: { kind: 'path', path: root }, policy: { ...DEFAULT_POLICY }, category: null, display: {} },
    ],
    issues,
  }
}

/**
 * Reads the marketplace of a source: the repository root, or each sparse path in order. Codex files win over the
 * Claude file at the same root; a root with only a plugin manifest is a single-plugin source.
 */
export async function readMarketplace(
  tree: PackageTree,
  roots: readonly string[],
  opts: ReadMarketplaceOptions = {}
): Promise<ParsedMarketplace | null> {
  for (const root of roots) {
    const clean = root.replace(/^\.?\/+|\/+$/g, '')
    if (clean && !isSafeTreePath(clean)) continue
    const found = await readAt(tree, clean, opts)
    if (found) return found
  }
  return null
}
