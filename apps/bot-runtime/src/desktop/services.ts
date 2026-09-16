import { DESKTOP_HANDOFF_CAPABILITY, DESKTOP_LIVE_CAPABILITY, type DesktopInput, type NetworkPolicy } from '@maestrly/host-protocol'
import type { FileService } from '../files/service.js'
import type { ProviderEvent, TurnHooks } from '../providers/provider.js'
import type { BrowserSession } from '../tools/browser.js'
import { Computer } from '../tools/computer.js'
import { runtimeError } from '../turns/service.js'
import { captureDesktop } from './capture.js'
import { HumanInput } from './human-input.js'
import type { AdminRequest, AgentRequest, CapturedFile, ServicesInspect } from './service-protocol.js'
import type { VncTransmitter } from './vnc-server.js'
import type { X11Connection } from './x11.js'

export const QUIESCE_DEFAULT_MS = 15_000
const VIEWERS_MAX = 4
/** Collects the file produced by an existing capture helper without emitting guest events. */
function collector() {
  let produced: Record<string, unknown> | undefined
  const hooks: TurnHooks = {
    emit: (event: ProviderEvent) => {
      if (event.kind === 'file.produced') produced = event.detail
    },
    requestApproval: async () => 'deny',
    askQuestion: async () => '',
  }
  return { hooks, file: () => produced }
}
export interface DesktopServicesOptions {
  files: FileService
  browser: BrowserSession
  transmitter: VncTransmitter
  proxy?: { updatePolicy(policy: NetworkPolicy): void }
  /** Opens the XTEST connection for human input; absent means handoff is unavailable. */
  openX11?: () => Promise<X11Connection>
  /** Tells connected automation clients that DOM references and observations are stale. */
  invalidate?: () => void
  /** Whether the administrative socket came from a supervised systemd socket. */
  supervised?: boolean
  /** Full-desktop capture; defaults to the X11 capture of this session. */
  captureDesktop?: typeof captureDesktop
}

/**
 * Persistent graphical services of one bot session. They own the managed browser,
 * captures, the screen transmitter and human input, and survive the automation worker.
 * Automation requests pass an epoch-scoped gate that is drained before any person is
 * given control; a cancelled promise is never taken as proof that Playwright stopped.
 */
export class DesktopServices {
  private gate = { epoch: 0, allowed: false }
  private inflight = new Set<Promise<unknown>>()
  private human = { epoch: 0, enabled: false }
  private input?: HumanInput
  private x11?: X11Connection
  private opening?: Promise<HumanInput>
  private viewers = new Set<string>()
  private computer: Computer
  private capabilityCache?: Promise<ServicesInspect['capabilities']>
  constructor(private readonly options: DesktopServicesOptions) {
    this.computer = new Computer(options.browser)
  }
  get gateState() {
    return { ...this.gate, inflight: this.inflight.size }
  }
  get humanState() {
    return { ...this.human, pressed: this.input?.pressed ?? 0 }
  }
  private async admit<T>(run: () => Promise<T>): Promise<T> {
    if (!this.gate.allowed) throw runtimeError('BOT_PAUSED_BY_USER', 'A person is controlling this desktop')
    const operation = run()
    const tracked = operation.then(
      () => {},
      () => {}
    )
    this.inflight.add(tracked)
    try {
      return await operation
    } finally {
      this.inflight.delete(tracked)
    }
  }
  private async file(capture: (hooks: TurnHooks) => Promise<unknown>): Promise<CapturedFile> {
    const sink = collector()
    await capture(sink.hooks)
    const detail = sink.file()
    if (!detail || typeof detail.path !== 'string') throw runtimeError('INVALID_SCREENSHOT', 'Capture did not produce a file')
    const info = await this.options.files.stat({ path: detail.path })
    return { path: detail.path, name: String(detail.name), size: info.size, digest: info.digest! }
  }
  private async capture(observationId: string): Promise<CapturedFile> {
    let generation = ''
    let width = 0
    let height = 0
    const file = await this.file(async (hooks) => {
      const shot = await (this.options.captureDesktop ?? captureDesktop)(this.options.browser.desktop, this.options.files, observationId, hooks)
      generation = shot.generation
      width = shot.width
      height = shot.height
    })
    return { ...file, desktopGeneration: generation, width, height }
  }
  /** Automation catalogue: finite, schema-checked, no eval, shell or CDP endpoint. */
  async agent(request: AgentRequest): Promise<unknown> {
    const { browser } = this.options
    const p = request.params as Record<string, never>
    switch (request.op) {
      case 'services.inspect':
        return this.inspect()
      case 'desktop.generation':
        return { generation: await browser.desktop.generation() }
      case 'network.policy':
        this.options.proxy?.updatePolicy(request.params.network)
        return { applied: true }
      case 'browser.navigate':
        return this.admit(() => browser.navigate(request.params.url))
      case 'browser.snapshot':
        return this.admit(() => browser.snapshot())
      case 'browser.click':
        return this.admit(async () => {
          await browser.click(request.params.ref)
          return { done: true }
        })
      case 'browser.type':
        return this.admit(async () => {
          await browser.type(request.params.ref, request.params.text)
          return { done: true }
        })
      case 'browser.key':
        return this.admit(async () => {
          await browser.key(request.params.key)
          return { done: true }
        })
      case 'browser.screenshot':
        return this.admit(() => this.file((hooks) => browser.screenshot(request.params.observationId, hooks)))
      case 'browser.downloads':
        return this.admit(async () => browser.listDownloads())
      case 'computer.click':
        return this.admit(async () => {
          await this.computer.click(request.params.x, request.params.y, request.params.button)
          return { done: true }
        })
      case 'computer.type':
        return this.admit(async () => {
          await this.computer.type(request.params.text)
          return { done: true }
        })
      case 'computer.key':
        return this.admit(async () => {
          await this.computer.key(request.params.key)
          return { done: true }
        })
      case 'desktop.capture':
        return this.admit(() => this.capture(request.params.observationId))
    }
    void p
    throw runtimeError('UNKNOWN_OPERATION', 'Unknown desktop operation')
  }
  private async humanInput(): Promise<HumanInput> {
    if (this.input && this.x11?.alive) return this.input
    if (!this.options.openX11) throw runtimeError('DESKTOP_UPDATE_REQUIRED', 'Human input is not available in this environment')
    this.opening ??= this.options
      .openX11()
      .then((x11) => {
        this.x11 = x11
        this.input = new HumanInput(x11)
        return this.input
      })
      .finally(() => {
        this.opening = undefined
      })
    return this.opening
  }
  /** Drains started automation work; unfinished work within the deadline is uncertain. */
  async quiesce(epoch: number, timeoutMs = QUIESCE_DEFAULT_MS) {
    this.closeGate(epoch)
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    try {
      while (this.inflight.size) {
        const result = await Promise.race([Promise.all([...this.inflight]), deadline])
        if (result === 'timeout') throw runtimeError('HANDOFF_UNCERTAIN', 'Automation work did not finish before the handoff deadline')
      }
    } finally {
      clearTimeout(timer)
    }
    return { drained: true, epoch: this.gate.epoch }
  }
  private closeGate(epoch: number) {
    if (epoch < this.gate.epoch) throw runtimeError('STALE_DESKTOP', 'A newer control epoch is active')
    this.gate = { epoch, allowed: false }
  }
  async admin(request: AdminRequest): Promise<unknown> {
    switch (request.op) {
      case 'inspect':
        return this.inspect()
      case 'gate': {
        const { epoch, allowed } = request.params
        if (!allowed) {
          this.closeGate(epoch)
          return this.gateState
        }
        if (epoch < this.gate.epoch) throw runtimeError('STALE_DESKTOP', 'A newer control epoch is active')
        if (this.human.enabled) throw runtimeError('CONTROL_BUSY', 'Revoke human control before resuming automation')
        this.gate = { epoch, allowed: true }
        return this.gateState
      }
      case 'quiesce':
        return this.quiesce(request.params.epoch, request.params.timeoutMs)
      case 'human.enable': {
        const { epoch } = request.params
        if (this.gate.allowed || epoch < this.gate.epoch || epoch < this.human.epoch)
          throw runtimeError('HANDOFF_UNCERTAIN', 'Automation must be drained before human control')
        if (this.inflight.size) throw runtimeError('HANDOFF_UNCERTAIN', 'Automation work is still running')
        await this.humanInput()
        this.human = { epoch, enabled: true }
        return this.humanState
      }
      case 'human.disable': {
        const { epoch } = request.params
        if (epoch >= this.human.epoch) this.human = { epoch, enabled: false }
        await this.input?.releaseAll().catch(() => {})
        return this.humanState
      }
      case 'human.input': {
        const { epoch, events } = request.params
        if (!this.human.enabled || epoch !== this.human.epoch) throw runtimeError('CONTROL_EXPIRED', 'Human control is not active for this epoch')
        const input = await this.humanInput()
        return { applied: await input.apply(events as DesktopInput[]) }
      }
      case 'capture':
        if (this.gate.allowed) throw runtimeError('BOT_PAUSED_BY_USER', 'Handoff captures require a closed automation gate')
        return this.capture(request.params.observationId)
      case 'viewer.open': {
        const { grantId } = request.params
        if (!this.viewers.has(grantId)) {
          if (this.viewers.size >= VIEWERS_MAX) throw runtimeError('VIEWER_LIMIT', 'Too many viewers for this desktop')
          await this.options.transmitter.acquire()
          this.viewers.add(grantId)
        }
        const { desktop } = this.options.browser
        return { width: desktop.width, height: desktop.height, desktopGeneration: await desktop.generation() }
      }
      case 'viewer.close':
        if (this.viewers.delete(request.params.grantId)) this.options.transmitter.release()
        return { viewers: this.viewers.size }
      case 'network.policy':
        this.options.proxy?.updatePolicy(request.params.network)
        return { applied: true }
      case 'reset':
        // DOM references and observations from before a handoff are never valid again.
        this.options.invalidate?.()
        return { reset: true }
    }
  }
  private capabilities() {
    this.capabilityCache ??= (async () => {
      const values: ServicesInspect['capabilities'] = []
      if (!this.options.supervised) return values
      try {
        await this.options.transmitter.probe()
        values.push(DESKTOP_LIVE_CAPABILITY)
        await this.humanInput()
        values.push(DESKTOP_HANDOFF_CAPABILITY)
      } catch {
        /* capability stays absent; the Host asks for an update instead of degrading */
      }
      return values
    })()
    return this.capabilityCache
  }
  async inspect(): Promise<ServicesInspect> {
    const { desktop } = this.options.browser
    return {
      desktopGeneration: await desktop.generation(),
      width: desktop.width,
      height: desktop.height,
      gate: this.gateState,
      human: this.humanState,
      viewers: this.viewers.size,
      transmitter: this.options.transmitter.running ? 'running' : 'stopped',
      capabilities: await this.capabilities(),
    }
  }
  async close() {
    this.gate = { epoch: this.gate.epoch, allowed: false }
    this.human = { epoch: this.human.epoch, enabled: false }
    await this.input?.releaseAll().catch(() => {})
    this.x11?.close()
    await this.options.transmitter.close()
  }
}
