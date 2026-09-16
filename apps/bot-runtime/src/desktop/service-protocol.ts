import { connect, type Socket } from 'node:net'
import { z } from 'zod'
import { desktopInputBatchSchema, networkPolicySchema } from '@maestrly/host-protocol'
import { FrameDecoder } from '../control/framing.js'
import { runtimeError } from '../turns/service.js'

// Private per-session sockets of the graphical services. The agent socket serves the
// automation worker a finite catalogue of browser/capture operations (no eval, no
// shell, no CDP). The administrative socket is root-only (systemd socket, mode 0600)
// and is the only way to change the gate, apply human input or open a viewer.
export const SERVICES_FRAME_MAX = 256 * 1024
const uuid = z.string().uuid()
const epoch = z.number().int().nonnegative()
const text = z.string().max(32 * 1024)
const coordinate = z.number().int().min(0).max(4095)
const rpc = <O extends string, S extends z.ZodType>(op: O, params: S) =>
  z.strictObject({ id: z.number().int().nonnegative(), op: z.literal(op), params })
export const agentRequestSchema = z.discriminatedUnion('op', [
  rpc('browser.navigate', z.strictObject({ url: z.string().max(8192) })),
  rpc('browser.snapshot', z.strictObject({})),
  rpc('browser.click', z.strictObject({ ref: z.number().int().positive() })),
  rpc('browser.type', z.strictObject({ ref: z.number().int().positive(), text })),
  rpc('browser.key', z.strictObject({ key: z.string().min(1).max(100) })),
  rpc('browser.screenshot', z.strictObject({ observationId: uuid })),
  rpc('browser.downloads', z.strictObject({})),
  rpc('computer.click', z.strictObject({ x: coordinate, y: coordinate, button: z.enum(['left', 'right', 'middle']) })),
  rpc('computer.type', z.strictObject({ text })),
  rpc('computer.key', z.strictObject({ key: z.string().min(1).max(100) })),
  rpc('desktop.capture', z.strictObject({ observationId: uuid })),
  rpc('desktop.generation', z.strictObject({})),
  rpc('network.policy', z.strictObject({ network: networkPolicySchema })),
  rpc('services.inspect', z.strictObject({})),
])
export type AgentRequest = z.infer<typeof agentRequestSchema>
export const adminRequestSchema = z.discriminatedUnion('op', [
  rpc('inspect', z.strictObject({})),
  rpc('gate', z.strictObject({ epoch, allowed: z.boolean() })),
  rpc('quiesce', z.strictObject({ epoch, timeoutMs: z.number().int().min(100).max(60_000) })),
  rpc('human.enable', z.strictObject({ epoch })),
  rpc('human.disable', z.strictObject({ epoch })),
  rpc('human.input', z.strictObject({ epoch, events: desktopInputBatchSchema })),
  rpc('capture', z.strictObject({ observationId: uuid })),
  rpc('viewer.open', z.strictObject({ grantId: uuid })),
  rpc('viewer.close', z.strictObject({ grantId: uuid })),
  rpc('network.policy', z.strictObject({ network: networkPolicySchema })),
  rpc('reset', z.strictObject({})),
])
export type AdminRequest = z.infer<typeof adminRequestSchema>
export const capturedFileSchema = z.strictObject({
  path: z.string().regex(/^\.maestrly\/screens\/[a-f0-9-]{36}\.png$/),
  name: z.string().min(1).max(255),
  size: z.number().int().positive().max(8 * 1024 * 1024),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  desktopGeneration: z.string().max(128).optional(),
  width: z.number().int().positive().max(4096).optional(),
  height: z.number().int().positive().max(4096).optional(),
})
export type CapturedFile = z.infer<typeof capturedFileSchema>
export const servicesInspectSchema = z.strictObject({
  desktopGeneration: z.string().max(128),
  width: z.number().int().min(0).max(4096),
  height: z.number().int().min(0).max(4096),
  gate: z.strictObject({ epoch, allowed: z.boolean(), inflight: z.number().int().nonnegative() }),
  human: z.strictObject({ epoch, enabled: z.boolean(), pressed: z.number().int().nonnegative() }),
  viewers: z.number().int().nonnegative(),
  transmitter: z.enum(['running', 'stopped']),
  capabilities: z.array(z.enum(['desktop.live.v1', 'desktop.handoff.v1'])).max(2),
})
export type ServicesInspect = z.infer<typeof servicesInspectSchema>
const responseSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  result: z.unknown().optional(),
  error: z.strictObject({ code: z.string().regex(/^[A-Z_]{1,64}$/), message: z.string().max(400) }).optional(),
})
const eventSchema = z.strictObject({ event: z.enum(['invalidate']) })
const stableCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'SERVICES_ERROR'
}
const send = (socket: Socket, value: unknown) => {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  if (bytes.length > SERVICES_FRAME_MAX || socket.writableLength > 4 * SERVICES_FRAME_MAX) return socket.destroy()
  if (!socket.destroyed) socket.write(bytes)
}
/** Serves one connection with a strict schema; malformed frames close it. */
export function serveLineRpc<T extends { id: number; op: string; params: unknown }>(
  socket: Socket,
  schema: z.ZodType<T>,
  handle: (request: T) => Promise<unknown> | unknown,
  options: { maxInFlight?: number } = {}
) {
  const decoder = new FrameDecoder(SERVICES_FRAME_MAX)
  let inflight = 0
  socket.on('error', () => socket.destroy())
  socket.on('data', (chunk: Buffer) => {
    let frames: unknown[]
    try {
      frames = decoder.push(chunk)
    } catch {
      socket.destroy()
      return
    }
    for (const raw of frames) {
      const parsed = schema.safeParse(raw)
      if (!parsed.success || ++inflight > (options.maxInFlight ?? 16)) {
        socket.destroy()
        return
      }
      const request = parsed.data
      void Promise.resolve()
        .then(() => handle(request))
        .then(
          (result) => send(socket, { id: request.id, result: result ?? null }),
          (error) => send(socket, { id: request.id, error: { code: stableCode(error), message: 'Desktop services request failed' } })
        )
        .finally(() => {
          inflight--
        })
    }
  })
  return (event: 'invalidate') => send(socket, { event })
}
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
/** Client for either socket. A lost reply is reported, never retried automatically. */
export class LineRpcClient {
  private pending = new Map<number, Pending>()
  private next = 0
  private socket?: Socket
  private connecting?: Promise<Socket>
  private listeners = new Set<(event: 'invalidate') => void>()
  constructor(private readonly path: string, private readonly timeoutMs = 60_000) {}
  onEvent(listener: (event: 'invalidate') => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  get connected() {
    return !!this.socket && !this.socket.destroyed
  }
  private open(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    this.connecting ??= new Promise<Socket>((resolve, reject) => {
      const socket = connect({ path: this.path })
      const decoder = new FrameDecoder(SERVICES_FRAME_MAX)
      socket.once('connect', () => {
        this.socket = socket
        resolve(socket)
      })
      socket.on('error', (error) => reject(runtimeError('DESKTOP_UNAVAILABLE', error.message)))
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(runtimeError('DESKTOP_UNAVAILABLE', 'Desktop services disconnected; the request was not replayed'))
        }
        this.pending.clear()
      })
      socket.on('data', (chunk: Buffer) => {
        try {
          for (const raw of decoder.push(chunk)) {
            const event = eventSchema.safeParse(raw)
            if (event.success) {
              for (const listener of this.listeners) listener(event.data.event)
              continue
            }
            const response = responseSchema.parse(raw)
            const pending = this.pending.get(response.id)
            if (!pending) continue
            this.pending.delete(response.id)
            clearTimeout(pending.timer)
            if (response.error) pending.reject(runtimeError(response.error.code, response.error.message))
            else pending.resolve(response.result)
          }
        } catch {
          socket.destroy()
        }
      })
    }).finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }
  async request(op: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<unknown> {
    const socket = await this.open()
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(runtimeError('DESKTOP_TIMEOUT', 'Desktop services did not answer; outcome unknown'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      send(socket, { id, op, params })
    })
  }
  close() {
    this.socket?.destroy()
  }
}
