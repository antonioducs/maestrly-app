import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import {
  DESKTOP_LIMITS,
  desktopClaimResultSchema,
  desktopCloseResultSchema,
  desktopInputEventSchema,
  desktopInputResultSchema,
  desktopOpenResultSchema,
  desktopOperationSchema,
  desktopRenewResultSchema,
  desktopStateSchema,
  type DesktopInput,
  type DesktopOperation,
  type DesktopState,
} from '@maestrly/host-protocol'
import type { DesktopPhase, DesktopViewEvent, HostTarget } from '../shared/types'
import type { DesktopViewServer, WebSocketChannel } from './desktop-view-server'

export interface DesktopRpc {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  disconnect(): void
}
type Control = { capability: string; epoch: number; desktopGeneration: string; sequence: number }
type View = {
  handle: string
  webContentsId: number
  botId: string
  viewId: string
  state: DesktopState
  media: Duplex
  channel?: WebSocketChannel
  timer?: ReturnType<typeof setInterval>
  control?: Control
  queue: DesktopInput[]
  sending: boolean
  phase: DesktopPhase
  closed: boolean
}
const QUEUE_MAX = 512
export const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)) return code
  const match = /^\[([A-Z_]{1,64})\]/.exec(error instanceof Error ? error.message : '')
  return match?.[1]
}
const fail = (code: string, message = code) => Object.assign(new Error(message), { code })
/** Takes one ordered batch; consecutive pointer moves collapse to the last. */
export function takeBatch(queue: DesktopInput[]): DesktopInput[] {
  const batch: DesktopInput[] = []
  let text = 0
  while (queue.length && batch.length < DESKTOP_LIMITS.inputBatchMax) {
    const next = queue[0]
    if (next.kind === 'text' && text + next.text.length > DESKTOP_LIMITS.textMax) break
    queue.shift()
    if (next.kind === 'text') text += next.text.length
    const last = batch.at(-1)
    if (next.kind === 'pointer' && last?.kind === 'pointer') batch[batch.length - 1] = next
    else batch.push(next)
  }
  return batch
}

/**
 * Main-process owner of live desktop views. Media tickets and control capabilities
 * stay here, in memory, bound to the renderer that asked for them; the renderer only
 * sees an opaque handle, a loopback socket and public state.
 */
export class DesktopClient {
  private views = new Map<string, View>()
  private rpc?: { targetId: string; hostId: string; transport: Promise<DesktopRpc> }
  constructor(
    private readonly deps: {
      target: () => HostTarget | undefined
      /** Dedicated control transport to the selected Host; verifies its identity first. */
      connect: (target: HostTarget) => Promise<DesktopRpc>
      openMedia: (target: HostTarget, ticket: string) => Promise<{ stream: Duplex }>
      server: DesktopViewServer
      emit: (webContentsId: number, event: DesktopViewEvent) => void
      clientInstanceId: string
      pollMs?: number
    }
  ) {}
  private async transport() {
    const target = this.deps.target()
    if (!target?.hostId) throw fail('DESKTOP_UNAVAILABLE', 'Conecte-se a um computador antes de abrir a tela')
    if (!this.rpc || this.rpc.targetId !== target.id || this.rpc.hostId !== target.hostId) {
      // A different Host or target: nothing from the previous one survives.
      this.reset('TARGET_CHANGED')
      const transport = this.deps.connect(target)
      const entry = { targetId: target.id, hostId: target.hostId, transport }
      this.rpc = entry
      transport.catch(() => {
        if (this.rpc === entry) this.rpc = undefined
      })
    }
    return { rpc: await this.rpc.transport, target }
  }
  private async call<T>(method: string, params: Record<string, unknown>, schema: { parse(value: unknown): T }): Promise<T> {
    const { rpc } = await this.transport()
    try {
      return schema.parse(await rpc.request(method, params))
    } catch (error) {
      // A transport failure (not a Host answer) ends every view bound to that connection.
      if (!codeOf(error)) this.reset('DISCONNECTED')
      throw error
    }
  }
  private event(view: View, reason?: string) {
    this.deps.emit(view.webContentsId, { handle: view.handle, botId: view.botId, state: view.state, controlling: !!view.control, phase: view.phase, ...(reason ? { reason } : {}) })
  }
  private own(webContentsId: number, handle: string) {
    const view = this.views.get(handle)
    if (!view || view.closed || view.webContentsId !== webContentsId) throw fail('DESKTOP_UNAVAILABLE', 'A tela foi fechada; abra-a novamente')
    return view
  }
  async inspect(botId: string) {
    return this.call('bot.desktop.inspect', { botId }, desktopStateSchema)
  }
  async open(webContentsId: number, botId: string) {
    const { target } = await this.transport()
    const opened = await this.call('bot.desktop.open', { botId, clientInstanceId: this.deps.clientInstanceId }, desktopOpenResultSchema)
    let media: Duplex
    try {
      media = (await this.deps.openMedia(target, opened.mediaTicket)).stream
    } catch (error) {
      await this.call('bot.desktop.close', { viewId: opened.viewId }, desktopCloseResultSchema).catch(() => {})
      throw error
    }
    const view: View = { handle: randomUUID(), webContentsId, botId, viewId: opened.viewId, state: opened.state, media, queue: [], sending: false, phase: 'connecting', closed: false }
    this.views.set(view.handle, view)
    media.on('error', () => {})
    media.once('close', () => {
      if (!view.closed) void this.drop(view, 'MEDIA_CLOSED')
    })
    const socket = this.deps.server.issue(webContentsId, (channel) => {
      if (view.closed || view.channel) return channel.destroy()
      view.channel = channel
      view.phase = view.control ? 'controlling' : 'viewing'
      channel.on('error', () => {})
      media.pipe(channel).pipe(media)
      channel.once('close', () => {
        if (!view.closed) void this.drop(view, 'VIEW_CLOSED')
      })
      this.event(view)
    })
    view.timer = setInterval(() => void this.renew(view), DESKTOP_LIMITS.viewerRenewMs)
    view.timer.unref?.()
    return { handle: view.handle, url: socket.url, protocols: socket.protocols, state: opened.state }
  }
  private async renew(view: View) {
    if (view.closed) return
    try {
      const control = view.control
      const result = await this.call('bot.desktop.renew', { viewId: view.viewId, ...(control ? { controlEpoch: control.epoch, controlCapability: control.capability } : {}) }, desktopRenewResultSchema)
      if (view.closed) return
      view.state = result.state
      if (view.control && !result.controlling) this.loseControl(view, 'CONTROL_EXPIRED')
      else this.event(view)
    } catch (error) {
      const code = codeOf(error)
      if (code === 'CONTROL_EXPIRED' || code === 'HANDOFF_UNCERTAIN') this.loseControl(view, code)
      else if (!code || code === 'DESKTOP_UNAVAILABLE') await this.drop(view, code ?? 'DISCONNECTED')
    }
  }
  private async wait(operation: DesktopOperation) {
    const deadline = Date.now() + 120_000
    let current = operation
    while (current.status === 'running') {
      if (Date.now() > deadline) throw fail('HANDOFF_UNCERTAIN', 'A etapa da tela não terminou a tempo')
      await new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? 250))
      current = await this.call('bot.desktop.operation.get', { operationId: operation.id }, desktopOperationSchema)
    }
    return current
  }
  private async refresh(view: View) {
    const result = await this.call('bot.desktop.renew', { viewId: view.viewId }, desktopRenewResultSchema).catch(() => undefined)
    if (result) view.state = result.state
  }
  async acquire(webContentsId: number, handle: string) {
    const view = this.own(webContentsId, handle)
    if (view.control) return this.snapshot(view)
    view.phase = 'acquiring'
    this.event(view)
    try {
      let operation: DesktopOperation
      try {
        operation = await this.call('bot.desktop.acquire', { viewId: view.viewId, expectedRevision: view.state.revision, idempotencyKey: randomUUID() }, desktopOperationSchema)
      } catch (error) {
        if (codeOf(error) !== 'REVISION_CONFLICT') throw error
        await this.refresh(view)
        operation = await this.call('bot.desktop.acquire', { viewId: view.viewId, expectedRevision: view.state.revision, idempotencyKey: randomUUID() }, desktopOperationSchema)
      }
      operation = await this.wait(operation)
      if (operation.status !== 'succeeded') throw fail(operation.failureCode ?? 'HANDOFF_UNCERTAIN')
      const claim = await this.call('bot.desktop.claimControl', { viewId: view.viewId, operationId: operation.id }, desktopClaimResultSchema)
      if (view.closed) throw fail('DESKTOP_UNAVAILABLE')
      view.control = { capability: claim.controlCapability, epoch: claim.controlEpoch, desktopGeneration: claim.desktopGeneration, sequence: 0 }
      view.state = claim.state
      view.phase = 'controlling'
      this.event(view)
      return this.snapshot(view)
    } catch (error) {
      if (!view.closed) {
        view.phase = view.channel ? 'viewing' : 'connecting'
        await this.refresh(view)
        this.event(view, codeOf(error))
      }
      throw error
    }
  }
  private loseControl(view: View, reason: string) {
    view.control = undefined
    view.queue = []
    if (!view.closed) {
      view.phase = view.channel ? 'viewing' : 'connecting'
      this.event(view, reason)
      void this.refresh(view).then(() => this.event(view))
    }
  }
  /** Accepts renderer input only for the controlling view; bounded and never replayed. */
  input(webContentsId: number, handle: string, raw: unknown) {
    const view = this.own(webContentsId, handle)
    if (!view.control) throw fail('CONTROL_EXPIRED', 'Você não está no controle desta tela')
    if (!Array.isArray(raw) || raw.length > DESKTOP_LIMITS.inputBatchMax) throw fail('INPUT_INVALID', 'Entrada inválida')
    const events = raw.map((event) => desktopInputEventSchema.parse(event))
    if (view.queue.length + events.length > QUEUE_MAX) {
      // A stale backlog is dropped and the person resynchronizes; nothing old is applied later.
      view.queue = []
      view.queue.push({ kind: 'releaseAll' })
      this.event(view, 'INPUT_RATE_LIMITED')
      void this.flush(view)
      return { queued: 0 }
    }
    view.queue.push(...events)
    void this.flush(view)
    return { queued: events.length }
  }
  private async flush(view: View) {
    if (view.sending) return
    view.sending = true
    try {
      while (view.queue.length && view.control && !view.closed) {
        const control = view.control
        const batch = takeBatch(view.queue)
        if (!batch.length) break
        const sequence = control.sequence++
        await this.call('bot.desktop.input', { viewId: view.viewId, controlCapability: control.capability, controlEpoch: control.epoch, desktopGeneration: control.desktopGeneration, sequence, events: batch }, desktopInputResultSchema)
      }
    } catch (error) {
      view.queue = []
      const code = codeOf(error) ?? 'DISCONNECTED'
      if (['CONTROL_EXPIRED', 'STALE_DESKTOP', 'HANDOFF_UNCERTAIN'].includes(code)) this.loseControl(view, code)
      else if (!view.closed) this.event(view, code)
    } finally {
      view.sending = false
    }
  }
  /** Revokes local input first, then asks the Host to hand control back to the bot. */
  async returnControl(webContentsId: number, target: { handle?: string; botId: string }, continueTask: boolean) {
    const view = target.handle ? this.own(webContentsId, target.handle) : undefined
    if (view && view.botId !== target.botId) throw fail('DESKTOP_UNAVAILABLE')
    const control = view?.control
    if (view) {
      view.queue = []
      view.control = undefined
      view.phase = 'returning'
      this.event(view)
    }
    const request = async () => {
      const state = view?.state ?? (await this.inspect(target.botId))
      return this.call('bot.desktop.return', {
        botId: target.botId,
        ...(view ? { viewId: view.viewId } : {}),
        ...(control ? { controlCapability: control.capability } : {}),
        expectedRevision: state.revision,
        idempotencyKey: randomUUID(),
        continueTask,
      }, desktopOperationSchema)
    }
    try {
      let operation: DesktopOperation
      try {
        operation = await request()
      } catch (error) {
        if (codeOf(error) !== 'REVISION_CONFLICT') throw error
        if (view) await this.refresh(view)
        operation = await request()
      }
      operation = await this.wait(operation)
      if (view) await this.refresh(view)
      const state = view ? view.state : await this.inspect(target.botId)
      return { status: operation.status, ...(operation.failureCode ? { failureCode: operation.failureCode } : {}), continued: !!operation.continuationTurnId, state }
    } finally {
      if (view && !view.closed) {
        view.phase = view.channel ? 'viewing' : 'connecting'
        this.event(view)
      }
    }
  }
  private snapshot(view: View) {
    return { handle: view.handle, state: view.state, controlling: !!view.control, phase: view.phase }
  }
  private async drop(view: View, reason: string) {
    if (view.closed) return
    view.closed = true
    this.views.delete(view.handle)
    clearInterval(view.timer)
    view.control = undefined
    view.queue = []
    view.channel?.destroy()
    view.media.destroy()
    view.phase = 'closed'
    this.event(view, reason)
    if (reason !== 'DISCONNECTED' && reason !== 'TARGET_CHANGED')
      await this.call('bot.desktop.close', { viewId: view.viewId }, desktopCloseResultSchema).catch(() => {})
  }
  async close(webContentsId: number, handle: string) {
    const view = this.views.get(handle)
    if (!view || view.webContentsId !== webContentsId) return { closed: true }
    await this.drop(view, 'CLOSED')
    return { closed: true }
  }
  /** The renderer that owned these views reloaded or closed. */
  revoke(webContentsId: number) {
    this.deps.server.revoke(webContentsId)
    for (const view of [...this.views.values()]) if (view.webContentsId === webContentsId) void this.drop(view, 'CLOSED')
  }
  /** Target change, Host disconnect or quit: close every view and the control connection. */
  reset(reason = 'DISCONNECTED') {
    for (const view of [...this.views.values()]) void this.drop(view, reason)
    const rpc = this.rpc
    this.rpc = undefined
    void rpc?.transport.then((transport) => transport.disconnect()).catch(() => {})
  }
}
