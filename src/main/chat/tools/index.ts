/**
 * Tool registry + Vercel AI SDK adapter. Ported from opencode tool/registry.ts: replaces
 * Layer/Scope/WeakMap/JSON-schema generation with a simple record + `ai` `tool()` (already generates
 * JSON schema from zod). Filter by Set membership.
 */
import { tool, type Tool, type ToolSet } from 'ai'
import { bashTool } from './bash'
import { readTool } from './read'
import { writeTool } from './write'
import { editTool } from './edit'
import { grepTool } from './grep'
import { globTool } from './glob'
import { webfetchTool } from './webfetch'
import { questionTool } from './question'
import { todoWriteTool } from './todo'
import { reviewPlanTool } from './review-plan'
import { generateImageTool } from './generate-image'
import { gitDiffTool } from './git-diff'
import { readExecutionContextTool, searchExecutionContextTool } from './execution-context'
import { submitReviewTool } from './submit-review'
import { boundText, type ToolContext, type ToolDef } from './util'
import { chatToolOutputToAiSdkOutput, modelOutputToChatToolOutput } from '../tool-output'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import { capabilityBehaviorFor } from '../../../shared/chat-mode'
import { isHostToolReadOnly } from '../tool-policy'
import { OPENAI_APPLY_PATCH_TOOL_NAME, OPENAI_LOCAL_SHELL_TOOL_NAME } from '../openai/native-tools'

export const ALL_TOOLS: ToolDef<any, any>[] = [
  readTool,
  grepTool,
  globTool,
  bashTool,
  writeTool,
  editTool,
  webfetchTool,
  questionTool,
  todoWriteTool,
  reviewPlanTool,
  generateImageTool,
  gitDiffTool,
  searchExecutionContextTool,
  readExecutionContextTool,
  submitReviewTool,
]
export const ALL_TOOL_NAMES = ALL_TOOLS.map((t) => t.name)

/** Tools that MUTATE the environment (execute commands / write). Excluded in Plan mode. */
const MUTATING_TOOL_NAMES = new Set(['bash', 'write', 'edit'])
/** AGENT-only tools (work organization) — excluded from read-only modes (plan/ask). */
const AGENT_ONLY_TOOL_NAMES = new Set(['todo_write'])
/** review_plan (submit & release) does not mutate the environment but is the Plan-mode ACTION — allowed in plan/agent,
 * never ask. Separate from generic read-only handling (otherwise Plan would lack it). */
const PLAN_TOOL_NAME = 'review_plan'
/** OPT-IN tools: never enabled by mode alone. Runner adds to `enabled` when the feature is enabled
 * (generate_image requires imagegen toggle + connected ChatGPT subscription — see chat/image-gen.ts). */
const OPT_IN_TOOL_NAMES = new Set([
  'generate_image',
  'git_diff',
  'search_execution_context',
  'read_execution_context',
  'submit_review',
])

/** Exact built-in surface for a technically read-only reviewer turn. */
export const REVIEWER_READONLY_TOOL_NAMES = new Set([
  'read',
  'grep',
  'glob',
  'git_diff',
  'search_execution_context',
  'read_execution_context',
  'submit_review',
])

/** Capabilities that make an Agent subagent a worker instead of a read-only investigator. */
export const SUBAGENT_MUTATING_TOOL_NAMES = new Set(['bash', 'write', 'edit', 'generate_image'])
/** Parent-only meta tools never delegated to children; they must not flip read-only classification. */
const PARENT_ONLY_CHILD_TOOL_NAMES = new Set([
  'task',
  'delegate',
  'review_plan',
  'todo_write',
  'use_skill',
  'wait_delegation',
  'list_delegations',
  'inspect_subagent',
  'cancel_delegation',
])

/**
 * Whether a configured subagent tool proves a MUTATING capability. Core mutators always do; provider-native
 * OpenAI tools (local_shell/apply_patch) are not host ToolSet entries and their mutating contract is explicit
 * here, so retry/idempotency guards share the exact same classification as capability gating; an explicitly
 * configured host tool with no proven read-only contract (mutating app tools, MCP tools without readOnlyHint,
 * unknown/unprovided names) fails closed as mutating. Core read-only built-ins and read-only-hinted host tools
 * never do. Same read-only source of truth as selectSubagentToolNames (isHostToolReadOnly/APP_TOOL_POLICY).
 */
export function subagentToolMutates(name: string, providedHostTools?: ToolSet | ReadonlySet<string>): boolean {
  if (SUBAGENT_MUTATING_TOOL_NAMES.has(name)) return true
  if (name === OPENAI_LOCAL_SHELL_TOOL_NAME || name === OPENAI_APPLY_PATCH_TOOL_NAME) return true
  if (PARENT_ONLY_CHILD_TOOL_NAMES.has(name)) return false
  if (READ_ONLY_TOOL_NAMES.includes(name)) return false
  const entry = hostToolEntries(providedHostTools ?? new Set<string>()).find(([providedName]) => providedName === name)
  return !isHostToolReadOnly(name, (entry?.[1] as { metadata?: unknown } | undefined)?.metadata)
}

export function hasSubagentMutatingCapability(
  configured: readonly string[] | undefined,
  providedHostTools?: ToolSet | ReadonlySet<string>
): boolean {
  return configured?.some((name) => subagentToolMutates(name, providedHostTools)) === true
}

/** Plan/Ask clamp children. Maestro's parent is read-only, but its Pool workers retain their own capability. */
export function isSubagentReadOnly(
  mode: ChatBehavior,
  configured?: readonly string[],
  providedHostTools?: ToolSet | ReadonlySet<string>
): boolean {
  return mode === 'plan' || mode === 'ask' || !hasSubagentMutatingCapability(configured, providedHostTools)
}

/** Opt-in tools never enter by mode; runners apply capability-specific gates. */
export function isOptInToolName(name: string): boolean {
  return OPT_IN_TOOL_NAMES.has(name)
}

/**
 * Worker capability boundary: host-managed `generate_image` may be delegated only when the parent actually
 * supplied that tool and the child is mutable. Read-only children never inherit it, and no native imagegen
 * capability is implied by this helper.
 */
export function isSubagentToolAllowed(
  name: string,
  readOnly: boolean,
  providedHostToolNames: ReadonlySet<string>
): boolean {
  if (!isOptInToolName(name)) return true
  return name === generateImageTool.name && !readOnly && providedHostToolNames.has(name)
}

interface SubagentDefinitionLike {
  name?: string
  source?: string
  tools?: readonly string[]
  virtual?: boolean
  baseAgentName?: string
}

function isInheritedWorker(definition: SubagentDefinitionLike): boolean {
  return (
    (definition.source === 'built-in' && definition.name === 'general-purpose') ||
    (definition.virtual === true && definition.baseAgentName === 'general-purpose')
  )
}

function hostToolEntries(providedHostTools: ToolSet | ReadonlySet<string>): Array<[string, unknown]> {
  return providedHostTools instanceof Set
    ? [...providedHostTools].map((name) => [name, undefined])
    : Object.entries(providedHostTools)
}

/**
 * Selects a child surface from the definition and the already-gated parent host surface.
 * Built-in workers inherit all parent host tools in Agent; read-only children inherit only host tools with a
 * proven read-only contract. A custom explicit `tools:` list remains an allowlist.
 */
export function selectSubagentToolNames(args: {
  definition: SubagentDefinitionLike
  readOnly: boolean
  providedHostTools?: ToolSet | ReadonlySet<string>
  /** Host-governed progressive-disclosure loader; enabled explicitly for Maestro workers only. */
  allowSkillLoader?: boolean
}): Set<string> {
  const providedHostTools = args.providedHostTools ?? new Set<string>()
  const entries = hostToolEntries(providedHostTools)
  const providedHostToolNames = new Set(entries.map(([name]) => name))
  const explicit = Boolean(args.definition.tools?.length)
  const inheritedWorker = isInheritedWorker(args.definition)
  const readOnlyHostNames = new Set(
    entries
      .filter(([name, rawTool]) => isHostToolReadOnly(name, (rawTool as { metadata?: unknown } | undefined)?.metadata))
      .map(([name]) => name)
  )

  let selected: Set<string>
  if (args.readOnly) {
    if (explicit && !inheritedWorker) {
      selected = new Set(
        args.definition.tools!.filter((name) => {
          const hostTool = entries.find(([providedName]) => providedName === name)?.[1]
          return (
            READ_ONLY_TOOL_NAMES.includes(name) ||
            isHostToolReadOnly(name, (hostTool as { metadata?: unknown } | undefined)?.metadata)
          )
        })
      )
    } else {
      selected = new Set(READ_ONLY_TOOL_NAMES)
      for (const name of readOnlyHostNames) selected.add(name)
    }
  } else if (inheritedWorker) {
    selected = new Set(args.definition.tools?.length ? args.definition.tools : READ_ONLY_TOOL_NAMES)
    for (const name of providedHostToolNames) selected.add(name)
  } else if (explicit) {
    selected = new Set(args.definition.tools)
  } else {
    selected = new Set(READ_ONLY_TOOL_NAMES)
    for (const name of readOnlyHostNames) selected.add(name)
  }

  for (const forbidden of ['task', 'delegate', 'review_plan', 'ask_question', 'todo_write']) {
    selected.delete(forbidden)
  }
  if (!args.allowSkillLoader) selected.delete('use_skill')
  for (const name of selected) {
    if (!isSubagentToolAllowed(name, args.readOnly, providedHostToolNames)) selected.delete(name)
  }
  return selected
}
/** Generic read-only tools (Plan/Ask): read/grep/glob/webfetch/ask_question. review_plan enters
 * only Plan (not Ask), so stays OUT here and is added explicitly by builtinToolNamesForMode. */
export const READ_ONLY_TOOL_NAMES = ALL_TOOL_NAMES.filter(
  (n) =>
    !MUTATING_TOOL_NAMES.has(n) && !AGENT_ONLY_TOOL_NAMES.has(n) && !OPT_IN_TOOL_NAMES.has(n) && n !== PLAN_TOOL_NAME
)

/** Built-ins by capability: Agent/Design = all except opt-ins; Plan = read-only + review_plan; Ask = read-only. */
export function builtinToolNamesForMode(mode: ChatBehavior): Set<string> {
  const capabilities = capabilityBehaviorFor(mode)
  const selected =
    capabilities === 'agent'
      ? new Set(ALL_TOOL_NAMES.filter((n) => !OPT_IN_TOOL_NAMES.has(n)))
      : capabilities === 'plan'
        ? new Set([...READ_ONLY_TOOL_NAMES, PLAN_TOOL_NAME])
        : new Set(READ_ONLY_TOOL_NAMES)
  return selected
}

function toAiTool(def: ToolDef<any, any>, makeCtx: (toolCallId: string, signal: AbortSignal) => ToolContext): Tool {
  return tool({
    description: def.description,
    inputSchema: def.parameters,
    execute: async (args: unknown, opts: { toolCallId: string; abortSignal?: AbortSignal }) => {
      const ctx = makeCtx(opts.toolCallId, opts.abortSignal ?? new AbortController().signal)
      const result = await def.execute(args, ctx)
      return boundText(def.toModelText(args, result), opts.toolCallId)
    },
    // Keep the generic adapter explicit: AI SDK otherwise turns any future structured/multimodal built-in
    // output into JSON before the provider sees it. Current built-ins remain the legacy bound text path.
    toModelOutput: ({ output }: { output: unknown }) => {
      const normalized = modelOutputToChatToolOutput(output)
      return typeof normalized === 'string'
        ? { type: 'text' as const, value: normalized || '(no output)' }
        : chatToolOutputToAiSdkOutput(normalized)
    },
  })
}

/** Builds the ToolSet for `streamText({ tools })`. */
export function buildTools(opts: {
  enabled?: Set<string>
  makeCtx: (toolCallId: string, signal: AbortSignal) => ToolContext
}): ToolSet {
  const out: ToolSet = {}
  for (const def of ALL_TOOLS) {
    if (opts.enabled && !opts.enabled.has(def.name)) continue
    out[def.name] = toAiTool(def, opts.makeCtx)
  }
  return out
}
