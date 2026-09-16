import type { NetworkPolicy } from '@maestrly/host-protocol'
import type { FileService } from '../files/service.js'
import type { TurnHooks } from '../providers/provider.js'
import { BrowserSession } from '../tools/browser.js'
import { Computer } from '../tools/computer.js'
import { captureDesktop } from './capture.js'

export type Shot = { bytes: Buffer; path: string }
export type DesktopShot = Shot & { generation: string; width: number; height: number }
export type PageSnapshot = { url: string; title: string; text: string; interactive: { ref: number; tag: string; name: string }[] }
/**
 * Browser and desktop operations available to the automation tools. In a managed
 * session they are served by the persistent graphical services; stopping automation
 * never closes the browser, its tabs or unsaved fields.
 */
export interface DesktopTools {
  readonly managed: boolean
  available(): Promise<boolean>
  navigate(url: string): Promise<{ url: string }>
  snapshot(): Promise<PageSnapshot>
  click(ref: number): Promise<void>
  type(ref: number, text: string): Promise<void>
  key(key: string): Promise<void>
  screenshot(observationId: string, hooks: TurnHooks): Promise<Shot>
  downloads(): Promise<{ path: string; name: string }[]>
  computerClick(x: number, y: number, button?: 'left' | 'right' | 'middle', signal?: AbortSignal): Promise<void>
  computerType(text: string, signal?: AbortSignal): Promise<void>
  computerKey(key: string, signal?: AbortSignal): Promise<void>
  captureDesktop(observationId: string, hooks: TurnHooks, signal?: AbortSignal): Promise<DesktopShot>
  generation(): Promise<string>
  updatePolicy?(network: NetworkPolicy): Promise<void>
  /** A turn was aborted mid-tool. */
  abort(): void
  close(): Promise<void>
}
/** Development and single-bot legacy runtimes: the worker owns its browser in-process. */
export class LocalDesktopTools implements DesktopTools {
  readonly managed = false
  private computer: Computer
  constructor(
    readonly browser: BrowserSession,
    private readonly files: FileService
  ) {
    this.computer = new Computer(browser)
  }
  available() {
    return BrowserSession.available()
  }
  navigate(url: string) {
    return this.browser.navigate(url)
  }
  snapshot() {
    return this.browser.snapshot()
  }
  click(ref: number) {
    return this.browser.click(ref)
  }
  type(ref: number, text: string) {
    return this.browser.type(ref, text)
  }
  key(key: string) {
    return this.browser.key(key)
  }
  screenshot(observationId: string, hooks: TurnHooks) {
    return this.browser.screenshot(observationId, hooks)
  }
  async downloads() {
    return this.browser.listDownloads()
  }
  computerClick(x: number, y: number, button?: 'left' | 'right' | 'middle', signal?: AbortSignal) {
    return this.computer.click(x, y, button, signal)
  }
  computerType(text: string, signal?: AbortSignal) {
    return this.computer.type(text, signal)
  }
  computerKey(key: string, signal?: AbortSignal) {
    return this.computer.key(key, signal)
  }
  captureDesktop(observationId: string, hooks: TurnHooks, signal?: AbortSignal) {
    return captureDesktop(this.browser.desktop, this.files, observationId, hooks, signal)
  }
  generation() {
    return this.browser.desktop.generation()
  }
  abort() {
    // Unmanaged workers keep the historical fail-safe: the browser dies with the turn.
    void this.browser.close()
  }
  close() {
    return this.browser.close()
  }
}
