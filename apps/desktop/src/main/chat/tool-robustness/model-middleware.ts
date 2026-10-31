/**
 * Language-model middleware for the BYOK transports (Anthropic Messages and OpenAI-compatible chat completions). It
 * sees the prompt of every request, including the AI SDK's own tool-loop steps, and:
 *
 * - repairs the tool-call history (`tool-history.ts`);
 * - gives the tool schemas the dialect the provider accepts (`schema-dialects.ts`);
 * - on OpenAI-compatible servers, replaces a streamed tool-call id the prompt already uses (servers that answer
 *   `call_0` on every step), so calls never collide across steps.
 *
 * OpenAI Responses is not wrapped: its ledger already reconciles tool calls and its strict schemas stay as built.
 */
import { randomBytes } from 'node:crypto'
import { wrapLanguageModel } from 'ai'
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider'
import { applySchemaDialect, selectSchemaDialect, type SchemaDialect } from './schema-dialects'
import { hasToolHistoryChanges, sanitizeToolHistory, type ToolHistoryStats } from './tool-history'

export interface ToolRobustnessModelOptions {
  transport: 'anthropic' | 'openai-compatible'
  baseURL: string
  modelId: string
  grok?: boolean
  /** Receives content-free counters when a request needed repairs. */
  onDiag?: (entry: Record<string, unknown>) => void
}

type CallTools = LanguageModelV4CallOptions['tools']

/** Applies a schema dialect to the function tools of a request; the same array when nothing changes. */
export function adaptRequestTools(tools: CallTools, dialect: SchemaDialect | null): CallTools {
  if (!dialect || !tools?.length) return tools
  let changed = false
  const adapted = tools.map((entry) => {
    if (entry.type !== 'function') return entry
    const inputSchema = applySchemaDialect(entry.inputSchema, dialect) as typeof entry.inputSchema
    if (inputSchema === entry.inputSchema) return entry
    changed = true
    return { ...entry, inputSchema }
  })
  return changed ? adapted : tools
}

export function promptToolCallIds(prompt: LanguageModelV4Prompt): Set<string> {
  const ids = new Set<string>()
  for (const message of prompt) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content) if (part.type === 'tool-call') ids.add(part.toolCallId)
  }
  return ids
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** A fresh id for a streamed call, keeping Mistral's nine-alphanumeric shape. */
export function freshToolCallId(original: string, taken: ReadonlySet<string>): string {
  for (;;) {
    let candidate: string
    if (/^[A-Za-z0-9]{9}$/.test(original)) {
      const bytes = randomBytes(9)
      candidate = Array.from(bytes, (byte) => ALNUM[byte % ALNUM.length]).join('')
    } else {
      candidate = `call_${randomBytes(12).toString('hex')}`
    }
    if (!taken.has(candidate)) return candidate
  }
}

/** Renames streamed or generated ids the prompt already holds, consistently across a call's parts. */
export function createToolCallIdRenamer(prompt: LanguageModelV4Prompt) {
  const taken = promptToolCallIds(prompt)
  const renamed = new Map<string, string>()
  return {
    rename(id: string): string {
      const existing = renamed.get(id)
      if (existing) return existing
      if (!taken.has(id)) return id
      const next = freshToolCallId(id, taken)
      taken.add(next)
      renamed.set(id, next)
      return next
    },
    get count() {
      return renamed.size
    },
  }
}

function renameStreamPart(part: LanguageModelV4StreamPart, rename: (id: string) => string): LanguageModelV4StreamPart {
  switch (part.type) {
    case 'tool-input-start':
    case 'tool-input-delta':
    case 'tool-input-end': {
      const id = rename(part.id)
      return id === part.id ? part : { ...part, id }
    }
    case 'tool-call': {
      if (part.providerExecuted) return part
      const toolCallId = rename(part.toolCallId)
      return toolCallId === part.toolCallId ? part : { ...part, toolCallId }
    }
    default:
      return part
  }
}

function renameContent(content: LanguageModelV4Content[], rename: (id: string) => string): LanguageModelV4Content[] {
  let changed = false
  const next = content.map((part) => {
    if (part.type !== 'tool-call' || part.providerExecuted) return part
    const toolCallId = rename(part.toolCallId)
    if (toolCallId === part.toolCallId) return part
    changed = true
    return { ...part, toolCallId }
  })
  return changed ? next : content
}

export function wrapToolRobustnessModel(model: LanguageModelV4, options: ToolRobustnessModelOptions): LanguageModelV4 {
  const dialect = selectSchemaDialect({
    transport: options.transport === 'anthropic' ? 'anthropic' : 'openai',
    baseURL: options.baseURL,
    modelId: options.modelId,
    grok: options.grok,
  })
  const compatible = options.transport === 'openai-compatible'
  let lastReport = ''
  const report = (stats: ToolHistoryStats) => {
    // Every step of a turn resends the history: report a repair once, not once per step.
    const signature = JSON.stringify(stats)
    if (signature === lastReport) return
    lastReport = signature
    options.onDiag?.({ kind: 'tool-history-sanitized', model: options.modelId, ...stats })
  }
  const reportIds = (count: number) => {
    if (count > 0) options.onDiag?.({ kind: 'tool-history-sanitized', model: options.modelId, streamIds: count })
  }
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => {
        const history = sanitizeToolHistory(params.prompt, { strictIds: options.transport === 'anthropic' })
        const tools = adaptRequestTools(params.tools, dialect)
        if (history.prompt === params.prompt && tools === params.tools) return params
        if (hasToolHistoryChanges(history.stats)) report(history.stats)
        return { ...params, prompt: history.prompt, tools }
      },
      ...(compatible
        ? {
            wrapStream: async ({ doStream, params }) => {
              const result = await doStream()
              const renamer = createToolCallIdRenamer(params.prompt)
              return {
                ...result,
                stream: result.stream.pipeThrough(
                  new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
                    transform: (part, controller) => controller.enqueue(renameStreamPart(part, renamer.rename)),
                    flush: () => reportIds(renamer.count),
                  })
                ),
              }
            },
            wrapGenerate: async ({ doGenerate, params }) => {
              const result = await doGenerate()
              const renamer = createToolCallIdRenamer(params.prompt)
              const content = renameContent(result.content, renamer.rename)
              reportIds(renamer.count)
              return content === result.content ? result : { ...result, content }
            },
          }
        : {}),
    },
  })
}
