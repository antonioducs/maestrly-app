import { createHash } from 'node:crypto'
import { asSchema } from '@ai-sdk/provider-utils'
import type { Tool, ToolSet } from 'ai'
import { ANTIGRAVITY_HOST_MCP_SERVER_NAME } from './permissions'

export interface HostToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const ANTIGRAVITY_TOOL_SIGNATURE_VERSION = 1

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
  return specs.sort((left, right) => left.name.localeCompare(right.name))
}

/** Covers names, descriptions, and schemas: a session is reusable only if the model saw exactly these tools. */
export function antigravityToolSignature(specs: readonly HostToolSpec[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: ANTIGRAVITY_TOOL_SIGNATURE_VERSION, specs }))
    .digest('hex')
}

/**
 * Antigravity loads MCP tools lazily: the model sees their names but not their descriptions or schemas, and guesses
 * arguments. The catalog below goes into the first prompt of every session so calls use the exact schemas.
 */
export function renderAntigravityToolCatalog(specs: readonly HostToolSpec[]): string {
  const lines = [
    '<maestrly_tools>',
    `Your only tools are the MCP tools of server "${ANTIGRAVITY_HOST_MCP_SERVER_NAME}" listed below. Call each one by its exact name; its arguments must match its JSON Schema exactly. Built-in Antigravity tools are disabled and any other tool is unavailable.`,
    ...specs.flatMap((spec) => [
      `- ${ANTIGRAVITY_HOST_MCP_SERVER_NAME}_${spec.name}: ${spec.description.replace(/\s+/g, ' ').trim()}`,
      `  arguments: ${JSON.stringify(spec.inputSchema)}`,
    ]),
    '</maestrly_tools>',
  ]
  return lines.join('\n')
}
