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

/** An environment that hosts the owner's chats and workspaces instead of bots. */
export const isWorkspacesEnvironment = (environment: Pick<FleetEnvironment, 'kind'>): boolean =>
  environment.kind === 'workspaces'

/** The environments bots run in: what bot lists and pickers show. */
export const botEnvironments = (environments: FleetEnvironment[]): FleetEnvironment[] =>
  environments.filter((environment) => !isWorkspacesEnvironment(environment))

/** The server's workspaces environment, if it has one; a server hosts workspaces in at most one. */
export const workspacesEnvironment = (environments: FleetEnvironment[]): FleetEnvironment | null =>
  environments.find(isWorkspacesEnvironment) ?? null

export type FleetEnvironmentGroup = { environment: FleetEnvironment; bots: FleetBot[] }
/**
 * Environments by name, each with its bots by name. Bots of no listed environment stay ungrouped: every bot of a
 * gateway without environments, and a bot whose environment has not arrived yet.
 */
export function groupBotsByEnvironment(
  environments: FleetEnvironment[],
  bots: FleetBot[]
): { groups: FleetEnvironmentGroup[]; ungrouped: FleetBot[] } {
  // A workspaces environment holds no bots: it is shown apart, on the Server page.
  const groups = botEnvironments(environments)
    .sort(compareByName)
    .map((environment) => ({ environment, bots: [] as FleetBot[] }))
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
