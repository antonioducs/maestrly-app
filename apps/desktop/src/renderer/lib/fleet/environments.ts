import {
  FLEET_ENVIRONMENTS_FEATURE,
  type FleetArchivedBot,
  type FleetBot,
  type FleetEnvironment,
  type FleetHostInfo,
  type FleetOwnerMemoryEntry,
} from '@maestrly/bot-fleet-protocol'
import type { FleetProvisioningTargetInput } from '../../../shared/fleet-targets'
import { compareByName, groupBotsByEnvironment, type FleetEnvironmentGroup } from './selectors'
import type { FleetController } from './use-fleet'

/** Whether the connected gateway groups bots in environments; without it the Mac keeps the UI from before them. */
export function hasEnvironments(connection: { features: string[] }): boolean {
  return connection.features.includes(FLEET_ENVIRONMENTS_FEATURE)
}

export function botMatchesQuery(bot: Pick<FleetBot, 'name' | 'role'>, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || bot.name.toLowerCase().includes(q) || bot.role.toLowerCase().includes(q)
}

/**
 * The sidebar search: an environment whose name matches keeps all its bots, the others keep their matching bots.
 * `resultCount` counts the bots shown, plus a matching environment without bots, so the "other tabs" hint stays off.
 */
export function filterEnvironmentGroups(
  groups: FleetEnvironmentGroup[],
  ungrouped: FleetBot[],
  query: string
): { groups: FleetEnvironmentGroup[]; ungrouped: FleetBot[]; resultCount: number } {
  const q = query.trim().toLowerCase()
  const kept = groups.flatMap((group) => {
    if (!q || group.environment.name.toLowerCase().includes(q)) return [group]
    const matching = group.bots.filter((bot) => botMatchesQuery(bot, q))
    return matching.length ? [{ environment: group.environment, bots: matching }] : []
  })
  const loose = ungrouped.filter((bot) => botMatchesQuery(bot, q))
  const resultCount = kept.reduce((sum, group) => sum + Math.max(1, group.bots.length), 0) + loose.length
  return { groups: kept, ungrouped: loose, resultCount }
}

/** How many results the Bots tab shows for a search, so the sidebar can point to other tabs when there are none. */
export function fleetSearchCount(
  connection: { features: string[] },
  snapshot: { bots: FleetBot[]; environments: FleetEnvironment[] },
  query: string
): number {
  if (!hasEnvironments(connection)) return snapshot.bots.filter((bot) => botMatchesQuery(bot, query)).length
  const { groups, ungrouped } = groupBotsByEnvironment(snapshot.environments, snapshot.bots)
  return filterEnvironmentGroups(groups, ungrouped, query).resultCount
}

export type EnvironmentDot = 'ready' | 'busy' | 'stopped' | 'failed'
/** The status dot of an environment header. */
export function environmentDot(environment: Pick<FleetEnvironment, 'lifecycle' | 'setup'>): EnvironmentDot {
  if (environment.lifecycle === 'failed' || environment.setup.step === 'failed') return 'failed'
  if (environment.lifecycle === 'running') return 'ready'
  if (environment.lifecycle === 'stopped' || environment.lifecycle === 'archived') return 'stopped'
  return 'busy'
}

/** The name of a new environment follows the bot's name until the owner types one. */
export type EnvironmentNameField = { value: string; edited: boolean }
export const emptyEnvironmentName: EnvironmentNameField = { value: '', edited: false }
export function followBotName(field: EnvironmentNameField, botName: string): EnvironmentNameField {
  return field.edited ? field : { value: botName, edited: false }
}
/** An emptied field follows the bot's name again. */
export function editEnvironmentName(value: string): EnvironmentNameField {
  return { value, edited: value !== '' }
}
export function environmentNameFor(field: EnvironmentNameField, botName: string): string {
  return field.value.trim() || botName.trim()
}

export type BotPlacement = { kind: 'new'; name: string } | { kind: 'existing'; environmentId: string | null }
/**
 * The placement fields of a create request. A gateway without environments gets none, exactly as before them; an
 * incomplete choice (no environment picked, no name) is null.
 */
export function placementRequest(
  placement: BotPlacement,
  enabled: boolean
): { environment?: { name: string }; environmentId?: string } | null {
  if (!enabled) return {}
  if (placement.kind === 'existing') return placement.environmentId ? { environmentId: placement.environmentId } : null
  const name = placement.name.trim()
  return name ? { environment: { name } } : null
}

const newEnvironmentSteps = ['container', 'desktop', 'profile', 'ready'] as const
const joinSteps = ['profile', 'ready'] as const
/** A bot joining an existing environment has no container to create: it only sets up its profile. */
export function creationSteps(joining: boolean): readonly FleetBot['setup']['step'][] {
  return joining ? joinSteps : newEnvironmentSteps
}
export function creationStepReached(
  steps: readonly string[],
  current: FleetBot['setup']['step'] | undefined,
  index: number
): boolean {
  return current !== undefined && steps.indexOf(current) >= index
}

const GB = 1024 ** 3
export const MEMORY_LIMIT_CHOICES_GB = [2, 4, 8, 12, 16] as const
export type MemoryLimitChoice = { value: string; bytes: number | null; gb: number | null }
export function memoryLimitValue(bytes: number | null): string {
  return bytes === null ? 'default' : String(bytes)
}
export function memoryLimitFromValue(value: string): number | null {
  return value === 'default' ? null : Number(value)
}
/** The gateway's default, whole limits, and a limit set elsewhere (another Mac, the API) so it stays visible. */
export function memoryLimitChoices(current: number | null): MemoryLimitChoice[] {
  const bytes: number[] = MEMORY_LIMIT_CHOICES_GB.map((gb) => gb * GB)
  if (current !== null && !bytes.includes(current)) bytes.push(current)
  return [
    { value: 'default', bytes: null, gb: null },
    ...bytes
      .sort((a, b) => a - b)
      .map((value) => ({ value: memoryLimitValue(value), bytes: value, gb: Math.round((value / GB) * 10) / 10 })),
  ]
}

export type OwnerMemoryScope = { kind: 'global' } | { kind: 'environment'; id: string; name: string | null }
/** Who reads an owner memory entry: every bot, or the bots of one environment (named when it is still listed). */
export function ownerMemoryScope(
  entry: Pick<FleetOwnerMemoryEntry, 'environmentId'>,
  environments: Pick<FleetEnvironment, 'id' | 'name'>[]
): OwnerMemoryScope {
  if (!entry.environmentId) return { kind: 'global' }
  const environment = environments.find((item) => item.id === entry.environmentId)
  return { kind: 'environment', id: entry.environmentId, name: environment?.name ?? null }
}

/** Starting, stopping or restarting a bot of an environment acts on its environment, shared with its other bots. */
export function lifecycleTarget(
  bot: Pick<FleetBot, 'id' | 'environmentId'>,
  enabled: boolean
): { environmentId: string } | { botId: string } {
  return enabled && bot.environmentId ? { environmentId: bot.environmentId } : { botId: bot.id }
}

/** Starts an offline bot: through its environment when bots share one, since the gateway refuses a shared bot. */
export function startBot(
  fleet: Pick<FleetController, 'state' | 'botAction' | 'environmentAction'>,
  bot: Pick<FleetBot, 'id' | 'environmentId'>
): Promise<void> {
  const target = lifecycleTarget(bot, hasEnvironments(fleet.state.connection))
  return 'environmentId' in target
    ? fleet.environmentAction(target.environmentId, 'start')
    : fleet.botAction(target.botId, 'start')
}

export function environmentBots(environment: Pick<FleetEnvironment, 'id'>, bots: FleetBot[]): FleetBot[] {
  return bots.filter((bot) => bot.environmentId === environment.id).sort(compareByName)
}

export function formatNames(names: string[], language: string): string {
  return names.length ? new Intl.ListFormat(language, { type: 'conjunction' }).format(names) : ''
}

/** The server offers a newer image than the environment runs: restarting it updates every bot in it. */
export function environmentUpdateAvailable(
  environment: Pick<FleetEnvironment, 'appVersion'>,
  host: Pick<FleetHostInfo, 'botImageVersion'> | null
): boolean {
  return Boolean(host?.botImageVersion && environment.appVersion && environment.appVersion !== host.botImageVersion)
}

export function isEnvironmentTarget(target: FleetProvisioningTargetInput): target is { environmentId: string } {
  return typeof target === 'object' && 'environmentId' in target
}

/**
 * What deleting an archived bot forever removes. In an environment whose Maestrly hosts several bots, only the bot's
 * conversation, memory and folders go; its environment keeps its accounts and files. Before environments, or on an
 * environment still on an image from before them, the bot goes with the files it had alone, as with its own container.
 */
export function archivedBotPurge(
  bot: Pick<FleetArchivedBot, 'environmentId'>,
  environments: Pick<FleetEnvironment, 'id' | 'capabilities'>[],
  enabled: boolean
): 'bot' | 'files' {
  const environment = enabled && bot.environmentId ? environments.find((item) => item.id === bot.environmentId) : null
  return environment?.capabilities.includes(FLEET_ENVIRONMENTS_FEATURE) ? 'bot' : 'files'
}

/** Where to finish bringing accounts from the Mac later: the environment that shares them, or the bot's settings. */
export function finishLaterKey(target: FleetProvisioningTargetInput): string {
  return isEnvironmentTarget(target) ? 'provisioning.finishLaterEnvironment' : 'provisioning.finishLater'
}

/** Who a provisioning view acts on: its target (an environment, or a bot before environments) and its name. */
export type ProvisioningSubject = { target: FleetProvisioningTargetInput; name: string; running: boolean }

/** A target as primitives, so effects keyed on it survive renders that rebuild the target object. */
export function targetParts(target: FleetProvisioningTargetInput): { scope: 'environment' | 'bot'; id: string } {
  if (typeof target === 'string') return { scope: 'bot', id: target }
  return 'environmentId' in target
    ? { scope: 'environment', id: target.environmentId }
    : { scope: 'bot', id: target.botId }
}
/** A bot goes as its bare id, exactly as the views from before environments sent it. */
export function targetFromParts(scope: 'environment' | 'bot', id: string): FleetProvisioningTargetInput {
  return scope === 'environment' ? { environmentId: id } : id
}

export function provisioningHintKey(availability: 'update-server' | 'restart-bot' | 'restart-environment'): string {
  if (availability === 'update-server') return 'provisioning.updateServer'
  return availability === 'restart-environment' ? 'provisioning.restartEnvironment' : 'provisioning.restartBot'
}

/**
 * Reports whether a watched key changed since the last call; the first key never counts, so a view refreshes on
 * real changes only, not on mount nor when Strict Mode runs its effects twice.
 */
export function createKeyWatcher(initial: string): (key: string) => boolean {
  let last = initial
  return (key) => {
    if (key === last) return false
    last = key
    return true
  }
}
