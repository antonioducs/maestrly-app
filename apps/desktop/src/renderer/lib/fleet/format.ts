import type {
  FleetActivity,
  FleetBot,
  FleetEnvironment,
  FleetHostInfo,
  FleetResources,
} from '@maestrly/bot-fleet-protocol'
import { compareByName } from './selectors'
import { baseToolName } from '../agent-activity'

/**
 * A bot's report that every account of its failover list reached its usage limit (`claude-accounts-exhausted`,
 * optionally followed by ` until=<ISO time>` when its accounts are expected back), or null for any other text.
 */
export function accountsExhaustedNotice(text: string | null): { kind: 'claude' | 'codex'; until: Date | null } | null {
  const match = /^(claude|codex)-accounts-exhausted(?: until=(\S+))?$/.exec(text ?? '')
  if (!match) return null
  const until = match[2] ? new Date(match[2]) : null
  return { kind: match[1] as 'claude' | 'codex', until: until && !Number.isNaN(until.getTime()) ? until : null }
}

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
  kind: 'environment' | 'bot' | 'swap' | 'system'
  id: string
  name: string
  bytes: number
  fraction: number
  tint: string
}
/** Compressed swap is memory of the containers, kept apart: muted like the system's, striped. */
export const COMPRESSED_SWAP_TINT =
  'repeating-linear-gradient(135deg, var(--muted-foreground) 0 2px, color-mix(in srgb, var(--muted-foreground) 35%, transparent) 2px 4px)'
/**
 * The host memory bar: one segment per environment (its bots share its container, so their memory counts once, with
 * the tint of its first bot), one per bot of no listed environment (gateways without environments), the swap the
 * server keeps compressed in memory (zram: pages the containers swapped out, which no container counts), and the rest.
 */
export function memorySegments(
  host: FleetHostInfo | null,
  bots: FleetBot[],
  environments: FleetEnvironment[] = []
): FleetMemorySegment[] {
  const total = host?.memory.totalBytes ?? 0
  if (!total) return []
  const listed = new Set(environments.map((environment) => environment.id))
  // The color the owner chose for the environment, else its first bot's.
  const tintOf = (environment: FleetEnvironment) =>
    environment.tint ??
    bots.filter((bot) => bot.environmentId === environment.id).sort(compareByName)[0]?.tint ??
    'var(--primary)'
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
  const rest = Math.max(0, (host?.memory.usedBytes ?? 0) - counted)
  const compressed = Math.min(rest, host?.memory.swap?.compressedBytes ?? 0)
  const system = rest - compressed
  return [
    ...active.map((item) => ({ ...item, fraction: item.bytes / total })),
    ...(compressed > 0
      ? [
          {
            kind: 'swap' as const,
            id: 'swap',
            name: '',
            bytes: compressed,
            fraction: compressed / total,
            tint: COMPRESSED_SWAP_TINT,
          },
        ]
      : []),
    {
      kind: 'system',
      id: 'system',
      name: '',
      bytes: system,
      fraction: system / total,
      tint: 'var(--muted-foreground)',
    },
  ]
}

/** From this much swap on, an environment shows what it swapped: less rounds to 0.0 GB. */
const SHOWN_SWAP_BYTES = 0.05 * 1024 ** 3
/** The memory a container moved out to swap, when there is enough to show; null otherwise. */
export function shownSwapBytes(resources: FleetResources): number | null {
  const swap = resources.swapBytes ?? null
  return swap !== null && swap >= SHOWN_SWAP_BYTES ? swap : null
}

/**
 * Processes of a container the kernel ended for lack of memory since it started, and what ran out: the container's own
 * limit, or the whole server's memory. Null when none were, or the server does not report them.
 */
export function outOfMemory(resources: FleetResources): { kills: number; cause: 'limit' | 'server' } | null {
  const kills = resources.oomKills ?? 0
  return kills > 0 ? { kills, cause: (resources.limitOoms ?? 0) > 0 ? 'limit' : 'server' } : null
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
