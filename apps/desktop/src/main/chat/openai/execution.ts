import { createHash } from 'node:crypto'
import type { Tool, ToolExecutionOptions, ToolSet } from 'ai'
import type { ToolOutput } from '../../../shared/chat'
import { getToolExecution, putToolExecution, type ToolExecutionRecord } from './inference-store'
import { interruptedOpenAIToolResultOutput, toOpenAILedgerValue, toOpenAIToolResultOutput } from './ledger'
import {
  isOpenAINativeFailedOutput,
  isOpenAINativePermissionDeniedOutput,
  isOpenAINativeToolName,
  OPENAI_NATIVE_PERMISSION_DENIED_PREFIX,
  OPENAI_NATIVE_TOOL_FAILED_PREFIX,
  openAINativeFailureOutput,
  openAINativeOutputText,
} from './native-tools'
import type { OpenAIResponsesLedger, OpenAIToolResultOutput } from './types'
import { isOpenAIReadOnlyTool, type OpenAIToolScheduler } from './tools'
import { mergeToolOutputImageDescriptions, modelOutputToChatToolOutput, toolOutputForPersistence } from '../tool-output'

type ExecutableTool = Tool<any, any>

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value == null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      // `<` on strings is the ECMAScript code-unit order. Unlike localeCompare, it is stable across the
      // host locale/ICU build, which is required because this digest is a durable idempotency key.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalize(item)])
  )
}

export function hashOpenAIToolInput(input: unknown): string {
  const json = toOpenAILedgerValue(input === undefined ? null : input, '$.toolInput')
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(json)))
    .digest('hex')
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

const isPermissionDenial = (error: unknown): boolean => {
  const name = error instanceof Error ? error.name : ''
  return ['PermissionRejectedError', 'PermissionCorrectedError', 'PermissionDeniedError'].includes(name)
}

const persistedOutput = (output: unknown): unknown => {
  if (output === undefined) return undefined
  try {
    return toOpenAILedgerValue(toolOutputForPersistence(output), '$.toolOutput')
  } catch {
    return errorMessage(output)
  }
}

export class OpenAIToolReplayError extends Error {
  constructor(
    message: string,
    readonly code: 'input-mismatch' | 'previous-error' | 'uncertain-execution'
  ) {
    super(message)
    this.name = 'OpenAIToolReplayError'
  }
}

export interface OpenAIToolExecutionStore {
  get(conversationId: string, callId: string): ToolExecutionRecord | null
  put(record: ToolExecutionRecord): void
}

export interface OpenAIToolExecutionScope {
  conversationId: string
  messageId: string
  /** Private prefix preventing subagent call_ids from colliding with the parent turn's ledger. */
  callIdPrefix?: string
}

function durableCallId(scope: OpenAIToolExecutionScope, callId: string): string {
  return scope.callIdPrefix ? `${scope.callIdPrefix}:${callId}` : callId
}

const sqliteExecutionStore: OpenAIToolExecutionStore = {
  get: getToolExecution,
  put: putToolExecution,
}

export interface OpenAIToolExecutionRecovery {
  callId: string
  /** `missing` closes a client-side call whose previous process left no recoverable checkpoint. */
  status: ToolExecutionRecord['status'] | 'missing'
}

export interface OpenAIToolExecutionReconciliation {
  ledger: OpenAIResponsesLedger
  recovered: OpenAIToolExecutionRecovery[]
}

const nativeRecordOutput = (record: ToolExecutionRecord): unknown | null => {
  if (!isOpenAINativeToolName(record.toolName)) return null
  if (record.status === 'completed') {
    return record.output != null && typeof record.output === 'object' ? record.output : null
  }
  const storedText = openAINativeOutputText(record.output)
  const storedReason = storedText?.startsWith(OPENAI_NATIVE_PERMISSION_DENIED_PREFIX)
    ? storedText.slice(OPENAI_NATIVE_PERMISSION_DENIED_PREFIX.length)
    : storedText?.startsWith(OPENAI_NATIVE_TOOL_FAILED_PREFIX)
      ? storedText.slice(OPENAI_NATIVE_TOOL_FAILED_PREFIX.length)
      : storedText
  const reason =
    record.status === 'running' || record.status === 'uncertain'
      ? `Tool execution ${record.callId} may have completed before the previous run stopped; it was not repeated.`
      : (storedReason ?? errorMessage(record.output))
  return openAINativeFailureOutput(record.toolName, reason, record.status === 'denied')
}

const recoveredToolOutput = (record: ToolExecutionRecord): OpenAIToolResultOutput => {
  const nativeOutput = nativeRecordOutput(record)
  if (nativeOutput != null) {
    return {
      type: 'json',
      value: toOpenAILedgerValue(nativeOutput, '$.recoveredNativeToolOutput'),
    }
  }
  if (record.status === 'completed') {
    return toOpenAIToolResultOutput(record.output === undefined ? null : record.output, '$.recoveredToolOutput')
  }
  if (record.status === 'denied') {
    return { type: 'execution-denied', reason: errorMessage(record.output) }
  }
  return {
    type: 'error-text',
    value:
      record.status === 'uncertain' || record.status === 'running'
        ? `Tool execution ${record.callId} may have completed before the previous run stopped; it was not repeated.`
        : errorMessage(record.output),
  }
}

/**
 * Close the crash window between the local effect and the stream's `tool-result` event. If durable execution
 * finished, the next sample receives the saved output without repeating the mutation. Recovery changes a `running`
 * checkpoint to `uncertain`: this closes the function call without assuming reexecution is safe.
 */
export function reconcileOpenAIToolExecutions(
  ledger: OpenAIResponsesLedger,
  scope: OpenAIToolExecutionScope,
  store: OpenAIToolExecutionStore = sqliteExecutionStore
): OpenAIToolExecutionReconciliation {
  const completedCallIds = new Set(
    ledger.entries.filter((entry) => entry.type === 'tool-result').map((entry) => entry.toolCallId)
  )
  const recovered: OpenAIToolExecutionRecovery[] = []
  const entries = [] as OpenAIResponsesLedger['entries']
  let pendingResults: OpenAIResponsesLedger['entries'] = []

  for (const entry of ledger.entries) {
    // Results are inserted before the step boundary that follows their calls. Appending every recovery to the
    // end can place a tool result after a later assistant item, which is itself an invalid Responses transcript.
    if (entry.type === 'step-boundary' && pendingResults.length > 0) {
      entries.push(...pendingResults)
      pendingResults = []
    }
    entries.push(entry)

    if (entry.type !== 'tool-call' || entry.providerExecuted || completedCallIds.has(entry.toolCallId)) continue
    const record = store.get(scope.conversationId, durableCallId(scope, entry.toolCallId))
    const recordMatches =
      record != null &&
      record.messageId === scope.messageId &&
      record.toolName === entry.toolName &&
      record.inputHash === hashOpenAIToolInput(entry.input)

    if (!recordMatches || record == null) {
      // Read-only calls deliberately have no durable execution row. They still need a terminal output after an
      // abort/crash: replaying a bare function_call makes every subsequent Responses request fail with 400.
      pendingResults.push({
        type: 'tool-result',
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        output: interruptedOpenAIToolResultOutput(entry.toolCallId),
      })
      completedCallIds.add(entry.toolCallId)
      recovered.push({ callId: entry.toolCallId, status: 'missing' })
      continue
    }

    let recoveredRecord = record
    if (record.status === 'running') {
      recoveredRecord = { ...record, status: 'uncertain' }
      store.put(recoveredRecord)
    }
    pendingResults.push({
      type: 'tool-result',
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      output: recoveredToolOutput(recoveredRecord),
    })
    completedCallIds.add(entry.toolCallId)
    recovered.push({ callId: entry.toolCallId, status: recoveredRecord.status })
  }
  entries.push(...pendingResults)

  return {
    ledger: recovered.length > 0 ? { ...ledger, entries } : ledger,
    recovered,
  }
}

/**
 * Apply the same canonical tool-image description patch to the durable execution checkpoint. Crash recovery
 * (`reconcileOpenAIToolExecutions`) restores missing ledger tool results from THIS row; without the patch it would
 * keep emitting output without descriptions. Best effort: update only `completed` executions, merging descriptions
 * MONOTONICALLY by image id (see `mergeToolOutputImageDescriptions`). Preserve newer checkpoint
 * text/structuredContent/isError; rewritten output with no matching id is a no-op.
 */
export function patchOpenAIToolExecutionOutputs(
  scope: OpenAIToolExecutionScope,
  enriched: ReadonlyArray<{ toolCallId: string; output: ToolOutput }>,
  store: OpenAIToolExecutionStore = sqliteExecutionStore
): void {
  for (const { toolCallId, output } of enriched) {
    const record = store.get(scope.conversationId, durableCallId(scope, toolCallId))
    if (record?.status !== 'completed') continue
    // Merge descriptions: the checkpoint's CURRENT output is authoritative; no actual change means the same reference.
    const current = modelOutputToChatToolOutput(record.output)
    const merged = mergeToolOutputImageDescriptions(current, output)
    if (merged === current) continue
    const patched = persistedOutput(merged)
    if (patched === undefined || JSON.stringify(record.output) === JSON.stringify(patched)) continue
    store.put({ ...record, output: patched })
  }
}

/**
 * Serialize mutations per conversation and use call_id as the idempotency key. An execution that died while
 * `running` is never retried blindly: it becomes `uncertain`, requiring a new model/user decision.
 */
export function wrapOpenAIToolExecutions(
  tools: ToolSet,
  scheduler: OpenAIToolScheduler,
  scope: OpenAIToolExecutionScope,
  store: OpenAIToolExecutionStore = sqliteExecutionStore
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, source]) => {
      const sourceTool = source as ExecutableTool & { isProviderExecuted?: boolean }
      // Provider-defined client tools (local_shell/apply_patch) still execute on this machine and need the
      // same scheduler/idempotency boundary as function tools. Only genuinely server-executed tools bypass it.
      if (sourceTool.execute == null || sourceTool.isProviderExecuted === true) return [toolName, sourceTool]

      const execute = sourceTool.execute
      const needsDurableCheckpoint = !isOpenAIReadOnlyTool(toolName, sourceTool)
      const wrapped: ExecutableTool = {
        ...sourceTool,
        execute: (input: unknown, options: ToolExecutionOptions<unknown>) =>
          scheduler.schedule(
            toolName,
            async () => {
              const modelCallId = options.toolCallId
              const callId = modelCallId ? durableCallId(scope, modelCallId) : ''
              const executionOptions = callId && callId !== modelCallId ? { ...options, toolCallId: callId } : options
              if (!needsDurableCheckpoint || !modelCallId) return execute(input, executionOptions)

              const inputHash = hashOpenAIToolInput(input)
              const previous = store.get(scope.conversationId, callId)
              if (previous) {
                if (
                  previous.messageId !== scope.messageId ||
                  previous.toolName !== toolName ||
                  previous.inputHash !== inputHash
                ) {
                  const nativeOutput = openAINativeFailureOutput(
                    toolName,
                    `Tool call ${modelCallId} was replayed with different tool or input`
                  )
                  if (nativeOutput != null) return nativeOutput
                  throw new OpenAIToolReplayError(
                    `Tool call ${modelCallId} was replayed with different tool or input`,
                    'input-mismatch'
                  )
                }
                if (previous.status === 'completed' || previous.status === 'denied') {
                  return nativeRecordOutput(previous) ?? previous.output
                }
                if (previous.status === 'running') {
                  const uncertain = { ...previous, status: 'uncertain' as const }
                  const nativeOutput = nativeRecordOutput(uncertain)
                  store.put({ ...uncertain, ...(nativeOutput != null ? { output: nativeOutput } : {}) })
                  if (nativeOutput != null) return nativeOutput
                  throw new OpenAIToolReplayError(
                    `Tool call ${modelCallId} may have executed before the previous run stopped; it was not repeated`,
                    'uncertain-execution'
                  )
                }
                if (previous.status === 'uncertain') {
                  const nativeOutput = nativeRecordOutput(previous)
                  if (nativeOutput != null) return nativeOutput
                  throw new OpenAIToolReplayError(
                    `Tool call ${modelCallId} has an uncertain previous execution and was not repeated`,
                    'uncertain-execution'
                  )
                }
                const nativeOutput = nativeRecordOutput(previous)
                if (nativeOutput != null) return nativeOutput
                throw new OpenAIToolReplayError(
                  `Tool call ${modelCallId} already ended as ${previous.status}: ${errorMessage(previous.output)}`,
                  'previous-error'
                )
              }

              store.put({ ...scope, callId, toolName, inputHash, status: 'running' })
              try {
                const output = await execute(input, executionOptions)
                store.put({
                  ...scope,
                  callId,
                  toolName,
                  inputHash,
                  status: isOpenAINativePermissionDeniedOutput(toolName, output)
                    ? 'denied'
                    : isOpenAINativeFailedOutput(toolName, output)
                      ? 'error'
                      : 'completed',
                  output: persistedOutput(output),
                })
                return output
              } catch (error) {
                store.put({
                  ...scope,
                  callId,
                  toolName,
                  inputHash,
                  status: isPermissionDenial(error) ? 'denied' : 'error',
                  output: errorMessage(error),
                })
                throw error
              }
            },
            sourceTool
          ),
      }
      return [toolName, wrapped]
    })
  ) as ToolSet
}
