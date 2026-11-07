import type { ListedMcpTool } from './mcp-types'

/**
 * What the model learns about external MCP tools without their schemas: a small index to know they exist, and a
 * ranked, bounded search to read the few it needs. One server can declare hundreds of tools, so nothing here ever
 * returns a whole catalog with its schemas.
 */

/** Size of the tool index in the description of `mcp_search`, about 2.5k tokens at the conservative 3.5 chars/token. */
export const MCP_DIRECTORY_BUDGET_CHARS = 9_000
/** Tools returned with their schema by one search. */
export const MCP_SEARCH_DEFAULT_LIMIT = 8
export const MCP_SEARCH_MAX_LIMIT = 25
/** Names returned by one listing, when a search names no query. */
export const MCP_LIST_DEFAULT_LIMIT = 200
export const MCP_LIST_MAX_LIMIT = 500
/** Characters of schemas one search returns; the lower ranks are left for a narrower query. */
export const MCP_SEARCH_RESULT_MAX_CHARS = 60_000
/** Characters of a tool's schema repeated in the error of a call with invalid arguments. */
export const MCP_SCHEMA_HINT_MAX_CHARS = 3_000

export interface McpDirectoryServer {
  /** How the model names the server in `mcp_search`: its display name, or its id when two share one. */
  label: string
  id: string
  /** Cached tool names; null when the server was never listed. */
  tools: readonly string[] | null
}

/** A server as the model reads it: its name, and the id a call can use too. */
export function mcpServerTitle(server: Pick<McpDirectoryServer, 'label' | 'id'>): string {
  return server.label === server.id ? server.id : `${server.label} (${server.id})`
}

function clipNames(names: readonly string[], maxChars: number): { text: string; shown: number } {
  let text = ''
  let shown = 0
  for (const name of names) {
    const next = shown === 0 ? name : `${text}, ${name}`
    if (next.length > maxChars) break
    text = next
    shown += 1
  }
  return { text, shown }
}

/**
 * Index of the cached tools of each server, names only. A small server lists everything; what a large one does not
 * fit in is counted, and found with a search. The budget is shared so that no server hides another.
 */
export function renderMcpDirectory(
  servers: readonly McpDirectoryServer[],
  budgetChars = MCP_DIRECTORY_BUDGET_CHARS
): string {
  const listed = servers.filter((server) => server.tools && server.tools.length > 0)
  const cold = servers.filter((server) => !server.tools || server.tools.length === 0)
  const lines: string[] = []
  let remaining =
    budgetChars - cold.reduce((sum, server) => sum + mcpServerTitle(server).length + server.label.length + 90, 0)
  // Smallest first: each server gets an equal share of what is left, and the ones that need less hand the rest on.
  const order = [...listed].sort((a, b) => (a.tools?.length ?? 0) - (b.tools?.length ?? 0))
  const rendered = new Map<McpDirectoryServer, string>()
  order.forEach((server, index) => {
    const names = server.tools ?? []
    const prefix = `- ${mcpServerTitle(server)}, ${names.length} tools: `
    const share = Math.max(0, Math.floor(remaining / (order.length - index)) - prefix.length - 40)
    const { text, shown } = clipNames(names, share)
    const more = names.length - shown
    const line = `${prefix}${text}${more > 0 ? `${shown > 0 ? ', ' : ''}… +${more} more (search by keyword)` : ''}`
    rendered.set(server, line)
    remaining -= line.length + 1
  })
  for (const server of servers) {
    const line = rendered.get(server)
    lines.push(
      line ?? `- ${mcpServerTitle(server)}: tools not listed yet; call mcp_search with server "${server.label}".`
    )
  }
  return lines.join('\n')
}

/** Lowercase words of a tool name or text, split at punctuation, underscores, hyphens and camelCase. */
export function searchTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Tools that match a query, best first. Every word counts; one that is in all words of the query counts more. */
export function rankMcpTools<T extends ListedMcpTool>(tools: readonly T[], query: string): T[] {
  const wanted = [...new Set(searchTokens(query))]
  const phrase = query.trim().toLowerCase()
  if (wanted.length === 0) return []
  const scored: Array<{ tool: T; score: number; index: number }> = []
  tools.forEach((tool, index) => {
    const name = tool.name.toLowerCase()
    const document = `${tool.title ?? ''}\n${tool.description ?? ''}`.toLowerCase()
    const nameWords = new Set(searchTokens(tool.name))
    const documentWords = new Set(searchTokens(document))
    let score = name === phrase ? 40 : 0
    let matched = 0
    for (const word of wanted) {
      let hit = 0
      if (nameWords.has(word)) hit += 6
      else if (name.includes(word)) hit += 4
      if (documentWords.has(word)) hit += 2
      else if (document.includes(word)) hit += 1
      if (hit > 0) matched += 1
      score += hit
    }
    if (matched === 0) return
    if (matched === wanted.length) score += 8
    if (phrase.length > 2 && (name.includes(phrase) || document.includes(phrase))) score += 6
    scored.push({ tool, score, index })
  })
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.tool)
}

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/** The leading items whose sizes fit `maxChars`; the first is always kept, however large. */
export function takeWithinChars<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  maxChars: number
): { taken: T[]; omitted: number } {
  const taken: T[] = []
  let used = 0
  for (const item of items) {
    const size = sizeOf(item)
    if (taken.length > 0 && used + size > maxChars) break
    taken.push(item)
    used += size
  }
  return { taken, omitted: items.length - taken.length }
}

/** The input schema of a tool, clipped, to repeat in the error of a call that did not match it. */
export function schemaHint(tool: Pick<ListedMcpTool, 'inputSchema'>): string {
  const text = JSON.stringify(tool.inputSchema ?? { type: 'object', properties: {} })
  return text.length > MCP_SCHEMA_HINT_MAX_CHARS ? `${text.slice(0, MCP_SCHEMA_HINT_MAX_CHARS)}…` : text
}
