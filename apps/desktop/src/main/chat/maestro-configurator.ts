import { randomUUID } from 'node:crypto'
import { jsonSchema, tool, type ToolSet } from 'ai'
import {
  diffMaestroConfigs,
  hashMaestroConfig,
  type MaestroConfiguratorCatalog,
  type MaestroConfiguratorCatalogModel,
  type MaestroConfiguratorEvent,
  type MaestroConfiguratorMessage,
  type MaestroConfiguratorProfile,
  type MaestroConfiguratorProposal,
  type MaestroConfiguratorSendInput,
  type MaestroConfiguratorSendResult,
  type MaestroConfiguratorState,
} from '../../shared/maestro-configurator'
import type { MaestroConfigDiagnostic, MaestroConfigV1 } from '../../shared/maestro'
import { isRealSubagentProfileEffort } from '../../shared/subagent-profile-effort'
import type { ChatAgent } from './agents'
import { listAvailableChatProviders } from './catalog'
import { recordStandaloneChatUsage } from './chat-store'
import { executeSubagent } from './subagent-executor'
import { resolveParentSubagentExecutionProfile } from './subagent-execution-profile'
import { applySubagentTextUpdate } from './subagent-text-stream'
import { validateMaestroConfig } from './maestro-config'
import {
  appendMaestroConfiguratorMessage,
  getMaestroConfiguratorThread,
  getStoredMaestroConfiguratorProfile,
  resetMaestroConfiguratorThread,
  setStoredMaestroConfiguratorProfile,
} from './maestro-configurator-store'
import { PermissionBroker, YOLO_RULESET } from './permission'
import { QuestionBroker } from './question-broker'
import { subagentModelCatalog, subagentModelMeta, subagentProviderStatus } from './subagent-provider-runtime'
import { getAppSetting } from '../store'
import { invalidateUnifiedUsageCache } from '../usage/usage-service'

const SURFACE_ID = 'maestro-configurator'
const MAX_USER_TEXT = 20_000
const MAX_TRANSCRIPT_TEXT = 60_000
const MAX_PROPOSAL_BYTES = 300_000
const TOOL_NAMES = ['read_available_model_catalog', 'read_maestro_draft', 'propose_maestro_config'] as const

const CONFIGURATOR_AGENT: ChatAgent = {
  name: SURFACE_ID,
  description: 'Builds and revises the global Maestro Agent Pool configuration.',
  category: 'configuration',
  source: 'built-in',
  tools: [...TOOL_NAMES],
  prompt: `You are the Maestrly Maestro Configurator. Help the user design the GLOBAL Maestro configuration shown in Settings.

You can inspect the current draft and the live runnable model catalog, then submit a complete proposal. You cannot save settings directly. A proposal is only applied to the visible draft after explicit user confirmation, and the normal Save global button remains the persistence boundary.

Understand these fields precisely:
- strategy selects balanced, best-quality, fast, or economy guidance for the parent;
- pool resources are logical roles with unique ids, labels, descriptions, worker/read-only capability, specialties, optional instructions, and ordered execution candidates;
- every candidate identifies providerId, modelId, a real reasoning effort or off, and optional Fast;
- an empty candidate list inherits the frozen orchestrator profile as final fallback;
- candidate order is fallback order;
- the parent sees the complete enabled Pool configuration and explicitly chooses the logical agent for every delegation.

Use only the three supplied configuration tools. Never claim to have edited or saved anything. For a requested change, inspect the draft, inspect the catalog when model availability matters, and call propose_maestro_config with the COMPLETE resulting config. You may answer questions without proposing. State assumptions about model strengths when they came from the user or from inference rather than catalog metadata. Preserve unrelated settings. Respond in the user's language.`,
}

const diagnostic = (
  message: string,
  severity: MaestroConfigDiagnostic['severity'],
  resourceId?: string
): MaestroConfigDiagnostic => ({
  code: 'resource-unavailable',
  message,
  severity,
  ...(resourceId ? { resourceId } : {}),
})

const unique = <T>(values: T[]): T[] => [...new Set(values)]

export async function buildMaestroConfiguratorCatalog(now = Date.now()): Promise<MaestroConfiguratorCatalog> {
  const providers = await Promise.all(
    listAvailableChatProviders().map(async (provider) => {
      if ((await subagentProviderStatus(provider.id)) !== 'available') return null
      const catalog = await subagentModelCatalog(provider.id)
      const modelIds = unique(catalog.models).sort((left, right) => left.localeCompare(right))
      const models = await Promise.all(
        modelIds.map(async (modelId): Promise<MaestroConfiguratorCatalogModel | null> => {
          const metadata = await subagentModelMeta(provider.id, modelId).catch(() => ({
            status: 'unavailable' as const,
            meta: null,
          }))
          if (metadata.meta?.chatCapable === false) return null
          return {
            id: modelId,
            reasoning: metadata.meta?.reasoning === true,
            reasoningEfforts: unique(metadata.meta?.reasoningEfforts ?? []),
            fastModeCapability: metadata.meta?.fastModeCapability === true,
            ...(metadata.meta?.contextWindow ? { contextWindow: metadata.meta.contextWindow } : {}),
          }
        })
      )
      return {
        id: provider.id,
        name: provider.name,
        catalogStatus: catalog.status,
        models: models.filter((model): model is MaestroConfiguratorCatalogModel => !!model),
      }
    })
  )
  return {
    providers: providers
      .filter((provider): provider is NonNullable<typeof provider> => !!provider)
      .sort((left, right) => left.name.localeCompare(right.name)),
    generatedAt: now,
  }
}

function catalogModel(
  catalog: MaestroConfiguratorCatalog,
  providerId: string,
  modelId: string
): MaestroConfiguratorCatalogModel | null {
  const provider = catalog.providers.find((entry) => entry.id === providerId)
  if (!provider) return null
  return provider.models.find((model) => model.id === modelId || model.id.split('/').pop() === modelId) ?? null
}

export function validateMaestroConfiguratorProfile(
  profile: MaestroConfiguratorProfile,
  catalog: MaestroConfiguratorCatalog
): string[] {
  const errors: string[] = []
  const provider = catalog.providers.find((entry) => entry.id === profile.providerId)
  if (!provider) return [`Provider “${profile.providerId}” is not currently runnable.`]
  if (!profile.modelId.trim()) errors.push('Choose a model for the configurator.')
  const model = catalogModel(catalog, profile.providerId, profile.modelId)
  if (provider.catalogStatus === 'available' && !model) {
    errors.push(`Model “${profile.modelId}” is not in the live catalog for “${provider.name}”.`)
  }
  if (profile.effort !== 'off' && !isRealSubagentProfileEffort(profile.effort)) {
    errors.push('Choose a real reasoning effort or the default/off option.')
  }
  if (model) {
    if (profile.effort !== 'off' && !model.reasoning) {
      errors.push(`Model “${profile.modelId}” does not expose configurable reasoning.`)
    } else if (
      profile.effort !== 'off' &&
      model.reasoningEfforts.length > 0 &&
      !model.reasoningEfforts.includes(profile.effort)
    ) {
      errors.push(`Effort “${profile.effort}” is not supported by “${profile.modelId}”.`)
    }
    if (profile.fastMode === true && !model.fastModeCapability) {
      errors.push(`Model “${profile.modelId}” does not support Fast mode.`)
    }
  }
  return errors
}

export function validateMaestroProposalCatalog(
  config: MaestroConfigV1,
  catalog: MaestroConfiguratorCatalog
): MaestroConfigDiagnostic[] {
  const diagnostics: MaestroConfigDiagnostic[] = []
  for (const resource of config.pool) {
    for (const candidate of resource.candidates) {
      const provider = catalog.providers.find((entry) => entry.id === candidate.providerId)
      if (!provider) {
        diagnostics.push(
          diagnostic(`Provider “${candidate.providerId}” is not currently runnable.`, 'error', resource.id)
        )
        continue
      }
      const model = catalogModel(catalog, candidate.providerId, candidate.modelId)
      if (!model) {
        diagnostics.push(
          diagnostic(
            provider.catalogStatus === 'available'
              ? `Model “${candidate.modelId}” is not in the live catalog for “${provider.name}”.`
              : `The catalog for “${provider.name}” is unavailable; “${candidate.modelId}” could not be verified.`,
            provider.catalogStatus === 'available' ? 'error' : 'warning',
            resource.id
          )
        )
        continue
      }
      if (candidate.effort !== 'off' && !model.reasoning) {
        diagnostics.push(
          diagnostic(`Model “${candidate.modelId}” does not expose configurable reasoning.`, 'error', resource.id)
        )
      } else if (
        candidate.effort !== 'off' &&
        model.reasoningEfforts.length > 0 &&
        !model.reasoningEfforts.includes(candidate.effort)
      ) {
        diagnostics.push(
          diagnostic(`Effort “${candidate.effort}” is not supported by “${candidate.modelId}”.`, 'error', resource.id)
        )
      }
      if (candidate.fastMode === true && !model.fastModeCapability) {
        diagnostics.push(diagnostic(`Model “${candidate.modelId}” does not support Fast mode.`, 'error', resource.id))
      }
    }
  }
  return diagnostics
}

function defaultProfile(catalog: MaestroConfiguratorCatalog): MaestroConfiguratorProfile | null {
  const savedProvider = getAppSetting('chat.defaultProvider') ?? ''
  const savedModel = getAppSetting('chat.defaultModel') ?? ''
  const savedEffort = (getAppSetting('chat.defaultReasoning') ?? 'off').trim().toLowerCase()
  const preferred = catalog.providers.find((provider) => provider.id === savedProvider)
  const provider = preferred ?? catalog.providers.find((entry) => entry.models.length > 0) ?? catalog.providers[0]
  if (!provider) return null
  const modelId =
    (provider.id === savedProvider && savedModel && catalogModel(catalog, provider.id, savedModel)?.id) ||
    provider.models[0]?.id ||
    (provider.id === savedProvider ? savedModel : '')
  if (!modelId) return null
  const model = catalogModel(catalog, provider.id, modelId)
  const effort =
    savedEffort === 'off' ||
    (isRealSubagentProfileEffort(savedEffort) &&
      model?.reasoning &&
      (model.reasoningEfforts.length === 0 || model.reasoningEfforts.includes(savedEffort)))
      ? savedEffort
      : 'off'
  return { providerId: provider.id, modelId, effort }
}

function transcriptFor(messages: MaestroConfiguratorMessage[], userText: string): string {
  const recent = messages.slice(-14)
  const lines = recent.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
  const latestProposal = [...recent].reverse().find((message) => message.proposal)?.proposal
  const proposalContext = latestProposal
    ? `\n\n# Latest un/superseded proposal\nSummary: ${latestProposal.summary}\nConfig:\n${JSON.stringify(latestProposal.config)}`
    : ''
  const transcript = lines.join('\n\n').slice(-MAX_TRANSCRIPT_TEXT)
  return `# Conversation so far\n${transcript || '(new thread)'}${proposalContext}\n\n# Current request\n${userText}`
}

interface ActiveTurn {
  id: string
  generation: number
  controller: AbortController
  done?: Promise<void>
}

export interface MaestroConfiguratorServiceDependencies {
  execute?: typeof executeSubagent
  resolveProfile?: typeof resolveParentSubagentExecutionProfile
  catalog?: () => Promise<MaestroConfiguratorCatalog>
  cwd?: () => string
  now?: () => number
  id?: () => string
}

export class MaestroConfiguratorService {
  private active: ActiveTurn | null = null
  private generation = 0
  private readonly execute: typeof executeSubagent
  private readonly resolveProfile: typeof resolveParentSubagentExecutionProfile
  private readonly readCatalog: () => Promise<MaestroConfiguratorCatalog>
  private readonly cwd: () => string
  private readonly now: () => number
  private readonly id: () => string

  constructor(dependencies: MaestroConfiguratorServiceDependencies = {}) {
    this.execute = dependencies.execute ?? executeSubagent
    this.resolveProfile = dependencies.resolveProfile ?? resolveParentSubagentExecutionProfile
    this.readCatalog = dependencies.catalog ?? (() => buildMaestroConfiguratorCatalog())
    this.cwd = dependencies.cwd ?? (() => process.cwd())
    this.now = dependencies.now ?? Date.now
    this.id = dependencies.id ?? randomUUID
  }

  async state(): Promise<MaestroConfiguratorState> {
    const catalog = await this.readCatalog()
    const stored = getStoredMaestroConfiguratorProfile()
    const profile =
      stored && validateMaestroConfiguratorProfile(stored, catalog).length === 0 ? stored : defaultProfile(catalog)
    if (profile && profile !== stored) setStoredMaestroConfiguratorProfile(profile)
    const storedThread = getMaestroConfiguratorThread()
    const thread = {
      ...storedThread,
      messages: storedThread.messages.map((message) => {
        if (!message.proposal) return message
        const parsed = validateMaestroConfig(message.proposal.config)
        if (!parsed.ok || typeof message.proposal.baseHash !== 'string') {
          const { proposal: _invalid, ...safe } = message
          return safe
        }
        return { ...message, proposal: { ...message.proposal, config: parsed.value.config } }
      }),
    }
    return { thread, profile, catalog, activeTurnId: this.active?.id ?? null }
  }

  async setProfile(
    profile: MaestroConfiguratorProfile
  ): Promise<{ ok: true; profile: MaestroConfiguratorProfile } | { ok: false; errors: string[] }> {
    const normalized: MaestroConfiguratorProfile = {
      providerId: profile.providerId?.trim() ?? '',
      modelId: profile.modelId?.trim() ?? '',
      effort: profile.effort?.trim().toLowerCase() || 'off',
      ...(profile.fastMode === true ? { fastMode: true } : {}),
    }
    const errors = validateMaestroConfiguratorProfile(normalized, await this.readCatalog())
    if (errors.length) return { ok: false, errors }
    return { ok: true, profile: setStoredMaestroConfiguratorProfile(normalized) }
  }

  async send(
    raw: MaestroConfiguratorSendInput,
    emit: (event: MaestroConfiguratorEvent) => void
  ): Promise<MaestroConfiguratorSendResult> {
    if (this.active) return { ok: false, error: 'maestro-configurator-busy' }
    const text = typeof raw?.text === 'string' ? raw.text.trim().slice(0, MAX_USER_TEXT) : ''
    if (!text) return { ok: false, error: 'maestro-configurator-empty-message' }
    const parsedDraft = validateMaestroConfig(raw?.draft)
    if (!parsedDraft.ok) return { ok: false, error: parsedDraft.errors.map((item) => item.message).join(' ') }
    const draft = parsedDraft.value.config
    const baseHash = hashMaestroConfig(draft)
    if (raw.baseHash !== baseHash) return { ok: false, error: 'maestro-configurator-stale-draft' }
    const catalog = await this.readCatalog()
    const profile = getStoredMaestroConfiguratorProfile() ?? defaultProfile(catalog)
    if (!profile) return { ok: false, error: 'maestro-configurator-no-model' }
    const profileErrors = validateMaestroConfiguratorProfile(profile, catalog)
    if (profileErrors.length) return { ok: false, error: profileErrors.join(' ') }

    const turnId = this.id()
    const userMessage: MaestroConfiguratorMessage = {
      id: this.id(),
      role: 'user',
      text,
      createdAt: this.now(),
    }
    const previousMessages = getMaestroConfiguratorThread().messages
    appendMaestroConfiguratorMessage(userMessage)
    const active: ActiveTurn = { id: turnId, generation: ++this.generation, controller: new AbortController() }
    this.active = active
    active.done = this.runTurn({ active, profile, catalog, draft, baseHash, text, previousMessages, emit })
    void active.done
    return { ok: true, turnId, userMessage }
  }

  cancel(turnId?: string): boolean {
    if (!this.active || (turnId && turnId !== this.active.id)) return false
    this.active.controller.abort(new Error('Maestro configurator turn cancelled.'))
    return true
  }

  async stop(): Promise<void> {
    const active = this.active
    if (!active) return
    active.controller.abort(new Error('Maestro configurator is stopping.'))
    await active.done
  }

  reset(emit?: (event: MaestroConfiguratorEvent) => void): void {
    this.generation++
    this.active?.controller.abort(new Error('Maestro configurator thread reset.'))
    this.active = null
    resetMaestroConfiguratorThread()
    emit?.({ kind: 'reset' })
  }

  private isCurrent(active: ActiveTurn): boolean {
    return this.active === active && active.generation === this.generation
  }

  private async runTurn(args: {
    active: ActiveTurn
    profile: MaestroConfiguratorProfile
    catalog: MaestroConfiguratorCatalog
    draft: MaestroConfigV1
    baseHash: string
    text: string
    previousMessages: MaestroConfiguratorMessage[]
    emit: (event: MaestroConfiguratorEvent) => void
  }): Promise<void> {
    const { active, emit } = args
    let proposal: MaestroConfiguratorProposal | undefined
    let streamedText = ''
    const safeEmit = (event: MaestroConfiguratorEvent): void => {
      if (this.isCurrent(active)) emit(event)
    }
    const tools: ToolSet = {
      read_available_model_catalog: tool({
        description: 'Returns the refreshed runnable provider/model catalog with reasoning and Fast capabilities.',
        metadata: { readOnly: true },
        inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
        execute: async () => this.readCatalog(),
      }),
      read_maestro_draft: tool({
        description: 'Returns the exact global Maestro draft currently visible to the user and its base hash.',
        metadata: { readOnly: true },
        inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
        execute: async () => ({ baseHash: args.baseHash, config: args.draft }),
      }),
      propose_maestro_config: tool({
        description:
          'Submits a COMPLETE replacement for the visible Maestro draft. This only creates a reviewable proposal; it never saves settings.',
        metadata: { readOnly: true },
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            summary: { type: 'string' },
            config: { type: 'object' },
          },
          required: ['summary', 'config'],
          additionalProperties: false,
        }),
        execute: async (input: unknown) => {
          proposal = undefined
          const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
          if (Buffer.byteLength(JSON.stringify(raw.config ?? null), 'utf8') > MAX_PROPOSAL_BYTES) {
            return { ok: false, errors: ['The proposed configuration is too large.'] }
          }
          const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 4_000) : ''
          if (!summary) return { ok: false, errors: ['The proposal needs a concise summary.'] }
          const parsed = validateMaestroConfig(raw.config)
          if (!parsed.ok) return { ok: false, errors: parsed.errors }
          const catalog = await this.readCatalog()
          const diagnostics = validateMaestroProposalCatalog(parsed.value.config, catalog)
          if (diagnostics.some((item) => item.severity === 'error')) return { ok: false, errors: diagnostics }
          const changes = diffMaestroConfigs(args.draft, parsed.value.config)
          if (changes.length === 0) return { ok: false, errors: ['The proposal does not change the current draft.'] }
          proposal = {
            id: this.id(),
            baseHash: args.baseHash,
            summary,
            config: parsed.value.config,
            changes,
            diagnostics,
            createdAt: this.now(),
          }
          return { ok: true, proposalId: proposal.id, changes: changes.length, diagnostics }
        },
      }),
    }

    try {
      const profile = await this.resolveProfile({
        agent: CONFIGURATOR_AGENT,
        parent: {
          providerId: args.profile.providerId,
          modelId: args.profile.modelId,
          effort: args.profile.effort,
        },
        parentFastMode: args.profile.fastMode === true,
      })
      if (!profile.effective) {
        throw new Error(profile.diagnostics?.map((item) => item.message).join(' ') || 'Configurator model unavailable.')
      }
      const result = await this.execute({
        conversationId: SURFACE_ID,
        projectId: SURFACE_ID,
        cwd: this.cwd(),
        parentMessageId: active.id,
        parentMessageOwnership: { kind: 'standalone' },
        mode: 'ask',
        permMode: 'ask',
        profile,
        definition: CONFIGURATOR_AGENT,
        agentName: CONFIGURATOR_AGENT.name,
        task: transcriptFor(args.previousMessages, args.text),
        readOnly: true,
        tools,
        allowedToolNames: new Set(TOOL_NAMES),
        broker: new PermissionBroker({ rulesetFor: () => YOLO_RULESET }),
        questionBroker: new QuestionBroker(),
        signal: active.controller.signal,
        progress: (message) => safeEmit({ kind: 'progress', turnId: active.id, message }),
        onTextUpdate: (update) => {
          streamedText = applySubagentTextUpdate(streamedText, update)
          safeEmit({ kind: 'text-update', turnId: active.id, update })
        },
      })
      if (!this.isCurrent(active)) return
      if (result.error) {
        throw Object.assign(new Error(result.error), {
          subagentUsage: result.usage,
          subagentModel: result.model,
          subagentRuntimeEstimatedCostUsd: result.runtimeEstimatedCostUsd,
        })
      }
      const assistantText = result.text.trim() || streamedText.trim() || '(no response)'
      const usage =
        result.usage || result.runtimeEstimatedCostUsd !== undefined
          ? {
              input: result.usage?.input ?? 0,
              output: result.usage?.output ?? 0,
              cacheRead: result.usage?.cacheRead ?? 0,
              cacheCreate: result.usage?.cacheCreate ?? 0,
              ...(result.runtimeEstimatedCostUsd !== undefined
                ? { runtimeEstimatedCostUsd: result.runtimeEstimatedCostUsd }
                : {}),
            }
          : undefined
      const message: MaestroConfiguratorMessage = {
        id: this.id(),
        role: 'assistant',
        text: assistantText,
        createdAt: this.now(),
        model: result.model ?? { providerId: args.profile.providerId, modelId: args.profile.modelId },
        ...(usage ? { usage } : {}),
        ...(proposal ? { proposal } : {}),
      }
      appendMaestroConfiguratorMessage(message)
      if (usage) {
        recordStandaloneChatUsage({
          id: active.id,
          model: message.model!,
          usage,
          runtimeEstimatedCostUsd: usage.runtimeEstimatedCostUsd,
          createdAt: message.createdAt,
        })
        invalidateUnifiedUsageCache()
      }
      safeEmit({ kind: 'completed', turnId: active.id, message })
    } catch (error) {
      if (!this.isCurrent(active)) return
      const measured = error as {
        subagentUsage?: { input: number; output: number; cacheRead: number; cacheCreate: number }
        subagentModel?: { providerId: string; modelId: string }
        subagentRuntimeEstimatedCostUsd?: number
      }
      if (measured.subagentUsage || measured.subagentRuntimeEstimatedCostUsd !== undefined) {
        recordStandaloneChatUsage({
          id: active.id,
          model: measured.subagentModel ?? {
            providerId: args.profile.providerId,
            modelId: args.profile.modelId,
          },
          usage: measured.subagentUsage ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
          runtimeEstimatedCostUsd: measured.subagentRuntimeEstimatedCostUsd,
          createdAt: this.now(),
        })
        invalidateUnifiedUsageCache()
      }
      if (active.controller.signal.aborted) safeEmit({ kind: 'cancelled', turnId: active.id })
      else safeEmit({ kind: 'error', turnId: active.id, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (this.active === active) this.active = null
    }
  }
}

export const maestroConfiguratorService = new MaestroConfiguratorService()
