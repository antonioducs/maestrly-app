import { createHash } from 'node:crypto'
import { getAppSetting, setAppSetting } from '../store'
import type { ListedMcpTool, McpServer } from './mcp-types'
import type { McpToolAnnotations } from './tool-policy'

export const MCP_CATALOG_KEY = 'chat.mcpCatalog.v1'

interface StoredCatalogEntry {
  fingerprint: string
  refreshedAt: number
  tools: ListedMcpTool[]
}

interface StoredCatalog {
  version: 1
  entries: Record<string, StoredCatalogEntry>
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)])
  )
}

export function mcpServerFingerprint(server: McpServer): string {
  const connection = canonical({
    transport: server.transport,
    url: server.url ?? null,
    headers: server.headers ?? {},
    command: server.command ?? null,
    args: server.args ?? [],
    env: server.env ?? {},
    // Only plugin servers set a working directory; leaving it out otherwise keeps existing fingerprints.
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
  })
  return createHash('sha256').update(JSON.stringify(connection)).digest('hex')
}

// A catalog with a few hundred tools weighs megabytes, and every server of every turn reads it. Parsing and sanitizing
// run again only when the stored text changes.
let parsedMemo: { raw: string; catalog: StoredCatalog } | undefined
const sanitizedEntries = new WeakMap<StoredCatalogEntry, ListedMcpTool[]>()

function parseCatalog(): StoredCatalog {
  const raw = getAppSetting(MCP_CATALOG_KEY)
  if (!raw) return { version: 1, entries: {} }
  if (parsedMemo?.raw === raw) return parsedMemo.catalog
  const catalog = parseStoredCatalog(raw)
  parsedMemo = { raw, catalog }
  return catalog
}

/** An unshared copy a writer may change: the memoized one belongs to the readers. */
function editableCatalog(): StoredCatalog {
  const raw = getAppSetting(MCP_CATALOG_KEY)
  return raw ? parseStoredCatalog(raw) : { version: 1, entries: {} }
}

function parseStoredCatalog(raw: string): StoredCatalog {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCatalog>
    if (
      parsed.version !== 1 ||
      !parsed.entries ||
      typeof parsed.entries !== 'object' ||
      Array.isArray(parsed.entries)
    ) {
      return { version: 1, entries: {} }
    }
    return { version: 1, entries: parsed.entries as Record<string, StoredCatalogEntry> }
  } catch {
    return { version: 1, entries: {} }
  }
}

function safeJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function safeAnnotations(value: unknown): McpToolAnnotations | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const out: McpToolAnnotations = {}
  if (typeof source.title === 'string') out.title = source.title
  if (typeof source.readOnlyHint === 'boolean') out.readOnlyHint = source.readOnlyHint
  if (typeof source.destructiveHint === 'boolean') out.destructiveHint = source.destructiveHint
  if (typeof source.idempotentHint === 'boolean') out.idempotentHint = source.idempotentHint
  if (typeof source.openWorldHint === 'boolean') out.openWorldHint = source.openWorldHint
  return Object.keys(out).length ? out : undefined
}

function safeTool(value: unknown): ListedMcpTool | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (typeof source.name !== 'string' || !source.name.trim()) return null
  const inputSchema = safeJsonObject(source.inputSchema)
  const annotations = safeAnnotations(source.annotations)
  return {
    name: source.name,
    ...(typeof source.title === 'string' ? { title: source.title } : {}),
    ...(typeof source.description === 'string' ? { description: source.description } : {}),
    ...(inputSchema ? { inputSchema } : {}),
    ...(annotations ? { annotations } : {}),
  }
}

export function sanitizeMcpCatalogTools(value: unknown): ListedMcpTool[] {
  if (!Array.isArray(value)) return []
  return value.map(safeTool).filter((entry): entry is ListedMcpTool => entry !== null)
}

export interface McpCatalogRead {
  tools: ListedMcpTool[]
  /** When the server was last listed. */
  refreshedAt: number
}

/** The cached tools of a server, or null when it was never listed or its connection settings changed since. */
export function readMcpCatalogEntry(server: McpServer): McpCatalogRead | null {
  const entry = parseCatalog().entries[server.id]
  if (!entry || entry.fingerprint !== mcpServerFingerprint(server)) return null
  let tools = sanitizedEntries.get(entry)
  if (!tools) {
    tools = sanitizeMcpCatalogTools(entry.tools)
    sanitizedEntries.set(entry, tools)
  }
  return { tools, refreshedAt: typeof entry.refreshedAt === 'number' ? entry.refreshedAt : 0 }
}

export function readMcpCatalog(server: McpServer): ListedMcpTool[] {
  return readMcpCatalogEntry(server)?.tools ?? []
}

export function writeMcpCatalog(server: McpServer, tools: readonly ListedMcpTool[]): void {
  const catalog = editableCatalog()
  catalog.entries[server.id] = {
    fingerprint: mcpServerFingerprint(server),
    refreshedAt: Date.now(),
    tools: sanitizeMcpCatalogTools(tools),
  }
  setAppSetting(MCP_CATALOG_KEY, JSON.stringify(catalog))
}

export function removeMcpCatalog(serverId: string): void {
  const catalog = editableCatalog()
  if (!(serverId in catalog.entries)) return
  delete catalog.entries[serverId]
  setAppSetting(MCP_CATALOG_KEY, JSON.stringify(catalog))
}
