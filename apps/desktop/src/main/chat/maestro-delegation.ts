import type { ChatModelRef, SubagentSessionSummary } from '../../shared/chat'
import type { MaestroDelegateIntent, MaestroTurnSnapshotV1 } from '../../shared/maestro'
import { normalizeSubagentProfileKey } from '../../shared/subagent-profiles'
import { BUILTIN_AGENTS, type ChatAgent } from './agents'
import {
  MaestroAgentExecutionError,
  resolveMaestroAgentExecution,
  type MaestroAgentExecutionResult,
} from './maestro-agent-execution'
import { recordSubagentDispatch, type ExplicitSubagentTurnState } from './subagent-selection-guard'
import { getSubagentSession } from './subagent-session-store'

const TERMINAL_SESSION = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function parseMaestroDelegateIntent(input: unknown): MaestroDelegateIntent {
  const raw = record(input)
  const agent = normalizeSubagentProfileKey(typeof raw.agent === 'string' ? raw.agent : '')
  const task = typeof raw.task === 'string' ? raw.task.trim() : ''
  const kind = normalizeSubagentProfileKey(typeof raw.kind === 'string' ? raw.kind : 'general') || 'general'
  const domain = normalizeSubagentProfileKey(typeof raw.domain === 'string' ? raw.domain : 'general') || 'general'
  const reviewOf = Array.isArray(raw.reviewOf)
    ? [
        ...new Set(
          raw.reviewOf
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        ),
      ]
    : []
  const resumeSessionId = typeof raw.resume_session_id === 'string' ? raw.resume_session_id.trim() : ''
  if (!task) throw new Error('delegate requires a non-empty task.')
  if (!agent) throw new Error('delegate requires an available agent id.')
  return {
    agent,
    task,
    kind,
    domain,
    reviewOf,
    independent: raw.independent === true,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  }
}

export const MAESTRO_DELEGATE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    agent: {
      type: 'string',
      description: 'Exact id of the enabled Maestro agent selected from the catalog in the system prompt.',
    },
    task: {
      type: 'string',
      description: 'Self-contained task with all context the worker needs. The worker cannot see this conversation.',
    },
    kind: {
      type: 'string',
      enum: ['explore', 'implement', 'test', 'review', 'fix', 'design', 'general'],
      description: 'Semantic type of work.',
    },
    domain: {
      type: 'string',
      description: 'Semantic domain such as frontend, backend, fullstack, infra, data, docs, or general.',
    },
    reviewOf: {
      type: 'array',
      items: { type: 'string' },
      description: 'Delegation ids being reviewed, when applicable.',
    },
    independent: { type: 'boolean', description: 'True when safe to run in parallel with sibling delegations.' },
    resume_session_id: {
      type: 'string',
      description:
        'sessionId of a terminal delegation of this SAME agent in this turn. Continues that worker in its ' +
        'existing native session (it keeps what it read, decided and produced). Use it when the original ' +
        'author applies review findings or the original reviewer re-checks its own findings. The host ' +
        'rejects a session from another agent, another turn, or one still running.',
    },
  },
  required: ['agent', 'task', 'kind', 'domain'],
  additionalProperties: false,
} as const

export const MAESTRO_DELEGATE_TOOL_DESCRIPTION =
  'Starts the exact logical Maestro agent selected by the parent and immediately returns a sessionId handle. ' +
  'Set agent to an enabled id from the complete catalog; Maestrly never substitutes another agent. Start ' +
  'independent workers, then call wait_delegation once per worker; its host-owned wait coalesces routine progress.'

function candidateLine(candidate: MaestroTurnSnapshotV1['pool'][number]['candidates'][number], index: number): string {
  return `${index + 1}. provider=${candidate.providerId}, model=${candidate.modelId}, effort=${candidate.effort}, Fast=${candidate.fastMode === true ? 'on' : 'off'}`
}

/** Complete non-secret catalog shown to the parent. This is intentionally separate from the regular subagent
 * catalog because Maestro lets the parent inspect execution candidates before choosing a logical agent. */
export function renderMaestroAgentCatalog(turn: MaestroTurnSnapshotV1): string {
  const agents = turn.pool.filter((resource) => resource.enabled)
  const lines = agents.map((resource) => {
    const candidates = resource.candidates.length
      ? resource.candidates.map(candidateLine).join(' | ')
      : 'inherits the parent provider/model/effort/Fast'
    return [
      `- ${resource.id} (${resource.label})`,
      `  capability: ${resource.capability}`,
      `  description: ${resource.description}`,
      `  specialties: ${resource.specialties.join(', ') || 'general'}`,
      `  physical binding: ${resource.agentName?.trim() || '(virtual resource)'}`,
      `  instructions: ${resource.instructions?.trim() || '(default agent instructions)'}`,
      `  execution candidates: ${candidates}`,
    ].join('\n')
  })
  return [
    '# Maestro Agent Pool',
    'You choose the logical agent for every delegate call. Maestrly validates and executes that exact agent and never substitutes another one.',
    'Use capability, specialties, instructions, and configured execution candidates to make the choice. You may run independent agents in parallel.',
    '`#agent-name` in the user message is a mandatory selection for that responsibility.',
    'Available enabled agents:',
    ...lines,
  ].join('\n')
}

export function maestroAgentsFromTurn(
  turn: MaestroTurnSnapshotV1,
  physicalAgents: readonly ChatAgent[] = BUILTIN_AGENTS
): ChatAgent[] {
  // Project snapshots may only bind portable built-ins. Local files with the same name must not change a
  // shared job's behavior; local/conversation Maestro keeps the user-resolved physical catalog unchanged.
  const executionAgents = turn.source === 'project' ? BUILTIN_AGENTS : physicalAgents
  const fallbackWorker =
    executionAgents.find((agent) => normalizeSubagentProfileKey(agent.name) === 'general-purpose') ??
    BUILTIN_AGENTS.find((agent) => agent.name === 'general-purpose')!
  const fallbackReader =
    executionAgents.find((agent) => normalizeSubagentProfileKey(agent.name) === 'explore') ??
    BUILTIN_AGENTS.find((agent) => agent.name === 'explore')!
  return turn.pool
    .filter((resource) => resource.enabled)
    .map((resource) => {
      const imported = resource.agentName
        ? executionAgents.find(
            (agent) => normalizeSubagentProfileKey(agent.name) === normalizeSubagentProfileKey(resource.agentName!)
          )
        : undefined
      const base = imported ?? (resource.capability === 'worker' ? fallbackWorker : fallbackReader)
      const basePrompt =
        resource.instructions?.trim() ||
        `${base.prompt}\n\nYou are the Maestro Pool resource “${resource.label}”. Focus on: ${resource.specialties.join(', ') || 'general'}.`
      const operationalBoundary =
        resource.capability === 'read-only'
          ? 'This Maestro delegation still receives the full operational tool catalog. You may use your isolated browser tabs and terminals to inspect, run validation, reproduce behavior, and gather evidence. Keep project source changes out of a review/investigation task unless the delegated task explicitly requires a fix.'
          : 'This Maestro delegation receives the full operational tool catalog. Browser tabs and terminals created for you are isolated to this delegation; use only those scoped resources and never attempt to control another worker’s resources.'
      return {
        ...base,
        name: resource.id,
        description: resource.description,
        category: resource.specialties[0] ?? 'general',
        tools: resource.capability === 'worker' ? (base.tools ?? fallbackWorker.tools) : undefined,
        prompt: `${basePrompt}\n\n${operationalBoundary}`,
        source: resource.agentName ? `maestro-import:${base.source}` : 'maestro-pool',
        virtual: true,
        baseAgentName: base.name,
      }
    })
}

function pendingExplicitAgent(state: ExplicitSubagentTurnState): string | undefined {
  return [...state.requested].find((name) => !state.dispatched.has(name))
}

/**
 * Identity is enforced by the host, not by the prompt: a resumed session must be a terminal `delegate` of the
 * same agent, in the same conversation and the same parent turn. Each violation has its own code so the parent
 * sees exactly which rule failed.
 */
export function assertMaestroResumeSession(args: {
  intent: MaestroDelegateIntent
  owner?: { conversationId: string; parentMessageId: string }
  lookupSession?: (sessionId: string) => SubagentSessionSummary | null
}): void {
  const sessionId = args.intent.resumeSessionId
  if (!sessionId) return
  const session = (args.lookupSession ?? getSubagentSession)(sessionId)
  if (!session) {
    throw new MaestroAgentExecutionError(
      'resume-session-not-found',
      `resume_session_id “${sessionId}” does not name a known delegation.`
    )
  }
  if (
    !args.owner ||
    session.origin !== 'delegate' ||
    session.conversationId !== args.owner.conversationId ||
    session.parentMessageId !== args.owner.parentMessageId
  ) {
    throw new MaestroAgentExecutionError(
      'resume-session-foreign',
      `resume_session_id “${sessionId}” belongs to another turn or conversation; only delegations of this turn can be resumed.`
    )
  }
  if (!TERMINAL_SESSION.has(session.status)) {
    throw new MaestroAgentExecutionError(
      'resume-session-active',
      `resume_session_id “${sessionId}” is still ${session.status}; wait for it to finish before continuing it.`
    )
  }
  if (normalizeSubagentProfileKey(session.agentName) !== args.intent.agent) {
    throw new MaestroAgentExecutionError(
      'resume-agent-mismatch',
      `resume_session_id “${sessionId}” was run by agent “${session.agentName}”, not “${args.intent.agent}”; a session can only be continued by the same agent.`
    )
  }
}

export async function prepareMaestroDelegation(args: {
  input: unknown
  turn: MaestroTurnSnapshotV1
  parent: ChatModelRef & { effort: string }
  parentFastMode: boolean
  turnState: ExplicitSubagentTurnState
  delegationId?: string
  /** Required to accept `resume_session_id`; without it any resume request is rejected as foreign. */
  owner?: { conversationId: string; parentMessageId: string }
  lookupSession?: (sessionId: string) => SubagentSessionSummary | null
}): Promise<{
  intent: MaestroDelegateIntent
  execution: MaestroAgentExecutionResult
  agentName: string
  task: string
}> {
  const intent = parseMaestroDelegateIntent(args.input)
  assertMaestroResumeSession({ intent, owner: args.owner, lookupSession: args.lookupSession })
  const explicitAgent = pendingExplicitAgent(args.turnState)
  // Reserve before the first async profile check. Parallel delegate calls otherwise observe the same pending
  // resource and all route to it, leaving later explicit user selections undispatched.
  if (explicitAgent && explicitAgent === intent.agent) recordSubagentDispatch(args.turnState, explicitAgent)
  const execution = await resolveMaestroAgentExecution({
    intent,
    turn: args.turn,
    parent: args.parent,
    parentFastMode: args.parentFastMode,
    explicitAgent,
    delegationId: args.delegationId,
  })
  recordSubagentDispatch(args.turnState, execution.resource.id)
  return { intent, execution, agentName: execution.resource.id, task: intent.task }
}
