import { createHash } from 'node:crypto'
import type {
  InstalledPluginDto,
  PluginCatalogEntryDto,
  PluginCompatibility,
  PluginComponentStatus,
  PluginInputDto,
  PluginInspectionDto,
  PluginMcpServerDto,
} from '../../shared/plugins'
import { classifyPlugin } from './compatibility'
import { loadPluginPackage } from './formats/detect'
import { isRecord } from './formats/shared'
import { sparsePattern } from './git-source'
import { PLUGIN_LIMITS } from './limits'
import type { MarketplaceEntry } from './marketplace'
import type { PluginInputSpec, PluginMcpServerSpec, PluginStdioServerSpec } from './mcp-normalize'
import type { PackageTree } from './package-tree'
import { parsePluginRelativePath } from './paths'
import type { InstalledPluginRecord } from './store'
import type { LoadResult, PluginPackage } from './types'

const MAX_EXECUTABLES = 50
const MARKETPLACE_FILES = [
  '.agents/plugins/marketplace.json',
  '.agents/plugins/api_marketplace.json',
  '.claude-plugin/marketplace.json',
]
const MANIFESTS = ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']

const under = (root: string, rel: string): string => [root, rel].filter(Boolean).join('/')

/** Sparse patterns for the marketplace files of a source root (and a single-plugin manifest at that root). */
export const CATALOG_PATTERNS = (root: string): string[] =>
  [...MARKETPLACE_FILES, ...MANIFESTS].map((file) => sparsePattern(under(root, file)))

/** Manifests, MCP/app/hooks configuration and license files of one plugin. */
export const PLUGIN_METADATA_PATTERNS = (pluginPath: string): string[] => [
  ...[...MANIFESTS, 'mcp.json', '.mcp.json', '.app.json', 'hooks.json', 'hooks/hooks.json', '.lsp.json'].map((file) =>
    sparsePattern(under(pluginPath, file))
  ),
  ...['LICENSE*', 'LICENCE*', 'COPYING*', 'license*'].map((glob) =>
    pluginPath ? `${sparsePattern(pluginPath)}/${glob}` : `/${glob}`
  ),
]

/** Skill and command documents, which classification and the details view need. */
export const PLUGIN_DETAIL_PATTERNS = (pluginPath: string): string[] => {
  const base = pluginPath ? sparsePattern(pluginPath) : ''
  return [`${base}/**/SKILL.md`, `${base}/commands/*.md`, `${base}/agents/*.md`]
}

/** Extra patterns for paths a manifest declares outside the default locations (JSON files, skills, commands, logo). */
export async function manifestReferencedPatterns(tree: PackageTree, pluginPath: string): Promise<string[]> {
  const sub = tree.sub(pluginPath)
  const out = new Set<string>()
  const addPath = (value: unknown, kind: 'file' | 'dir') => {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== 'string') continue
      const parsed = parsePluginRelativePath(item)
      if (!parsed.ok) continue
      const rel = parsed.segments.join('/')
      const full = under(pluginPath, rel)
      if (kind === 'file' || /\.(json|md|png|jpe?g|webp)$/i.test(rel)) {
        if (full) out.add(sparsePattern(full))
      } else {
        const base = full ? sparsePattern(full) : ''
        out.add(`${base}/**/SKILL.md`)
        out.add(`${base}/*.md`)
      }
    }
  }
  for (const manifestPath of MANIFESTS) {
    const raw = await sub.read(manifestPath, PLUGIN_LIMITS.jsonBytes)
    if (!raw) continue
    let manifest: unknown
    try {
      manifest = JSON.parse(raw.toString('utf8'))
    } catch {
      continue
    }
    if (!isRecord(manifest)) continue
    addPath(manifest.skills, 'dir')
    addPath(manifest.commands, 'dir')
    addPath(manifest.agents, 'dir')
    if (typeof manifest.mcpServers === 'string' || Array.isArray(manifest.mcpServers))
      addPath(manifest.mcpServers, 'file')
    addPath(manifest.apps, 'file')
    if (typeof manifest.hooks === 'string' || Array.isArray(manifest.hooks)) addPath(manifest.hooks, 'file')
    if (isRecord(manifest.commands))
      for (const value of Object.values(manifest.commands)) if (isRecord(value)) addPath(value.source, 'file')
    const iface = isRecord(manifest.interface)
      ? manifest.interface
      : isRecord(manifest.extensions) && isRecord(manifest.extensions['com.openai'])
        ? (manifest.extensions['com.openai'] as Record<string, unknown>).interface
        : undefined
    if (isRecord(iface)) {
      addPath(iface.logo, 'file')
      addPath(iface.composerIcon, 'file')
    }
    if (isRecord(manifest.extensions) && isRecord(manifest.extensions['com.openai']))
      addPath((manifest.extensions['com.openai'] as Record<string, unknown>).apps, 'file')
  }
  return [...out]
}

export interface Inspection {
  pkg: PluginPackage | null
  load: LoadResult
  compatibility: PluginCompatibility
  consentFingerprint: string
  /** stdio serverKey → digest of its launch line. */
  launchDigests: Record<string, string>
  endpoints: string[]
  executables: string[]
  executablesTruncated: boolean
  requirements: string[]
  licenseText: { text: string | null; truncated: boolean }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const sorted = (record: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))

export function launchDigest(server: PluginStdioServerSpec): string {
  return sha256(
    JSON.stringify({ command: server.command, args: server.args, cwd: server.cwd, env: sorted(server.env) })
  )
}

/** Fingerprint of everything the user approves at install: stdio launch lines, MCP endpoints and executables. */
export function consentFingerprint(input: {
  launch: Record<string, string>
  endpoints: string[]
  executables: string[]
}): string {
  return sha256(
    JSON.stringify({
      launch: sorted(input.launch),
      endpoints: [...new Set(input.endpoints)].sort(),
      executables: [...new Set(input.executables)].sort(),
    })
  )
}

export function launchLine(server: PluginStdioServerSpec): string {
  const quote = (value: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : JSON.stringify(value))
  return [server.command, ...server.args].map(quote).join(' ')
}

function executablesOf(tree: PackageTree): { list: string[]; truncated: boolean } {
  const all = [...tree.entries.values()]
    .filter(
      (entry) => entry.mode === 'executable' || (entry.mode === 'file' && entry.path.split('/').includes('scripts'))
    )
    .map((entry) => entry.path)
    .sort()
  return { list: all.slice(0, MAX_EXECUTABLES), truncated: all.length > MAX_EXECUTABLES }
}

/** Loads and classifies the plugin of a marketplace entry from its (sub)tree. */
export async function inspectTree(tree: PackageTree, entry: MarketplaceEntry): Promise<Inspection> {
  const sourcePath =
    entry.source.kind === 'path' ? entry.source.path : entry.source.kind === 'git' ? (entry.source.path ?? '') : ''
  const load = await loadPluginPackage(tree, {
    claudeEntry: entry.claude,
    displayOverrides: { displayName: entry.display.displayName, description: entry.display.description },
    rootName: sourcePath.split('/').pop() || entry.name,
  })
  const compatibility = classifyPlugin(load, {
    sourceSupported: entry.source.kind !== 'unsupported',
    installation: entry.policy.installation,
  })
  const pkg = load.ok ? load.pkg : null
  const launchDigests: Record<string, string> = {}
  const mcpEndpoints: string[] = []
  const requirements = new Set<string>()
  for (const server of pkg?.mcpServers ?? []) {
    if (server.transport === 'stdio') {
      launchDigests[server.key] = launchDigest(server)
      if (server.commandKind === 'bare') requirements.add(server.command)
    } else mcpEndpoints.push(server.url)
  }
  const endpoints = [
    ...new Set(
      [...mcpEndpoints, pkg?.homepage, pkg?.links.privacy, pkg?.links.terms, pkg?.links.support].filter(
        (value): value is string => !!value
      )
    ),
  ]
  const executables = executablesOf(tree)
  let licenseText: Inspection['licenseText'] = { text: null, truncated: false }
  if (pkg?.license.file) {
    const raw = await tree.read(pkg.license.file, PLUGIN_LIMITS.fileBytes)
    if (raw)
      licenseText = {
        text: raw.subarray(0, PLUGIN_LIMITS.licenseBytes).toString('utf8'),
        truncated: raw.length > PLUGIN_LIMITS.licenseBytes,
      }
  }
  return {
    pkg,
    load,
    compatibility,
    consentFingerprint: consentFingerprint({
      launch: launchDigests,
      endpoints: mcpEndpoints,
      executables: executables.list,
    }),
    launchDigests,
    endpoints,
    executables: executables.list,
    executablesTruncated: executables.truncated,
    requirements: [...requirements].sort(),
    licenseText,
  }
}

const componentStatus = (pkg: PluginPackage, key: string): PluginComponentStatus =>
  pkg.components.find((c) => c.kind === 'mcp-server' && c.name === key)?.status ?? 'supported'

export function mcpServerDtos(
  pkg: PluginPackage,
  installed?: InstalledPluginRecord,
  extra?: (server: PluginMcpServerSpec) => Partial<PluginMcpServerDto>
): PluginMcpServerDto[] {
  return pkg.mcpServers.map((server) => {
    const record = installed?.servers[server.key]
    const base: PluginMcpServerDto = {
      key: server.key,
      id: record?.id ?? null,
      transport: server.transport,
      endpoint: server.transport === 'stdio' ? launchLine(server) : safeHost(server.url),
      launch: server.transport === 'stdio' ? launchLine(server) : null,
      auth: server.auth.kind,
      status: componentStatus(pkg, server.key),
      ...(installed
        ? {
            enabled: record?.enabled ?? false,
            ...(server.transport === 'stdio'
              ? { consented: installed.consent.stdio[server.key] === launchDigest(server) }
              : {}),
          }
        : {}),
    }
    return { ...base, ...(extra?.(server) ?? {}) }
  })
}

function safeHost(url: string): string {
  try {
    return new URL(url.replace(/\$\{[^}]*\}/g, 'placeholder')).host
  } catch {
    return url
  }
}

export function inputDtos(inputs: readonly PluginInputSpec[], setIds: ReadonlySet<string>): PluginInputDto[] {
  return inputs.map((input) => ({
    id: input.id,
    label: input.label,
    description: input.description,
    sensitive: input.sensitive,
    required: input.required,
    set: setIds.has(input.id),
    target: input.target.kind,
    serverKey: input.target.kind === 'config' ? null : input.target.serverKey,
  }))
}

export function skillDtos(pkg: PluginPackage): PluginInspectionDto['skills'] {
  return pkg.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    kind: skill.kind,
    hasScripts: skill.hasScripts,
  }))
}

export function toCatalogEntryDto(input: {
  marketplaceId: string
  entry: MarketplaceEntry
  inspection: Inspection | null
  installed: boolean
  updateAvailable: boolean
}): PluginCatalogEntryDto {
  const { entry, inspection } = input
  const pkg = inspection?.pkg ?? null
  return {
    marketplaceId: input.marketplaceId,
    name: entry.name,
    displayName: pkg?.displayName ?? entry.display.displayName ?? entry.name,
    description: pkg?.description ?? entry.display.description ?? null,
    publisher: pkg?.publisher ?? null,
    category: entry.category ?? pkg?.category ?? null,
    version: pkg?.version ?? entry.display.version ?? null,
    format: pkg?.format ?? null,
    compatibility:
      entry.source.kind === 'unsupported'
        ? { level: 'unavailable', reasons: [{ code: 'source-unsupported', detail: entry.source.type }] }
        : (inspection?.compatibility ?? null),
    installed: input.installed,
    updateAvailable: input.updateAvailable,
    hasLogo: !!pkg?.logoPath,
    policy: entry.policy,
  }
}

export function toInspectionDto(input: {
  marketplaceId: string
  entry: MarketplaceEntry
  inspection: Inspection
  source: { url: string; path: string | null; commit: string }
  installed?: InstalledPluginRecord
  inputsSet?: ReadonlySet<string>
  updateAvailable?: boolean
}): PluginInspectionDto {
  const { inspection } = input
  const pkg = inspection.pkg
  const catalog = toCatalogEntryDto({
    marketplaceId: input.marketplaceId,
    entry: input.entry,
    inspection,
    installed: !!input.installed,
    updateAvailable: input.updateAvailable ?? false,
  })
  return {
    ...catalog,
    compatibility: catalog.compatibility ?? inspection.compatibility,
    source: input.source,
    license: {
      spdx: pkg?.license.spdx ?? null,
      text: inspection.licenseText.text,
      truncated: inspection.licenseText.truncated,
    },
    homepage: pkg?.homepage ?? null,
    links: pkg?.links ?? {},
    capabilities: pkg?.capabilities ?? [],
    skills: pkg ? skillDtos(pkg) : [],
    mcpServers: pkg ? mcpServerDtos(pkg, input.installed) : [],
    components: pkg?.components ?? [],
    endpoints: inspection.endpoints,
    inputs: pkg ? inputDtos(pkg.inputs, input.inputsSet ?? new Set()) : [],
    executables: inspection.executables,
    executablesTruncated: inspection.executablesTruncated,
    requirements: inspection.requirements,
    consentFingerprint: inspection.consentFingerprint,
    issues: [
      ...(inspection.load.ok ? [] : [{ code: inspection.load.code, detail: inspection.load.detail }]),
      ...(pkg?.issues ?? []),
    ],
  }
}

export type { InstalledPluginDto }
