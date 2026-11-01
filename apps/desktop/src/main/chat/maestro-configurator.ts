import { randomUUID } from 'node:crypto'
import { jsonSchema, tool, type ToolSet } from 'ai'
import {
  MAESTRO_CONFIGURATOR_MAX_IMAGES,
  MAESTRO_PROPOSAL_STRATEGY_UNIT,
  diffMaestroConfigs,
  maestroProposalOutcomes,
  prepareMaestroConfiguratorDraft,
  type MaestroConfiguratorCatalog,
  type MaestroConfiguratorCatalogModel,
  type MaestroConfiguratorChange,
  type MaestroConfiguratorEvent,
  type MaestroConfiguratorImageInput,
  type MaestroConfiguratorImageRef,
  type MaestroConfiguratorMessage,
  type MaestroConfiguratorPreparedDraft,
  type MaestroConfiguratorProfile,
  type MaestroConfiguratorProposal,
  type MaestroConfiguratorSendInput,
  type MaestroConfiguratorSendResult,
  type MaestroConfiguratorState,
  type MaestroConfiguratorThreadEvent,
  type MaestroProposalOutcome,
  type MaestroSettingsDraftSession,
} from '../../shared/maestro-configurator'
import type { MaestroConfigDiagnostic, MaestroConfigV1, MaestroStrategyProfileCatalogItem } from '../../shared/maestro'
import type { ChatImageInterpreter } from '../../shared/chat'
import { MAX_ATTACHMENT_IMAGE_BYTES, MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE } from '../../shared/memory-policy'
import { isRealSubagentProfileEffort } from '../../shared/subagent-profile-effort'
import { tMain } from '../i18n'
import type { ChatAgent } from './agents'
import { listActiveAccountChatProviders, listAvailableChatProviders } from './catalog'
import { recordStandaloneChatUsage } from './chat-store'
import { sniffImageFormat } from './image-magic'
import { executeSubagent } from './subagent-executor'
import { resolveParentSubagentExecutionProfile } from './subagent-execution-profile'
import { applySubagentTextUpdate } from './subagent-text-stream'
import { validateMaestroConfig } from './maestro-config'
import {
  appendMaestroConfiguratorMessage,
  getMaestroConfiguratorThread,
  getStoredMaestroConfiguratorProfile,
  resetMaestroConfiguratorThread,
  sanitizeMaestroConfiguratorEvent,
  setStoredMaestroConfiguratorProfile,
  updateMaestroConfiguratorMessage,
} from './maestro-configurator-store'
import { getMaestroSettingsDraft } from './maestro-settings-draft'
import { listMaestroStrategyProfiles } from './maestro-strategy-profiles'
import { PermissionBroker, YOLO_RULESET } from './permission'
import { QuestionBroker } from './question-broker'
import { subagentModelCatalog, subagentModelMeta, subagentProviderStatus } from './subagent-provider-runtime'
import { getAppSetting } from '../store'
import { invalidateUnifiedUsageCache } from '../usage/usage-service'

const SURFACE_ID = 'maestro-configurator'
const MAX_USER_TEXT = 20_000
const MAX_TRANSCRIPT_TEXT = 60_000
const MAX_PROPOSAL_BYTES = 300_000
const MAX_IMAGE_DESCRIPTION_CHARS = 12_000
const TRANSCRIPT_MESSAGES = 20
const MAX_REPORTED_CHANGES = 40
const TOOL_NAMES = ['read_available_model_catalog', 'read_maestro_draft', 'propose_maestro_config'] as const

const CONFIGURATOR_AGENT: ChatAgent = {
  name: SURFACE_ID,
  description: 'Builds and revises the Maestro Agent Pool configuration edited in Settings.',
  category: 'configuration',
  source: 'built-in',
  tools: [...TOOL_NAMES],
  prompt: `You are the Maestrly Maestro Configurator. Help the user design the Maestro configuration edited in Settings: the Global default or one of their custom strategies.

You can inspect the draft the user is editing and the live runnable model catalog, then submit a complete proposal. You cannot save settings directly. A proposal is only applied to the visible draft after explicit user confirmation, and the editor's save button remains the persistence boundary.

read_maestro_draft returns the editor's state at the moment you call it, including edits the user made after your last turn: which configuration is open (the Global default or a custom strategy), the draft, the changes it has that are not saved yet, and candidate rows the user has not finished filling in (left out of the draft; applying a proposal drops them). Call it at the start of every turn that discusses or changes the configuration; never assume the draft still matches an earlier read or your previous proposal.

Lines that start with "Event:" in the conversation are actions the user took in the editor. A proposal takes effect only after an "applied" event, and is saved only after a "saved" event; until then, say it is pending rather than done.

The user reviews a proposal inside the Pool and may take only part of it: the strategy change and the changes to each resource are accepted or left out separately. An "applied ... except ..." event names what they left out; treat those parts as declined, not forgotten, and read the draft before building on the result. A dismissed proposal was declined as a whole.

Balanced, Best quality, Fast and Economy are the strategy field of the open configuration, not separate configurations: to change it, propose a config with another strategy.

A provider named "Active account" follows that provider's account pool and runs on whichever of its accounts is active; the other entries of the same provider are fixed accounts.

Images the user attaches are transcribed before your turn and reach you as text under "Attached images", not as pixels. When a detail you need is not in the transcription, say so instead of guessing.

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
  // The same providers the Pool editor offers: every account plus the "active account" entry of an account pool.
  const providers = await Promise.all(
    [...listActiveAccountChatProviders(), ...listAvailableChatProviders()].map(async (provider) => {
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
            ...(typeof metadata.meta?.vision === 'boolean' ? { vision: metadata.meta.vision } : {}),
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

const describeSkipped = (keys: string[]): string =>
  keys
    .map((key) =>
      key === MAESTRO_PROPOSAL_STRATEGY_UNIT
        ? 'the strategy change'
        : `the changes to resource "${key.slice('resource:'.length)}"`
    )
    .join(', ')

/** How the transcript tells the model what became of a proposal. */
function proposalOutcomeText(outcome: MaestroProposalOutcome | undefined): string {
  switch (outcome?.status) {
    case 'applied': {
      const scope = outcome.skipped.length ? ` except ${describeSkipped(outcome.skipped)}` : ''
      const state =
        outcome.state === 'saved' ? ', then saved' : outcome.state === 'discarded' ? ', then discarded unsaved' : ''
      return `applied to the draft${scope}${state}`
    }
    case 'dismissed':
      return 'dismissed by the user'
    case 'superseded':
      return 'not applied, replaced by a later proposal'
    default:
      return 'not applied yet'
  }
}

/** English, because it is written for the model; the renderer shows its own localized line for the event. */
export function maestroConfiguratorEventText(event: MaestroConfiguratorThreadEvent): string {
  switch (event.kind) {
    case 'proposal-applied':
      return event.skipped?.length
        ? `The user applied proposal ${event.proposalId} to the draft except ${describeSkipped(event.skipped)}, which they left as they were. It is not saved yet.`
        : `The user applied proposal ${event.proposalId} to the draft. It is not saved yet.`
    case 'proposal-dismissed':
      return `The user dismissed proposal ${event.proposalId} without applying any of it.`
    case 'draft-discarded':
      return `The user discarded the unsaved changes of "${event.profileName}"; the draft is back to its saved state.`
    case 'saved':
      return event.target === 'global'
        ? 'The user saved the draft as the Global default.'
        : event.target === 'custom'
          ? `The user saved the draft to the custom strategy "${event.profileName}".`
          : `The user saved the draft as the new custom strategy "${event.profileName}".`
    case 'profile-selected':
      return `The user opened "${event.profileName}" (${event.source === 'builtin' ? 'read-only built-in' : event.source === 'custom' ? 'custom strategy' : 'Global default'}) in the editor.`
  }
}

const imageNotes = (images: MaestroConfiguratorImageRef[] | undefined): string =>
  (images ?? [])
    .map((image) =>
      image.description
        ? `\n[Attached image "${image.name}", transcribed by ${image.descriptionModel ?? 'a vision model'}:\n${image.description}]`
        : `\n[Attached image "${image.name}" could not be read]`
    )
    .join('')

function transcriptFor(
  messages: MaestroConfiguratorMessage[],
  userText: string,
  images: MaestroConfiguratorImageRef[]
): string {
  const outcomes = maestroProposalOutcomes(messages)
  const recent = messages.slice(-TRANSCRIPT_MESSAGES)
  const lines = recent.map((message) => {
    if (message.role === 'event') return `Event: ${message.text}`
    if (message.role === 'user') return `User: ${message.text}${imageNotes(message.images)}`
    const proposal = message.proposal
      ? `\n[Proposal ${message.proposal.id}, ${proposalOutcomeText(outcomes.get(message.proposal.id))}: ${message.proposal.summary}]`
      : ''
    return `Assistant: ${message.text}${proposal}`
  })
  const latestProposal = [...recent].reverse().find((message) => message.proposal)?.proposal
  const proposalContext =
    latestProposal && outcomes.get(latestProposal.id)?.status === 'pending'
      ? `\n\n# Latest proposal (not applied)\nId: ${latestProposal.id}\nSummary: ${latestProposal.summary}\nConfig:\n${JSON.stringify(latestProposal.config)}`
      : ''
  const transcript = lines.join('\n\n').slice(-MAX_TRANSCRIPT_TEXT)
  const attached = images.length
    ? `\n\n# Attached images\n${images
        .map(
          (image) =>
            `## ${image.name} (transcribed by ${image.descriptionModel ?? 'a vision model'})\n${image.description ?? ''}`
        )
        .join('\n\n')}`
    : ''
  return `# Conversation so far\n${transcript || '(new thread)'}${proposalContext}\n\n# Current request\n${userText || '(no text: see the attached images)'}${attached}`
}

type ImageParseResult = { ok: true; value: MaestroConfiguratorImageInput[] } | { ok: false; error: string }

/** The renderer's declared name and type are not trusted: the format comes from the bytes. */
function parseImages(value: unknown): ImageParseResult {
  if (value === undefined || value === null) return { ok: true, value: [] }
  const invalid: ImageParseResult = { ok: false, error: 'maestro-configurator-invalid-image' }
  if (!Array.isArray(value) || value.length > MAESTRO_CONFIGURATOR_MAX_IMAGES) return invalid
  const images: MaestroConfiguratorImageInput[] = []
  let total = 0
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid
    const raw = item as Record<string, unknown>
    const bytes =
      raw.bytes instanceof Uint8Array ? raw.bytes : raw.bytes instanceof ArrayBuffer ? new Uint8Array(raw.bytes) : null
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_IMAGE_BYTES) return invalid
    total += bytes.byteLength
    if (total > MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE) return invalid
    const format = sniffImageFormat(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    if (!format) return invalid
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : `image.${format.ext}`
    images.push({ name, mediaType: format.mime, bytes })
  }
  return { ok: true, value: images }
}

const sameInterpreter = (left: ChatImageInterpreter, right: ChatImageInterpreter): boolean =>
  left.providerId === right.providerId && left.modelId === right.modelId

interface LiveDraft {
  prepared: MaestroConfiguratorPreparedDraft
  editing: {
    profileId: string
    name: string
    source: MaestroStrategyProfileCatalogItem['source']
    readOnly: boolean
    unsavedChanges: number
    unsavedChangeList: MaestroConfiguratorChange[]
  } | null
  issues?: string[]
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
  /** The Settings editor's live state; null when no editor reported one. */
  liveDraft?: () => MaestroSettingsDraftSession | null
  strategyProfiles?: () => MaestroStrategyProfileCatalogItem[]
  imageInterpreter?: () => Promise<ChatImageInterpreter | null>
  describeImage?: (args: {
    interpreter: ChatImageInterpreter
    image: MaestroConfiguratorImageInput
    signal: AbortSignal
  }) => Promise<string>
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
  private readonly liveDraft: () => MaestroSettingsDraftSession | null
  private readonly strategyProfiles: () => MaestroStrategyProfileCatalogItem[]
  private readonly imageInterpreter: () => Promise<ChatImageInterpreter | null>
  private readonly describeImage: NonNullable<MaestroConfiguratorServiceDependencies['describeImage']>

  constructor(dependencies: MaestroConfiguratorServiceDependencies = {}) {
    this.execute = dependencies.execute ?? executeSubagent
    this.resolveProfile = dependencies.resolveProfile ?? resolveParentSubagentExecutionProfile
    this.readCatalog = dependencies.catalog ?? (() => buildMaestroConfiguratorCatalog())
    this.cwd = dependencies.cwd ?? (() => process.cwd())
    this.now = dependencies.now ?? Date.now
    this.id = dependencies.id ?? randomUUID
    this.liveDraft = dependencies.liveDraft ?? getMaestroSettingsDraft
    this.strategyProfiles = dependencies.strategyProfiles ?? (() => listMaestroStrategyProfiles(null).items)
    // Loaded on first use: the interpreter pulls in every provider runtime, which a text-only thread never needs.
    this.imageInterpreter =
      dependencies.imageInterpreter ?? (async () => (await import('./image-interpreter')).getImageInterpreter())
    this.describeImage =
      dependencies.describeImage ??
      (async ({ interpreter, image, signal }) =>
        (await import('./image-interpreter')).describeStandaloneImage({
          interpreter,
          image,
          surfaceId: SURFACE_ID,
          cwd: this.cwd(),
          signal,
        }))
  }

  /**
   * Models that read the attached images: the assistant's own model unless its catalog says it has no vision, then
   * the image interpreter configured in Settings.
   */
  private async imageReaders(
    profile: MaestroConfiguratorProfile,
    catalog: MaestroConfiguratorCatalog
  ): Promise<ChatImageInterpreter[]> {
    const readers: ChatImageInterpreter[] = []
    if (catalogModel(catalog, profile.providerId, profile.modelId)?.vision !== false) {
      readers.push({
        providerId: profile.providerId,
        modelId: profile.modelId,
        ...(profile.effort !== 'off' ? { effort: profile.effort } : {}),
      })
    }
    const configured = await this.imageInterpreter().catch(() => null)
    if (configured && !readers.some((reader) => sameInterpreter(reader, configured))) readers.push(configured)
    return readers
  }

  private readerLabel(reader: ChatImageInterpreter, catalog: MaestroConfiguratorCatalog): string {
    const provider = catalog.providers.find((entry) => entry.id === reader.providerId)?.name ?? reader.providerId
    return `${provider} / ${reader.modelId}`
  }

  private async transcribe(
    image: MaestroConfiguratorImageInput,
    readers: ChatImageInterpreter[],
    catalog: MaestroConfiguratorCatalog,
    signal: AbortSignal
  ): Promise<{ text: string; model: string }> {
    for (const reader of readers) {
      try {
        const text = (await this.describeImage({ interpreter: reader, image, signal })).trim()
        if (text) return { text: text.slice(0, MAX_IMAGE_DESCRIPTION_CHARS), model: this.readerLabel(reader, catalog) }
      } catch (error) {
        if (signal.aborted) throw error
      }
    }
    throw new Error('maestro-configurator-image-failed')
  }

  /** What the editor shows right now; falls back to the draft sent with the message when it reported nothing valid. */
  private readLiveDraft(fallback: MaestroConfiguratorPreparedDraft): LiveDraft {
    const session = this.liveDraft()
    if (!session) return { prepared: fallback, editing: null }
    const parsed = prepareMaestroConfiguratorDraft(session.draft)
    const prepared = parsed.ok ? parsed.value : fallback
    const item = this.strategyProfiles().find((entry) => entry.id === session.profileId)
    const changes = item ? diffMaestroConfigs(item.config, prepared.config) : []
    return {
      prepared,
      editing: {
        profileId: session.profileId,
        name: item?.name ?? session.profileName,
        source: item?.source ?? 'global',
        readOnly: item?.source === 'builtin',
        unsavedChanges: changes.length,
        unsavedChangeList: changes.slice(0, MAX_REPORTED_CHANGES),
      },
      ...(parsed.ok ? {} : { issues: parsed.errors.map((item) => item.message) }),
    }
  }

  /** Records an editor action in the thread so the next turn knows it. Nothing is recorded in an empty thread. */
  recordEvent(value: unknown): MaestroConfiguratorMessage | null {
    const event = sanitizeMaestroConfiguratorEvent(value)
    if (!event) return null
    const messages = getMaestroConfiguratorThread().messages
    if (!messages.some((message) => message.role !== 'event')) return null
    if (
      (event.kind === 'proposal-applied' || event.kind === 'proposal-dismissed') &&
      !messages.some((message) => message.proposal?.id === event.proposalId)
    ) {
      return null
    }
    const last = messages.at(-1)
    if (last?.role === 'event' && JSON.stringify(last.event) === JSON.stringify(event)) return null
    const message: MaestroConfiguratorMessage = {
      id: this.id(),
      role: 'event',
      text: maestroConfiguratorEventText(event),
      createdAt: this.now(),
      event,
    }
    appendMaestroConfiguratorMessage(message)
    return message
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
    const images = parseImages(raw?.images)
    if (!images.ok) return { ok: false, error: images.error }
    if (!text && images.value.length === 0) return { ok: false, error: 'maestro-configurator-empty-message' }
    const prepared = prepareMaestroConfiguratorDraft(raw?.draft)
    if (!prepared.ok) return { ok: false, error: prepared.errors.map((item) => item.message).join(' ') }
    if (raw.baseHash !== prepared.value.baseHash) return { ok: false, error: 'maestro-configurator-stale-draft' }
    const catalog = await this.readCatalog()
    const profile = getStoredMaestroConfiguratorProfile() ?? defaultProfile(catalog)
    if (!profile) return { ok: false, error: 'maestro-configurator-no-model' }
    const profileErrors = validateMaestroConfiguratorProfile(profile, catalog)
    if (profileErrors.length) return { ok: false, error: profileErrors.join(' ') }
    const readers = images.value.length ? await this.imageReaders(profile, catalog) : []
    if (images.value.length && readers.length === 0) return { ok: false, error: 'maestro-configurator-no-vision' }

    const turnId = this.id()
    const userMessage: MaestroConfiguratorMessage = {
      id: this.id(),
      role: 'user',
      text,
      createdAt: this.now(),
      ...(images.value.length
        ? {
            images: images.value.map((image) => ({
              name: image.name,
              mediaType: image.mediaType,
              byteSize: image.bytes.byteLength,
            })),
          }
        : {}),
    }
    const previousMessages = getMaestroConfiguratorThread().messages
    appendMaestroConfiguratorMessage(userMessage)
    const active: ActiveTurn = { id: turnId, generation: ++this.generation, controller: new AbortController() }
    this.active = active
    active.done = this.runTurn({
      active,
      profile,
      catalog,
      prepared: prepared.value,
      text,
      userMessage,
      images: images.value,
      readers,
      previousMessages,
      emit,
    })
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
    prepared: MaestroConfiguratorPreparedDraft
    text: string
    userMessage: MaestroConfiguratorMessage
    images: MaestroConfiguratorImageInput[]
    readers: ChatImageInterpreter[]
    previousMessages: MaestroConfiguratorMessage[]
    emit: (event: MaestroConfiguratorEvent) => void
  }): Promise<void> {
    const { active, emit } = args
    let proposal: MaestroConfiguratorProposal | undefined
    let streamedText = ''
    let imageRefs: MaestroConfiguratorImageRef[] = []
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
        description:
          'Returns the Maestro draft as the editor shows it right now, its base hash, which strategy is open, its unsaved changes and the candidate rows still being filled in.',
        metadata: { readOnly: true },
        inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
        execute: async () => {
          const live = this.readLiveDraft(args.prepared)
          return {
            baseHash: live.prepared.baseHash,
            config: live.prepared.config,
            editing: live.editing
              ? {
                  strategyId: live.editing.profileId,
                  strategyName: live.editing.name,
                  kind: live.editing.source,
                  readOnly: live.editing.readOnly,
                  unsavedChanges: live.editing.unsavedChanges,
                  unsavedChangeList: live.editing.unsavedChangeList,
                }
              : 'unknown: the editor did not report its state; config is the draft sent with the message',
            unfinishedCandidateRows: live.prepared.skippedCandidates,
            ...(live.issues
              ? {
                  editorIssues: live.issues,
                  note: 'The editor currently holds an invalid draft; config is the last valid one.',
                }
              : {}),
          }
        },
      }),
      propose_maestro_config: tool({
        description:
          'Submits a COMPLETE replacement for the Maestro draft open in the editor. This only creates a reviewable proposal; it never saves settings.',
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
          // Diff against the editor's current draft, which may have moved since the message was sent.
          const live = this.readLiveDraft(args.prepared)
          const changes = diffMaestroConfigs(live.prepared.config, parsed.value.config)
          if (changes.length === 0) return { ok: false, errors: ['The proposal does not change the current draft.'] }
          proposal = {
            id: this.id(),
            baseHash: live.prepared.baseHash,
            summary,
            config: parsed.value.config,
            changes,
            diagnostics,
            createdAt: this.now(),
          }
          const notes = [
            ...(live.editing?.readOnly
              ? [
                  `“${live.editing.name}” is a read-only built-in strategy: the user must open the Global default or a custom strategy before applying.`,
                ]
              : []),
            ...(live.prepared.skippedCandidates.length
              ? [
                  `Applying replaces the draft and drops ${live.prepared.skippedCandidates.length} unfinished candidate row(s).`,
                ]
              : []),
          ]
          return {
            ok: true,
            proposalId: proposal.id,
            changes: changes.length,
            diagnostics,
            ...(notes.length ? { notes } : {}),
          }
        },
      }),
    }

    try {
      if (args.images.length) {
        const transcribed: MaestroConfiguratorImageRef[] = []
        for (const [index, image] of args.images.entries()) {
          safeEmit({
            kind: 'progress',
            turnId: active.id,
            message: tMain('main')('maestroConfigurator.readingImage', {
              index: index + 1,
              count: args.images.length,
            }),
          })
          const result = await this.transcribe(image, args.readers, args.catalog, active.controller.signal)
          transcribed.push({
            name: image.name,
            mediaType: image.mediaType,
            byteSize: image.bytes.byteLength,
            description: result.text,
            descriptionModel: result.model,
          })
        }
        if (!this.isCurrent(active)) return
        imageRefs = transcribed
        const updated: MaestroConfiguratorMessage = { ...args.userMessage, images: transcribed }
        updateMaestroConfiguratorMessage(updated)
        safeEmit({ kind: 'message', message: updated })
      }
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
        task: transcriptFor(args.previousMessages, args.text, imageRefs),
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
