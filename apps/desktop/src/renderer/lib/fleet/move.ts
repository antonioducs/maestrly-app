import {
  FLEET_BOT_MOVE_FEATURE,
  FLEET_ENVIRONMENT_LIMITS,
  type FleetBot,
  type FleetBotMove,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import type { FleetMoveBotInput } from '../../../shared/fleet-targets'
import { environmentJoinAvailability, type EnvironmentJoinAvailability } from './provisioning'
import { environmentOf } from './selectors'
import type { FleetController } from './use-fleet'

/** Why a bot cannot move now, or `ready`. */
export type BotMoveAvailability =
  | 'ready'
  | 'update-server'
  | 'moving'
  | 'not-running'
  | 'restart-environment'
  | 'screen'
/**
 * Whether a bot can start a move: the server moves bots, the bot is not moving already, runs, has its screen back, and
 * its environment's Maestrly moves bots (an older image needs the environment restarted first).
 */
export function botMoveAvailability(fleet: FleetController, bot: FleetBot): BotMoveAvailability {
  if (!fleet.state.connection.features.includes(FLEET_BOT_MOVE_FEATURE)) return 'update-server'
  if (bot.move) return 'moving'
  if (bot.lifecycle !== 'running') return 'not-running'
  if (bot.takeover.state !== 'none') return 'screen'
  const environment = environmentOf(fleet.state.snapshot.environments, bot)
  if (!environment?.capabilities.includes(FLEET_BOT_MOVE_FEATURE)) return 'restart-environment'
  return 'ready'
}

/** Why an environment cannot take a bot now, or `ready`. */
export type MoveTargetAvailability = EnvironmentJoinAvailability | 'current' | 'version'
/**
 * Whether a bot can move to an environment: another bots environment, with room, running a Maestrly that moves bots,
 * of the same version as the bot's own environment (a package is read by the version that wrote it).
 */
export function moveTargetAvailability(
  fleet: FleetController,
  bot: FleetBot,
  environment: FleetEnvironment
): MoveTargetAvailability {
  if (environment.id === bot.environmentId) return 'current'
  const join = environmentJoinAvailability(fleet, environment)
  if (join !== 'ready') return join
  if (!environment.capabilities.includes(FLEET_BOT_MOVE_FEATURE)) return 'restart-environment'
  const source = environmentOf(fleet.state.snapshot.environments, bot)
  if (source?.appVersion && environment.appVersion && source.appVersion !== environment.appVersion) return 'version'
  return 'ready'
}
/** Why an environment cannot take a bot, as a translation key and its values. */
export function moveTargetHint(availability: Exclude<MoveTargetAvailability, 'ready'>): {
  key: string
  values?: Record<string, unknown>
} {
  switch (availability) {
    case 'current':
      return { key: 'move.hint.current' }
    case 'version':
      return { key: 'move.hint.version' }
    case 'restart-environment':
      return { key: 'move.hint.restart' }
    case 'full':
      return { key: 'environment.full', values: { max: FLEET_ENVIRONMENT_LIMITS.botsMax } }
    case 'update-server':
      return { key: 'move.error.unsupported' }
    case 'start-environment':
      return { key: 'move.hint.start' }
    case 'not-running':
      return { key: 'environment.waitToJoin' }
  }
}

/** Where the owner chose to move the bot; null while the choice is incomplete. */
export function moveRequest(
  choice: { kind: 'new'; name: string } | { kind: 'existing'; environmentId: string | null }
): FleetMoveBotInput | null {
  if (choice.kind === 'existing') return choice.environmentId ? { environmentId: choice.environmentId } : null
  const name = choice.name.trim()
  return name ? { newEnvironment: { name } } : null
}

/** The steps the owner follows, and the step each phase of the move is at. */
export const MOVE_STEPS = ['pause', 'pack', 'transfer', 'check', 'finish'] as const
export type MoveStep = (typeof MOVE_STEPS)[number]
const STEP_OF: Record<FleetBotMove['phase'], number> = {
  prepared: 0,
  freezing: 0,
  exporting: 1,
  importing: 2,
  verifying: 3,
  committing: 4,
  'releasing-source': 4,
  completed: 5,
}
/** The step a move is at: every step before it is done. A completed move is past the last one. */
export function moveStepIndex(phase: FleetBotMove['phase']): number {
  return STEP_OF[phase]
}
