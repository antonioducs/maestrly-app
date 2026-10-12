import type { RendererApi } from './index'

declare global {
  interface Window {
    /** This computer's app and window; a host's backend is reached with `hostApi(hostId)` (see renderer/lib/hosts). */
    api: RendererApi
  }
}

export {}
