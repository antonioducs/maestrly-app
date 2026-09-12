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
  })
  return createHash('sha256').update(JSON.stringify(connection)).digest('hex')
}

function parseCatalog(): StoredCatalog {
  const raw = getAppSetting(MCP_CATALOG_KEY)
  if (!raw) return { version: 1, entries: {} }
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

export function readMcpCatalog(server: McpServer): ListedMcpTool[] {
  const entry = parseCatalog().entries[server.id]
  if (!entry || entry.fingerprint !== mcpServerFingerprint(server)) return []
  return sanitizeMcpCatalogTools(entry.tools)
}

export function writeMcpCatalog(server: McpServer, tools: readonly ListedMcpTool[]): void {
  const catalog = parseCatalog()
  catalog.entries[server.id] = {
    fingerprint: mcpServerFingerprint(server),
    refreshedAt: Date.now(),
    tools: sanitizeMcpCatalogTools(tools),
  }
  setAppSetting(MCP_CATALOG_KEY, JSON.stringify(catalog))
}

export function removeMcpCatalog(serverId: string): void {
  const catalog = parseCatalog()
  if (!(serverId in catalog.entries)) return
  delete catalog.entries[serverId]
  setAppSetting(MCP_CATALOG_KEY, JSON.stringify(catalog))
}
