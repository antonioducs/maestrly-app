import { createHash } from 'node:crypto'
import { asSchema } from '@ai-sdk/provider-utils'
import {
  createSdkMcpServer,
  tool as claudeTool,
  type HookCallbackMatcher,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Tool as AiTool, ToolSet } from 'ai'
import { z } from 'zod'
import {
  modelOutputToChatToolOutput,
  stripToolOutputMetadata,
  toolOutputIsError,
  toolOutputToMcpCallResult,
} from '../tool-output'
import type { ToolOutput } from '../../../shared/chat'
import type { ClaudeToolJournal } from './tool-journal'

export const CLAUDE_MCP_SERVER_NAME = 'maestrly'
export const CLAUDE_MCP_TOOL_PREFIX = `mcp__${CLAUDE_MCP_SERVER_NAME}__`

const CLAUDE_NATIVE_TOOL_NAMES = [
  'Agent',
  'Task',
  'Skill',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'AskUserQuestion',
  'ExitPlanMode',
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
] as const

export const CLAUDE_DISALLOWED_NATIVE_TOOLS = [...CLAUDE_NATIVE_TOOL_NAMES]

const NATIVE_ALIAS_CANDIDATES: Record<string, string> = {
  Agent: 'task',
  Task: 'task',
  Skill: 'use_skill',
  TodoWrite: 'todo_write',
  TaskCreate: 'todo_write',
  TaskUpdate: 'todo_write',
  TaskGet: 'todo_write',
  TaskList: 'todo_write',
  AskUserQuestion: 'ask_question',
  ExitPlanMode: 'review_plan',
  Bash: 'bash',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'webfetch',
}

export interface ClaudeToolBridge {
  server: McpSdkServerConfigWithInstance
  allowedTools: string[]
  toolAliases: Record<string, string>
  toolSignature: string
  nameFromSdk: (name: string) => string
  preToolUseHook: HookCallbackMatcher
  /** Retrieves the canonical host result after the provider-facing projection has been sent. */
  takeToolOutput: (toolCallId: string) => ToolOutput | undefined
}

type JsonSchema = Record<string, unknown>

function schemaRecord(value: unknown): JsonSchema {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonSchema) : {}
}

/**
 * The Agent SDK's in-process MCP helper accepts Zod shapes while Maestrly's
 * ToolSet may carry either Zod or JSON Schema. This converter intentionally
 * covers the JSON Schema vocabulary used by our core/app/external MCP tools.
 * The original AI SDK validator still runs before execution as defense in depth.
 */
function jsonSchemaToZod(raw: unknown): z.ZodType {
  const schema = schemaRecord(raw)
  if (schema.const !== undefined) return z.literal(schema.const as string | number | boolean | null)
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum
    if (values.every((value) => typeof value === 'string')) {
      return z.enum(values as [string, ...string[]])
    }
    const literals = values.map((value) => z.literal(value as string | number | boolean | null))
    if (literals.length === 1) return literals[0]
    return z.union(literals as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
  }
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (alternatives?.length) {
    const converted = alternatives.map(jsonSchemaToZod)
    if (converted.length === 1) return converted[0]
    return z.union(converted as [z.ZodType, z.ZodType, ...z.ZodType[]])
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return schema.allOf.map(jsonSchemaToZod).reduce((left, right) => z.intersection(left, right))
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const nullable = types.includes('null') || schema.nullable === true
  const primary = types.find((type) => type !== 'null')
  let result: z.ZodType
  switch (primary) {
    case 'string':
      result = z.string()
      break
    case 'integer':
      result = z.number().int()
      break
    case 'number':
      result = z.number()
      break
    case 'boolean':
      result = z.boolean()
      break
    case 'array':
      result = z.array(jsonSchemaToZod(schema.items))
      break
    case 'object':
    default: {
      const properties = schemaRecord(schema.properties)
      const required = new Set(
        Array.isArray(schema.required) ? schema.required.filter((v) => typeof v === 'string') : []
      )
      const shape: Record<string, z.ZodType> = {}
      for (const [name, property] of Object.entries(properties)) {
        const converted = jsonSchemaToZod(property)
        shape[name] = required.has(name) ? converted : converted.optional()
      }
      const object = z.object(shape)
      result = schema.additionalProperties === false ? object.strict() : object.loose()
      break
    }
  }
  return nullable ? result.nullable() : result
}

function callToolResult(value: unknown, isError: boolean): CallToolResult {
  return toolOutputToMcpCallResult(value, { isError }) as CallToolResult
}

function stripQualifiedName(name: string): string {
  if (name.startsWith(CLAUDE_MCP_TOOL_PREFIX)) return name.slice(CLAUDE_MCP_TOOL_PREFIX.length)
  return NATIVE_ALIAS_CANDIDATES[name] ?? name
}

function canonicalInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalInput)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalInput(entry)])
  )
}

function inputHash(value: unknown): string {
  const encoded = JSON.stringify(canonicalInput(value)) ?? 'undefined'
  return createHash('sha256').update(encoded).digest('hex')
}

export async function buildClaudeToolBridge(
  tools: ToolSet,
  signal: AbortSignal,
  eagerToolNames: ReadonlySet<string> = new Set([
    'read',
    'grep',
    'glob',
    'ask_question',
    'todo_write',
    'review_plan',
    'task',
    'delegate',
    'use_skill',
  ]),
  beforeExecute?: () => void,
  journal?: ClaudeToolJournal
): Promise<ClaudeToolBridge> {
  const definitions: SdkMcpToolDefinition<any>[] = []
  const canonicalOutputs = new Map<string, ToolOutput>()
  const signatureRows: Array<{ name: string; description: string; schema: unknown; eager: boolean }> = []
  const verifiedIds = new Set<string>()
  const verifiedKeys = new Map<string, string>()
  const verifiedByInput = new Map<string, string[]>()
  const waitingByInput = new Map<string, Array<(toolCallId: string) => void>>()
  const callKey = (name: string, input: unknown) => `${name}\0${inputHash(input)}`
  const announceVerifiedToolCall = (sdkName: string, toolCallId: string, input: unknown): void => {
    if (!toolCallId || (!journal && verifiedIds.has(toolCallId))) return
    verifiedIds.add(toolCallId)
    const name = stripQualifiedName(sdkName)
    const key = callKey(name, input)
    if (journal) {
      const prior = verifiedKeys.get(toolCallId)
      if (prior && prior !== key) throw new Error(`Conflicting Claude tool call: ${toolCallId}`)
      verifiedKeys.set(toolCallId, key)
      if (verifiedByInput.get(key)?.includes(toolCallId)) return
    }
    const waiter = waitingByInput.get(key)?.shift()
    if (waiter) {
      waiter(toolCallId)
      return
    }
    const queue = verifiedByInput.get(key) ?? []
    queue.push(toolCallId)
    verifiedByInput.set(key, queue)
  }
  const claimToolCall = (name: string, input: unknown): Promise<string> => {
    const key = callKey(name, input)
    const queued = verifiedByInput.get(key)?.shift()
    if (queued) return Promise.resolve(queued)
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Claude tool call was aborted.'))
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const removeWaiter = () => {
        const current = waitingByInput.get(key)
        if (current)
          waitingByInput.set(
            key,
            current.filter((entry) => entry !== finish)
          )
      }
      const finish = (toolCallId: string) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        clearTimeout(timer)
        resolve(toolCallId)
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        removeWaiter()
        signal.removeEventListener('abort', onAbort)
        clearTimeout(timer)
        reject(error)
      }
      const onAbort = () => fail(signal.reason ?? new Error('Claude tool call was aborted.'))
      const waiters = waitingByInput.get(key) ?? []
      waiters.push(finish)
      waitingByInput.set(key, waiters)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(
        () => fail(new Error(`Claude tool call "${name}" arrived without a verified tool-use id.`)),
        10_000
      )
      timer.unref?.()
    })
  }
  for (const [name, raw] of Object.entries(tools).sort(([left], [right]) => left.localeCompare(right))) {
    const aiTool = raw as AiTool
    if (!aiTool.execute || !aiTool.inputSchema) continue
    const schema = asSchema(aiTool.inputSchema)
    const jsonSchema = await schema.jsonSchema
    const zodObject = jsonSchemaToZod(jsonSchema)
    const inputShape = zodObject instanceof z.ZodObject ? zodObject.shape : { input: zodObject }
    const description = typeof aiTool.description === 'string' ? aiTool.description : `Maestrly tool ${name}.`
    const eager = eagerToolNames.has(name)
    definitions.push(
      claudeTool(
        name,
        description,
        inputShape,
        async (input, extra) => {
          const callback = async () => {
            signal.throwIfAborted()
            beforeExecute?.()
            let parsed: unknown = input
            if ('input' in inputShape && Object.keys(inputShape).length === 1)
              parsed = (input as { input: unknown }).input
            if (schema.validate) {
              const validation = await schema.validate(parsed)
              if (!validation.success) throw validation.error
              parsed = validation.value
            }
            // The in-process MCP callback does not carry an authoritative
            // tool-use id. Only the host-owned PreToolUse hook may establish it.
            const toolCallId = await claimToolCall(name, input)
            signal.throwIfAborted()
            const sdkSignal =
              (extra as { signal?: unknown })?.signal instanceof AbortSignal
                ? (extra as { signal: AbortSignal }).signal
                : null
            const executionSignal = !journal && sdkSignal ? AbortSignal.any([signal, sdkSignal]) : signal
            executionSignal.throwIfAborted()
            beforeExecute?.()
            const execute = async () =>
              (aiTool.execute as (...args: any[]) => unknown)(parsed, {
                toolCallId,
                messages: [],
                abortSignal: executionSignal,
              })
            const output = journal ? await journal.run(toolCallId, name, parsed, execute) : await execute()
            const canonical = modelOutputToChatToolOutput(output)
            canonicalOutputs.set(toolCallId, canonical)
            const modelOutput = aiTool.toModelOutput
              ? await (aiTool.toModelOutput as (options: Record<string, unknown>) => unknown)({
                  toolCallId,
                  input: parsed,
                  output,
                })
              : output
            return callToolResult(stripToolOutputMetadata(modelOutput), toolOutputIsError(canonical))
          }
          return journal ? journal.track(callback) : callback()
        },
        { alwaysLoad: eager }
      )
    )
    signatureRows.push({ name, description, schema: jsonSchema, eager })
  }
  const names = signatureRows.map((row) => row.name)
  const allowedTools = names.map((name) => `${CLAUDE_MCP_TOOL_PREFIX}${name}`)
  const toolAliases: Record<string, string> = {}
  for (const [nativeName, maestrlyName] of Object.entries(NATIVE_ALIAS_CANDIDATES)) {
    if (names.includes(maestrlyName)) toolAliases[nativeName] = `${CLAUDE_MCP_TOOL_PREFIX}${maestrlyName}`
  }
  return {
    server: createSdkMcpServer({
      name: CLAUDE_MCP_SERVER_NAME,
      version: '1.0.0',
      tools: definitions,
    }),
    allowedTools,
    toolAliases,
    toolSignature: createHash('sha256').update(JSON.stringify(signatureRows)).digest('hex'),
    nameFromSdk: stripQualifiedName,
    takeToolOutput: (toolCallId) => {
      const output = canonicalOutputs.get(toolCallId)
      canonicalOutputs.delete(toolCallId)
      return output
    },
    preToolUseHook: {
      hooks: [
        async (input, toolUseID) => {
          if (input.hook_event_name === 'PreToolUse') {
            const id = toolUseID ?? input.tool_use_id
            const normalizedName = stripQualifiedName(input.tool_name)
            if (!id || !names.includes(normalizedName)) {
              return {
                continue: false,
                stopReason: 'Maestrly rejected an unverified Claude tool call.',
              }
            }
            announceVerifiedToolCall(input.tool_name, id, input.tool_input)
          }
          return { continue: true }
        },
      ],
    },
  }
}
