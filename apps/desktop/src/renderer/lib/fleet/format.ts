import type { FleetActivity, FleetBot, FleetHostInfo } from '@maestrly/bot-fleet-protocol'

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

export function memorySegments(
  host: FleetHostInfo | null,
  bots: FleetBot[]
): { id: string; fraction: number; tint: string }[] {
  const total = host?.memory.totalBytes ?? 0
  if (!total) return []
  const active = bots
    .map((bot) => ({ id: bot.id, bytes: bot.resources.memoryBytes ?? 0, tint: bot.tint }))
    .filter((item) => item.bytes > 0)
  const botBytes = active.reduce((sum, item) => sum + item.bytes, 0)
  const system = Math.max(0, (host?.memory.usedBytes ?? 0) - botBytes)
  return [
    ...active.map((item) => ({ id: item.id, fraction: item.bytes / total, tint: item.tint })),
    { id: 'system', fraction: system / total, tint: 'var(--muted-foreground)' },
  ]
}

export function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}
