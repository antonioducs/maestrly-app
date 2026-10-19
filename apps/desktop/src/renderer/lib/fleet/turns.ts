import { type FleetBot, fleetPrimaryWorking } from '@maestrly/bot-fleet-protocol'

/** A turn of one of the bot's side conversations: a routine run's, or a conversation with another bot's. */
export interface SideTurn {
  kind: 'routine' | 'peer'
  id: string
  title: string
  startedAt: string | null
}

type TurnsBot = Pick<FleetBot, 'status' | 'runningRun'> & { turns?: FleetBot['turns'] }

/** Whether the bot's own conversation has a turn running, from a gateway of any age. */
export function primaryWorking(bot: TurnsBot): boolean {
  return fleetPrimaryWorking({ turns: bot.turns ?? null, status: bot.status, runningRun: bot.runningRun })
}

/**
 * The turns of the bot's side conversations, oldest first: from its `turns` (`parallel-turns`), or from an older
 * gateway, the routine run it works on.
 */
export function sideTurns(bot: TurnsBot): SideTurn[] {
  if (bot.turns)
    return bot.turns.flatMap((turn) =>
      turn.kind === 'primary' || !turn.id
        ? []
        : [{ kind: turn.kind, id: turn.id, title: turn.title, startedAt: turn.startedAt }]
    )
  const run = bot.runningRun
  return run ? [{ kind: 'routine', id: run.id, title: run.title, startedAt: run.startedAt }] : []
}

/** Whether the gateway runs the bot's conversations at once: messages to its own then never wait for its side ones. */
export const runsInParallel = (bot: Pick<FleetBot, 'turns'> | { turns?: FleetBot['turns'] }): boolean => !!bot.turns
