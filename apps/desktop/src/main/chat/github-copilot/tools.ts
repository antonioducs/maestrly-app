import { asSchema } from '@ai-sdk/provider-utils'
import type { Tool as AiTool, ToolSet } from 'ai'
import type { Tool as CopilotTool } from '@github/copilot-sdk'
import { toolOutputImages, toolOutputText, type ToolOutput } from '../../../shared/chat'
import {
  modelOutputToChatToolOutput,
  stripToolOutputMetadata,
  toolOutputIsError,
  toolOutputToCopilotResult,
} from '../tool-output'

export const COPILOT_TOOL_SEARCH_DEFER_THRESHOLD = 0

export interface CopilotToolCatalogProfile {
  total: number
  eager: number
  deferred: number
  serializedBytes: number
  schemaBytes: number
  descriptionBytes: number
  largestDescriptionBytes: number
}

export interface MergedCopilotToolSet {
  tools: ToolSet
  deferredToolNames: ReadonlySet<string>
}

/**
 * Preserves the established Copilot collision order (task > skill > app > MCP > core) while deriving defer
 * policy from the effective owner of every tool name.
 */
export function mergeCopilotToolSets(
  core: ToolSet,
  mcp: ToolSet,
  app: ToolSet,
  skill: ToolSet,
  task: ToolSet
): MergedCopilotToolSet {
  const tools: ToolSet = { ...core, ...mcp, ...app, ...skill, ...task }
  const deferredToolNames = new Set([...Object.keys(mcp), ...Object.keys(app)])
  for (const name of Object.keys(skill)) deferredToolNames.delete(name)
  for (const name of Object.keys(task)) deferredToolNames.delete(name)
  return { tools, deferredToolNames }
}

/** Returns an anonymous, deterministic size profile suitable for persistent diagnostics. */
export function profileCopilotTools(tools: readonly CopilotTool[]): CopilotToolCatalogProfile {
  const declarations = [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      description: entry.description ?? '',
      parameters: entry.parameters ?? {},
      defer: entry.defer ?? 'auto',
    }))
  const descriptionSizes = declarations.map((entry) => Buffer.byteLength(entry.description, 'utf8'))
  return {
    total: declarations.length,
    eager: declarations.filter((entry) => entry.defer === 'never').length,
    deferred: declarations.filter((entry) => entry.defer === 'auto').length,
    serializedBytes: Buffer.byteLength(JSON.stringify(declarations), 'utf8'),
    schemaBytes: declarations.reduce(
      (total, entry) => total + Buffer.byteLength(JSON.stringify(entry.parameters), 'utf8'),
      0
    ),
    descriptionBytes: descriptionSizes.reduce((total, size) => total + size, 0),
    largestDescriptionBytes: Math.max(0, ...descriptionSizes),
  }
}

/** Converts Maestrly/AI SDK tools into host-managed Copilot SDK tools. */
export async function copilotTools(
  tools: ToolSet,
  signal: AbortSignal,
  deferredToolNames: ReadonlySet<string>,
  onToolOutput?: (toolCallId: string, output: ToolOutput) => void
): Promise<CopilotTool[]> {
  const converted: CopilotTool[] = []
  for (const [name, raw] of Object.entries(tools).sort(([a], [b]) => a.localeCompare(b))) {
    const aiTool = raw as AiTool
    if (!aiTool.execute || !aiTool.inputSchema) continue
    const schema = asSchema(aiTool.inputSchema)
    const parameters = await schema.jsonSchema
    converted.push({
      name,
      description: typeof aiTool.description === 'string' ? aiTool.description : `Maestrly tool ${name}.`,
      parameters: parameters as Record<string, unknown>,
      // The official runtime owns built-ins with names such as `bash`. Maestrly intentionally replaces them so
      // execution continues through our permission, sandbox, MCP and output-filtering contracts.
      overridesBuiltInTool: true,
      skipPermission: true,
      defer: deferredToolNames.has(name) ? 'auto' : 'never',
      handler: async (input, invocation) => {
        let parsed = input
        if (schema.validate) {
          const validation = await schema.validate(input)
          if (!validation.success) throw validation.error
          parsed = validation.value
        }
        const result = await (aiTool.execute as (...args: any[]) => unknown)(parsed, {
          toolCallId: invocation.toolCallId,
          messages: [],
          abortSignal: signal,
        })
        const canonical = modelOutputToChatToolOutput(result)
        onToolOutput?.(invocation.toolCallId, canonical)
        const modelOutput = aiTool.toModelOutput
          ? await (aiTool.toModelOutput as (options: Record<string, unknown>) => unknown)({
              toolCallId: invocation.toolCallId,
              input: parsed,
              output: result,
            })
          : result
        const normalized = modelOutputToChatToolOutput(stripToolOutputMetadata(modelOutput))
        const isError = toolOutputIsError(canonical)
        if (!toolOutputImages(normalized).length && !isError) return toolOutputText(normalized)
        return toolOutputToCopilotResult(normalized, { isError })
      },
    })
  }
  return converted
}
