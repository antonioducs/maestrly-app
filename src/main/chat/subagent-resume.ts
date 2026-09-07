import { createHash } from 'node:crypto'
import type { SubagentRuntimeHandle } from '../../shared/chat'
import { getClaudeSubscriptionManager } from './claude-agent-sdk/manager'
import { clearClaudeSessionCleanup } from './claude-agent-sdk/session-store'
import {
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isGitHubCopilotSubscriptionProvider,
} from './catalog'
import { getCodexSubscriptionManager } from './codex-subscription/manager'
import { clearCodexThreadCleanup } from './codex-subscription/thread-store'
import { renderTranscript } from './message'
import {
  getSubagentRuntimeHandle,
  getSubagentSession,
  getSubagentTranscriptPage,
  listSubagentSessions,
  updateSubagentSession,
} from './subagent-session-store'

const LAST_REPORT_MAX_CHARS = 8_000
const REPLAY_MAX_TOOL_OUTPUT_CHARS = 4_000
const REPLAY_MAX_CHARS = 160_000
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

/** Previous turn as chat history: the available "resume" for stateless providers (BYOK/ai-sdk). */
export type SubagentReplayMessage = { role: 'user' | 'assistant'; content: string }

export interface SubagentResumeSource {
  sessionId: string
  agentName: string
  handle: SubagentRuntimeHandle | null
  /** Previous turn's last assistant text (clipped). Empty when the worker reported nothing. */
  lastReport: string
  /** Rendered previous task + assistant work (text and tools); empty without a useful transcript. */
  replay: SubagentReplayMessage[]
}

export type SubagentResumeRecreateReason =
  | 'provider-unsupported'
  | 'no-runtime-handle'
  | 'no-transcript'
  | 'provider-mismatch'
  | 'account-changed'
  | 'tools-changed'
  | 'model-changed'
  | 'behavior-profile-changed'
  | 'definition-changed'
  | 'resume-rejected'
  | 'session-replaced'

export type SubagentResumePlan =
  | { mode: 'native'; handle: SubagentRuntimeHandle }
  | { mode: 'replay'; history: SubagentReplayMessage[] }
  | { mode: 'recreate'; reason: SubagentResumeRecreateReason }

/**
 * Signature of sorted dynamic-tool NAMES for a Codex worker. thread/resume does not accept dynamicTools,
 * so a list different from the original thread/start invalidates resume (`tools-changed`).
 */
export function subagentToolSignature(specs: ReadonlyArray<{ name: string }>): string {
  const names = specs.map((spec) => spec.name).sort()
  return createHash('sha256').update(JSON.stringify(names)).digest('hex')
}

export function claudeSubagentRuntimeSignature(input: {
  modelId: string
  behaviorProfileId: string | null
  prompt: string
  readOnly: boolean
  sentEffort: string | null
  fastMode: boolean
  toolNames: readonly string[]
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        modelId: input.modelId,
        behaviorProfileId: input.behaviorProfileId,
        prompt: input.prompt,
        readOnly: input.readOnly,
        sentEffort: input.sentEffort,
        fastMode: input.fastMode,
        toolNames: [...input.toolNames].sort(),
      })
    )
    .digest('hex')
}

/** Reads what the previous turn left: native handle (if any) and final report for fallback. */
export function resolveSubagentResume(sessionId: string): SubagentResumeSource | null {
  const session = getSubagentSession(sessionId)
  if (!session) return null
  const page = getSubagentTranscriptPage(sessionId, { limit: 1_000 })
  let lastReport = ''
  const assistantMessages = (page?.messages ?? []).filter((message) => message.role === 'assistant')
  for (const message of assistantMessages) {
    for (const part of message.parts) {
      if (part.type === 'text' && part.text.trim()) lastReport = part.text
    }
  }
  // renderTranscript prefixes blocks with roles; the chat message already supplies the role here, so keep only the body.
  const work = renderTranscript(assistantMessages, {
    maxToolOutputChars: REPLAY_MAX_TOOL_OUTPUT_CHARS,
    maxChars: REPLAY_MAX_CHARS,
  })
    .replace(/^Assistant: /, '')
    .trim()
  return {
    sessionId,
    agentName: session.agentName,
    handle: getSubagentRuntimeHandle(sessionId),
    lastReport:
      lastReport.length > LAST_REPORT_MAX_CHARS ? `${lastReport.slice(0, LAST_REPORT_MAX_CHARS)}…` : lastReport,
    replay: work
      ? [
          { role: 'user', content: session.task },
          { role: 'assistant', content: work },
        ]
      : [],
  }
}

/**
 * Decides without IO how the next turn continues: `native` reopens the provider thread (Codex/Claude),
 * `replay` resends the previous turn as history (stateless BYOK/ai-sdk), and any provider, account,
 * or toolset mismatch yields `recreate` with its reason — parent and UI see the exact cause.
 */
export function planSubagentResume(input: {
  providerId: string
  accountId: string | null
  /** Codex only: thread/resume does not accept dynamicTools, so tool lists must be identical. */
  toolSignature?: string
  /** Claude-only native-session identity and prompt contract. */
  modelId?: string
  behaviorProfileId?: string | null
  runtimeSignature?: string
  resume: Pick<SubagentResumeSource, 'handle'> & Partial<Pick<SubagentResumeSource, 'replay'>>
}): SubagentResumePlan {
  const codex = isCodexSubscriptionProvider(input.providerId)
  const claude = isClaudeSubscriptionProvider(input.providerId)
  if (!codex && !claude) {
    // Copilot has sessions but its worker runner does not yet expose handles; BYOK has no server-side
    // session, so previous-turn history IS the resume.
    if (isGitHubCopilotSubscriptionProvider(input.providerId)) {
      return { mode: 'recreate', reason: 'provider-unsupported' }
    }
    const history = input.resume.replay ?? []
    return history.length ? { mode: 'replay', history } : { mode: 'recreate', reason: 'no-transcript' }
  }
  const handle = input.resume.handle
  if (!handle) return { mode: 'recreate', reason: 'no-runtime-handle' }
  if ((codex && handle.kind !== 'codex-thread') || (claude && handle.kind !== 'claude-session')) {
    return { mode: 'recreate', reason: 'provider-mismatch' }
  }
  if ((handle.accountId ?? null) !== (input.accountId ?? null)) return { mode: 'recreate', reason: 'account-changed' }
  if (handle.kind === 'claude-session') {
    if (input.modelId !== undefined && handle.modelId !== input.modelId) {
      return { mode: 'recreate', reason: 'model-changed' }
    }
    if (input.behaviorProfileId !== undefined && (handle.behaviorProfileId ?? null) !== input.behaviorProfileId) {
      return { mode: 'recreate', reason: 'behavior-profile-changed' }
    }
    if (input.runtimeSignature !== undefined && handle.runtimeSignature !== input.runtimeSignature) {
      return { mode: 'recreate', reason: 'definition-changed' }
    }
  }
  if (
    handle.kind === 'codex-thread' &&
    input.toolSignature !== undefined &&
    handle.toolSignature !== input.toolSignature
  ) {
    return { mode: 'recreate', reason: 'tools-changed' }
  }
  return { mode: 'native', handle }
}

/** Recreated-turn task: the new worker receives the previous report as explicit context. */
export function recreatedTask(
  task: string,
  previous: Pick<SubagentResumeSource, 'sessionId' | 'agentName' | 'lastReport'>,
  reason: SubagentResumeRecreateReason
): string {
  const report = previous.lastReport.trim() || '(the previous turn returned no text)'
  return [
    `<maestrly-previous-turn agent="${previous.agentName}" session="${previous.sessionId}" reason="${reason}">`,
    'The parent asked you to continue a previous turn of yours, but the native session could not be resumed.',
    'This is your final report from that turn; treat it as your own prior work:',
    '',
    report,
    '</maestrly-previous-turn>',
    '',
    task,
  ].join('\n')
}

export interface ReleaseRuntimeDeps {
  deleteCodexThread: (threadId: string, accountId: string | null) => Promise<void>
  deleteClaudeSession: (sessionId: string, cwd: string, accountId: string | null) => Promise<void>
}

const defaultReleaseDeps: ReleaseRuntimeDeps = {
  deleteCodexThread: (threadId, accountId) =>
    getCodexSubscriptionManager(accountId).deleteThread(threadId, { signal: AbortSignal.timeout(15_000) }),
  deleteClaudeSession: (sessionId, cwd, accountId) =>
    getClaudeSubscriptionManager(accountId).deleteManagedSession(sessionId, cwd),
}

function alreadyMissing(message: string): boolean {
  return /\b(not found|does not exist|no such)\b/i.test(message)
}

/**
 * Parent turn end: deletes native threads/sessions persisted by terminal delegations. Idempotent —
 * clear the handle after success, count "not found" as success, and retain failures in the existing cleanup tombstone
 * for the next boot's sweeper.
 */
export async function releaseTurnDelegationRuntimes(
  conversationId: string,
  parentMessageId: string,
  deps: ReleaseRuntimeDeps = defaultReleaseDeps
): Promise<{ released: string[]; failed: string[] }> {
  const released: string[] = []
  const failed: string[] = []
  const sessions = listSubagentSessions(conversationId, { parentMessageId, origin: 'delegate', limit: 200 })
  for (const session of sessions) {
    if (!TERMINAL.has(session.status)) continue
    const handle = getSubagentRuntimeHandle(session.id)
    if (!handle) continue
    try {
      if (handle.kind === 'codex-thread') {
        try {
          await deps.deleteCodexThread(handle.threadId, handle.accountId)
        } catch (error) {
          if (!alreadyMissing(error instanceof Error ? error.message : String(error))) throw error
        }
        clearCodexThreadCleanup(handle.threadId)
      } else {
        try {
          await deps.deleteClaudeSession(handle.sessionId, handle.cwd, handle.accountId)
        } catch (error) {
          if (!alreadyMissing(error instanceof Error ? error.message : String(error))) throw error
        }
        clearClaudeSessionCleanup(handle.sessionId)
      }
      updateSubagentSession(session.id, { runtimeHandle: null })
      released.push(session.id)
    } catch {
      // The tombstone written when the remote ID was created keeps the resource enumerable by the sweeper.
      failed.push(session.id)
    }
  }
  return { released, failed }
}
