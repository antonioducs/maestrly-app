import type { FleetBot, FleetPendingInteraction } from '@maestrly/bot-fleet-protocol'
import type { Text } from '../i18n/translate'
import type { FleetState } from './state'

export type EnvironmentGroup = { id: string; name: string; bots: FleetBot[]; working: number }

/** Bots grouped by the environment they run in, in the server's order; bots outside any environment come last. */
export function botsByEnvironment(state: FleetState, query: string, looseName = 'Bots'): EnvironmentGroup[] {
  const q = query.trim().toLowerCase()
  const known = new Map(state.environments.map((environment) => [environment.id, environment.name]))
  const environmentName = (bot: FleetBot) => (bot.environmentId ? known.get(bot.environmentId) : undefined)
  const matches = (bot: FleetBot) =>
    !q || [bot.name, bot.role, environmentName(bot) ?? ''].some((field) => field.toLowerCase().includes(q))
  const groups: EnvironmentGroup[] = state.environments.map((environment) => ({
    id: environment.id,
    name: environment.name,
    bots: [],
    working: 0,
  }))
  const loose: EnvironmentGroup = { id: '', name: looseName, bots: [], working: 0 }
  for (const bot of state.bots) {
    if (!matches(bot)) continue
    const group = groups.find((item) => item.id === bot.environmentId && known.has(item.id)) ?? loose
    group.bots.push(bot)
    if (bot.status === 'working') group.working++
  }
  return [...groups, loose].filter((group) => group.bots.length > 0)
}

/** One request per bot, its oldest; bots that waited longest come first. */
export function waitingItems(state: FleetState): { bot: FleetBot; interaction: FleetPendingInteraction }[] {
  const oldest = new Map<string, FleetPendingInteraction>()
  for (const { botId, interaction } of state.inbox) {
    const current = oldest.get(botId)
    if (!current || interaction.at < current.at) oldest.set(botId, interaction)
  }
  return state.bots
    .filter((bot) => oldest.has(bot.id))
    .map((bot) => ({ bot, interaction: oldest.get(bot.id) as FleetPendingInteraction }))
    .sort((a, b) => a.interaction.at.localeCompare(b.interaction.at))
}

/** The pending request a transcript card answers; null once it was answered or expired. */
export function interactionForItem(state: FleetState, botId: string, itemId: string): FleetPendingInteraction | null {
  return state.inbox.find((item) => item.botId === botId && item.interaction.itemId === itemId)?.interaction ?? null
}

export type StatusLine = { text: string; tone: 'cue' | 'mono' | 'plain' }

/** One line on what a bot is doing, for the drawer and the conversation header. */
export function botStatusLine(bot: FleetBot, { t, plural }: Text): StatusLine {
  const activity = bot.activity
  switch (bot.status) {
    case 'waiting':
      if (activity?.kind === 'permission') return { text: t('status.permission'), tone: 'cue' }
      if (activity?.kind === 'question') return { text: t('status.question'), tone: 'cue' }
      if (activity?.kind === 'help') return { text: t('status.help'), tone: 'cue' }
      return { text: t('cue.eyebrow'), tone: 'cue' }
    case 'working':
      if (activity?.kind === 'tool')
        return { text: activity.target ? `${activity.tool} ${activity.target}` : activity.tool, tone: 'mono' }
      if (activity?.kind === 'thinking') return { text: t('status.thinking'), tone: 'plain' }
      if (activity?.kind === 'compacting') return { text: t('status.compacting'), tone: 'plain' }
      if (activity?.kind === 'queued') return { text: plural('status.queued', activity.count), tone: 'plain' }
      return { text: t('status.working'), tone: 'plain' }
    case 'setup':
      return {
        text: t(activity?.kind === 'setup' && activity.need === 'compaction' ? 'status.setupCompaction' : 'status.setupAccount'),
        tone: 'plain',
      }
    case 'paused':
      return { text: t('status.paused'), tone: 'plain' }
    case 'offline':
      return { text: t('status.offline'), tone: 'plain' }
    case 'starting':
      return { text: t('status.starting'), tone: 'plain' }
    case 'human':
      return { text: t('status.human'), tone: 'plain' }
    default: {
      const summary = activity?.kind === 'idle' ? activity.lastTurnSummary : null
      return { text: summary || bot.role || t('status.idle'), tone: 'plain' }
    }
  }
}

const SHELL_TOOLS = new Set(['bash', 'shell', 'exec_command'])

/** How a status line reads on screen: a shell command as `$ command`, as the prototype and terminals show it. */
export function statusLineText(bot: FleetBot, line: StatusLine): string {
  const activity = bot.activity
  if (line.tone === 'mono' && activity?.kind === 'tool' && activity.target && SHELL_TOOLS.has(activity.tool))
    return `$ ${activity.target}`
  return line.text
}

/** A bot in these states takes no messages from the phone, as on the desktop. */
export const isComposerLocked = (bot: FleetBot): boolean =>
  ['paused', 'human', 'offline', 'starting', 'setup'].includes(bot.status)
