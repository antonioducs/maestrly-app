import { createHash } from 'node:crypto'
import { asSchema } from '@ai-sdk/provider-utils'
import type { Tool, ToolSet } from 'ai'
import { ANTIGRAVITY_HOST_MCP_SERVER_NAME } from './permissions'

export interface HostToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const ANTIGRAVITY_TOOL_SIGNATURE_VERSION = 2

/**
 * Bytes the catalog may take before tools lose their schemas in it. The runtime keeps only the first 192,000 bytes
 * of a prompt, and a new session's first prompt also carries the instructions, the seed transcript and the message.
 * Maestrly's own tools take about 80 KB; one MCP server can add more than 100 KB on its own.
 */
export const ANTIGRAVITY_TOOL_CATALOG_MAX_BYTES = 96_000

/** Host tool that returns the descriptions and schemas the catalog leaves out. */
export const ANTIGRAVITY_TOOL_SCHEMAS_TOOL = 'get_tool_schemas'
const TOOL_SCHEMAS_MAX_NAMES = 25
const SUMMARY_MAX_CHARS = 160
const PREFIX = `${ANTIGRAVITY_HOST_MCP_SERVER_NAME}_`

const TOOL_SCHEMAS_SPEC: HostToolSpec = {
  name: ANTIGRAVITY_TOOL_SCHEMAS_TOOL,
  description:
    'Returns the full description and JSON Schema of tools that <maestrly_tools> lists without arguments. Call it before using one of them for the first time.',
  inputSchema: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: TOOL_SCHEMAS_MAX_NAMES,
        description: 'Tool names as listed in <maestrly_tools>.',
      },
    },
    required: ['names'],
    additionalProperties: false,
  },
}

const byName = (left: HostToolSpec, right: HostToolSpec) => left.name.localeCompare(right.name)

/** MCP tool definitions for every executable tool in the set, sorted by name. */
export async function hostToolSpecs(tools: ToolSet): Promise<HostToolSpec[]> {
  const specs: HostToolSpec[] = []
  for (const [name, raw] of Object.entries(tools)) {
    const tool = raw as Tool
    if (!tool || typeof tool.execute !== 'function' || !tool.inputSchema) continue
    const jsonSchema = (await asSchema(tool.inputSchema).jsonSchema) as Record<string, unknown>
    specs.push({
      name,
      description:
        typeof tool.description === 'string' && tool.description ? tool.description : `Maestrly tool ${name}.`,
      inputSchema: jsonSchema && typeof jsonSchema === 'object' ? jsonSchema : { type: 'object' },
    })
  }
  return specs.sort(byName)
}

/**
 * Covers names, descriptions, schemas, and which tools the catalog summarized: a session is reusable only if the
 * model saw exactly this catalog.
 */
export function antigravityToolSignature(specs: readonly HostToolSpec[], summarized: Iterable<string> = []): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: ANTIGRAVITY_TOOL_SIGNATURE_VERSION, specs, summarized: [...summarized].sort() }))
    .digest('hex')
}

function summarize(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat
  return sentence.length <= SUMMARY_MAX_CHARS ? sentence : `${sentence.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`
}

/**
 * Antigravity loads MCP tools lazily: the model sees their names but not their descriptions or schemas, and guesses
 * arguments. The catalog below goes into the first prompt of every session so calls use the exact schemas. Tools in
 * `summarized` get one line each; the model fetches their schemas with `get_tool_schemas`.
 */
export function renderAntigravityToolCatalog(
  specs: readonly HostToolSpec[],
  summarized: ReadonlySet<string> = new Set()
): string {
  const brief = specs.filter((spec) => summarized.has(spec.name))
  const lines = [
    '<maestrly_tools>',
    `Your only tools are the MCP tools of server "${ANTIGRAVITY_HOST_MCP_SERVER_NAME}" listed below. Call each one by its exact name; its arguments must match its JSON Schema exactly. Built-in Antigravity tools are disabled and any other tool is unavailable.`,
    ...specs
      .filter((spec) => !summarized.has(spec.name))
      .flatMap((spec) => [
        `- ${PREFIX}${spec.name}: ${spec.description.replace(/\s+/g, ' ').trim()}`,
        `  arguments: ${JSON.stringify(spec.inputSchema)}`,
      ]),
    ...(brief.length
      ? [
          `The tools below are listed without their JSON Schemas to keep this prompt small. Before calling one for the first time, call ${PREFIX}${ANTIGRAVITY_TOOL_SCHEMAS_TOOL} with its name (several names per call are fine), then pass arguments that match the returned schema exactly.`,
          ...brief.map((spec) => `- ${PREFIX}${spec.name}: ${summarize(spec.description)}`),
        ]
      : []),
    '</maestrly_tools>',
  ]
  return lines.join('\n')
}

export interface AntigravityToolCatalogPlan {
  /** Every tool the host serves: `specs`, plus `get_tool_schemas` when some tool is summarized. */
  specs: HostToolSpec[]
  /** Tools the catalog lists by name and summary only. */
  summarized: ReadonlySet<string>
  catalog: string
}

/**
 * Keeps the catalog within `maxBytes` by summarizing whole tiers of tools in order (external MCP tools before app
 * tools, for example) until it fits. Tools in no tier always keep their schemas. The plan depends only on the specs,
 * so the same tools always produce the same catalog and signature.
 */
export function planAntigravityToolCatalog(
  specs: readonly HostToolSpec[],
  tiers: readonly (readonly string[])[] = [],
  maxBytes = ANTIGRAVITY_TOOL_CATALOG_MAX_BYTES
): AntigravityToolCatalogPlan {
  const full = renderAntigravityToolCatalog(specs)
  const unchanged = { specs: [...specs], summarized: new Set<string>(), catalog: full }
  if (Buffer.byteLength(full, 'utf8') <= maxBytes || specs.some((spec) => spec.name === TOOL_SCHEMAS_SPEC.name)) {
    return unchanged
  }
  const served = [...specs, TOOL_SCHEMAS_SPEC].sort(byName)
  const present = new Set(specs.map((spec) => spec.name))
  const summarized = new Set<string>()
  let catalog = full
  for (const tier of tiers) {
    const before = summarized.size
    for (const name of tier) if (present.has(name)) summarized.add(name)
    if (summarized.size === before) continue
    catalog = renderAntigravityToolCatalog(served, summarized)
    if (Buffer.byteLength(catalog, 'utf8') <= maxBytes) break
  }
  return summarized.size ? { specs: served, summarized, catalog } : unchanged
}

/** Answer of `get_tool_schemas`: the full entry of each requested tool, in the catalog's format. */
export function antigravityToolSchemasText(specs: readonly HostToolSpec[], input: unknown): string {
  const raw = (input as { names?: unknown } | null)?.names
  const requested = (Array.isArray(raw) ? raw : [])
    .filter((name): name is string => typeof name === 'string' && Boolean(name.trim()))
    .slice(0, TOOL_SCHEMAS_MAX_NAMES)
  if (!requested.length) return `Pass the tool names in "names" (at most ${TOOL_SCHEMAS_MAX_NAMES}).`
  const index = new Map(specs.map((spec) => [spec.name, spec]))
  const entries: string[] = []
  const unknown: string[] = []
  for (const name of requested) {
    const trimmed = name.trim()
    const spec =
      index.get(trimmed) ?? (trimmed.startsWith(PREFIX) ? index.get(trimmed.slice(PREFIX.length)) : undefined)
    if (!spec) {
      unknown.push(trimmed)
      continue
    }
    entries.push(
      `- ${PREFIX}${spec.name}: ${spec.description.replace(/\s+/g, ' ').trim()}\n  arguments: ${JSON.stringify(spec.inputSchema)}`
    )
  }
  if (unknown.length) entries.push(`Unknown tools: ${unknown.join(', ')}. Use the names listed in <maestrly_tools>.`)
  return entries.join('\n')
}
