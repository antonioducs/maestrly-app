declare module '@novnc/novnc' {
  /** Subset of the noVNC RFB API used as a decoder/renderer. Input stays in viewOnly mode. */
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; wsProtocols?: string[] })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    clipViewport: boolean
    focusOnClick: boolean
    showDotCursor: boolean
    qualityLevel: number
    compressionLevel: number
    background: string
    disconnect(): void
  }
}
