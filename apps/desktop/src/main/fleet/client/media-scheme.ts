import { protocol, type CustomScheme } from 'electron'
import { FLEET_MEDIA_SCHEME } from '../../../shared/fleet-media'
import { serveFleetMedia } from './media-protocol'
import type { FleetServerId } from '../../../shared/fleet-servers'
import type { FleetClientService } from './service'

/** Declared with the app's other privileged schemes before it is ready. `stream` lets `<video>` read ranges. */
export const FLEET_MEDIA_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: FLEET_MEDIA_SCHEME,
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
}

/** Serves bot videos to the app's own windows; the default session is theirs, not the drawer browser's. */
export function handleFleetMediaProtocol(
  resolve: (serverId: FleetServerId) => Pick<FleetClientService, 'mediaEntry'> | null
): void {
  protocol.handle(FLEET_MEDIA_SCHEME, (request) =>
    serveFleetMedia(request, async (target) => (await resolve(target.serverId)?.mediaEntry(target)) ?? null)
  )
}
