import type * as browserControl from '../browser-control'

export type BrowserSurfaceState = 'starting' | 'ready' | 'inspecting' | 'error'

export interface BrowserSurfaceInfo {
  state: BrowserSurfaceState
  url?: string
}

export interface BrowserSurfaceScreenshot {
  data: string
  metadata: {
    url: string
    viewport: { width: number; height: number }
    scroll: browserControl.ScrollPosition | null
  }
}

/** Automation contract shared by owned visual-review windows and user-owned drawer tabs. */
export interface BrowserSurface {
  readonly partition: string
  readonly origin: string
  info(): BrowserSurfaceInfo
  show(): boolean
  navigate(url: string): Promise<{ url: string }>
  reload(): Promise<{ moved: boolean; url: string }>
  waitFor(options: { selector?: string; text?: string; networkIdle?: boolean; timeoutMs?: number }): Promise<unknown>
  snapshot(): ReturnType<typeof browserControl.snapshot>
  screenshot(): Promise<BrowserSurfaceScreenshot>
  readText(): Promise<string>
  scroll(input: Parameters<typeof browserControl.scroll>[1]): ReturnType<typeof browserControl.scroll>
  consoleLogs(level?: string, limit?: number): ReturnType<typeof browserControl.getConsoleLogs>
  networkLogs(onlyErrors?: boolean, limit?: number): ReturnType<typeof browserControl.getNetworkLogs>
  click(ref: number): Promise<void>
  doubleClick(ref: number): Promise<void>
  type(ref: number, text: string, clear?: boolean): Promise<void>
  pressKey(key: string, modifiers?: string[]): Promise<void>
  drag(fromRef: number, toRef: number): Promise<void>
  dispose(): Promise<void>
}
