declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, channel: object, options?: { shared?: boolean; credentials?: Record<string, string> })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    qualityLevel: number
    compressionLevel: number
    focus(options?: FocusOptions): void
    clipboardPasteFrom(text: string): void
    sendKey(keysym: number, code: string, down?: boolean): void
    disconnect(): void
  }
}
