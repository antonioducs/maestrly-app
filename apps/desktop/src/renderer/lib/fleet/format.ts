import type { FleetActivity, FleetBot, FleetEnvironment, FleetHostInfo } from '@maestrly/bot-fleet-protocol'
import { compareByName } from './selectors'
import { baseToolName } from '../agent-activity'

export function formatPairingCode(value: string): string {
  const characters = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8)
  return characters.length > 4 ? `${characters.slice(0, 4)}-${characters.slice(4)}` : characters
}

export function activityLabel(
  activity: FleetActivity | null,
  status: FleetBot['status']
): { key: string; values?: Record<string, string | number> } {
  if (activity) {
    switch (activity.kind) {
      case 'setup':
        return { key: activity.need === 'compaction' ? 'activity.setupCompaction' : 'activity.setup' }
      case 'tool':
        return { key: 'activity.tool', values: { tool: activity.tool, target: activity.target ?? '' } }
      case 'permission':
        return { key: 'activity.permission', values: { title: activity.title } }
      case 'help':
        return { key: 'activity.help', values: { reason: activity.reason } }
      case 'queued':
        return { key: 'activity.queued', values: { count: activity.count } }
      case 'idle':
        return activity.lastTurnSummary
          ? { key: 'activity.lastTurn', values: { summary: activity.lastTurnSummary } }
          : { key: 'activity.idle' }
      default:
        return { key: `activity.${activity.kind}` }
    }
  }
  return { key: `status.${status}` }
}

export type FleetMemorySegment = {
  kind: 'environment' | 'bot' | 'system'
  id: string
  name: string
  fraction: number
  tint: string
}
/**
 * The host memory bar: one segment per environment (its bots share its container, so their memory counts once, with
 * the tint of its first bot), one per bot of no listed environment (gateways without environments), and the rest.
 */
export function memorySegments(
  host: FleetHostInfo | null,
  bots: FleetBot[],
  environments: FleetEnvironment[] = []
): FleetMemorySegment[] {
  const total = host?.memory.totalBytes ?? 0
  if (!total) return []
  const listed = new Set(environments.map((environment) => environment.id))
  const tintOf = (environment: FleetEnvironment) =>
    bots.filter((bot) => bot.environmentId === environment.id).sort(compareByName)[0]?.tint ?? 'var(--primary)'
  const active = [
    ...environments.map((environment) => ({
      kind: 'environment' as const,
      id: environment.id,
      name: environment.name,
      bytes: environment.resources.memoryBytes ?? 0,
      tint: tintOf(environment),
    })),
    ...bots
      .filter((bot) => !bot.environmentId || !listed.has(bot.environmentId))
      .map((bot) => ({
        kind: 'bot' as const,
        id: bot.id,
        name: bot.name,
        bytes: bot.resources.memoryBytes ?? 0,
        tint: bot.tint,
      })),
  ].filter((item) => item.bytes > 0)
  const counted = active.reduce((sum, item) => sum + item.bytes, 0)
  const system = Math.max(0, (host?.memory.usedBytes ?? 0) - counted)
  return [
    ...active.map(({ bytes, ...item }) => ({ ...item, fraction: bytes / total })),
    { kind: 'system', id: 'system', name: '', fraction: system / total, tint: 'var(--muted-foreground)' },
  ]
}

export function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

/** The first word of a bot's name: how the computer's header and its return button address the bot. */
export function botFirstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

/** Whether a tool works on the bot's computer (its browser, desktop or terminal), which the owner can watch there. */
export function isComputerTool(name: string): boolean {
  return /^(browser|computer|terminal)_/.test(baseToolName(name))
}
