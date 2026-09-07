import { createHash, randomUUID } from 'node:crypto'
import { jsonSchema, tool, type ToolSet } from 'ai'
import type {
  CitationSource,
  Citations,
  CopilotSession,
  MessageOptions,
  SessionEvent,
  Tool as CopilotTool,
} from '@github/copilot-sdk'
import type {
  ChatMessage,
  ChatModelRef,
  ChatPermMode,
  ChatSubagentUsage,
  ChatStreamEvent,
  ChatUsage,
  SubagentRunMeta,
  ToolOutput,
} from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import { capabilityBehaviorFor } from '../../../shared/chat-mode'
import type { MaestroTurnSnapshotV1 } from '../../../shared/maestro'
import { applyChatEvent } from '../../../shared/chat'
import { responseDurationMs } from '../../../shared/response-duration'
import { getAppFlag, getConversation, getConvUiPrefs } from '../../store'
import { stagePlan } from '../../plan-broker'
import { gitEnvInfo } from '../../git-service'
import { buildAppTools, buildMcpTools } from '../mcp'
import { chatDiag } from '../diag-log'
import { lastConversationContextMessage, runnerContextHistory, upsertChatMessage } from '../chat-store'
import { createDeltaCoalescer } from '../delta-coalescer'
import {
  clipPersistedToolOutput,
  droppedImageText,
  nativeSeedContextText,
  renderNativeSeedTranscript,
  renderTranscript,
} from '../message'
import type { PermissionBroker } from '../permission'
import type { QuestionBroker } from '../question-broker'
import { buildProjectContext } from '../project-context'
import { renderSkillContext, skillCatalogLine, type ChatSkill } from '../skills'
import { effectiveSkills, findEffectiveSkill } from '../skill-state'
import type { ChatAgent } from '../agents'
import { listEffectiveAgents } from '../virtual-subagents'
import { buildAndRenderSubagentDispatchCatalog } from '../subagent-dispatch-catalog'
import {
  assertSubagentSelection,
  createExplicitSubagentTurnState,
  recordSubagentDispatch,
} from '../subagent-selection-guard'
import { detectExplicitSubagentsForTurn } from '../subagent-turn-request'
import {
  builtinToolNamesForMode,
  buildTools,
  isSubagentReadOnly,
  REVIEWER_READONLY_TOOL_NAMES,
  selectSubagentToolNames,
} from '../tools'
import type { GeneratedImageEmission, GeneratedImageUsage, ReviewerToolRuntime, ToolContext } from '../tools/util'
import {
  emitGeneratedImagePart,
  generateImageToolEnabled,
  GENERATE_IMAGE_TOOL_NAME,
  mergeGeneratedImageUsage,
} from '../image-gen'
import { IN_TURN_COMPACT_RATIO, SYSTEM_PROMPT } from '../runner'
import { compileOpenAIPrompt } from '../openai/prompt'
import { resolveSubagentExecutionProfile } from '../subagent-execution-profile'
import { namespaceSubagentToolSet, type NormalizedAiUsage } from '../subagent-runner'
import { SubagentCoordinator, type SubagentLease } from '../subagent-coordinator'
import { recordModelCallUsage } from '../usage-diagnostics'
import {
  MAESTRO_DELEGATE_TOOL_DESCRIPTION,
  MAESTRO_DELEGATE_TOOL_SCHEMA,
  maestroAgentsFromTurn,
  prepareMaestroDelegation,
  renderMaestroAgentCatalog,
} from '../maestro-delegation'
import { MAESTRO_SYSTEM_SPEC, renderMaestroTurnPolicy } from '../maestro-prompt'
import type { MaestroLiveRunPort } from '../maestro-live'
import { buildSubagentSupervisionTools } from '../maestro-supervision-tools'
import { startMaestroDelegation } from '../maestro-delegation-registry'
import type { SubagentSessionRecorder } from '../subagent-session'
import { isClaudeSubscriptionProvider } from '../catalog'
import { githubCopilotErrorMessage } from './errors'
import { copilotResultToChatToolOutput } from '../tool-output'
import { describeEphemeralToolImage, hasConfiguredImageInterpreter } from '../image-interpreter'
import { resolveFileImageBytesSync } from '../attachment-artifacts'
import { adaptToolSetForModel, supportsChatToolImages } from '../tool-capabilities'
import { getSubagentProfileModelMeta } from '../subagent-profile-model-meta'
import { executeSubagent } from '../subagent-executor'
import { FABLE_51_PROFILE_FLAG, resolveFableBehaviorProfile, type FableBehaviorProfile } from '../fable/profile'
import { hardDeleteGitHubCopilotSession } from './lifecycle'
import { renderDesignUltraGuidance } from '../design-mode-prompt'
import { resolveGitHubCopilotHarness } from './harness'
import {
  COPILOT_TOOL_SEARCH_DEFER_THRESHOLD,
  copilotTools,
  mergeCopilotToolSets,
  profileCopilotTools,
  type CopilotToolCatalogProfile,
} from './tools'
import type {
  GitHubCopilotAccountIdentity,
  GitHubCopilotCreateSessionConfig,
  GitHubCopilotSubscriptionManager,
} from './manager'
import {
  clearGitHubCopilotSessionCleanup,
  getGitHubCopilotSessionBinding,
  putGitHubCopilotSessionBinding,
  queueGitHubCopilotSessionCleanup,
  retireGitHubCopilotSessionBinding,
  type GitHubCopilotSessionBinding,
} from './session-store'

const SESSION_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const MAX_IN_TURN_COMPACTIONS = 2
const PORTABLE_CONTINUE_PROMPT =
  'Continue the same assistant turn from the imported transcript. Do not repeat completed work or prior progress updates.'
export const GITHUB_COPILOT_AGENT_DESCRIPTION_MAX_CHARS = 240
export const GITHUB_COPILOT_TASK_TOOL_DESCRIPTION_MAX_BYTES = 512
export const GITHUB_COPILOT_TASK_TOOL_DESCRIPTION =
  'Delegate one focused, self-contained task to an isolated Maestrly subagent. The subagent sees only the ' +
  'supplied prompt and returns its result. Include all required context and select the agent from the input enum.'

interface PreparedRuntime {
  tools: CopilotTool[]
  hostTools: ToolSet
  deferredHostToolNames: ReadonlySet<string>
  toolProfile: CopilotToolCatalogProfile
  agents: ChatAgent[]
  toolSignature: string
  availableTools: string[]
  systemMessage: string
  behaviorProfile?: FableBehaviorProfile
  takeToolOutput: (toolCallId: string) => ToolOutput | undefined
  close: () => Promise<void>
}

interface TaskExecutionResult {
  output: string
  error?: string
  sub?: SubagentRunMeta
}

interface GitHubCopilotRunnerState {
  planSubmitted: boolean
  session: CopilotSession | null
  subagentCoordinator: SubagentCoordinator
  /**
   * Publish the generated image part (generate_image). Only REAL turns define this; compact/inspect omit the tool
   * because they have no assistant message to display the artifact.
   */
  emitGeneratedImage?: (toolCallId: string, image: GeneratedImageEmission) => void
  onGeneratedImageUsage?: (usage: GeneratedImageUsage) => void
  runTask:
    | ((
        input: unknown,
        toolCallId: string,
        signal: AbortSignal,
        update: (state: { output?: string; sub?: SubagentRunMeta }) => void
      ) => Promise<TaskExecutionResult>)
    | null
}

export interface RunGitHubCopilotChatArgs {
  conversationId: string
  projectId: string
  cwd: string
  selection: ChatModelRef
  /** Behavior resolved once at turn admission. undefined keeps direct-call compatibility by resolving locally. */
  behaviorProfile?: FableBehaviorProfile | null
  mode: ChatBehavior
  maestro?: MaestroTurnSnapshotV1
  maestroLive?: MaestroLiveRunPort
  permMode: ChatPermMode
  reasoningEffort?: string
  maestrlyUltra?: boolean
  /** The selected model does not accept images: send the attachment as TEXT (interpreter description or note). */
  dropImages?: boolean
  manager: GitHubCopilotSubscriptionManager
  accountIdentity: GitHubCopilotAccountIdentity
  broker: PermissionBroker
  questionBroker: QuestionBroker
  emit: (event: ChatStreamEvent) => void
  signal: AbortSignal
  responseStartedAt?: number
  onSessionReady?: (sessionId: string) => boolean
  canPersistSession?: () => boolean
  onModelContextWindow?: (contextWindow: number) => void
  /** Effective model window. Together with compactHistory, enables portable intra-turn compaction. */
  contextWindow?: number
  /** Summarizes the durable visible history; the runner persists the returned boundary in the live bubble. */
  compactHistory?: () => Promise<{
    summary: string
    usage?: NormalizedAiUsage
    runtimeEstimatedCostUsd?: number
  } | null>
  /** Isolated review loop: do not resume the conversation binding; transcript = execution. */
  ephemeralSession?: boolean
  messageMeta?: {
    source?: import('../../../shared/chat').ChatMessageSource
    internal?: boolean
    executionScope?: import('../../../shared/chat').ChatExecutionScope
    reviewLoop?: import('../../../shared/chat').ChatReviewLoopMeta
  }
  executionScope?: import('../../../shared/chat').ChatExecutionScope
  /** Isolated review turns receive only the fixed host-owned read-only surface. */
  reviewerRuntime?: ReviewerToolRuntime
}

export interface RunGitHubCopilotChatResult {
  planSubmitted: boolean
  sessionId: string
}

type GitHubCopilotRuntimePreparationArgs = Omit<
  RunGitHubCopilotChatArgs,
  | 'emit'
  | 'responseStartedAt'
  | 'onSessionReady'
  | 'canPersistSession'
  | 'onModelContextWindow'
  | 'contextWindow'
  | 'compactHistory'
>

export interface CompactGitHubCopilotSessionArgs extends GitHubCopilotRuntimePreparationArgs {
  customInstructions?: string
}

export interface GitHubCopilotCompactionContextWindow {
  tokenLimit: number
  currentTokens: number
  messagesLength: number
  systemTokens?: number
  conversationTokens?: number
  toolDefinitionsTokens?: number
}

export interface CompactGitHubCopilotSessionResult {
  sessionId: string
  success: boolean
  tokensRemoved: number
  messagesRemoved: number
  summary: string | null
  contextWindow?: GitHubCopilotCompactionContextWindow
}

function safeTokens(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function markdownLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([[\]])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

function inlineCode(value: string): string {
  const longestFence = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(longestFence + 1)
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${fence}${padding}${value}${padding}${fence}`
}

function citationUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function citationKey(source: CitationSource): string {
  const url = citationUrl(source.url)
  if (url) return `url:${url}`
  const path = source.path?.replace(/[\r\n]+/g, ' ').trim()
  if (path) return `path:${path}`
  return `id:${source.provider}:${source.id}`
}

function citationLine(source: CitationSource): string {
  const url = citationUrl(source.url)
  const path = source.path?.replace(/[\r\n]+/g, ' ').trim()
  const fallback = path || url || source.id
  const label = markdownLabel(source.title?.trim() || fallback)
  if (url) {
    const destination = url.replace(/</g, '%3C').replace(/>/g, '%3E')
    return `- [${label}](<${destination}>)`
  }
  if (path) return source.title?.trim() ? `- ${label} — ${inlineCode(path)}` : `- ${inlineCode(path)}`
  return `- ${label}`
}

function collectCitations(citations: Citations | undefined, target: Map<string, string>): void {
  for (const source of citations?.sources ?? []) {
    const key = citationKey(source)
    if (!target.has(key)) target.set(key, citationLine(source))
  }
}

function dataUrlBlob(data: string): { data: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(data)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

function currentMessageInput(
  message: ChatMessage,
  seedTranscript: string,
  dropImages = false,
  transientContext?: string
): MessageOptions {
  const prompt: string[] = []
  const attachments: NonNullable<MessageOptions['attachments']> = []
  if (seedTranscript) prompt.push(nativeSeedContextText(seedTranscript))
  for (const part of message.parts) {
    if (part.type === 'text' && part.text) prompt.push(part.text)
    if (part.type === 'context' && part.text) prompt.push(part.text)
    // `/skill` invocation: send the expanded block (instructions + root + inventory) to the model instead of the chip.
    if (part.type === 'skill-invocation' && part.body) prompt.push(part.body)
    if (part.type !== 'file') continue
    if (part.kind === 'image') {
      const resolved = dropImages ? null : resolveFileImageBytesSync(message.conversationId, part)
      const blob = resolved
        ? { data: Buffer.from(resolved.bytes).toString('base64'), mimeType: resolved.mediaType }
        : dataUrlBlob(part.data ?? '')
      if (blob) attachments.push({ type: 'blob', data: blob.data, mimeType: blob.mimeType, displayName: part.name })
      else if (dropImages) prompt.push(droppedImageText(part))
      else prompt.push(`[Image attachment ${part.name} could not be decoded by the host.]`)
      continue
    }
    const label = part.hidden ? `Content referenced by ${part.name}` : `Attached file ${part.name}`
    prompt.push(`${label}:\n\n${part.data}`)
  }
  if (transientContext) prompt.push(transientContext)
  return {
    prompt: prompt.join('\n\n').trim() || '(continue)',
    ...(attachments.length ? { attachments } : {}),
  }
}

function bindingCanResume(
  binding: GitHubCopilotSessionBinding | null,
  previousMessageId: string | null,
  modelId: string,
  harnessProfile: GitHubCopilotSessionBinding['harnessProfile'],
  toolSignature: string,
  accountFingerprint: string,
  accountId: string | null
): boolean {
  return !!(
    binding &&
    previousMessageId &&
    binding.lastMessageId === previousMessageId &&
    binding.modelId === modelId &&
    binding.harnessProfile === harnessProfile &&
    binding.toolSignature === toolSignature &&
    binding.accountFingerprint === accountFingerprint &&
    // Multiple accounts: a session lives in its owner's COPILOT_HOME; another account must never resume it.
    binding.accountId === accountId
  )
}

/** Maps Copilot/provider spellings to the finish-reason contract consumed by Maestrly. */
export function normalizeGitHubCopilotFinishReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'stop'
  const reason = value.trim().toLowerCase()
  if (reason === 'tool_calls') return 'tool-calls'
  if (reason === 'content_filter') return 'content-filter'
  if (reason === 'max_tokens' || reason === 'max_output_tokens') return 'length'
  return reason
}

async function retireSession(
  manager: GitHubCopilotSubscriptionManager,
  conversationId: string,
  sessionId: string
): Promise<void> {
  retireGitHubCopilotSessionBinding(conversationId, sessionId)
  queueGitHubCopilotSessionCleanup(conversationId, sessionId, manager.accountId ?? null)
  await hardDeleteGitHubCopilotSession(manager, sessionId).catch(() => undefined)
}

function skillsCatalog(skills: readonly ChatSkill[]): string {
  if (!skills.length) return ''
  return 'Project skills available through `use_skill`:\n' + skills.map(skillCatalogLine).join('\n')
}

/**
 * Same policy as Codex (dynamicToolSignature): only sorted name LISTS. Metadata (tool description/parameters,
 * agent prompt/profile, profile rules) changes on every MCP reconnection or config edit and does NOT require
 * retiring the session: resumeSession reapplies the full sessionConfig (tools + systemMessage mode:replace), and
 * profiles only govern host-side `task` execution, resolved per turn. Lists still invalidate sessions: they define
 * the structural contract referenced by session history. modelId/harnessProfile/accountFingerprint are checked
 * separately in bindingCanResume.
 */
export function gitHubCopilotToolSignature(
  tools: readonly { name: string }[],
  agents: readonly Pick<ChatAgent, 'name'>[]
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 3,
        tools: tools.map((tool) => tool.name).sort(),
        agents: agents.map((agent) => agent.name).sort(),
      })
    )
    .digest('hex')
}

export function agentsCatalog(agents: readonly ChatAgent[], conversationId = '', forceReadOnly = false): string {
  if (!agents.length) return ''
  const catalog = buildAndRenderSubagentDispatchCatalog(
    { agents, conversationId, forceReadOnly },
    { descriptionMaxChars: GITHUB_COPILOT_AGENT_DESCRIPTION_MAX_CHARS, ellipsis: true }
  )
  return (
    'Maestrly can delegate isolated work through the host-managed `task` tool. Give each subagent a ' +
    `self-contained prompt; independent tasks may run in parallel. Agent descriptions below are capped at ` +
    `${GITHUB_COPILOT_AGENT_DESCRIPTION_MAX_CHARS} characters.\n` +
    catalog
  )
}

async function prepareRuntime(
  args: GitHubCopilotRuntimePreparationArgs,
  assistantId: string,
  state: GitHubCopilotRunnerState
): Promise<PreparedRuntime> {
  const capabilityMode = capabilityBehaviorFor(args.mode)
  const activateTerminalStep = (): void => {
    state.planSubmitted = true
    // Let the custom tool result cross JSON-RPC before ending this agent loop.
    setImmediate(() => void state.session?.abort().catch(() => undefined))
  }
  const makeContext = (toolCallId: string, toolSignal: AbortSignal): ToolContext => ({
    conversationId: args.conversationId,
    projectId: args.projectId,
    messageId: assistantId,
    toolCallId,
    cwd: args.cwd,
    signal: toolSignal,
    ask: (action, resources, save) => {
      if (args.reviewerRuntime) {
        return action === 'read' || action === 'grep' || action === 'glob'
          ? Promise.resolve()
          : Promise.reject(new Error(`Reviewer read-only boundary denied ${action}`))
      }
      return args.broker.assert({
        conversationId: args.conversationId,
        projectId: args.projectId,
        action,
        resources,
        save,
        toolName: action,
        toolCallId,
        signal: toolSignal,
      })
    },
    askQuestion: (questions) =>
      args.questionBroker.ask({
        conversationId: args.conversationId,
        messageId: assistantId,
        toolCallId,
        questions,
        signal: toolSignal,
      }),
    submitPlan: (plan, title) => {
      const result = stagePlan({ agentId: args.conversationId, cwd: args.cwd, plan, title })
      if (!result.ok) return false
      activateTerminalStep()
      return true
    },
    ...(args.reviewerRuntime
      ? {
          reviewer: {
            recordEvidence: (kind) => args.reviewerRuntime!.recordEvidence(kind),
            searchExecutionContext: (input) => args.reviewerRuntime!.searchExecutionContext(input),
            readExecutionContext: (input) => args.reviewerRuntime!.readExecutionContext(input),
            submitReview: (decision) => {
              const result = args.reviewerRuntime!.submitReview(decision)
              if (result.ok) activateTerminalStep()
              return result
            },
          } satisfies ReviewerToolRuntime,
        }
      : {}),
    ...(state.emitGeneratedImage
      ? { emitGeneratedImage: (image: GeneratedImageEmission) => state.emitGeneratedImage?.(toolCallId, image) }
      : {}),
    ...(state.onGeneratedImageUsage ? { onGeneratedImageUsage: state.onGeneratedImageUsage } : {}),
  })

  const enabledBuiltins = args.reviewerRuntime
    ? new Set(REVIEWER_READONLY_TOOL_NAMES)
    : builtinToolNamesForMode(args.mode)
  // generate_image is OPT-IN and exists only when a part can be published: toggle enabled + ChatGPT subscription
  // connected (it generates the image even when the conversation runs on Copilot).
  if (
    !args.reviewerRuntime &&
    state.emitGeneratedImage &&
    (await generateImageToolEnabled(args.conversationId, args.mode))
  ) {
    enabledBuiltins.add(GENERATE_IMAGE_TOOL_NAME)
  }
  const core = buildTools({ enabled: enabledBuiltins, makeCtx: makeContext })
  const gate = (toolName: string, toolCallId: string, signal?: AbortSignal) => {
    return args.broker.assert({
      conversationId: args.conversationId,
      projectId: args.projectId,
      action: 'mcp',
      resources: [toolName],
      save: [toolName],
      toolName,
      toolCallId,
      signal,
    })
  }
  const prefs = args.reviewerRuntime ? undefined : getConvUiPrefs(args.conversationId).chat?.tools
  const appToolsEnabled = !args.reviewerRuntime && (prefs?.app ?? getAppFlag('chat.appTools', false))
  const disabledIds = new Set(prefs?.mcpDisabled ?? [])
  const mcp = args.reviewerRuntime
    ? { tools: {}, close: async () => {} }
    : await buildMcpTools({
        mode: args.mode,
        signal: args.signal,
        gate,
        disabledIds,
        codexSafeNames: true,
        supportsImages: true,
        describeImage: (image) =>
          describeEphemeralToolImage({
            image,
            conversationId: args.conversationId,
            cwd: args.cwd,
            signal: args.signal,
          }),
      })
  const app = appToolsEnabled
    ? await buildAppTools({
        conversationId: args.conversationId,
        mode: args.mode,
        gate,
        exclude: new Set(['review_plan']),
        supportsImages: true,
        describeImage: (image) =>
          describeEphemeralToolImage({
            image,
            conversationId: args.conversationId,
            cwd: args.cwd,
            signal: args.signal,
          }),
      })
    : { tools: {}, close: async () => {} }

  try {
    const skills =
      args.reviewerRuntime || args.mode === 'ask'
        ? []
        : (await effectiveSkills(args.cwd, args.conversationId)).filter((skill) => skill.modelInvocable)
    const skillTools: ToolSet = skills.length
      ? {
          use_skill: tool({
            description: 'Loads the complete instructions for a Maestrly project skill before acting.',
            inputSchema: jsonSchema<{ name: string }>({
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
              additionalProperties: false,
            }),
            execute: async ({ name }) => {
              const skill = await findEffectiveSkill(args.cwd, args.conversationId, name)
              // Disabled, missing, or `disable-model-invocation` means nonexistent from the model's perspective.
              return skill?.modelInvocable
                ? renderSkillContext(skill)
                : `Skill "${name}" not found. Available: ${skills.map((item) => item.name).join(', ') || '(none)'}`
            },
          }),
        }
      : {}

    const allAgents = args.reviewerRuntime
      ? []
      : await listEffectiveAgents({
          cwd: args.cwd,
          conversationId: args.conversationId,
          mode: capabilityMode === 'agent' || args.mode === 'maestro' ? 'agent' : 'plan',
        })
    const agents =
      args.mode === 'maestro' && args.maestro
        ? maestroAgentsFromTurn(args.maestro, allAgents)
        : capabilityMode === 'agent'
          ? allAgents
          : args.maestrlyUltra
            ? allAgents.filter((agent) => agent.name === 'explore')
            : []
    const delegationToolName = args.mode === 'maestro' ? 'delegate' : 'task'
    const taskTools: ToolSet = agents.length
      ? {
          [delegationToolName]: tool({
            description:
              args.mode === 'maestro' ? MAESTRO_DELEGATE_TOOL_DESCRIPTION : GITHUB_COPILOT_TASK_TOOL_DESCRIPTION,
            inputSchema: jsonSchema(
              args.mode === 'maestro'
                ? MAESTRO_DELEGATE_TOOL_SCHEMA
                : {
                    type: 'object',
                    properties: {
                      agent: { type: 'string', enum: agents.map((agent) => agent.name) },
                      prompt: { type: 'string', description: 'Self-contained subtask and all required context.' },
                    },
                    required: ['agent', 'prompt'],
                    additionalProperties: false,
                  }
            ),
            execute: async (input, options) => {
              if (!state.runTask) throw new Error('The Maestrly subagent executor is not ready')
              const result = await state.runTask(
                input,
                options.toolCallId,
                options.abortSignal ?? args.signal,
                () => {}
              )
              if (result.error) throw new Error(result.error)
              return result.output
            },
          }),
        }
      : {}
    const supervisionTools = agents.length
      ? buildSubagentSupervisionTools({
          conversationId: args.conversationId,
          parentMessageId: assistantId,
          maestro: args.mode === 'maestro',
          signal: args.signal,
        })
      : {}
    const hostRuntime = mergeCopilotToolSets(core, mcp.tools, app.tools, skillTools, {})
    const combinedRuntime = mergeCopilotToolSets(core, mcp.tools, app.tools, skillTools, {
      ...taskTools,
      ...supervisionTools,
    })
    const adaptedRuntime = adaptToolSetForModel({
      tools: combinedRuntime.tools,
      supportsImages: !args.dropImages,
      describeImage: (image) =>
        describeEphemeralToolImage({ image, conversationId: args.conversationId, cwd: args.cwd, signal: args.signal }),
    })
    const canonicalToolOutputs = new Map<string, ToolOutput>()
    const tools = await copilotTools(
      adaptedRuntime,
      args.signal,
      combinedRuntime.deferredToolNames,
      (toolCallId, output) => canonicalToolOutputs.set(toolCallId, output)
    )
    const availableTools = tools.map((entry) => `custom:${entry.name}`)
    const toolProfile = profileCopilotTools(tools)

    const harness = resolveGitHubCopilotHarness(args.selection.modelId)
    const behaviorProfile =
      args.behaviorProfile === undefined
        ? resolveFableBehaviorProfile({
            requestedModelId: args.selection.modelId,
            enabled: getAppFlag(FABLE_51_PROFILE_FLAG, true),
          }).profile
        : args.behaviorProfile
    const projectContext = await buildProjectContext(args.projectId, args.cwd)
    const skillContext = skillsCatalog(skills)
    const agentContext =
      args.mode === 'maestro' && args.maestro
        ? renderMaestroAgentCatalog(args.maestro)
        : agentsCatalog(agents, args.conversationId, capabilityMode === 'plan' || capabilityMode === 'ask')
    const platform =
      process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform
    const git = await gitEnvInfo(args.cwd).catch(() => null)
    const gitLine = git ? ` Git branch: ${git.branch} (${git.dirty ? 'uncommitted changes' : 'clean'}).` : ''
    const env = `OS: ${platform}. Today's date: ${new Date().toISOString().slice(0, 10)}. Project directory: ${args.cwd}.${gitLine}`
    const ultra = args.maestrlyUltra
      ? args.mode === 'maestro'
        ? 'Maximum-rigor reasoning applies only to the orchestrator; choose agents deliberately from the frozen Strategy and Pool.'
        : args.mode === 'design'
          ? renderDesignUltraGuidance(args.mode)
          : args.mode === 'agent'
            ? 'Maximum-rigor Maestrly Ultra mode is active. Decompose non-trivial work, delegate independent slices through task when useful, integrate the results, verify the implementation, and critically review it before finishing.'
            : 'Maximum-rigor Maestrly Ultra mode is active. Stay read-only, investigate deeply, delegate independent exploration when useful, and cross-check the conclusion.'
      : ''
    const notes = Boolean(getConversation(args.conversationId))
    const runtimeOverlay =
      `\n\n# Active runtime\nYou are running through the official GitHub Copilot SDK/CLI runtime with the ` +
      `${harness.profile} Maestrly harness selected from model ${args.selection.modelId}. Copilot is the transport; ` +
      `the selected model family governs behavioral instructions. Only the explicitly supplied tools are available.`
    let systemMessage =
      SYSTEM_PROMPT(args.cwd, appToolsEnabled, args.mode, notes, behaviorProfile) +
      runtimeOverlay +
      projectContext +
      (skillContext ? `\n\n# Project skills\n${skillContext}` : '') +
      (agentContext ? `\n\n${args.mode === 'maestro' ? agentContext : `# Subagents\n${agentContext}`}` : '') +
      (args.mode === 'maestro' && args.maestro ? `\n\n${renderMaestroTurnPolicy(args.maestro)}` : '') +
      (ultra ? `\n\n# Ultra mode\n${ultra}` : '') +
      `\n\n# Environment\n${env}`
    if (harness.promptProfile === 'codex-gpt-5.6-sol@5bed644') {
      systemMessage = compileOpenAIPrompt({
        cwd: args.cwd,
        mode: args.mode === 'maestro' ? 'ask' : args.mode,
        appToolsEnabled,
        hasNotesTab: notes,
        projectContext,
        skillsContext: skillContext,
        agentsContext: `${agentContext}${args.mode === 'maestro' ? `\n\n${MAESTRO_SYSTEM_SPEC}` : ''}${
          args.mode === 'maestro' && args.maestro ? `\n\n${renderMaestroTurnPolicy(args.maestro)}` : ''
        }`,
        envContext: env,
        ultraContext: ultra,
        nativeTools: { localShell: false, applyPatch: false },
      }).instructions
    }

    const signature = gitHubCopilotToolSignature(tools, agents)
    return {
      tools,
      hostTools: hostRuntime.tools,
      deferredHostToolNames: hostRuntime.deferredToolNames,
      toolProfile,
      agents,
      toolSignature: signature,
      availableTools,
      systemMessage,
      ...(behaviorProfile ? { behaviorProfile } : {}),
      takeToolOutput: (toolCallId) => {
        const output = canonicalToolOutputs.get(toolCallId)
        canonicalToolOutputs.delete(toolCallId)
        return output
      },
      close: async () => {
        await Promise.all([mcp.close(), app.close()])
      },
    }
  } catch (error) {
    await Promise.all([mcp.close(), app.close()])
    throw error
  }
}

interface UsageAccumulator {
  mainInput: number
  mainOutput: number
  mainCached: number
  mainCacheCreate: number
  subInput: number
  subOutput: number
  subCached: number
  subCacheCreate: number
  contextInput: number
  contextWindow: number
  finishReason: string
}

function chatUsage(
  usage: UsageAccumulator,
  managedSubagents: readonly ChatSubagentUsage[] = []
): ChatUsage | undefined {
  const managed = managedSubagents.reduce(
    (total, item) => ({
      input: total.input + item.input,
      output: total.output + item.output,
      cached: total.cached + (item.cachedInput ?? 0),
      cacheCreate: total.cacheCreate + (item.cacheCreate ?? 0),
    }),
    { input: 0, output: 0, cached: 0, cacheCreate: 0 }
  )
  const nativeSubInput = Math.max(0, usage.subInput - usage.subCached - usage.subCacheCreate)
  const subInput = nativeSubInput + managed.input
  const subOutput = usage.subOutput + managed.output
  const subCached = usage.subCached + managed.cached
  const subCacheCreate = usage.subCacheCreate + managed.cacheCreate
  if (
    !usage.mainInput &&
    !usage.mainOutput &&
    !usage.mainCached &&
    !usage.mainCacheCreate &&
    !subInput &&
    !subOutput &&
    !subCached &&
    !subCacheCreate &&
    !usage.contextInput &&
    !managedSubagents.length
  )
    return undefined
  return {
    usageVersion: 2,
    input: Math.max(0, usage.mainInput - usage.mainCached - usage.mainCacheCreate),
    output: usage.mainOutput,
    ...(usage.contextInput ? { contextInput: usage.contextInput, contextOutput: 0 } : {}),
    ...(usage.contextWindow ? { modelContextWindow: usage.contextWindow } : {}),
    ...(usage.mainCached ? { cachedInput: usage.mainCached } : {}),
    ...(usage.mainCacheCreate ? { cacheCreate: usage.mainCacheCreate } : {}),
    ...(subInput ? { subInput } : {}),
    ...(subOutput ? { subOutput } : {}),
    ...(subCached ? { subCachedInput: subCached } : {}),
    ...(subCacheCreate ? { subCacheCreate } : {}),
    ...(managedSubagents.length ? { subagentUsage: [...managedSubagents] } : {}),
  }
}

function addPortableCompactionUsage(usage: UsageAccumulator, compacted: NormalizedAiUsage | undefined): void {
  if (!compacted) return
  const input = safeTokens(compacted.input)
  const cached = safeTokens(compacted.cacheRead)
  const cacheCreate = safeTokens(compacted.cacheCreate)
  const totalInput = Math.max(safeTokens(compacted.totalInput), input + cached + cacheCreate)
  usage.mainInput += totalInput
  usage.mainOutput += safeTokens(compacted.output)
  usage.mainCached += cached
  usage.mainCacheCreate += cacheCreate
}

/**
 * Efforts the official Copilot runner CAN serialize (SDK whitelist): all other values are OMITTED from the session
 * (silent degradation). Single source of truth: review-loop freezing uses the SAME list so it never freezes an
 * effort the transport cannot deliver.
 */
export const GITHUB_COPILOT_SERIALIZABLE_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

function officialSessionConfig(
  args: Pick<RunGitHubCopilotChatArgs, 'selection' | 'reasoningEffort' | 'cwd'>,
  runtime: PreparedRuntime,
  onEvent: (event: SessionEvent) => void
): GitHubCopilotCreateSessionConfig {
  return {
    model: args.selection.modelId,
    reasoningEffort:
      args.reasoningEffort &&
      GITHUB_COPILOT_SERIALIZABLE_EFFORTS.includes(
        args.reasoningEffort as (typeof GITHUB_COPILOT_SERIALIZABLE_EFFORTS)[number]
      )
        ? (args.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh')
        : undefined,
    workingDirectory: args.cwd,
    tools: runtime.tools,
    availableTools: runtime.availableTools,
    toolSearch: { enabled: true, deferThreshold: COPILOT_TOOL_SEARCH_DEFER_THRESHOLD },
    systemMessage: { mode: 'replace', content: runtime.systemMessage },
    streaming: true,
    includeSubAgentStreamingEvents: true,
    infiniteSessions: { enabled: false },
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    customAgentsLocalOnly: true,
    coauthorEnabled: false,
    enableSessionTelemetry: false,
    enableCitations: true,
    enableSkills: false,
    enableSessionStore: false,
    enableHostGitOperations: false,
    memory: { enabled: false },
    onPermissionRequest: () => ({
      kind: 'reject' as const,
      feedback: 'This Maestrly session allows only host-managed custom tools.',
    }),
    onEvent,
  }
}

/** Official Copilot runtime adapter: Maestrly owns UI/tools/persistence while the SDK owns the agent loop. */
export async function runGitHubCopilotChat(args: RunGitHubCopilotChatArgs): Promise<RunGitHubCopilotChatResult> {
  if (args.signal.aborted) throw new Error('Turn aborted before GitHub Copilot started')
  args.manager.assertAccountIdentity(args.accountIdentity)
  const accountFingerprint = args.accountIdentity.fingerprint
  if (!accountFingerprint) throw new Error('GitHub Copilot is not authenticated')
  const responseStartedAt = args.responseStartedAt ?? Date.now()
  const history = runnerContextHistory(args.conversationId, {
    ephemeralSession: args.ephemeralSession,
    executionScope: args.messageMeta?.executionScope,
  })
  const currentUser = history.at(-1)
  if (currentUser?.role !== 'user') throw new Error('Current user message was not persisted')

  const assistantId = randomUUID()
  const createdAt = Date.now()
  let messages: ChatMessage[] = [
    {
      id: assistantId,
      conversationId: args.conversationId,
      role: 'assistant',
      parts: [],
      model: args.selection,
      ...(args.messageMeta ?? {}),
      createdAt,
    },
  ]
  let lastPersistAt = 0
  let dirty = false
  const persist = (): void => {
    lastPersistAt = Date.now()
    dirty = false
    upsertChatMessage(messages[0])
  }
  const coalescer = createDeltaCoalescer(args.emit)
  const apply = (event: ChatStreamEvent, force = false): void => {
    messages = applyChatEvent(messages, event)
    coalescer.push(event)
    if (force || Date.now() - lastPersistAt > 300) persist()
    else dirty = true
  }
  upsertChatMessage(messages[0])
  coalescer.push({
    kind: 'message-start',
    messageId: assistantId,
    model: args.selection,
    createdAt,
    responseStartedAt,
    ...(args.messageMeta?.source ? { source: args.messageMeta.source } : {}),
    ...(args.messageMeta?.reviewLoop ? { reviewLoop: args.messageMeta.reviewLoop } : {}),
  })

  const state: GitHubCopilotRunnerState = {
    planSubmitted: false,
    session: null,
    runTask: null,
    subagentCoordinator: new SubagentCoordinator({
      onEvent: (event) =>
        chatDiag({
          kind: 'subagent-coordinator',
          runtime: 'github-copilot-subscription',
          conv: args.conversationId,
          ...event,
        }),
    }),
    emitGeneratedImage: (toolCallId, image) => emitGeneratedImagePart(apply, assistantId, toolCallId, image),
    onGeneratedImageUsage: (imageUsage) => mergeGeneratedImageUsage(managedSubagentUsage, imageUsage),
  }
  let runtime: PreparedRuntime | null = null
  let sessionId = ''
  let sessionPersisted = false
  let sessionRetired = false
  const fatal = { message: null as string | null }
  let disconnected = false
  const usage: UsageAccumulator = {
    mainInput: 0,
    mainOutput: 0,
    mainCached: 0,
    mainCacheCreate: 0,
    subInput: 0,
    subOutput: 0,
    subCached: 0,
    subCacheCreate: 0,
    contextInput: 0,
    contextWindow: 0,
    finishReason: 'stop',
  }
  const managedSubagentUsage = new Map<string, ChatSubagentUsage>()
  try {
    runtime = await prepareRuntime(args, assistantId, state)
    chatDiag({
      kind: 'fable-behavior-profile',
      profile: runtime.behaviorProfile?.id ?? 'legacy',
      requestedModel: args.selection.modelId,
      resolvedModel: args.selection.modelId,
      transport: 'github-copilot',
      effort: args.reasoningEffort ?? 'default',
      progressMode: 'prompt-only',
      conv: args.conversationId,
    })
    const taskRuntime = runtime
    const harness = resolveGitHubCopilotHarness(args.selection.modelId)
    const previousMessage = history.at(-2) ?? null
    const existing = getGitHubCopilotSessionBinding(args.conversationId)
    const canResume =
      !args.ephemeralSession &&
      bindingCanResume(
        existing,
        previousMessage?.id ?? null,
        args.selection.modelId,
        harness.profile,
        runtime.toolSignature,
        accountFingerprint,
        args.manager.accountId ?? null
      )
    if (existing && !canResume && !args.ephemeralSession)
      await retireSession(args.manager, args.conversationId, existing.sessionId)

    const startedText = new Set<string>()
    const startedReasoning = new Set<string>()
    const streamedText = new Set<string>()
    const streamedReasoning = new Set<string>()
    const startedTools = new Set<string>()
    const subagentCalls = new Map<string, string>()
    const subagentProgress = new Map<string, string[]>()
    const subagentMessages = new Map<string, { order: string[]; content: Map<string, string> }>()
    const subagentRuns = new Map<string, SubagentRunMeta>()
    const resolvedTaskProfiles = new Map<string, ReturnType<typeof resolveSubagentExecutionProfile>>()
    const citationLines = new Map<string, string>()
    const portableContextWindow = safeTokens(args.contextWindow)
    let providerAttemptActive = false
    let portableCompactionRequested = false
    let portableCompactionInProgress = false
    let portableAbortPromise: Promise<void> | null = null
    let inTurnCompactions = 0
    let activeSessionEventGeneration = 0

    const ensureTool = (toolCallId: string, toolName: string, input: unknown): void => {
      if (startedTools.has(toolCallId)) return
      startedTools.add(toolCallId)
      apply({ kind: 'tool-input-start', messageId: assistantId, toolCallId, toolName })
      apply({ kind: 'tool-call', messageId: assistantId, toolCallId, toolName, input }, toolName === 'ask_question')
      apply({ kind: 'tool-state', messageId: assistantId, toolCallId, state: { status: 'running' } })
    }
    const progressSubagent = (toolCallId: string, line: string): void => {
      const lines = subagentProgress.get(toolCallId) ?? []
      lines.push(line)
      subagentProgress.set(toolCallId, lines)
      apply({
        kind: 'tool-state',
        messageId: assistantId,
        toolCallId,
        state: { status: 'running', output: lines.slice(-12).join('\n') },
      })
    }
    const recordSubagentMessage = (
      toolCallId: string,
      messageId: string,
      content: string,
      replace: boolean
    ): string => {
      let messages = subagentMessages.get(toolCallId)
      if (!messages) {
        messages = { order: [], content: new Map() }
        subagentMessages.set(toolCallId, messages)
      }
      if (!messages.content.has(messageId)) messages.order.push(messageId)
      const next = replace ? content : (messages.content.get(messageId) ?? '') + content
      messages.content.set(messageId, next)
      return next
    }
    const subagentResult = (toolCallId: string): string | null => {
      const messages = subagentMessages.get(toolCallId)
      if (!messages) return null
      for (let index = messages.order.length - 1; index >= 0; index -= 1) {
        const content = messages.content.get(messages.order[index])?.trim()
        if (content) return content
      }
      return null
    }
    const previewSubagentMessage = (toolCallId: string, content: string): void => {
      apply({
        kind: 'tool-state',
        messageId: assistantId,
        toolCallId,
        state: { status: 'running', output: content },
      })
    }

    const recordManagedUsage = (
      model: ChatModelRef,
      measured?: NormalizedAiUsage,
      runtimeEstimatedCostUsd?: number
    ): void => {
      if (!measured && runtimeEstimatedCostUsd == null) return
      const key = `${model.providerId}\0${model.modelId}`
      const current = managedSubagentUsage.get(key)
      if (current) {
        current.input += measured?.input ?? 0
        current.output += measured?.output ?? 0
        current.cachedInput = (current.cachedInput ?? 0) + (measured?.cacheRead ?? 0)
        current.cacheCreate = (current.cacheCreate ?? 0) + (measured?.cacheCreate ?? 0)
        if (runtimeEstimatedCostUsd == null && measured) {
          current.catalogInput = (current.catalogInput ?? 0) + measured.input
          current.catalogOutput = (current.catalogOutput ?? 0) + measured.output
          current.catalogCacheRead = (current.catalogCacheRead ?? 0) + measured.cacheRead
          current.catalogCacheCreate = (current.catalogCacheCreate ?? 0) + measured.cacheCreate
        }
        if (current.runtimeEstimatedCostUsd != null || runtimeEstimatedCostUsd != null) {
          current.runtimeEstimatedCostUsd = (current.runtimeEstimatedCostUsd ?? 0) + (runtimeEstimatedCostUsd ?? 0)
        }
      } else {
        managedSubagentUsage.set(key, {
          providerId: model.providerId,
          modelId: model.modelId,
          input: measured?.input ?? 0,
          output: measured?.output ?? 0,
          ...(measured?.cacheRead ? { cachedInput: measured.cacheRead } : {}),
          ...(measured?.cacheCreate ? { cacheCreate: measured.cacheCreate } : {}),
          ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
          ...(runtimeEstimatedCostUsd == null && measured
            ? {
                catalogInput: measured.input,
                catalogOutput: measured.output,
                catalogCacheRead: measured.cacheRead,
                catalogCacheCreate: measured.cacheCreate,
              }
            : {}),
        })
      }
    }
    const selectableAgentNames = taskRuntime.agents.map((agent) => agent.name)
    const subagentTurnState = createExplicitSubagentTurnState(
      detectExplicitSubagentsForTurn(history, selectableAgentNames),
      selectableAgentNames
    )
    state.runTask = async (input, toolCallId, signal) => {
      let agentName =
        input && typeof input === 'object' && typeof (input as { agent?: unknown }).agent === 'string'
          ? (input as { agent: string }).agent.trim()
          : ''
      let task =
        input && typeof input === 'object' && typeof (input as { prompt?: unknown }).prompt === 'string'
          ? (input as { prompt: string }).prompt.trim()
          : ''
      const maestroPrepared =
        args.mode === 'maestro' && args.maestro
          ? await prepareMaestroDelegation({
              input,
              turn: args.maestro,
              parent: { ...args.selection, effort: args.reasoningEffort || 'off' },
              parentFastMode: false,
              turnState: subagentTurnState,
              delegationId: toolCallId,
              owner: { conversationId: args.conversationId, parentMessageId: assistantId },
            })
          : undefined
      if (maestroPrepared) {
        agentName = maestroPrepared.agentName
        task = maestroPrepared.task
      }
      if (!agentName || !task) throw new Error('task requires non-empty agent and prompt fields')
      // Agent selection is semantic and happens before execution-profile resolution.
      // Execution routing is host-managed and keyed by the selected agent name.
      // A role mentioned inside task.prompt must never alter profile resolution.
      if (!maestroPrepared) {
        assertSubagentSelection({
          state: subagentTurnState,
          selectedAgent: agentName,
          availableAgents: taskRuntime.agents.map((agent) => agent.name),
          runtime: 'github-copilot',
          conversationId: args.conversationId,
        })
        recordSubagentDispatch(subagentTurnState, agentName)
      }
      ensureTool(
        toolCallId,
        args.mode === 'maestro' ? 'delegate' : 'task',
        args.mode === 'maestro' ? input : { agent: agentName, prompt: task }
      )
      const startedAt = Date.now()
      const lines: string[] = []
      let resolved = resolvedTaskProfiles.get(toolCallId)
      if (!resolved) {
        resolved = maestroPrepared
          ? Promise.resolve({
              definition: taskRuntime.agents.find((agent) => agent.name === agentName) ?? null,
              profile: maestroPrepared.execution.profile,
            })
          : resolveSubagentExecutionProfile({
              agentName,
              agents: taskRuntime.agents,
              conversationId: args.conversationId,
              parentFastMode: false,
              parent: { ...args.selection, effort: args.reasoningEffort || 'off' },
            })
        resolvedTaskProfiles.set(toolCallId, resolved)
      }
      const { definition, profile } = await resolved
      const meta = (
        measured?: NormalizedAiUsage,
        final = false,
        runtimeEstimatedCostUsd?: number
      ): SubagentRunMeta => ({
        profile,
        ...(maestroPrepared ? { maestro: maestroPrepared.execution.snapshot } : {}),
        startedAt,
        ...(measured
          ? {
              usage: {
                input: measured.input,
                output: measured.output,
                cacheRead: measured.cacheRead,
                cacheCreate: measured.cacheCreate,
              },
            }
          : {}),
        ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
        ...(final ? { durationMs: Math.max(0, Date.now() - startedAt) } : {}),
      })
      const update = (output: string | undefined, sub: SubagentRunMeta): void => {
        subagentRuns.set(toolCallId, sub)
        apply({
          kind: 'tool-state',
          messageId: assistantId,
          toolCallId,
          state: { status: 'running', ...(output ? { output } : {}), sub },
        })
      }
      update(undefined, meta())
      if (!definition || !profile.effective) {
        const sub = meta(undefined, true)
        update(undefined, sub)
        return { output: '', error: `Subagent "${agentName}" has no runnable execution profile.`, sub }
      }
      const executeResolved = async (
        workSignal: AbortSignal,
        sessionRecorder?: SubagentSessionRecorder,
        background = false
      ) => {
        const progress = (line: string): void => {
          if (background) return
          lines.push(line)
          update(lines.slice(-12).join('\n'), meta())
        }
        const childMeta = isClaudeSubscriptionProvider(profile.effective!.providerId)
          ? { meta: { vision: true } }
          : await getSubagentProfileModelMeta(profile.effective!.providerId, profile.effective!.modelId).catch(() => ({
              meta: null,
            }))
        const childTools = adaptToolSetForModel({
          tools: taskRuntime.hostTools,
          supportsImages: supportsChatToolImages({
            modelVision: childMeta.meta?.vision,
            unknownVision: 'unsupported',
            imageInterpreterConfigured: hasConfiguredImageInterpreter(),
          }),
          describeImage: (image) =>
            describeEphemeralToolImage({
              image,
              conversationId: args.conversationId,
              cwd: args.cwd,
              signal: workSignal,
            }),
        })
        const namespacedChildTools = namespaceSubagentToolSet(childTools, toolCallId)
        const readOnly = isSubagentReadOnly(args.mode, definition.tools, childTools)
        const selectedToolNames = selectSubagentToolNames({
          definition,
          readOnly,
          providedHostTools: namespacedChildTools,
        })
        let lease: SubagentLease | null = null
        try {
          lease = await state.subagentCoordinator.acquire({ agent: agentName, signal: workSignal })
          const result = await executeSubagent({
            conversationId: args.conversationId,
            projectId: args.projectId,
            cwd: args.cwd,
            parentMessageId: assistantId,
            toolCallId,
            delegationId: maestroPrepared?.execution.snapshot.delegationId,
            delegationLabel: maestroPrepared?.execution.snapshot.resource.label,
            maestroSnapshot: maestroPrepared?.execution.snapshot,
            mode: args.mode,
            permMode: args.permMode,
            profile,
            definition,
            agentName,
            task,
            readOnly,
            tools: namespacedChildTools,
            allowedToolNames: selectedToolNames,
            deferredToolNames: taskRuntime.deferredHostToolNames,
            broker: args.broker,
            questionBroker: args.questionBroker,
            signal: workSignal,
            progress,
            sessionRecorder,
            emitGeneratedImage: state.emitGeneratedImage,
            onGeneratedImageUsage: state.onGeneratedImageUsage,
            account: {
              parentProviderId: args.selection.providerId,
              copilot: { manager: args.manager, identity: args.accountIdentity },
            },
          })
          if (result.model && (result.usage || result.runtimeEstimatedCostUsd != null)) {
            recordManagedUsage(result.model, result.usage, result.runtimeEstimatedCostUsd)
          }
          const summary = sessionRecorder?.summary()
          const sub = {
            ...meta(result.usage, true, result.runtimeEstimatedCostUsd),
            ...(sessionRecorder
              ? {
                  sessionId: sessionRecorder.id,
                  phase: summary?.phase,
                  lastActivityAt: summary?.lastActivityAt,
                }
              : {}),
          }
          if (!background) update(lines.slice(-12).join('\n'), sub)
          return result.error
            ? { output: result.text, error: `Subagent "${agentName}" failed: ${result.error}`, sub }
            : { output: result.text, sub }
        } catch (error) {
          const withUsage = error as Error & {
            subagentUsage?: NormalizedAiUsage
            subagentModel?: ChatModelRef
            subagentRuntimeEstimatedCostUsd?: number
          }
          if (
            withUsage.subagentModel &&
            (withUsage.subagentUsage || withUsage.subagentRuntimeEstimatedCostUsd != null)
          ) {
            recordManagedUsage(
              withUsage.subagentModel,
              withUsage.subagentUsage,
              withUsage.subagentRuntimeEstimatedCostUsd
            )
          }
          if (!background) {
            const sub = meta(withUsage.subagentUsage, true, withUsage.subagentRuntimeEstimatedCostUsd)
            update(lines.slice(-12).join('\n'), sub)
          }
          throw error
        } finally {
          lease?.release()
        }
      }

      if (maestroPrepared) {
        const handle = startMaestroDelegation({
          conversationId: args.conversationId,
          parentMessageId: assistantId,
          toolCallId,
          agentName,
          task,
          profile,
          maestro: maestroPrepared.execution.snapshot,
          parentSignal: signal,
          maestroLive: args.maestroLive,
          execute: (workSignal, sessionRecorder) => executeResolved(workSignal, sessionRecorder, true),
        })
        if (handle.sub) subagentRuns.set(toolCallId, handle.sub)
        return handle
      }
      return executeResolved(signal)
    }

    let initialContextProfileLogged = false
    const onEvent = (event: SessionEvent): void => {
      switch (event.type) {
        case 'assistant.message_delta': {
          if (event.agentId) {
            const callId = subagentCalls.get(event.agentId)
            if (callId && event.data.deltaContent) {
              previewSubagentMessage(
                callId,
                recordSubagentMessage(callId, event.data.messageId, event.data.deltaContent, false)
              )
            }
            return
          }
          const partId = `copilot_text_${event.data.messageId}`
          if (!startedText.has(partId)) {
            startedText.add(partId)
            apply({ kind: 'text-start', messageId: assistantId, partId })
          }
          streamedText.add(event.data.messageId)
          apply({ kind: 'text-delta', messageId: assistantId, partId, delta: event.data.deltaContent })
          return
        }
        case 'assistant.message': {
          if (event.agentId) {
            const callId = subagentCalls.get(event.agentId)
            if (callId && event.data.content) {
              previewSubagentMessage(
                callId,
                recordSubagentMessage(callId, event.data.messageId, event.data.content, true)
              )
            }
            return
          }
          collectCitations(event.data.citations, citationLines)
          if (streamedText.has(event.data.messageId) || !event.data.content) return
          const partId = `copilot_text_${event.data.messageId}`
          apply({ kind: 'text-start', messageId: assistantId, partId })
          apply({ kind: 'text-delta', messageId: assistantId, partId, delta: event.data.content })
          return
        }
        case 'assistant.reasoning_delta': {
          if (event.agentId) return
          const partId = `copilot_reasoning_${event.data.reasoningId}`
          if (!startedReasoning.has(partId)) {
            startedReasoning.add(partId)
            apply({ kind: 'reasoning-start', messageId: assistantId, partId })
          }
          streamedReasoning.add(event.data.reasoningId)
          apply({ kind: 'reasoning-delta', messageId: assistantId, partId, delta: event.data.deltaContent })
          return
        }
        case 'assistant.reasoning': {
          if (event.agentId || streamedReasoning.has(event.data.reasoningId) || !event.data.content) return
          const partId = `copilot_reasoning_${event.data.reasoningId}`
          apply({ kind: 'reasoning-start', messageId: assistantId, partId })
          apply({ kind: 'reasoning-delta', messageId: assistantId, partId, delta: event.data.content })
          return
        }
        case 'tool.execution_start': {
          if (event.agentId) {
            const parent = subagentCalls.get(event.agentId)
            if (parent) progressSubagent(parent, `${event.data.toolName} started`)
            return
          }
          ensureTool(event.data.toolCallId, event.data.toolName, event.data.arguments ?? {})
          return
        }
        case 'tool.execution_partial_result': {
          const data = event.data
          if (event.agentId) {
            const parent = subagentCalls.get(event.agentId)
            if (parent && data.partialOutput.trim()) progressSubagent(parent, data.partialOutput.trim())
            return
          }
          apply({
            kind: 'tool-state',
            messageId: assistantId,
            toolCallId: data.toolCallId,
            state: { status: 'running', output: clipPersistedToolOutput(data.partialOutput) },
          })
          return
        }
        case 'tool.execution_progress': {
          const data = event.data
          if (event.agentId) {
            const parent = subagentCalls.get(event.agentId)
            if (parent && data.progressMessage.trim()) progressSubagent(parent, data.progressMessage.trim())
            return
          }
          apply({
            kind: 'tool-state',
            messageId: assistantId,
            toolCallId: data.toolCallId,
            state: { status: 'running', output: data.progressMessage },
          })
          return
        }
        case 'tool.execution_complete': {
          if (event.agentId) {
            const parent = subagentCalls.get(event.agentId)
            if (parent)
              progressSubagent(parent, `${event.data.success ? 'completed' : 'failed'} ${event.data.toolCallId}`)
            return
          }
          ensureTool(event.data.toolCallId, 'tool', {})
          // FINAL state persisted in parts_json: the SDK delivers full detailedContent (uncapped), with the same risk
          // as native Codex exec: huge output prevents future transcript reseeding.
          const normalizedOutput =
            taskRuntime.takeToolOutput(event.data.toolCallId) ??
            copilotResultToChatToolOutput(event.data.result ?? { content: '(no output)' }, event.data.success)
          const outputText = clipPersistedToolOutput(
            typeof normalizedOutput === 'string' ? normalizedOutput : normalizedOutput.text
          )
          const output = typeof normalizedOutput === 'string' ? outputText : { ...normalizedOutput, text: outputText }
          const sub = subagentRuns.get(event.data.toolCallId)
          apply(
            {
              kind: 'tool-state',
              messageId: assistantId,
              toolCallId: event.data.toolCallId,
              state: event.data.success
                ? { status: 'completed', output, ...(sub ? { sub } : {}) }
                : {
                    status: 'error',
                    error: clipPersistedToolOutput(
                      githubCopilotErrorMessage(event.data.error?.message ?? outputText ?? 'Tool failed')
                    ),
                    ...(sub ? { sub } : {}),
                  },
            },
            true
          )
          return
        }
        case 'subagent.started': {
          const callId = event.data.toolCallId
          if (event.agentId) subagentCalls.set(event.agentId, callId)
          ensureTool(callId, 'task', {
            agent: event.data.agentName,
            description: event.data.agentDescription,
            model: event.data.model,
          })
          progressSubagent(
            callId,
            `Subagent ${event.data.agentDisplayName} started${event.data.model ? ` (${event.data.model})` : ''}`
          )
          return
        }
        case 'subagent.completed': {
          const callId = event.data.toolCallId
          const lines = subagentProgress.get(callId) ?? []
          const result = subagentResult(callId)
          const completed = `Subagent ${event.data.agentDisplayName} completed${event.data.durationMs ? ` in ${event.data.durationMs}ms` : ''}`
          const output = result ?? [...lines.slice(-11), completed].join('\n')
          apply(
            {
              kind: 'tool-state',
              messageId: assistantId,
              toolCallId: callId,
              state: { status: 'completed', output },
            },
            true
          )
          return
        }
        case 'subagent.failed': {
          ensureTool(event.data.toolCallId, 'task', { agent: event.data.agentName })
          apply({
            kind: 'tool-state',
            messageId: assistantId,
            toolCallId: event.data.toolCallId,
            state: { status: 'error', error: githubCopilotErrorMessage(event.data.error) },
          })
          return
        }
        case 'assistant.usage': {
          const input = safeTokens(event.data.inputTokens)
          const output = safeTokens(event.data.outputTokens)
          const cached = Math.min(input, safeTokens(event.data.cacheReadTokens))
          const cacheCreate = Math.min(input - cached, safeTokens(event.data.cacheWriteTokens))
          recordModelCallUsage({
            runtime: 'github-copilot-subscription',
            providerId: args.selection.providerId,
            modelId: args.selection.modelId,
            conversationId: args.conversationId,
            ...(event.agentId ? { agent: event.agentId } : {}),
            usage: {
              input: Math.max(0, input - cached - cacheCreate),
              output,
              cacheRead: cached,
              cacheCreate,
              totalInput: input,
            },
          })
          if (event.agentId) {
            usage.subInput += input
            usage.subOutput += output
            usage.subCached += cached
            usage.subCacheCreate += cacheCreate
          } else {
            usage.mainInput += input
            usage.mainOutput += output
            usage.mainCached += cached
            usage.mainCacheCreate += cacheCreate
            if (event.data.finishReason)
              usage.finishReason = normalizeGitHubCopilotFinishReason(event.data.finishReason)
          }
          return
        }
        case 'session.usage_info': {
          if (event.agentId) return
          usage.contextInput = safeTokens(event.data.currentTokens)
          if (!initialContextProfileLogged) {
            initialContextProfileLogged = true
            chatDiag({
              kind: 'github-copilot-subscription-initial-context',
              mode: args.mode,
              model: args.selection.modelId,
              contextInput: usage.contextInput,
              toolDefinitionsTokens: safeTokens(event.data.toolDefinitionsTokens),
              tools: taskRuntime.toolProfile,
            })
          }
          const limit = safeTokens(event.data.tokenLimit)
          if (limit && limit !== usage.contextWindow) {
            usage.contextWindow = limit
            args.onModelContextWindow?.(limit)
          }
          const compactionWindow =
            portableContextWindow > 0 && usage.contextWindow > 0
              ? Math.min(portableContextWindow, usage.contextWindow)
              : Math.max(portableContextWindow, usage.contextWindow)
          if (
            providerAttemptActive &&
            !state.planSubmitted &&
            !portableCompactionRequested &&
            !portableCompactionInProgress &&
            inTurnCompactions < MAX_IN_TURN_COMPACTIONS &&
            compactionWindow > 0 &&
            args.compactHistory &&
            usage.contextInput / compactionWindow >= IN_TURN_COMPACT_RATIO
          ) {
            portableCompactionRequested = true
            const session = state.session
            portableAbortPromise = session?.abort().catch(() => undefined) ?? null
          }
          return
        }
        case 'session.error': {
          if (portableCompactionRequested || portableCompactionInProgress) return
          fatal.message = githubCopilotErrorMessage(event.data.message)
          return
        }
      }
    }

    const nextSessionConfig = (): GitHubCopilotCreateSessionConfig => {
      const generation = ++activeSessionEventGeneration
      return officialSessionConfig(args, runtime!, (event) => {
        if (generation === activeSessionEventGeneration) onEvent(event)
      })
    }

    let didResume = false
    if (canResume && existing) {
      try {
        state.session = await args.manager.resumeSession(existing.sessionId, {
          ...nextSessionConfig(),
          suppressResumeEvent: true,
          continuePendingWork: false,
        })
        didResume = true
      } catch {
        activeSessionEventGeneration += 1
        await retireSession(args.manager, args.conversationId, existing.sessionId)
      }
    }
    if (!state.session) state.session = await args.manager.createSession(nextSessionConfig())
    chatDiag({
      kind: 'github-copilot-subscription-tools-profile',
      mode: args.mode,
      model: args.selection.modelId,
      resumed: didResume,
      tools: taskRuntime.toolProfile,
    })
    sessionId = state.session.sessionId
    // Isolated: create a durable tombstone as soon as the remote ID exists; finally hard-deletes it.
    if (args.ephemeralSession) {
      queueGitHubCopilotSessionCleanup(args.conversationId, sessionId, args.manager.accountId ?? null)
    }
    args.manager.assertAccountIdentity(args.accountIdentity)
    if (!(args.onSessionReady?.(sessionId) ?? true)) {
      await retireSession(args.manager, args.conversationId, sessionId)
      sessionRetired = true
      throw new Error('GitHub Copilot session was discarded because the conversation is being closed')
    }

    // Finite limits (same protection as the Codex runner): INFINITY here lets history containing giant tool outputs
    // break reseeding by exceeding the API character limit.
    const seedTranscript = didResume ? '' : renderNativeSeedTranscript(history.slice(0, -1))
    let input = currentMessageInput(currentUser, seedTranscript, args.dropImages === true)
    const onAbort = (): void => {
      void state.session?.abort().catch(() => undefined)
    }
    while (state.session) {
      if (args.signal.aborted) break
      portableCompactionRequested = false
      portableAbortPromise = null
      providerAttemptActive = true
      args.signal.addEventListener('abort', onAbort, { once: true })
      try {
        await state.session.sendAndWait(
          { ...input, agentMode: args.reviewerRuntime || args.mode === 'plan' ? 'plan' : 'interactive' },
          SESSION_WAIT_TIMEOUT_MS
        )
      } catch (error) {
        if (!portableCompactionRequested) throw error
      } finally {
        providerAttemptActive = false
        args.signal.removeEventListener('abort', onAbort)
      }
      await portableAbortPromise

      if (!portableCompactionRequested || args.signal.aborted || state.planSubmitted) break

      // compactHistory reads the durable conversation, so make the provider's partial output visible to it first.
      persist()
      portableCompactionInProgress = true
      let compacted: Awaited<ReturnType<NonNullable<RunGitHubCopilotChatArgs['compactHistory']>>> = null
      try {
        compacted = await args.compactHistory!()
      } catch {
        compacted = null
      } finally {
        portableCompactionInProgress = false
      }
      const summary = compacted?.summary.trim()
      if (!compacted || !summary) throw new Error('GitHub Copilot portable intra-turn compaction failed')

      addPortableCompactionUsage(usage, compacted.usage)
      inTurnCompactions += 1
      apply(
        {
          kind: 'compaction',
          messageId: assistantId,
          partId: randomUUID(),
          text: summary,
          strategy: 'summary',
          usage: chatUsage(usage, [...managedSubagentUsage.values()]),
        },
        true
      )
      chatDiag({
        kind: 'github-copilot-subscription-in-turn-compact',
        compacts: inTurnCompactions,
        contextInput: usage.contextInput,
        contextWindow:
          portableContextWindow > 0 && usage.contextWindow > 0
            ? Math.min(portableContextWindow, usage.contextWindow)
            : Math.max(portableContextWindow, usage.contextWindow),
        model: args.selection.modelId,
        conv: args.conversationId,
      })

      // The native history is now stale relative to the portable boundary. It must never be resumed again.
      const retiredSessionId = sessionId
      activeSessionEventGeneration += 1
      await args.manager.disconnectSession(retiredSessionId).catch(() => undefined)
      disconnected = true
      await retireSession(args.manager, args.conversationId, retiredSessionId)
      sessionRetired = true
      state.session = null
      if (args.signal.aborted) break

      const freshSession = await args.manager.createSession(nextSessionConfig())
      state.session = freshSession
      sessionId = freshSession.sessionId
      disconnected = false
      sessionRetired = false
      // Isolated: each intra-turn compaction session is also ephemeral.
      if (args.ephemeralSession) {
        queueGitHubCopilotSessionCleanup(args.conversationId, sessionId, args.manager.accountId ?? null)
      }
      args.manager.assertAccountIdentity(args.accountIdentity)
      if (!(args.onSessionReady?.(sessionId) ?? true)) {
        await retireSession(args.manager, args.conversationId, sessionId)
        sessionRetired = true
        throw new Error('GitHub Copilot session was discarded because the conversation is being closed')
      }

      usage.contextInput = 0
      const continuationTranscript = renderTranscript([...history, messages[0]], {
        maxToolOutputChars: 16_000,
        maxChars: 800_000,
      })
      const continueMessage: ChatMessage = {
        id: randomUUID(),
        conversationId: args.conversationId,
        role: 'user',
        parts: [{ type: 'text', id: randomUUID(), text: PORTABLE_CONTINUE_PROMPT }],
        createdAt: Date.now(),
      }
      input = currentMessageInput(continueMessage, continuationTranscript, true)
    }

    if (citationLines.size) {
      const partId = 'copilot_citations'
      apply({ kind: 'text-start', messageId: assistantId, partId })
      apply({
        kind: 'text-delta',
        messageId: assistantId,
        partId,
        delta: `\n\n### Sources\n${[...citationLines.values()].join('\n')}`,
      })
    }

    if (args.signal.aborted) {
      apply(
        {
          kind: 'aborted',
          messageId: assistantId,
          usage: chatUsage(usage, [...managedSubagentUsage.values()]),
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        true
      )
    } else if (fatal.message) {
      apply(
        {
          kind: 'error',
          messageId: assistantId,
          message: fatal.message,
          usage: chatUsage(usage, [...managedSubagentUsage.values()]),
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        true
      )
    } else {
      apply(
        {
          kind: 'finish',
          messageId: assistantId,
          finishReason: state.planSubmitted ? 'stop' : usage.finishReason || 'stop',
          usage: chatUsage(usage, [...managedSubagentUsage.values()]),
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        true
      )
    }

    args.manager.assertAccountIdentity(args.accountIdentity)
    if (!args.signal.aborted && !fatal.message && !args.ephemeralSession && (args.canPersistSession?.() ?? true)) {
      putGitHubCopilotSessionBinding({
        conversationId: args.conversationId,
        sessionId,
        modelId: args.selection.modelId,
        harnessProfile: harness.profile,
        toolSignature: runtime.toolSignature,
        lastMessageId: assistantId,
        accountFingerprint,
        accountId: args.manager.accountId,
      })
      clearGitHubCopilotSessionCleanup(sessionId)
      sessionPersisted = true
    }
    if (dirty) persist()
    coalescer.flush()
    return { planSubmitted: state.planSubmitted, sessionId }
  } catch (error) {
    if (args.signal.aborted) {
      apply(
        {
          kind: 'aborted',
          messageId: assistantId,
          usage: chatUsage(usage, [...managedSubagentUsage.values()]),
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        true
      )
    } else {
      apply(
        {
          kind: 'error',
          messageId: assistantId,
          message: fatal.message ?? githubCopilotErrorMessage(error),
          usage: chatUsage(usage, [...managedSubagentUsage.values()]),
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        true
      )
    }
    coalescer.flush()
  } finally {
    if (sessionId && !disconnected) {
      disconnected = true
      await args.manager.disconnectSession(sessionId).catch(() => undefined)
    }
    // A non-persisted SDK session is otherwise unreachable after disconnect. This covers aborts, runtime
    // errors, account races and rejected onSessionReady callbacks without leaving provider-owned state behind.
    if (sessionId && !sessionPersisted && !sessionRetired) {
      await retireSession(args.manager, args.conversationId, sessionId)
      sessionRetired = true
    }
    await runtime?.close().catch(() => undefined)
    if (dirty) persist()
    coalescer.flush()
    coalescer.dispose()
  }
  return { planSubmitted: state.planSubmitted, sessionId }
}

/**
 * Provider-native manual compaction. It resumes the exact persisted session contract, asks the official runtime
 * to compact its own history, and leaves Maestrly's visible transcript/binding cursor untouched.
 */
export async function compactGitHubCopilotSession(
  args: CompactGitHubCopilotSessionArgs
): Promise<CompactGitHubCopilotSessionResult> {
  if (args.signal.aborted) throw new Error('GitHub Copilot compaction was aborted before it started')
  args.manager.assertAccountIdentity(args.accountIdentity)
  const accountFingerprint = args.accountIdentity.fingerprint
  if (!accountFingerprint) throw new Error('GitHub Copilot is not authenticated')

  const binding = getGitHubCopilotSessionBinding(args.conversationId)
  if (!binding) throw new Error('This conversation has no GitHub Copilot session to compact')
  const harness = resolveGitHubCopilotHarness(args.selection.modelId)
  // Resume boundary = MAIN context (isolated rounds never move the conversation binding).
  const latestMessage = lastConversationContextMessage(args.conversationId)
  if (
    binding.modelId !== args.selection.modelId ||
    binding.harnessProfile !== harness.profile ||
    binding.accountFingerprint !== accountFingerprint ||
    binding.accountId !== (args.manager.accountId ?? null) ||
    latestMessage?.id !== binding.lastMessageId
  ) {
    throw new Error('The GitHub Copilot session contract changed and cannot be compacted safely')
  }

  const state: GitHubCopilotRunnerState = {
    planSubmitted: false,
    session: null,
    runTask: null,
    subagentCoordinator: new SubagentCoordinator(),
  }
  const runtime = await prepareRuntime(args, binding.lastMessageId, state)
  try {
    if (runtime.toolSignature !== binding.toolSignature) {
      throw new Error('The GitHub Copilot tool contract changed and cannot be compacted safely')
    }
    const sessionConfig = officialSessionConfig(args, runtime, () => {})
    state.session = await args.manager.resumeSession(binding.sessionId, {
      ...sessionConfig,
      suppressResumeEvent: true,
      continuePendingWork: false,
    })
    chatDiag({
      kind: 'github-copilot-subscription-tools-profile',
      mode: args.mode,
      model: args.selection.modelId,
      resumed: true,
      operation: 'compaction',
      tools: runtime.toolProfile,
    })
    args.manager.assertAccountIdentity(args.accountIdentity)

    const onAbort = (): void => {
      void state.session?.rpc.history.abortManualCompaction().catch(() => undefined)
    }
    args.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await state.session.rpc.history.compact(
        args.customInstructions ? { customInstructions: args.customInstructions } : undefined
      )
      if (args.signal.aborted) throw new Error('GitHub Copilot compaction was aborted')
      args.manager.assertAccountIdentity(args.accountIdentity)
      return {
        sessionId: binding.sessionId,
        success: result.success,
        tokensRemoved: result.tokensRemoved,
        messagesRemoved: result.messagesRemoved,
        summary: result.summaryContent ?? null,
        ...(result.contextWindow ? { contextWindow: result.contextWindow } : {}),
      }
    } finally {
      args.signal.removeEventListener('abort', onAbort)
    }
  } finally {
    await args.manager.disconnectSession(binding.sessionId).catch(() => undefined)
    await runtime.close().catch(() => undefined)
  }
}
