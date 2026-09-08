import { randomUUID } from 'node:crypto'
import type { ChatModelRef } from '../../../shared/chat'
import type { SubagentExecutionSnapshotV1 } from '../../../shared/subagent-profiles'
import type { ChatAgent } from '../agents'
import type { NormalizedAiUsage } from '../subagent-runner'
import { createSubagentTextEmitter, type SubagentTextUpdateHandler } from '../subagent-text-stream'
import { recordModelCallUsage } from '../usage-diagnostics'
import { MEMORY_TOOL_GUIDANCE } from '../memory-tool-guidance'
import { isSubagentToolAllowed } from '../tools'
import type { CodexAppServerClient } from './client'
import {
  dynamicToolRegistrations,
  type DynamicToolFunctionSpec,
  type DynamicToolRegistrationSpec,
} from './dynamic-tools'
import { nativeSubagentSuppressionConfig } from './model-catalog-override'
import {
  codexTextInput,
  type CodexAccountRateLimitsReadResponse,
  type CodexApprovalPolicy,
  type CodexSandboxPolicy,
} from './protocol'
import { classifyCodexQuotaFailure, classifyCodexQuotaFailureWithRateLimits } from './quota-error'
import { parseCodexRateLimits } from './rate-limits'

interface TokenBreakdown {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

interface TokenUsageNotification {
  threadId: string
  tokenUsage: { total: TokenBreakdown }
}

interface TurnCompletedNotification {
  threadId: string
  turn: {
    id: string
    status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
    error?: { message?: string } | null
  }
}

export interface CodexSubagentCheckpoint {
  commands?: string[]
  statusLines?: string[]
  filesChanged?: string[]
  completedDynamicTools?: CodexDynamicToolCheckpoint[]
  inFlightDynamicTools?: CodexDynamicToolCheckpoint[]
}

export interface CodexDynamicToolCheckpoint {
  tool: string
  itemId?: string
  callId?: string
  argumentsSummary?: string
}

export interface CodexSubagentQuotaPartial {
  text: string
  usage?: NormalizedAiUsage
  model?: ChatModelRef
  checkpoint?: CodexSubagentCheckpoint
  physicalProviderId?: string
  accountId?: string | null
}

export class CodexSubagentQuotaError extends Error {
  readonly name = 'CodexSubagentQuotaError'
  constructor(
    message: string,
    readonly partial: CodexSubagentQuotaPartial
  ) {
    super(message)
  }
}

export interface RunCodexSubagentArgs {
  client: CodexAppServerClient
  cwd: string
  profile: SubagentExecutionSnapshotV1
  definition: ChatAgent
  signal: AbortSignal
  agentName: string
  task: string
  readOnly: boolean
  /** Concrete transport tier resolved for this child model on the physical account used by the attempt. */
  serviceTier: string
  approvalPolicy: CodexApprovalPolicy
  sandboxPolicy: CodexSandboxPolicy
  dynamicTools: DynamicToolFunctionSpec[]
  registerThread: (threadId: string, modelId: string) => boolean
  removeThread: (threadId: string, terminal: boolean) => void
  progress?: (line: string) => void
  onTextUpdate?: SubagentTextUpdateHandler
  /** Physical account used for this attempt (failover-aware). */
  physicalProviderId?: string
  accountId?: string | null
  /**
   * Maestro delegations keep the thread on the app-server so a later turn can resume it. The caller owns the
   * deletion (end of the parent turn) and must tombstone the id via `onThreadStarted`.
   */
  persistRuntime?: boolean
  /** Reopen this thread instead of starting one. A rejected resume falls back to a fresh thread + fallbackTask. */
  resume?: { threadId: string; fallbackTask: string }
  onThreadStarted?: (info: { threadId: string; resumed: boolean }) => void
}

export interface CodexSubagentResult {
  text: string
  error?: string
  usage?: NormalizedAiUsage
  model?: ChatModelRef
  /** Only when `resume` was requested. */
  resumed?: boolean
  resumeReason?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const SUBAGENT_STOP_TIMEOUT_MS = 15_000
const OWNED_REQUEST_TIMEOUT_MS = 30_000
const CHECKPOINT_LIST_LIMIT = 24
const CHECKPOINT_LINE_LIMIT = 40
const CHECKPOINT_ID_LIMIT = 160
const CHECKPOINT_ARGUMENT_SUMMARY_LIMIT = 240

function ownedRequestDeadline(label: string): { promise: Promise<never>; error: Error; cancel: () => void } {
  const error = new Error(`${label} timed out after ${OWNED_REQUEST_TIMEOUT_MS}ms`)
  let timer: NodeJS.Timeout | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(error), OWNED_REQUEST_TIMEOUT_MS)
    timer.unref()
  })
  void promise.catch(() => {})
  return {
    promise,
    error,
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

function usageOf(notification: TokenUsageNotification | null): NormalizedAiUsage | undefined {
  if (!notification) return undefined
  const inputTotal = Math.max(0, Number(notification.tokenUsage.total.inputTokens) || 0)
  const cacheRead = Math.min(inputTotal, Math.max(0, Number(notification.tokenUsage.total.cachedInputTokens) || 0))
  return {
    input: inputTotal - cacheRead,
    output: Math.max(0, Number(notification.tokenUsage.total.outputTokens) || 0),
    cacheRead,
    cacheCreate: 0,
    totalInput: inputTotal,
  }
}

function itemProgress(item: Record<string, unknown>): string | null {
  if (item.type === 'commandExecution' && typeof item.command === 'string') return `Running ${item.command}`
  if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    const paths = item.changes
      .filter(isRecord)
      .map((change) => change.path)
      .filter((path): path is string => typeof path === 'string')
    return paths.length ? `Changing ${paths.join(', ')}` : 'Changing files'
  }
  if (item.type === 'dynamicToolCall' && typeof item.tool === 'string') return `Calling ${item.tool}`
  return null
}

function pushBounded(list: string[], value: string, limit: number): void {
  const trimmed = value.trim()
  if (!trimmed) return
  if (list.includes(trimmed)) return
  if (list.length >= limit) return
  list.push(trimmed.slice(0, 500))
}

function checkpointText(value: unknown, limit = CHECKPOINT_ID_LIMIT): string | undefined {
  if (typeof value !== 'string') return undefined
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return sanitized ? sanitized.slice(0, limit) : undefined
}

function dynamicArgumentKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (isRecord(value)) return 'object'
  return typeof value
}

function summarizeDynamicToolArguments(value: unknown): string | undefined {
  if (Array.isArray(value)) return `args: array(${value.length})`
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
    .slice(0, 8)
    .map(([key, entry]) => {
      const safeKey = checkpointText(key, 48) ?? 'key'
      return `${safeKey}:${dynamicArgumentKind(entry)}`
    })
  if (!entries.length) return undefined
  const suffix = Object.keys(value).length > entries.length ? ', …' : ''
  return `args: ${entries.join(', ')}${suffix}`.slice(0, CHECKPOINT_ARGUMENT_SUMMARY_LIMIT)
}

function dynamicToolCheckpoint(
  item: Record<string, unknown>,
  params?: Record<string, unknown>
): CodexDynamicToolCheckpoint | null {
  const tool = checkpointText(item.tool)
  if (!tool) return null
  const itemId = checkpointText(item.id) ?? checkpointText(params?.itemId)
  const callId = checkpointText(item.callId) ?? checkpointText(params?.callId)
  const argumentsSummary = summarizeDynamicToolArguments(item.arguments)
  return {
    tool,
    ...(itemId ? { itemId } : {}),
    ...(callId ? { callId } : {}),
    ...(argumentsSummary ? { argumentsSummary } : {}),
  }
}

export function sameCodexDynamicToolCheckpoint(
  first: CodexDynamicToolCheckpoint,
  second: CodexDynamicToolCheckpoint
): boolean {
  if (first.tool !== second.tool) return false
  if (first.itemId && second.itemId && first.itemId === second.itemId) return true
  if (first.callId && second.callId && first.callId === second.callId) return true
  if (first.itemId || second.itemId || first.callId || second.callId) return false
  return first.argumentsSummary === second.argumentsSummary
}

function pushDynamicToolCheckpoint(
  list: CodexDynamicToolCheckpoint[],
  entry: CodexDynamicToolCheckpoint,
  limit: number
): void {
  if (list.some((existing) => sameCodexDynamicToolCheckpoint(existing, entry))) return
  if (list.length >= limit) return
  list.push(entry)
}

function removeDynamicToolCheckpoint(list: CodexDynamicToolCheckpoint[], entry: CodexDynamicToolCheckpoint): void {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (sameCodexDynamicToolCheckpoint(list[index], entry)) list.splice(index, 1)
  }
}

function fileChangePaths(item: Record<string, unknown>): string[] {
  if (!Array.isArray(item.changes)) return []
  return item.changes
    .filter(isRecord)
    .map((change) => change.path)
    .filter((path): path is string => typeof path === 'string' && Boolean(path))
}

function buildCheckpoint(state: {
  commands: string[]
  statusLines: string[]
  filesChanged: string[]
  completedDynamicTools: CodexDynamicToolCheckpoint[]
  inFlightDynamicTools: CodexDynamicToolCheckpoint[]
}): CodexSubagentCheckpoint | undefined {
  const checkpoint: CodexSubagentCheckpoint = {}
  if (state.commands.length) checkpoint.commands = state.commands.slice(0, CHECKPOINT_LIST_LIMIT)
  if (state.statusLines.length) checkpoint.statusLines = state.statusLines.slice(-CHECKPOINT_LINE_LIMIT)
  if (state.filesChanged.length) checkpoint.filesChanged = state.filesChanged.slice(0, CHECKPOINT_LIST_LIMIT)
  if (state.completedDynamicTools.length) {
    checkpoint.completedDynamicTools = state.completedDynamicTools.slice(0, CHECKPOINT_LIST_LIMIT)
  }
  if (state.inFlightDynamicTools.length) {
    checkpoint.inFlightDynamicTools = state.inFlightDynamicTools.slice(0, CHECKPOINT_LIST_LIMIT)
  }
  return checkpoint.commands ||
    checkpoint.statusLines ||
    checkpoint.filesChanged ||
    checkpoint.completedDynamicTools ||
    checkpoint.inFlightDynamicTools
    ? checkpoint
    : undefined
}

/** Runs one ephemeral child thread over the already-authenticated app-server connection. */
export async function runCodexSubagent(args: RunCodexSubagentArgs): Promise<CodexSubagentResult> {
  const effective = args.profile.effective
  if (!effective) return { text: '', error: `Subagent "${args.agentName}" has no runnable execution profile.` }
  if (args.signal.aborted) throw new Error('Subagent aborted before its thread started')
  const model: ChatModelRef = {
    providerId: args.physicalProviderId ?? effective.providerId,
    modelId: effective.modelId,
  }
  let threadId = ''
  let turnId = ''
  let turnTerminal = false
  let turnStartRequested = false
  let cleanupTransferred = false
  let resumed = false
  let resumeReason: string | undefined
  let latestUsage: TokenUsageNotification | null = null
  let loggedUsage: NormalizedAiUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 }
  let completionResolve!: (value: TurnCompletedNotification) => void
  let completionReject!: (error: Error) => void
  const completed = new Promise<TurnCompletedNotification>((resolve, reject) => {
    completionResolve = resolve
    completionReject = reject
  })
  void completed.catch(() => {})
  let terminalResolve!: () => void
  const terminal = new Promise<void>((resolve) => {
    terminalResolve = resolve
  })
  const textByItem = new Map<string, string>()
  const emitText = createSubagentTextEmitter(args.onTextUpdate)
  const currentText = (): string => [...textByItem.values()].join('\n\n')
  const checkpointState = {
    commands: [] as string[],
    statusLines: [] as string[],
    filesChanged: [] as string[],
    completedDynamicTools: [] as CodexDynamicToolCheckpoint[],
    inFlightDynamicTools: [] as CodexDynamicToolCheckpoint[],
  }
  const noteProgress = (line: string): void => {
    pushBounded(checkpointState.statusLines, line, CHECKPOINT_LINE_LIMIT)
    args.progress?.(line)
  }
  let offNotification: () => void = () => {}
  let abortRequested: boolean = args.signal.aborted
  let shutdownDeadline: number | null = null
  let abortTimer: NodeJS.Timeout | undefined
  let abortTimeoutReject!: (error: Error) => void
  const abortTimeout = new Promise<never>((_resolve, reject) => {
    abortTimeoutReject = reject
  })
  // `abort` may arrive while thread/start is in flight, before Promise.race below attaches handlers.
  void abortTimeout.catch(() => {})
  let interruptTurnId = ''
  let interruptPromise: Promise<void> | null = null
  const markTerminal = (): void => {
    if (turnTerminal) return
    turnTerminal = true
    terminalResolve()
    if (abortTimer) {
      clearTimeout(abortTimer)
      abortTimer = undefined
    }
  }
  const requestInterrupt = (): Promise<void> => {
    if (!threadId || !turnId || turnTerminal) return Promise.resolve()
    if (interruptTurnId === turnId && interruptPromise) return interruptPromise
    interruptTurnId = turnId
    const requested = args.client
      .interruptTurn({ threadId, turnId }, { signal: AbortSignal.timeout(SUBAGENT_STOP_TIMEOUT_MS) })
      .then(() => undefined)
    interruptPromise = requested
    return requested
  }
  const armAbortTimeout = (): void => {
    if (shutdownDeadline !== null || turnTerminal) return
    shutdownDeadline = Date.now() + SUBAGENT_STOP_TIMEOUT_MS
    abortTimer = setTimeout(() => {
      abortTimer = undefined
      abortTimeoutReject(new Error(`Timed out waiting for Codex subagent ${threadId || args.agentName} to stop`))
    }, SUBAGENT_STOP_TIMEOUT_MS)
    abortTimer.unref()
  }
  const waitForTerminalUntil = async (deadline: number, interruptError?: unknown): Promise<void> => {
    if (turnTerminal) return
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw interruptError ?? new Error(`Timed out waiting for Codex subagent ${threadId} to stop`)
    }
    await Promise.race([
      terminal,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(interruptError ?? new Error(`Timed out waiting for Codex subagent ${threadId} to stop`))
        }, remainingMs)
        timer.unref()
        void terminal.finally(() => clearTimeout(timer))
      }),
    ])
  }
  const onAbort = (): void => {
    abortRequested = true
    armAbortTimeout()
    void requestInterrupt().catch(() => {})
  }
  args.signal.addEventListener('abort', onAbort, { once: true })
  if (abortRequested) armAbortTimeout()

  const quotaPartial = (text: string, usage?: NormalizedAiUsage): CodexSubagentQuotaPartial => {
    const checkpoint = buildCheckpoint(checkpointState)
    return {
      text,
      ...(usage ? { usage } : {}),
      model,
      ...(checkpoint ? { checkpoint } : {}),
      ...(args.physicalProviderId ? { physicalProviderId: args.physicalProviderId } : {}),
      ...(args.accountId !== undefined ? { accountId: args.accountId } : {}),
    }
  }

  const throwIfQuota = async (error: unknown, text: string, usage?: NormalizedAiUsage): Promise<void> => {
    let classification = classifyCodexQuotaFailure(error)
    if (classification.kind === 'suspect') {
      // Returning an unconfirmed failure as a result would bypass managed-task quota failover.
      classification = await classifyCodexQuotaFailureWithRateLimits(error, async () =>
        parseCodexRateLimits(
          await args.client.request<CodexAccountRateLimitsReadResponse>(
            'account/rateLimits/read',
            {},
            { signal: args.signal, timeoutMs: OWNED_REQUEST_TIMEOUT_MS }
          )
        )
      )
    }
    if (abortRequested)
      throw Object.assign(new Error('Subagent aborted'), { subagentUsage: usage, subagentModel: model })
    if (classification.kind !== 'quota') return
    throw new CodexSubagentQuotaError(classification.message, quotaPartial(text, usage))
  }

  const execute = async (): Promise<CodexSubagentResult> => {
    try {
      const providedDynamicToolNames = new Set(args.dynamicTools.map((spec) => spec.name))
      const threadOptions = {
        model: effective.modelId,
        serviceTier: args.serviceTier,
        cwd: args.cwd,
        approvalPolicy: args.readOnly ? 'untrusted' : args.approvalPolicy,
        sandbox: 'read-only',
        config: {
          // Flags cover only legacy multi-agent; the effective gate is the app-server process
          // `model_catalog_json` flag (manager.ts). Only the per-thread hint inherited by the child remains here.
          'features.multi_agent': false,
          'features.multi_agent_v2': false,
          // Some runtime versions enable imagegen by default. Subagents never produce artifacts
          // visible in the parent message, so they must disable it explicitly.
          'features.image_generation': false,
          ...nativeSubagentSuppressionConfig(),
          ...(args.readOnly ? { 'features.shell_tool': false, web_search: 'disabled' } : {}),
        },
        developerInstructions: [
          args.definition.prompt,
          `You are the delegated Maestrly subagent "${args.agentName}". Work only on the supplied task.`,
          MEMORY_TOOL_GUIDANCE,
          args.readOnly
            ? 'This delegated run is strictly read-only. Do not modify files, execute commands, or spawn subagents.'
            : 'Do not spawn subagents. Return a concise result to the parent when the task is complete.',
        ].join('\n\n'),
        personality: 'pragmatic',
      } as const
      if (args.resume) {
        // thread/resume rejects dynamicTools: the caller already compared tool signatures before requesting this.
        const resumeDeadline = ownedRequestDeadline('Codex subagent thread/resume')
        const resumeRequest = args.client.resumeThread(
          { threadId: args.resume.threadId, ...threadOptions } as Parameters<CodexAppServerClient['resumeThread']>[0],
          { timeoutMs: 0 }
        )
        void resumeRequest.catch(() => {})
        try {
          const reopened = await Promise.race([resumeRequest, abortTimeout, resumeDeadline.promise])
          threadId = reopened.thread.id
          resumed = true
        } catch (error) {
          if (abortRequested || error === resumeDeadline.error) throw error
          // Thread lost/rejected by the provider: recreate with the previous report, keeping the reason visible.
          resumeReason = 'resume-rejected'
          noteProgress(`Could not resume previous session; starting a fresh one (${errorMessage(error)})`)
        } finally {
          resumeDeadline.cancel()
        }
      }
      if (!threadId) {
        const threadDeadline = ownedRequestDeadline('Codex subagent thread/start')
        const startThreadRequest = args.client.startThread(
          {
            ...threadOptions,
            ephemeral: !args.persistRuntime,
            dynamicTools: dynamicToolRegistrations(
              args.dynamicTools.filter((spec) =>
                isSubagentToolAllowed(spec.name, args.readOnly, providedDynamicToolNames)
              )
            ),
            ...(args.readOnly ? { environments: [] } : {}),
          } as Parameters<CodexAppServerClient['startThread']>[0] & {
            dynamicTools: DynamicToolRegistrationSpec[]
            environments?: []
          },
          { timeoutMs: 0 }
        )
        void startThreadRequest.catch(() => {})
        let started: Awaited<typeof startThreadRequest>
        try {
          started = await Promise.race([startThreadRequest, abortTimeout, threadDeadline.promise])
        } catch (error) {
          if (abortRequested || error === threadDeadline.error) {
            void startThreadRequest.then((lateThread) => args.removeThread(lateThread.thread.id, true)).catch(() => {})
          }
          throw error
        } finally {
          threadDeadline.cancel()
        }
        threadId = started.thread.id
      }
      if (!args.registerThread(threadId, effective.modelId)) {
        turnTerminal = true
        throw new Error('Codex subagent parent route closed before the child could start')
      }
      args.onThreadStarted?.({ threadId, resumed })
      noteProgress(`Starting subagent ${args.agentName}`)
      if (abortRequested) {
        markTerminal()
        throw new Error('Subagent aborted before its turn started')
      }

      offNotification = args.client.onNotification(({ method, params }) => {
        if (!isRecord(params) || params.threadId !== threadId) return
        if (method === 'turn/started') {
          const turn = isRecord(params.turn) ? params.turn : null
          if (turn && typeof turn.id === 'string') turnId = turn.id
          if (abortRequested && turnId) void requestInterrupt().catch(() => {})
          return
        }
        if (method === 'thread/tokenUsage/updated') {
          latestUsage = params as unknown as TokenUsageNotification
          const current = usageOf(latestUsage)
          if (current) {
            const delta = {
              input: Math.max(0, current.input - loggedUsage.input),
              output: Math.max(0, current.output - loggedUsage.output),
              cacheRead: Math.max(0, current.cacheRead - loggedUsage.cacheRead),
              cacheCreate: 0,
              totalInput: Math.max(0, current.totalInput - loggedUsage.totalInput),
            }
            if (delta.totalInput || delta.output) {
              recordModelCallUsage({
                runtime: 'codex-subscription',
                providerId: model.providerId,
                modelId: model.modelId,
                agent: args.agentName,
                usage: delta,
              })
            }
            loggedUsage = current
          }
          return
        }
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          const itemId = typeof params.itemId === 'string' ? params.itemId : 'answer'
          textByItem.set(itemId, (textByItem.get(itemId) ?? '') + params.delta)
          emitText(currentText())
          return
        }
        if (method === 'item/started') {
          const item = isRecord(params.item) ? params.item : null
          if (item) {
            if (item.type === 'commandExecution' && typeof item.command === 'string') {
              pushBounded(checkpointState.commands, item.command, CHECKPOINT_LIST_LIMIT)
            }
            if (item.type === 'fileChange') {
              for (const path of fileChangePaths(item)) {
                pushBounded(checkpointState.filesChanged, path, CHECKPOINT_LIST_LIMIT)
              }
            }
            if (item.type === 'dynamicToolCall') {
              const dynamicTool = dynamicToolCheckpoint(item, params)
              if (dynamicTool) {
                pushDynamicToolCheckpoint(checkpointState.inFlightDynamicTools, dynamicTool, CHECKPOINT_LIST_LIMIT)
              }
            }
          }
          const progress = item ? itemProgress(item) : null
          if (progress) noteProgress(progress)
          return
        }
        if (method === 'item/completed') {
          const item = isRecord(params.item) ? params.item : null
          if (!item) return
          if (item.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
            if (!textByItem.has(item.id)) {
              textByItem.set(item.id, item.text)
              emitText(currentText())
            }
          } else {
            if (item.type === 'commandExecution' && typeof item.command === 'string') {
              pushBounded(checkpointState.commands, item.command, CHECKPOINT_LIST_LIMIT)
            }
            if (item.type === 'fileChange') {
              for (const path of fileChangePaths(item)) {
                pushBounded(checkpointState.filesChanged, path, CHECKPOINT_LIST_LIMIT)
              }
            }
            if (item.type === 'dynamicToolCall') {
              const dynamicTool = dynamicToolCheckpoint(item, params)
              if (dynamicTool) {
                removeDynamicToolCheckpoint(checkpointState.inFlightDynamicTools, dynamicTool)
                pushDynamicToolCheckpoint(checkpointState.completedDynamicTools, dynamicTool, CHECKPOINT_LIST_LIMIT)
              }
            }
            const progress = itemProgress(item)
            if (progress) noteProgress(`${progress} completed`)
          }
          return
        }
        if (method === 'turn/completed') {
          markTerminal()
          completionResolve(params as unknown as TurnCompletedNotification)
        }
        if (method === 'thread/deleted') {
          markTerminal()
          completionReject(new Error('Codex subagent thread was deleted before completion'))
        }
      })

      turnStartRequested = true
      const turnDeadline = ownedRequestDeadline('Codex subagent turn/start')
      const startTurnRequest = args.client.startTurn(
        {
          threadId,
          clientUserMessageId: randomUUID(),
          input: [codexTextInput(args.resume && !resumed ? args.resume.fallbackTask : args.task)],
          cwd: args.cwd,
          model: effective.modelId,
          serviceTier: args.serviceTier,
          approvalPolicy: args.readOnly ? 'untrusted' : args.approvalPolicy,
          sandboxPolicy: args.readOnly ? { type: 'readOnly', networkAccess: false } : args.sandboxPolicy,
          effort: effective.sentEffort,
          summary: 'auto',
          personality: 'pragmatic',
          collaborationMode: {
            mode: 'default',
            settings: {
              model: effective.modelId,
              reasoning_effort: effective.sentEffort,
              developer_instructions: null,
            },
          },
        },
        { timeoutMs: 0 }
      )
      void startTurnRequest.catch(() => {})
      let turn: Awaited<typeof startTurnRequest>
      try {
        turn = await Promise.race([startTurnRequest, abortTimeout, turnDeadline.promise])
      } catch (error) {
        const ownershipUncertain = abortRequested || error === turnDeadline.error
        // Normal RPC rejection is terminal: no turn was accepted. Local abort/timeout is ambiguous;
        // retain ownership of the original promise and terminate any late response below.
        if (!ownershipUncertain && !turnId) markTerminal()
        if (ownershipUncertain && !turnTerminal && !turnId) {
          cleanupTransferred = true
          void startTurnRequest
            .then(async (lateTurn) => {
              turnId = lateTurn.turn.id
              let interruptError: unknown
              try {
                await requestInterrupt()
              } catch (lateError) {
                interruptError = lateError
              }
              await waitForTerminalUntil(Date.now() + SUBAGENT_STOP_TIMEOUT_MS, interruptError)
            })
            .catch(() => {
              // A rejected turn/start means no turn exists to stop. A fulfilled late response is handled above.
              if (!turnId) markTerminal()
            })
            .finally(() => {
              offNotification()
              args.removeThread(threadId, turnTerminal)
            })
        }
        throw error
      } finally {
        turnDeadline.cancel()
      }
      turnId = turn.turn.id
      if (abortRequested) onAbort()
      const result = await Promise.race([
        completed,
        abortTimeout,
        args.client.waitForExit().then(() => {
          throw args.client.failure ?? new Error('Codex app-server exited while a subagent was running')
        }),
      ])
      const usage = usageOf(latestUsage)
      const text = [...textByItem.values()].join('\n\n').trim()
      if (result.turn.status === 'completed') {
        return { text: text || '(the subagent returned no text)', ...(usage ? { usage } : {}), model }
      }
      const error = result.turn.error?.message || `Codex subagent ${result.turn.status}`
      if (abortRequested)
        throw Object.assign(new Error('Subagent aborted'), { subagentUsage: usage, subagentModel: model })
      await throwIfQuota({ turn: result.turn }, text, usage)
      return { text, error, ...(usage ? { usage } : {}), model }
    } catch (error) {
      if (error instanceof CodexSubagentQuotaError) throw error
      const usage = usageOf(latestUsage)
      if (abortRequested)
        throw Object.assign(new Error(errorMessage(error)), { subagentUsage: usage, subagentModel: model })
      const text = [...textByItem.values()].join('\n\n').trim()
      await throwIfQuota(error, text, usage)
      return { text: text || '', error: errorMessage(error), ...(usage ? { usage } : {}), model }
    }
  }

  let result: CodexSubagentResult | undefined
  let executionError: unknown
  try {
    result = await execute()
  } catch (error) {
    executionError = error
  }

  let cleanupError: unknown
  try {
    if (!cleanupTransferred && threadId && turnId && !turnTerminal) {
      const deadline = shutdownDeadline ?? Date.now() + SUBAGENT_STOP_TIMEOUT_MS
      let interruptError: unknown
      try {
        await requestInterrupt()
      } catch (error) {
        interruptError = error
      }
      if (!turnTerminal) {
        try {
          await waitForTerminalUntil(deadline, interruptError)
        } catch (error) {
          cleanupError = error
        }
      }
    }
  } finally {
    args.signal.removeEventListener('abort', onAbort)
    if (abortTimer) clearTimeout(abortTimer)
    if (!cleanupTransferred) offNotification()
    if (threadId && !cleanupTransferred) {
      // Ephemeral threads are intentionally not persisted, so `thread/delete` is invalid for them. The parent
      // may release the active lifecycle record only after this runner observed a terminal notification.
      args.removeThread(threadId, turnTerminal || !turnStartRequested)
    }
  }

  const usage = usageOf(latestUsage)
  if (cleanupError) {
    throw Object.assign(new Error(errorMessage(cleanupError)), { subagentUsage: usage, subagentModel: model })
  }
  if (executionError) throw executionError
  const settled = result ?? {
    text: '',
    error: 'Codex subagent returned no result',
    ...(usage ? { usage } : {}),
    model,
  }
  return args.resume ? { ...settled, resumed, ...(resumeReason ? { resumeReason } : {}) } : settled
}
