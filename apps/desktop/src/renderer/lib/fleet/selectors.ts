import type { FleetBot, FleetEnvironment, FleetTakeoverState } from '@maestrly/bot-fleet-protocol'

export function ownsTakeover(takeover: FleetTakeoverState, deviceId: string | null): boolean {
  return takeover.state === 'human' && deviceId !== null && takeover.deviceId === deviceId
}

export function takeoverBlocksResume(takeover: FleetTakeoverState): boolean {
  return takeover.state !== 'none'
}

export function botsWithDifferentVersion(bots: FleetBot[], macVersion: string): FleetBot[] {
  return macVersion ? bots.filter((bot) => bot.appVersion !== null && bot.appVersion !== macVersion) : []
}

/** By name, then by id so that equal names keep a stable order. */
export function compareByName(a: { id: string; name: string }, b: { id: string; name: string }): number {
  return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export type FleetEnvironmentGroup = { environment: FleetEnvironment; bots: FleetBot[] }
/**
 * Environments by name, each with its bots by name. Bots of no listed environment stay ungrouped: every bot of a
 * gateway without environments, and a bot whose environment has not arrived yet.
 */
export function groupBotsByEnvironment(
  environments: FleetEnvironment[],
  bots: FleetBot[]
): { groups: FleetEnvironmentGroup[]; ungrouped: FleetBot[] } {
  const groups = [...environments].sort(compareByName).map((environment) => ({ environment, bots: [] as FleetBot[] }))
  const byId = new Map(groups.map((group) => [group.environment.id, group]))
  const ungrouped: FleetBot[] = []
  for (const bot of bots) {
    const group = bot.environmentId ? byId.get(bot.environmentId) : undefined
    if (group) group.bots.push(bot)
    else ungrouped.push(bot)
  }
  for (const group of groups) group.bots.sort(compareByName)
  return { groups, ungrouped: ungrouped.sort(compareByName) }
}

/** The listed environment a bot runs in, if any. */
export function environmentOf(
  environments: FleetEnvironment[],
  bot: Pick<FleetBot, 'environmentId'>
): FleetEnvironment | undefined {
  return bot.environmentId ? environments.find((environment) => environment.id === bot.environmentId) : undefined
}
