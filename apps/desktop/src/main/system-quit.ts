/**
 * Requests from the system to end the app: no one is there to answer a confirmation, and a pending one would hold up
 * the shutdown or logout, so they quit with the usual cleanup and without asking.
 */

/** systemd and display managers send SIGTERM at shutdown and logout, SIGHUP when the terminal goes, SIGINT is Ctrl+C. */
export const SYSTEM_QUIT_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const

interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown
  off(signal: NodeJS.Signals, listener: () => void): unknown
}

/** Electron passes the event with `preventDefault`, though its typings declare a listener without arguments. */
type ShutdownListener = (event?: { preventDefault(): void }) => void

interface ShutdownSource {
  on(event: 'shutdown', listener: ShutdownListener): unknown
  off(event: 'shutdown', listener: ShutdownListener): unknown
}

export interface SystemQuitSources {
  platform: NodeJS.Platform
  signals: SignalSource
  powerMonitor: ShutdownSource
  /** Marks the quit as the system's and starts it; called again for a repeated request. */
  quit: () => void
}

/**
 * Listens for the system's requests to end the app. Install after `app` is ready: Electron sets its own signal handlers
 * while starting, and a later Node listener replaces them for these signals.
 */
export function installSystemQuitHandlers({ platform, signals, powerMonitor, quit }: SystemQuitSources): () => void {
  // One graceful attempt per signal, as Electron's own handlers: a repeated signal finds no listener and ends the
  // process at once. Each signal keeps its own attempt; logind sends SIGHUP right after SIGTERM at logout.
  const listeners = new Map<NodeJS.Signals, () => void>()
  for (const signal of SYSTEM_QUIT_SIGNALS) {
    listeners.set(signal, () => {
      signals.off(signal, listeners.get(signal)!)
      quit()
    })
  }
  // Linux takes a logind delay lock while a listener is attached; holding it until this process exits gives the cleanup
  // time to end what the app started. macOS would cancel the shutdown instead, so there it only quits.
  const onShutdown: ShutdownListener = (event) => {
    if (platform === 'linux') event?.preventDefault()
    quit()
  }
  const watchSignals = platform !== 'win32'
  if (watchSignals) for (const [signal, listener] of listeners) signals.on(signal, listener)
  if (platform === 'linux' || platform === 'darwin') powerMonitor.on('shutdown', onShutdown)
  return () => {
    if (watchSignals) for (const [signal, listener] of listeners) signals.off(signal, listener)
    if (platform === 'linux' || platform === 'darwin') powerMonitor.off('shutdown', onShutdown)
  }
}
