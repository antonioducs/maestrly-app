import {
  FLEET_TASK_COMPLEXITY_TIER,
  fleetDelegationTierFor,
  type FleetBotDelegation,
  type FleetDelegationModel,
  type FleetSelectionOption,
} from '@maestrly/bot-fleet-protocol'
import { subscriptionBaseProviderId } from '../../../shared/chat'
import { TASK_COMPLEXITIES, type SubagentModelTier, type TaskComplexity } from '../../../shared/subagent-profiles'
import type { SubagentRoute, SubagentRouter } from '../../chat/subagent-route'

export interface DelegationRouterDeps {
  settings(): FleetBotDelegation
  /** The bot's visible selection options: one per connected account and model. */
  options(): readonly FleetSelectionOption[]
  /** Share of an account's usage window still free, 0..1; null when unknown. */
  headroom(providerId: string): number | null
  admissible(providerId: string): boolean
  /** Starts a background read of accounts whose usage is unknown, for the next task. */
  warm?(providerIds: readonly string[]): void
}

/** The efforts each class of model runs at, by preference, among those the model accepts. */
const EFFORTS: Record<SubagentModelTier, string[]> = {
  fast: ['low', 'minimal', 'medium'],
  balanced: ['medium', 'high', 'low'],
  strong: ['high', 'xhigh', 'max', 'medium'],
}

export function effortForTier(tier: SubagentModelTier, efforts: readonly string[]): string {
  if (!efforts.length) return 'off'
  return EFFORTS[tier].find((effort) => efforts.includes(effort)) ?? efforts[Math.floor(efforts.length / 2)]!
}

const offers = (model: FleetDelegationModel) => (option: FleetSelectionOption) =>
  subscriptionBaseProviderId(option.providerId) === model.providerId && option.modelId === model.modelId

/** The allowed models that at least one connected account offers now. */
function available(deps: Pick<DelegationRouterDeps, 'settings' | 'options'>): FleetDelegationModel[] {
  const options = deps.options()
  return deps.settings().models.filter((model) => options.some(offers(model)))
}

/**
 * Where a delegated task runs: the allowed models of the class its difficulty asks for (else the next stronger class),
 * on every account that offers them and may take a turn now, the roomiest first when the owner spreads the work.
 * Without a class that fits, it has no candidates and the conversation's model runs it.
 */
export function routeDelegatedTask(complexity: TaskComplexity | null, deps: DelegationRouterDeps): SubagentRoute {
  const settings = deps.settings()
  const wanted = complexity ?? 'medium'
  const models = available(deps)
  const fit = fleetDelegationTierFor(models, wanted)
  const info = {
    complexity: wanted,
    declared: complexity !== null,
    tier: fit?.tier ?? null,
    upgraded: fit?.upgraded ?? false,
  }
  if (!fit) return { info, candidates: [] }
  const pairs = models
    .filter((model) => model.tier === fit.tier)
    .flatMap((model, order) =>
      deps
        .options()
        .filter(offers(model))
        .filter((option) => deps.admissible(option.providerId))
        .map((option) => ({ option, order, headroom: deps.headroom(option.providerId) }))
    )
  deps.warm?.(pairs.filter((pair) => pair.headroom === null).map((pair) => pair.option.providerId))
  const ranked = settings.spreadAccounts
    ? [...pairs].sort((a, b) => (b.headroom ?? 0.5) - (a.headroom ?? 0.5) || a.order - b.order)
    : pairs
  return {
    info,
    candidates: ranked.map(({ option }) => ({
      providerId: option.providerId,
      modelId: option.modelId,
      effort: effortForTier(fit.tier, option.efforts),
    })),
  }
}

export function createDelegationRouter(deps: DelegationRouterDeps): SubagentRouter {
  return ({ complexity }) => routeDelegatedTask(complexity, deps)
}

const DIFFICULTY: Record<TaskComplexity, string> = {
  simple: 'simple (mechanical or high-volume work: download, rename, convert, transcribe, extract)',
  medium: 'medium (routine writing, editing or code)',
  complex: 'complex (unknown causes, design decisions, subtle correctness)',
}

/** What a delegating bot is told: delegate long work, size every task, and which allowed model serves each size. */
export function delegationPolicyPrompt(deps: Pick<DelegationRouterDeps, 'settings' | 'options'>): string {
  const settings = deps.settings()
  const options = deps.options()
  const models = available(deps)
  const lines = TASK_COMPLEXITIES.map((complexity) => {
    const fit = fleetDelegationTierFor(models, complexity)
    if (!fit) return `- ${DIFFICULTY[complexity]}: no allowed model; do this work yourself instead of calling task`
    const labels = [
      ...new Set(
        models
          .filter((model) => model.tier === fit.tier)
          .map((model) => options.find(offers(model))?.modelLabel ?? model.modelId)
      ),
    ]
    const upgraded = fit.upgraded ? ` (no ${FLEET_TASK_COMPLEXITY_TIER[complexity]} model allowed)` : ''
    return `- ${DIFFICULTY[complexity]}: ${labels.join(' or ')}${upgraded}`
  })
  const retry = settings.retryStronger
    ? 'When a task fails or its report says it is unsure, run it once more with the next complexity, passing what the first attempt reported; then tell your owner what happened.'
    : 'When a task fails or its report says it is unsure, do not run it again: tell your owner.'
  return [
    '# Tasks: delegate',
    `Your owner set you to delegate. Hand every self-contained piece of work that takes more than a few tool calls to task, and keep for yourself only short answers, the conversation with your owner, decisions that need this conversation, and the final summary. Call task for independent pieces in the same response so they run at the same time; at most ${settings.maxTasks} run at once and the others wait. Tasks running at the same time share your desktop and browser: let at most one of them use computer_* or browser_* tools.`,
    'Every task call sets complexity, and Maestrly runs it on a model your owner allowed for that difficulty:',
    ...lines,
    'Write each task prompt self-contained, and ask for a short report: what was done, the paths of the files it wrote, and anything it is unsure of. Large results go to files, not into the report.',
    retry,
  ].join('\n')
}
