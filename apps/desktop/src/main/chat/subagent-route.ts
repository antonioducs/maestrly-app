import {
  TASK_COMPLEXITIES,
  type SubagentDelegationInfo,
  type SubagentProfileCandidate,
  type TaskComplexity,
} from '../../shared/subagent-profiles'

export interface SubagentRoute {
  info: SubagentDelegationInfo
  /** Ordered candidates for the task; empty when no allowed model fits and the normal profile rules apply. */
  candidates: SubagentProfileCandidate[]
}
export type SubagentRouter = (request: { agentName: string; complexity: TaskComplexity | null }) => SubagentRoute

/** Conversations whose tasks a host routes by difficulty (a bot in delegate mode), by conversation id. */
const routers = new Map<string, SubagentRouter>()

export function setSubagentRouter(conversationId: string, router: SubagentRouter | null): void {
  if (router) routers.set(conversationId, router)
  else routers.delete(conversationId)
}

export function getSubagentRouter(conversationId: string): SubagentRouter | null {
  return routers.get(conversationId) ?? null
}

export function parseTaskComplexity(value: unknown): TaskComplexity | null {
  return typeof value === 'string' && (TASK_COMPLEXITIES as readonly string[]).includes(value)
    ? (value as TaskComplexity)
    : null
}

const TASK_COMPLEXITY_PROPERTY = {
  type: 'string',
  enum: [...TASK_COMPLEXITIES],
  description:
    'How hard the task is: simple (mechanical or high-volume: download, rename, convert, transcribe, extract), medium (routine writing, editing or code), complex (unknown causes, design decisions, subtle correctness). Maestrly runs it on a model sized for it.',
}

/** The `task` input schema of a conversation: with a router, `complexity` is required so every task is sized. */
export function withTaskComplexity<T extends { properties: Record<string, unknown>; required: string[] }>(
  schema: T,
  conversationId: string
): T {
  if (!routers.has(conversationId)) return schema
  return {
    ...schema,
    properties: { ...schema.properties, complexity: TASK_COMPLEXITY_PROPERTY },
    required: [...schema.required, 'complexity'],
  }
}
