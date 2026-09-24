import {
  MAESTRLY_ULTRA_EFFORT,
  isMaestrlyUltraEffort,
  resolveFrozenSentEffort,
} from '../shared/chat'
import type {
  ConversationDispatchModelOption,
  ConversationDispatchSettings,
  ConversationDispatchSettingsRequest,
} from '../shared/conversation-dispatch'

/** Capability snapshot as produced by the chat service (see describeChatModelForDispatch). */
export interface DispatchModelCapability {
  available: boolean
  reasoning: boolean
  reasoningEfforts: string[]
  nativeUltraMode: boolean
  fastMode: boolean
}

export interface ConversationDispatchSettingsDeps {
  /** Settings the source conversation would use for its next turn; null when unconfigured. */
  sourceSettings(conversationId: string): ConversationDispatchSettings | null
  /** Catalog of executable provider/model pairs, used to resolve a model named without its provider. */
  listModels(): Promise<ConversationDispatchModelOption[]>
  describeModel(providerId: string, modelId: string): Promise<DispatchModelCapability>
  /** Fail-closed admission check (authentication, account identity, sent effort) for the final selection. */
  validateSelection(
    sourceConversationId: string,
    settings: ConversationDispatchSettings
  ): Promise<{ ok: true } | { ok: false; error: string }>
}

export type ConversationDispatchSettingsError =
  | 'no-source-model'
  | 'model-required'
  | 'model-unavailable'
  | 'model-ambiguous'
  | 'reasoning-unsupported'
  | 'fast-mode-unsupported'
  | 'provider-unavailable'

export type ResolvedConversationDispatchSettings =
  | { ok: true; settings: ConversationDispatchSettings; inherited: string[] }
  | { ok: false; error: ConversationDispatchSettingsError; message: string }

const DEFAULT_EFFORT_ALIASES = new Set(['off', 'default', 'padrao', 'padrão', 'auto', 'normal'])

function normalizeEffort(value: string): string {
  const effort = value.trim().toLowerCase()
  if (DEFAULT_EFFORT_ALIASES.has(effort)) return 'off'
  if (effort === 'extra-high' || effort === 'extra high' || effort === 'x-high') return 'xhigh'
  return effort
}

/**
 * The value to persist for `effort` on this model, or null when unsupported. Ultra maps to the native level when
 * the model has one, otherwise to Maestrly Ultra over the advertised levels. Without advertised levels nothing
 * but the provider default is proven to work.
 */
function supportedEffort(effort: string, capability: DispatchModelCapability): string | null {
  if (effort === 'off') return 'off'
  if (!capability.reasoning || capability.reasoningEfforts.length === 0) return null
  const efforts = capability.reasoningEfforts
  if (effort === 'ultra' && efforts.includes('ultra')) return 'ultra'
  if (isMaestrlyUltraEffort(effort, efforts)) {
    // Maestrly Ultra resolves to the strongest advertised level; confirm it resolves at all.
    return resolveFrozenSentEffort({ reasoning: MAESTRLY_ULTRA_EFFORT, supportedEfforts: efforts }) !== null
      ? MAESTRLY_ULTRA_EFFORT
      : null
  }
  return efforts.includes(effort) ? effort : null
}

function describeEfforts(capability: DispatchModelCapability): string {
  return capability.reasoning && capability.reasoningEfforts.length
    ? `off, ${capability.reasoningEfforts.join(', ')}`
    : 'off (provider default only)'
}

/**
 * Resolve requested settings against the live catalog. Explicitly requested values must be supported exactly —
 * never silently replaced or downgraded. Omitted values inherit the source conversation's settings when they are
 * compatible with the chosen model, and otherwise fall back to provider defaults; both cases are reported.
 */
export async function resolveConversationDispatchSettings(
  sourceConversationId: string,
  requested: ConversationDispatchSettingsRequest,
  deps: ConversationDispatchSettingsDeps
): Promise<ResolvedConversationDispatchSettings> {
  const source = deps.sourceSettings(sourceConversationId)
  const inherited: string[] = []
  let providerId = requested.providerId?.trim()
  let modelId = requested.modelId?.trim()

  if (!modelId) {
    if (providerId && source?.providerId !== providerId) {
      return {
        ok: false,
        error: 'model-required',
        message: `Choose a model for provider "${providerId}"; it differs from the current conversation's provider.`,
      }
    }
    if (!source) {
      return {
        ok: false,
        error: 'no-source-model',
        message: 'The current conversation has no model selected. Specify providerId and modelId explicitly.',
      }
    }
    providerId = source.providerId
    modelId = source.modelId
    inherited.push('model')
  } else if (!providerId) {
    const catalog = await deps.listModels()
    const matches = catalog.filter((entry) => entry.modelId === modelId)
    const loose = matches.length
      ? matches
      : catalog.filter((entry) => entry.modelId.toLowerCase() === modelId!.toLowerCase())
    if (loose.length === 0) {
      return {
        ok: false,
        error: 'model-unavailable',
        message: `Model "${modelId}" is not available from any connected provider. Call list_conversation_models.`,
      }
    }
    if (loose.length > 1) {
      return {
        ok: false,
        error: 'model-ambiguous',
        message:
          `Model "${modelId}" is offered by several providers/accounts (` +
          loose.map((entry) => `${entry.providerLabel} = ${entry.providerId}`).join('; ') +
          '). Ask the person which one to use and pass providerId.',
      }
    }
    providerId = loose[0].providerId
    modelId = loose[0].modelId
  }

  const capability = await deps.describeModel(providerId!, modelId!)
  if (!capability.available) {
    return {
      ok: false,
      error: 'model-unavailable',
      message: `Model "${modelId}" is not available for provider "${providerId}" (not listed or not signed in).`,
    }
  }

  let reasoning: string
  if (requested.reasoning !== undefined) {
    const value = supportedEffort(normalizeEffort(requested.reasoning), capability)
    if (value === null) {
      return {
        ok: false,
        error: 'reasoning-unsupported',
        message: `Effort "${requested.reasoning}" is not supported by ${modelId}. Supported: ${describeEfforts(capability)}.`,
      }
    }
    reasoning = value
  } else {
    const inheritedEffort = source ? supportedEffort(normalizeEffort(source.reasoning), capability) : 'off'
    reasoning = inheritedEffort ?? 'off'
    inherited.push(inheritedEffort === null ? `reasoning (reset to default: "${source?.reasoning}" is unsupported)` : 'reasoning')
  }

  let fastMode: boolean
  if (requested.fastMode !== undefined) {
    if (requested.fastMode && !capability.fastMode) {
      return {
        ok: false,
        error: 'fast-mode-unsupported',
        message: `Fast mode is not available for ${modelId}. Leave it off or choose a model that supports it.`,
      }
    }
    fastMode = requested.fastMode
  } else {
    fastMode = source?.fastMode === true && capability.fastMode
    inherited.push(source?.fastMode === true && !capability.fastMode ? 'fastMode (off: unsupported by this model)' : 'fastMode')
  }

  const settings: ConversationDispatchSettings = { providerId: providerId!, modelId: modelId!, reasoning, fastMode }
  const validated = await deps.validateSelection(sourceConversationId, settings)
  if (!validated.ok) {
    return validated.error === 'no-key' || validated.error === 'no-provider'
      ? {
          ok: false,
          error: 'provider-unavailable',
          message: `Provider "${providerId}" is not signed in or has no credentials.`,
        }
      : {
          ok: false,
          error: reasoning !== 'off' ? 'reasoning-unsupported' : 'model-unavailable',
          message:
            reasoning !== 'off'
              ? `The ${modelId} runtime did not confirm effort "${reasoning}". Supported: ${describeEfforts(capability)}.`
              : `Model "${modelId}" could not be validated for provider "${providerId}" (${validated.error}).`,
        }
  }
  return { ok: true, settings, inherited }
}

/** Whether a destination's persisted settings match the validated selection exactly. */
export function sameDispatchSettings(
  left: ConversationDispatchSettings | null,
  right: ConversationDispatchSettings
): boolean {
  return (
    !!left &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    (left.reasoning || 'off') === (right.reasoning || 'off') &&
    left.fastMode === right.fastMode
  )
}
