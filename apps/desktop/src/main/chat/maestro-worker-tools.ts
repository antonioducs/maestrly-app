import type { ToolSet } from 'ai'
import type { GeneratedImageEmission, GeneratedImageUsage } from './tools/util'
import type { PermissionBroker } from './permission'
import type { SubagentExecutionSnapshotV1 } from '../../shared/subagent-profiles'
import { getConvUiPrefs } from '../store'
import { createMaestroWorkerScope, type MaestroWorkerScope } from '../maestro-worker-scope'
import { buildAppTools, buildMcpTools } from './mcp'
import { describeEphemeralToolImage, hasConfiguredImageInterpreter } from './image-interpreter'
import { adaptToolSetForModel, supportsChatToolImages } from './tool-capabilities'
import { getSubagentProfileModelMeta } from './subagent-profile-model-meta'
import { isClaudeSubscriptionProvider, isCodexSubscriptionProvider } from './catalog'
import { generateImageToolEnabled, GENERATE_IMAGE_TOOL_NAME } from './image-gen'
import { ALL_TOOL_NAMES, buildTools } from './tools'
import { buildModelSkillRuntime } from './skill-runtime'

const MAESTRO_WORKER_PARENT_ONLY_TOOLS = new Set([
  'ask_question',
  'delegate',
  // Internal review-loop evidence requires a reviewer runtime that Pool workers do not own.
  'git_diff',
  'task',
  'review_plan',
  'todo_write',
  'search_execution_context',
  'read_execution_context',
  'submit_review',
  // Pure UI focus has no worker-local meaning and must not disturb the user's active terminal.
  'terminal_focus',
  'wait_delegation',
  'list_delegations',
  'inspect_subagent',
  'cancel_delegation',
])

export function isMaestroWorkerOperationalToolName(name: string): boolean {
  return !MAESTRO_WORKER_PARENT_ONLY_TOOLS.has(name)
}

export interface MaestroWorkerToolRuntime {
  tools: ToolSet
  allowedToolNames: ReadonlySet<string>
  deferredToolNames: ReadonlySet<string>
  skillCatalog: string
  scope: MaestroWorkerScope
  close(): Promise<void>
}

export async function buildMaestroWorkerTools(args: {
  conversationId: string
  projectId: string
  cwd: string
  parentMessageId: string
  delegationId: string
  label: string
  profile: SubagentExecutionSnapshotV1
  broker: PermissionBroker
  signal: AbortSignal
  emitGeneratedImage?: (toolCallId: string, image: GeneratedImageEmission) => void
  onGeneratedImageUsage?: (usage: GeneratedImageUsage) => void
  generateImage?: (
    prompt: string,
    signal: AbortSignal,
    onUsage?: (usage: GeneratedImageUsage) => void
  ) => Promise<GeneratedImageEmission>
}): Promise<MaestroWorkerToolRuntime> {
  const effective = args.profile.effective
  if (!effective) throw new Error('A Maestro worker tool runtime requires an effective execution profile.')

  const scope = createMaestroWorkerScope({
    conversationId: args.conversationId,
    delegationId: args.delegationId,
    label: args.label,
    signal: args.signal,
  })
  let app: Awaited<ReturnType<typeof buildAppTools>> | null = null
  let mcp: Awaited<ReturnType<typeof buildMcpTools>> | null = null
  try {
    const skillRuntime = await buildModelSkillRuntime({
      cwd: args.cwd,
      conversationId: args.conversationId,
    })
    const childMeta = isClaudeSubscriptionProvider(effective.providerId)
      ? { meta: { vision: true } }
      : await getSubagentProfileModelMeta(effective.providerId, effective.modelId).catch(() => ({ meta: null }))
    const supportsImages = supportsChatToolImages({
      modelVision: childMeta.meta?.vision,
      unknownVision: 'unsupported',
      imageInterpreterConfigured: hasConfiguredImageInterpreter(),
    })
    const describeImage = (image: Parameters<typeof describeEphemeralToolImage>[0]['image']) =>
      describeEphemeralToolImage({
        image,
        conversationId: args.conversationId,
        cwd: args.cwd,
        signal: args.signal,
      })
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

    const disabledIds = new Set(getConvUiPrefs(args.conversationId).chat?.tools?.mcpDisabled ?? [])
    app = await buildAppTools({
      conversationId: args.conversationId,
      mode: 'agent',
      gate,
      exclude: new Set(['review_plan', 'terminal_focus']),
      workerScope: scope,
      supportsImages,
      describeImage,
    })
    mcp = await buildMcpTools({
      mode: 'agent',
      signal: args.signal,
      gate,
      disabledIds,
      codexSafeNames: isCodexSubscriptionProvider(effective.providerId),
      supportsImages,
      describeImage,
    })

    const canGenerateImage =
      args.emitGeneratedImage != null && (await generateImageToolEnabled(args.conversationId, 'agent'))
    const builtinNames = new Set(
      ALL_TOOL_NAMES.filter(
        (name) => isMaestroWorkerOperationalToolName(name) && (name !== GENERATE_IMAGE_TOOL_NAME || canGenerateImage)
      )
    )
    const builtins = buildTools({
      enabled: builtinNames,
      makeCtx: (toolCallId, signal) => ({
        conversationId: args.conversationId,
        projectId: args.projectId,
        messageId: args.parentMessageId,
        toolCallId,
        cwd: args.cwd,
        signal,
        ask: (action, resources, save) => {
          return args.broker.assert({
            conversationId: args.conversationId,
            projectId: args.projectId,
            action,
            resources,
            save,
            toolName: action,
            toolCallId,
            signal,
          })
        },
        askQuestion: async () => [],
        ...(args.emitGeneratedImage
          ? { emitGeneratedImage: (image: GeneratedImageEmission) => args.emitGeneratedImage?.(toolCallId, image) }
          : {}),
        ...(args.onGeneratedImageUsage ? { onGeneratedImageUsage: args.onGeneratedImageUsage } : {}),
        ...(args.generateImage ? { generateImage: args.generateImage } : {}),
      }),
    })
    const operationalTools = Object.fromEntries(
      Object.entries({ ...builtins, ...skillRuntime.tools, ...mcp.tools, ...app.tools }).filter(([name]) =>
        isMaestroWorkerOperationalToolName(name)
      )
    ) as ToolSet
    const tools = adaptToolSetForModel({
      tools: operationalTools,
      supportsImages,
      describeImage,
    })
    const allowedToolNames = new Set(Object.keys(tools))
    const deferredToolNames = new Set(
      [...Object.keys(mcp.tools), ...Object.keys(app.tools)].filter((name) => allowedToolNames.has(name))
    )
    let closed = false
    return {
      tools,
      allowedToolNames,
      deferredToolNames,
      skillCatalog: skillRuntime.catalog,
      scope,
      close: async () => {
        if (closed) return
        closed = true
        await Promise.allSettled([app!.close(), mcp!.close()])
        await scope.close().catch(() => undefined)
      },
    }
  } catch (error) {
    await Promise.allSettled([app?.close(), mcp?.close()])
    await scope.close().catch(() => undefined)
    throw error
  }
}
