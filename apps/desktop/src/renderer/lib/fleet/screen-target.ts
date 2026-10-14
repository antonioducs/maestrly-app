import type { FleetScreenSurface } from '@maestrly/bot-fleet-protocol'
import type { FleetScreenTargetInput } from '../../../shared/fleet-targets'

/**
 * The target of a screen: a bot's browser or apps area (a bare id is its browser area, as before environments), an
 * environment's own screen, or a workspaces conversation's computer (`apps`, the default) or browser tile. For a
 * conversation, `id` is its environment and `conversationId` its id on the host.
 */
export function screenTargetOf(input: {
  kind: 'bot' | 'environment' | 'conversation'
  id: string
  surface: FleetScreenSurface | null
  conversationId?: string
}): FleetScreenTargetInput {
  const { kind, id, surface } = input
  if (kind === 'conversation')
    return { environmentId: id, conversationId: input.conversationId ?? '', surface: surface ?? 'apps' }
  if (kind === 'environment') return { environmentId: id }
  return surface ? { botId: id, surface } : id
}
