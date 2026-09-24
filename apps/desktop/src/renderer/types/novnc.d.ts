declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, channel: object, options?: { shared?: boolean; credentials?: Record<string, string> })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    qualityLevel: number
    compressionLevel: number
    focus(options?: FocusOptions): void
    disconnect(): void
  }
}
