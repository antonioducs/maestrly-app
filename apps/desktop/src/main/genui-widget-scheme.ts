import { protocol, type CustomScheme } from 'electron'
import { GENUI_WIDGET_SCHEME } from '../shared/genui-widget'
import { genUiWidgetFrameResponse } from '../shared/genui-widget-frame'

/** The frame of inline HTML answers needs a secure, standard origin of its own: never the app's. */
export const GENUI_WIDGET_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: GENUI_WIDGET_SCHEME,
  privileges: { standard: true, secure: true },
}

/** Serves the frame page to the app's own windows; the drawer browser's session does not know the scheme. */
export function handleGenUiWidgetProtocol(): void {
  protocol.handle(GENUI_WIDGET_SCHEME, (request) => {
    const response = genUiWidgetFrameResponse(request)
    return new Response(response.body, { status: response.status, headers: response.headers })
  })
}
