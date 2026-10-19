import {
  FLEET_TASK_COMPLEXITIES,
  FLEET_TASK_COMPLEXITY_TIER,
  fleetDelegationTierFor,
  type FleetBotDelegation,
  type FleetDelegationModel,
  type FleetDelegationTier,
  type FleetSelectionOption,
  type FleetTaskComplexity,
} from '@maestrly/bot-fleet-protocol'
import { subscriptionBaseProviderId } from '../../../shared/chat'

/** What a model is likely for, from its name; the owner can change it. */
export function suggestedDelegationTier(modelId: string): FleetDelegationTier {
  // `mini` and the like only as their own word: `gemini` is not a small model.
  if (/haiku|flash|(?:^|[^a-z])(?:mini|nano|lite|small)(?![a-z])/i.test(modelId)) return 'fast'
  if (/(opus|fable|astra|ultra|\bpro\b|\bmax\b)/i.test(modelId)) return 'strong'
  return 'balanced'
}

export interface DelegationModelGroup {
  /** The provider without an account: every account of it offers the group's models. */
  providerId: string
  /** The accounts of the provider, as the settings name them. */
  accounts: string[]
  models: Array<{ modelId: string; label: string }>
}

/** The models the owner can allow, once per provider whatever its number of accounts. */
export function delegationModelGroups(options: readonly FleetSelectionOption[]): DelegationModelGroup[] {
  const groups = new Map<string, DelegationModelGroup>()
  for (const option of options) {
    const providerId = subscriptionBaseProviderId(option.providerId)
    let group = groups.get(providerId)
    if (!group) {
      group = { providerId, accounts: [], models: [] }
      groups.set(providerId, group)
    }
    if (!group.accounts.includes(option.providerLabel)) group.accounts.push(option.providerLabel)
    if (!group.models.some((model) => model.modelId === option.modelId))
      group.models.push({ modelId: option.modelId, label: option.modelLabel })
  }
  return [...groups.values()]
}

/** Allows a model for a class of tasks, changes its class, or (with null) stops allowing it. */
export function setDelegationModel(
  delegation: FleetBotDelegation,
  providerId: string,
  modelId: string,
  tier: FleetDelegationTier | null
): FleetBotDelegation {
  const same = (model: FleetDelegationModel) => model.providerId === providerId && model.modelId === modelId
  if (tier === null) return { ...delegation, models: delegation.models.filter((model) => !same(model)) }
  const models = delegation.models.some(same)
    ? delegation.models.map((model) => (same(model) ? { ...model, tier } : model))
    : [...delegation.models, { providerId, modelId, tier }]
  return { ...delegation, models }
}

export interface DelegationPreviewRow {
  complexity: FleetTaskComplexity
  /** The models a task of this difficulty runs on; empty when none fits and the bot does it itself. */
  models: string[]
  /** The class the difficulty asked for when no allowed model of it existed and a stronger one runs it. */
  upgradedFrom: FleetDelegationTier | null
}

/** Where a task of each difficulty would go with these settings and the models connected now. */
export function delegationPreview(
  delegation: FleetBotDelegation,
  options: readonly FleetSelectionOption[]
): DelegationPreviewRow[] {
  const offered = (model: FleetDelegationModel) =>
    options.find(
      (option) => subscriptionBaseProviderId(option.providerId) === model.providerId && option.modelId === model.modelId
    )
  const available = delegation.models.filter((model) => offered(model))
  return FLEET_TASK_COMPLEXITIES.map((complexity) => {
    const fit = fleetDelegationTierFor(available, complexity)
    if (!fit) return { complexity, models: [], upgradedFrom: null }
    const models = [
      ...new Set(
        available.filter((model) => model.tier === fit.tier).map((model) => offered(model)?.modelLabel ?? model.modelId)
      ),
    ]
    return { complexity, models, upgradedFrom: fit.upgraded ? FLEET_TASK_COMPLEXITY_TIER[complexity] : null }
  })
}
