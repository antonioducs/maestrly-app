'use strict'
// Preload of the drawer browser's session (`persist:drawer-browser`); it runs in every page and popup of that session,
// before the page's own scripts. Plain CommonJS on purpose: a sandboxed preload cannot load modules, and the file ships
// as a resource instead of going through the app bundle.
//
// Electron builds Chromium without Chrome's own `window.chrome` members (`app`, `csi`, `loadTimes`), and Google's
// sign-in refuses a browser that lacks them ("This browser or app may not be secure"). The members below follow the
// shapes Chrome documents, filled from the page's own navigation timing.

const PAGE_SCRIPT = `(() => {
  const chromeObject = window.chrome && typeof window.chrome === 'object' ? window.chrome : {}
  const navigationEntry = () => (performance.getEntriesByType('navigation')[0]) || {}
  const seconds = (ms) => (performance.timeOrigin + (ms || 0)) / 1000
  const define = (name, value) => {
    if (name in chromeObject) return
    Object.defineProperty(chromeObject, name, { value, writable: true, enumerable: true, configurable: true })
  }

  define('loadTimes', function loadTimes() {
    const nav = navigationEntry()
    const protocol = nav.nextHopProtocol || 'h2'
    const paint = performance.getEntriesByName('first-paint')[0]
    return {
      requestTime: seconds(nav.requestStart),
      startLoadTime: seconds(nav.startTime),
      commitLoadTime: seconds(nav.responseStart),
      finishDocumentLoadTime: seconds(nav.domContentLoadedEventEnd),
      finishLoadTime: seconds(nav.loadEventEnd),
      firstPaintTime: seconds(paint ? paint.startTime : 0),
      firstPaintAfterLoadTime: 0,
      navigationType: nav.type === 'reload' ? 'Reload' : nav.type === 'back_forward' ? 'BackForward' : 'Other',
      wasFetchedViaSpdy: protocol === 'h2' || protocol === 'h3',
      wasNpnNegotiated: protocol === 'h2' || protocol === 'h3',
      npnNegotiatedProtocol: protocol,
      wasAlternateProtocolAvailable: false,
      connectionInfo: protocol,
    }
  })

  define('csi', function csi() {
    const nav = navigationEntry()
    return {
      startE: Math.round(performance.timeOrigin + (nav.startTime || 0)),
      onloadT: Math.round(performance.timeOrigin + (nav.loadEventEnd || 0)),
      pageT: performance.now(),
      tran: 15,
    }
  })

  define('app', {
    isInstalled: false,
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    getDetails: function getDetails() { return null },
    getIsInstalled: function getIsInstalled() { return false },
    runningState: function runningState() { return 'cannot_run' },
  })

  if (window.chrome !== chromeObject) {
    Object.defineProperty(window, 'chrome', { value: chromeObject, writable: true, enumerable: true, configurable: true })
  }
})()`

try {
  // The main world is where the page looks for `window.chrome`; the preload itself runs in an isolated world.
  require('electron')
    .webFrame.executeJavaScript(PAGE_SCRIPT)
    .catch(() => {})
} catch {
  /* A page that cannot take the script loads without it. */
}
