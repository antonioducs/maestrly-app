export const CURSOR_TOOL_BRIDGE_SIGNATURE_VERSION = 3

export function hashCursorToolSignature(toolNames: readonly string[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: CURSOR_TOOL_BRIDGE_SIGNATURE_VERSION,
        tools: [...toolNames].sort(),
      })
    )
    .digest('hex')
}
import { createHash } from 'node:crypto'
import { asSchema } from '@ai-sdk/provider-utils'
import type { SDKCustomTool, SDKCustomToolResult, SDKJsonValue } from '@cursor/sdk'
import type { Tool, ToolSet } from 'ai'
import type { ChatStreamEvent, ToolOutput, ToolState } from '../../../shared/chat'
import { unwrapCursorMcpToolCall } from '../../../shared/cursor-mcp-tool'
import type { PermissionBroker } from '../permission'
import type { QuestionBroker } from '../question-broker'
import type { GeneratedImageEmission, ToolContext } from '../tools/util'
import {
  modelOutputToChatToolOutput,
  stripToolOutputMetadata,
  toolOutputIsError,
  toolOutputToCursorResult,
} from '../tool-output'

const CURSOR_CUSTOM_TOOL_PREFIX_PATTERNS = [
  /^mcp__custom-user-tools__/i,
  /^custom-user-tools__/i,
  /^custom-user-tools_/i,
  /^custom-user-tools\./i,
  /^mcp__custom_user_tools__/i,
  /^custom_user_tools__/i,
  /^custom_user_tools_/i,
  /^custom_user_tools\./i,
  /^mcp__/i,
]

export function cursorNameFromSdk(name: string, knownNames: ReadonlySet<string>): string {
  if (knownNames.has(name)) return name

  let candidate = name
  for (let pass = 0; pass < CURSOR_CUSTOM_TOOL_PREFIX_PATTERNS.length + 1; pass += 1) {
    let changed = false
    for (const pattern of CURSOR_CUSTOM_TOOL_PREFIX_PATTERNS) {
      const stripped = candidate.replace(pattern, '')
      if (stripped === candidate) continue
      changed = true
      candidate = stripped
      if (knownNames.has(candidate)) return candidate
      break
    }
    if (!changed) break
  }

  if (/^mcp__/i.test(name)) {
    const lower = name.toLowerCase()
    const matches = [...knownNames].filter((known) => {
      const suffix = known.toLowerCase()
      return lower.endsWith(`__${suffix}`) || lower.endsWith(`_${suffix}`) || lower.endsWith(`.${suffix}`)
    })
    if (matches.length === 1) return matches[0]
  }
  return name
}

export function normalizeCursorToolEvent(
  event: ChatStreamEvent,
  nameFromSdk: (name: string) => string,
  taskTerminalStates?: ReadonlyMap<string, ToolState>
): ChatStreamEvent {
  if (event.kind === 'tool-input-start') {
    const normalized = nameFromSdk(unwrapCursorMcpToolCall(event.toolName, undefined).toolName)
    return normalized === event.toolName ? event : { ...event, toolName: normalized }
  }
  if (event.kind === 'tool-call') {
    const unwrapped = unwrapCursorMcpToolCall(event.toolName, event.input)
    const normalized = nameFromSdk(unwrapped.toolName)
    if (normalized === event.toolName && unwrapped.input === event.input) return event
    return { ...event, toolName: normalized, input: unwrapped.input }
  }
  if (event.kind === 'tool-state') {
    const authoritative = taskTerminalStates?.get(event.toolCallId)
    if (authoritative) return { ...event, state: authoritative }
  }
  return event
}

export interface CursorToolBridge {
  customTools: Record<string, SDKCustomTool>

  toolSignature: string
  toolNames: string[]
  nameFromSdk: (name: string) => string

  takeToolOutput: (toolCallId: string) => ToolOutput | undefined
}

export type CursorToolBridgeContextFactory = (toolCallId: string, signal: AbortSignal) => ToolContext

export interface BuildCursorToolBridgeArgs {
  tools: ToolSet

  signal: AbortSignal
}

function toSdkResult(value: unknown): SDKCustomToolResult {
  if (value == null) return { content: [{ type: 'text', text: '(no output)' }] }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { content: [{ type: 'text', text: String(value) }] }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as { content?: unknown; isError?: unknown; structuredContent?: unknown }
    if (candidate.content !== undefined && !('type' in (value as Record<string, unknown>))) {
      return value as SDKCustomToolResult
    }
    if ('text' in (value as Record<string, unknown>) || 'images' in (value as Record<string, unknown>)) {
      return toolOutputToCursorResult(value) as SDKCustomToolResult
    }
    if (
      candidate.content !== undefined ||
      candidate.isError !== undefined ||
      candidate.structuredContent !== undefined ||
      'type' in (value as Record<string, unknown>)
    ) {
      return toolOutputToCursorResult(value) as SDKCustomToolResult
    }
  }
  try {
    return { content: [{ type: 'text', text: JSON.stringify(value) }] }
  } catch {
    return { content: [{ type: 'text', text: String(value) }] }
  }
}

function applyCursorErrorStatus(result: SDKCustomToolResult, isError: boolean): SDKCustomToolResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return isError ? { content: [{ type: 'text', text: String(result ?? '(no output)') }], isError: true } : result
  }
  const { isError: _projectedError, ...content } = result as Extract<SDKCustomToolResult, object> & {
    isError?: boolean
  }
  return isError ? { ...content, isError: true } : content
}

export async function buildCursorToolBridge(args: BuildCursorToolBridgeArgs): Promise<CursorToolBridge> {
  const { tools, signal } = args
  const customTools: Record<string, SDKCustomTool> = {}
  const toolNames: string[] = []
  const canonicalOutputs = new Map<string, ToolOutput>()

  for (const [name, definition] of Object.entries(tools)) {
    const aiTool = definition as Tool
    const execute = aiTool?.execute
    if (!aiTool || typeof execute !== 'function') continue

    const description = typeof aiTool.description === 'string' ? aiTool.description : ''
    const schema = asSchema(aiTool.inputSchema)
    const jsonSchema = (await schema.jsonSchema) as Record<string, SDKJsonValue>
    toolNames.push(name)

    customTools[name] = {
      description,
      inputSchema: jsonSchema,
      execute: async (args, context) => {
        signal.throwIfAborted()
        const toolCallId = context?.toolCallId ?? `cursor_${name}`

        let parsed: Record<string, SDKJsonValue> = args
        if (schema.validate) {
          const validation = await schema.validate(args)
          if (!validation.success) {
            const message = validation.error instanceof Error ? validation.error.message : String(validation.error)
            return {
              content: [{ type: 'text', text: `Invalid arguments for "${name}": ${message}` }],
              isError: true,
            }
          }
          parsed = validation.value as Record<string, SDKJsonValue>
        }
        signal.throwIfAborted()
        const result = await execute(
          parsed as never,
          {
            toolCallId,
            abortSignal: signal,
          } as never
        )
        const canonical = modelOutputToChatToolOutput(result)
        canonicalOutputs.set(toolCallId, canonical)
        const modelOutput = aiTool.toModelOutput
          ? await (aiTool.toModelOutput as (options: Record<string, unknown>) => unknown)({
              toolCallId,
              input: parsed,
              output: result,
            })
          : result

        return applyCursorErrorStatus(toSdkResult(stripToolOutputMetadata(modelOutput)), toolOutputIsError(canonical))
      },
    }
  }

  const toolSignature = hashCursorToolSignature(toolNames)

  const known = new Set(toolNames)
  return {
    customTools,
    toolSignature,
    toolNames: [...toolNames].sort(),
    nameFromSdk: (name) => cursorNameFromSdk(name, known),
    takeToolOutput: (toolCallId) => {
      const output = canonicalOutputs.get(toolCallId)
      canonicalOutputs.delete(toolCallId)
      return output
    },
  }
}

export function cursorToolSignatureFromBridge(bridge: CursorToolBridge): string {
  return bridge.toolSignature
}

export type { PermissionBroker, QuestionBroker, ToolContext, GeneratedImageEmission }
