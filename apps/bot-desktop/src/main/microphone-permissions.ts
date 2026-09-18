import type { Session, WebContents } from 'electron'

/**
 * Microphone authorization for this window, and nothing else.
 *
 * Electron asks twice about the same capability, in two different places. `setPermissionRequestHandler`
 * runs for a prompt; `setPermissionCheckHandler` runs for the synchronous check the page makes
 * before it asks. Installing only the first one leaves the second answering its default, which
 * is how a renderer ends up believing it has a device it was never granted.
 *
 * So both are installed, both answer the same way, and both refuse everything except audio
 * capture requested by the main frame of this exact window at the exact renderer URL — never
 * an iframe, never a service worker, never a page that navigated somewhere unexpected. The
 * camera and screen capture are refused outright: this product records voice notes, and a
 * microphone permission must not quietly become a camera permission.
 */
export interface MicrophoneGate {
  /** True only while the person is actually recording in this window. */
  armed: boolean
}

const ALLOWED = new Set(['audioCapture', 'media'])
const DENIED_MEDIA = new Set(['video', 'display-capture', 'videoCapture'])

export interface PermissionDetails {
  mediaTypes?: string[]
  securityOrigin?: string
  requestingUrl?: string
  isMainFrame?: boolean
}

/**
 * The single decision both handlers share. It is written as a pure function so the rules can
 * be tested without an Electron window, and so the two handlers cannot drift apart.
 */
export function decideMicrophone(input: {
  permission: string
  details: PermissionDetails
  isMainFrame: boolean
  sameWebContents: boolean
  requestingUrl: string
  expectedUrl: string
  armed: boolean
}): boolean {
  if (!ALLOWED.has(input.permission)) return false
  if (!input.sameWebContents || !input.isMainFrame) return false
  if (input.requestingUrl !== input.expectedUrl) return false
  // "media" covers audio and video together: accept it only when audio is the only thing asked.
  const mediaTypes = input.details.mediaTypes
  if (mediaTypes !== undefined) {
    if (!mediaTypes.length || mediaTypes.some((type) => DENIED_MEDIA.has(type))) return false
    if (!mediaTypes.every((type) => type === 'audio')) return false
  } else if (input.permission === 'media') return false
  // Only while a person is holding the button: a page that asks on load gets nothing.
  return input.armed
}

export function installMicrophonePermissions(input: { session: Session; contents: WebContents; expectedUrl: string; gate: MicrophoneGate }) {
  const { session, contents, expectedUrl, gate } = input
  const urlOf = (webContents: WebContents | null, details: PermissionDetails) =>
    details.requestingUrl ?? (webContents && !webContents.isDestroyed() ? webContents.getURL() : '')
  const mainFrame = (webContents: WebContents | null, details: PermissionDetails) =>
    details.isMainFrame ?? (webContents ? !webContents.isDestroyed() : false)

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      decideMicrophone({
        permission,
        details: (details ?? {}) as PermissionDetails,
        isMainFrame: mainFrame(webContents, (details ?? {}) as PermissionDetails),
        sameWebContents: !!webContents && webContents.id === contents.id,
        requestingUrl: urlOf(webContents, (details ?? {}) as PermissionDetails),
        expectedUrl,
        armed: gate.armed,
      })
    )
  })
  session.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    decideMicrophone({
      permission,
      details: (details ?? {}) as PermissionDetails,
      isMainFrame: mainFrame(webContents, (details ?? {}) as PermissionDetails),
      sameWebContents: !!webContents && webContents.id === contents.id,
      requestingUrl: urlOf(webContents, (details ?? {}) as PermissionDetails),
      expectedUrl,
      armed: gate.armed,
    })
  )
}

/**
 * The macOS side of the same decision. The system grant is asked for by a person's gesture and
 * is never assumed: a denied or restricted microphone produces a message that says what to do,
 * instead of a silent recording that captures nothing.
 */
export type MicrophoneAccess = 'granted' | 'denied' | 'restricted' | 'unavailable'
export interface SystemPreferencesLike {
  getMediaAccessStatus?(mediaType: 'microphone'): string
  askForMediaAccess?(mediaType: 'microphone'): Promise<boolean>
}
export async function requestSystemMicrophone(systemPreferences: SystemPreferencesLike, platform = process.platform): Promise<MicrophoneAccess> {
  if (platform !== 'darwin') return 'granted'
  const status = systemPreferences.getMediaAccessStatus?.('microphone') ?? 'unknown'
  if (status === 'granted') return 'granted'
  if (status === 'restricted') return 'restricted'
  if (status === 'denied') return 'denied'
  if (!systemPreferences.askForMediaAccess) return 'unavailable'
  return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied'
}
