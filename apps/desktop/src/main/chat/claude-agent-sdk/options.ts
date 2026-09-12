import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeToolBridge } from './tools'

const CLAUDE_EFFORT_LEVELS = new Set<NonNullable<Options['effort']>>(['low', 'medium', 'high', 'xhigh', 'max'])

export function resolveClaudeEffort(requested: string | undefined): Options['effort'] {
  if (!requested || !CLAUDE_EFFORT_LEVELS.has(requested as NonNullable<Options['effort']>)) return undefined
  return requested as NonNullable<Options['effort']>
}

/** SDK settings required for Fast Mode to take effect per session. */
export function buildClaudeFastModeSettings(fastMode: boolean): {
  fastMode: boolean
  fastModePerSessionOptIn: true
} {
  return { fastMode, fastModePerSessionOptIn: true }
}

export interface BuildClaudeChatQueryOptionsArgs {
  abortController: AbortController
  cwd: string
  modelId: string
  reasoningEffort?: string
  fastMode?: boolean
  systemPrompt: string
  bridge: ClaudeToolBridge
  postToolUseHook?: HookCallbackMatcher
  disallowedNativeTools: readonly string[]
  resume?: string
  resumeSessionAt?: string
  forkSession?: boolean
}

/**
 * Builds the locked-down Agent SDK surface used by Maestrly chat.
 *
 * Keep this function pure: account validation and session lifecycle stay in
 * the caller, while this object remains straightforward to audit and test.
 */
export function buildClaudeChatQueryOptions(args: BuildClaudeChatQueryOptionsArgs): Options {
  const effort = resolveClaudeEffort(args.reasoningEffort)
  return {
    abortController: args.abortController,
    cwd: args.cwd,
    model: args.modelId,
    ...(effort ? { effort } : {}),
    systemPrompt: args.systemPrompt,
    settingSources: [],
    settings: {
      ...buildClaudeFastModeSettings(Boolean(args.fastMode)),
      promptSuggestionEnabled: false,
      autoMemoryEnabled: false,
      autoCompactEnabled: false,
      precomputeCompactionEnabled: false,
    },
    strictMcpConfig: true,
    mcpServers: { maestrly: args.bridge.server },
    tools: [],
    allowedTools: args.bridge.allowedTools,
    disallowedTools: [...args.disallowedNativeTools],
    toolAliases: args.bridge.toolAliases,
    skills: [],
    plugins: [],
    agents: {},
    hooks: {
      PreToolUse: [args.bridge.preToolUseHook],
      ...(args.postToolUseHook ? { PostToolUse: [args.postToolUseHook] } : {}),
    },
    ...(args.postToolUseHook ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    permissionMode: 'dontAsk',
    includePartialMessages: true,
    promptSuggestions: false,
    persistSession: true,
    ...(args.resume ? { resume: args.resume } : {}),
    ...(args.resumeSessionAt
      ? {
          resumeSessionAt: args.resumeSessionAt,
          forkSession: Boolean(args.forkSession),
        }
      : {}),
  }
}

export interface BuildClaudeCompactionQueryOptionsArgs {
  abortController: AbortController
  cwd: string
  modelId: string
  sessionId: string
  disallowedNativeTools: readonly string[]
}

export function buildClaudeCompactionQueryOptions(args: BuildClaudeCompactionQueryOptionsArgs): Options {
  return {
    abortController: args.abortController,
    cwd: args.cwd,
    model: args.modelId,
    resume: args.sessionId,
    systemPrompt: 'Execute the requested Claude session command.',
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    tools: [],
    allowedTools: [],
    disallowedTools: [...args.disallowedNativeTools],
    skills: [],
    plugins: [],
    agents: {},
    permissionMode: 'dontAsk',
    includePartialMessages: false,
    promptSuggestions: false,
  }
}
