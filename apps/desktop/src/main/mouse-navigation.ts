import type { BrowserWindow, WebContents } from 'electron'

export type NavigationDirection = 'back' | 'forward'

const APP_COMMAND_DIRECTIONS: Record<string, NavigationDirection> = {
  'browser-backward': 'back',
  'browser-forward': 'forward',
}

const MAC_MOUSE_DIRECTIONS: Record<string, NavigationDirection> = {
  back: 'back',
  forward: 'forward',
}

const MAC_SWIPE_DIRECTIONS: Record<string, NavigationDirection> = {
  left: 'back',
  right: 'forward',
}

/** Translate window navigation commands only while the browser or VS Code has focus. */
export function attachWindowNavigation(
  window: BrowserWindow,
  navigateFocused: (direction: NavigationDirection) => boolean,
  platform: NodeJS.Platform = process.platform
): void {
  window.on('app-command', (event, command) => {
    const direction = APP_COMMAND_DIRECTIONS[command]
    if (direction && navigateFocused(direction)) event.preventDefault()
  })
  if (platform === 'darwin') {
    window.on('swipe', (event, swipeDirection) => {
      const direction = MAC_SWIPE_DIRECTIONS[swipeDirection]
      if (direction && navigateFocused(direction)) event.preventDefault()
    })
  }
}

/** macOS does not emit Electron app-command; intercept mouse4/mouse5 before the page receives them. */
export function attachMacMouseNavigation(
  webContents: WebContents,
  navigate: (direction: NavigationDirection) => void,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'darwin') return
  webContents.on('before-mouse-event', (event, mouse) => {
    // Electron 42 exposes back/forward buttons at runtime, although MouseInputEvent declarations still list
    // only left/middle/right.
    const direction = MAC_MOUSE_DIRECTIONS[mouse.button as string]
    if (!direction) return
    event.preventDefault()
    if (mouse.type === 'mouseDown') navigate(direction)
  })
}
