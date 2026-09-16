import { readFile } from 'node:fs/promises'
import type { NetworkPolicy } from '@maestrly/host-protocol'
import { digest, type FileService } from '../files/service.js'
import type { TurnHooks } from '../providers/provider.js'
import { runtimeError } from '../turns/service.js'
import type { DesktopShot, DesktopTools, PageSnapshot, Shot } from './desktop-tools.js'
import { capturedFileSchema, LineRpcClient, type CapturedFile } from './service-protocol.js'

/**
 * Automation-side client of the session's graphical services. It reaches only the
 * agent socket: every request is gated by the services and drained before a handoff.
 */
export class ManagedDesktopClient implements DesktopTools {
  readonly managed = true
  private readonly rpc: LineRpcClient
  constructor(
    path: string,
    private readonly files: FileService,
    onInvalidate: () => void
  ) {
    this.rpc = new LineRpcClient(path)
    this.rpc.onEvent(() => onInvalidate())
  }
  private call<T>(op: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    return this.rpc.request(op, params, timeoutMs) as Promise<T>
  }
  async available() {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await this.call('services.inspect', {}, 5_000)
        return true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    return false
  }
  navigate(url: string) {
    return this.call<{ url: string }>('browser.navigate', { url })
  }
  snapshot() {
    return this.call<PageSnapshot>('browser.snapshot')
  }
  async click(ref: number) {
    await this.call('browser.click', { ref })
  }
  async type(ref: number, text: string) {
    await this.call('browser.type', { ref, text })
  }
  async key(key: string) {
    await this.call('browser.key', { key })
  }
  /** Captures are written by the services into the workspace; bytes are re-verified here. */
  private async produced(op: string, observationId: string, hooks: TurnHooks, summary: string): Promise<Shot & { file: CapturedFile }> {
    const file = capturedFileSchema.parse(await this.call(op, { observationId }))
    const bytes = await readFile(await this.files.safePath(file.path))
    if (bytes.length !== file.size || digest(bytes) !== file.digest)
      throw runtimeError('INVALID_SCREENSHOT', 'Capture changed before it was read')
    hooks.emit({ kind: 'file.produced', summary, detail: { path: file.path, name: file.name, size: file.size, digest: file.digest } })
    return { bytes, path: file.path, file }
  }
  async screenshot(observationId: string, hooks: TurnHooks): Promise<Shot> {
    const { bytes, path } = await this.produced('browser.screenshot', observationId, hooks, 'Captura de tela disponível')
    return { bytes, path }
  }
  async captureDesktop(observationId: string, hooks: TurnHooks): Promise<DesktopShot> {
    const { bytes, path, file } = await this.produced('desktop.capture', observationId, hooks, 'Captura da área de trabalho disponível')
    if (!file.desktopGeneration || !file.width || !file.height) throw runtimeError('INVALID_SCREENSHOT', 'Capture lacks its desktop identity')
    return { bytes, path, generation: file.desktopGeneration, width: file.width, height: file.height }
  }
  downloads() {
    return this.call<{ path: string; name: string }[]>('browser.downloads')
  }
  async computerClick(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left') {
    await this.call('computer.click', { x, y, button })
  }
  async computerType(text: string) {
    await this.call('computer.type', { text })
  }
  async computerKey(key: string) {
    await this.call('computer.key', { key })
  }
  async generation() {
    return (await this.call<{ generation: string }>('desktop.generation', {}, 10_000)).generation
  }
  async updatePolicy(network: NetworkPolicy) {
    await this.call('network.policy', { network }, 10_000)
  }
  abort() {
    // Started work finishes inside the services; a handoff drains it before control changes.
  }
  async close() {
    this.rpc.close()
  }
}
