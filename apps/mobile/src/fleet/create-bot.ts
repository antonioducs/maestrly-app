import {
  FLEET_ENVIRONMENT_LIMITS,
  FLEET_ENVIRONMENTS_FEATURE,
  type FleetCeiling,
  type FleetCreateBotRequest,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from '../gateway/client'

/**
 * Whether a new bot can join an environment now, or what has to happen first. The phone adds bots only to existing
 * environments: a new one would start with no model account, which only a computer can bring.
 */
export type JoinAvailability = 'ready' | 'full' | 'stopped' | 'starting' | 'restart'

export function joinAvailability(
  environment: Pick<FleetEnvironment, 'botIds' | 'lifecycle' | 'capabilities'>
): JoinAvailability {
  if (environment.botIds.length >= FLEET_ENVIRONMENT_LIMITS.botsMax) return 'full'
  if (environment.lifecycle === 'stopped' || environment.lifecycle === 'failed') return 'stopped'
  if (environment.lifecycle !== 'running') return 'starting'
  // An environment running an image from before environments hosts one bot until it restarts on the current image.
  return environment.capabilities.includes(FLEET_ENVIRONMENTS_FEATURE) ? 'ready' : 'restart'
}

export type EnvironmentChoice = { environment: FleetEnvironment; availability: JoinAvailability }

/** The environments a new bot can go to, in the server's order: those of bots, not those of workspaces. */
export function environmentChoices(environments: FleetEnvironment[]): EnvironmentChoice[] {
  return environments
    .filter((environment) => environment.kind !== 'workspaces' && environment.lifecycle !== 'archived')
    .map((environment) => ({ environment, availability: joinAvailability(environment) }))
}

/** The environment asked for when a bot can join it, else the only one that can take a bot; none when in doubt. */
export function initialEnvironment(choices: EnvironmentChoice[], preferred: string | null): string | null {
  const ready = choices.filter((choice) => choice.availability === 'ready')
  const asked = ready.find((choice) => choice.environment.id === preferred)
  if (asked) return asked.environment.id
  return ready.length === 1 ? ready[0].environment.id : null
}

export type NewBotForm = {
  name: string
  instructions: string
  environmentId: string | null
  ceiling: FleetCeiling
  talksTo: string[]
}
export type NewBotRequest = Omit<FleetCreateBotRequest, 'idempotencyKey'>
export type NewBotProblem = 'name' | 'environment'

/**
 * The create request a form makes, or what it still lacks. Artifact publishing is left to the server's default: the
 * phone cannot prepare the server for it, as a computer does.
 */
export function newBotRequest(
  form: NewBotForm
): { ok: true; request: NewBotRequest } | { ok: false; problem: NewBotProblem } {
  const name = form.name.trim()
  if (!name) return { ok: false, problem: 'name' }
  if (!form.environmentId) return { ok: false, problem: 'environment' }
  return {
    ok: true,
    request: {
      name,
      instructions: form.instructions.trim(),
      ceiling: form.ceiling,
      talksTo: [...new Set(form.talksTo)],
      environmentId: form.environmentId,
    },
  }
}

export type CreateBotIssue = 'offline' | 'gone' | 'cannotJoin' | 'outdated' | 'invalid' | 'failed'

/** Why the server did not create the bot, as the form says it. */
export function createBotIssue(error: unknown): CreateBotIssue {
  if (error instanceof Error && error.name === 'ZodError') return 'invalid'
  if (!(error instanceof GatewayError)) return 'failed'
  if (error.code === 'NETWORK' || error.code === 'TIMEOUT') return 'offline'
  // The environment or a bot it may talk to was removed meanwhile.
  if (error.code === 'NOT_FOUND') return 'gone'
  // The environment filled up, or must restart on the current image before it takes another bot.
  if (error.code === 'CONFLICT') return 'cannotJoin'
  if (error.code === 'PROTOCOL_INCOMPATIBLE') return 'outdated'
  if (error.code === 'INVALID_REQUEST') return 'invalid'
  return 'failed'
}
