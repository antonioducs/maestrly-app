import { protocol } from 'electron'
import { FLEET_MEDIA_SCHEME_PRIVILEGES } from './fleet/client/media-scheme'
import { GENUI_WIDGET_SCHEME_PRIVILEGES } from './genui-widget-scheme'

/** Every privileged scheme of the app, in one call: Electron keeps only the last list it receives. */
export const PRIVILEGED_SCHEMES = [FLEET_MEDIA_SCHEME_PRIVILEGES, GENUI_WIDGET_SCHEME_PRIVILEGES]

/** Must run before the app is ready. */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES)
}
