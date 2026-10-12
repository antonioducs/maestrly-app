import { protocol } from 'electron'
import { FLEET_MEDIA_SCHEME } from '../../../shared/fleet-media'
import { serveFleetMedia } from './media-protocol'
import type { FleetClientService } from './service'

/** Must run before the app is ready. `stream` lets `<video>` read ranges while the file is served. */
export function registerFleetMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FLEET_MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
    },
  ])
}

/** Serves bot videos to the app's own windows; the default session is theirs, not the drawer browser's. */
export function handleFleetMediaProtocol(fleet: Pick<FleetClientService, 'mediaEntry'>): void {
  protocol.handle(FLEET_MEDIA_SCHEME, (request) => serveFleetMedia(request, (target) => fleet.mediaEntry(target)))
}
