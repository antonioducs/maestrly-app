import {
  FLEET_SCREEN_CLOSE_CODES,
  ScreenStreamCore,
  fleetBridgeOrigin,
  type FleetScreenSurface,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError, type GatewayClient } from '../gateway/client'

export type ScreenMode = 'view' | 'control'
export type ScreenRequest = { botId: string; mode: ScreenMode; surface: FleetScreenSurface }

/** How a screen ended: the WebSocket's close, or what failed before or while it was open. */
export type ScreenEnd = { code: number | null; reason: string } | { error: unknown }

/** What a bot's screen tells the view that shows it. */
export type ScreenLinkEvent =
  /** The screen said hello: it is `width`×`height` pixels, and pictures follow. */
  | { type: 'open'; width: number; height: number }
  /** An H.264 access unit to decode; `codec` is the WebCodecs codec of its last key frame. */
  | { type: 'frame'; id: number; key: boolean; codec: string; data: Uint8Array }
  /** A still picture to show instead, as the demo's screen sends. */
  | { type: 'picture'; uri: string }
  /** The screen's pointer, for viewers: -1, -1 when it is off the screen. */
  | { type: 'pointer'; x: number; y: number }
  | { type: 'end'; end: ScreenEnd }

/** A bot's screen, open or opening: the owner's input goes in, the view's progress comes back. */
export interface ScreenLink {
  /** `buttons` holds the stream's bits: 1 left, 2 middle, 4 right. */
  pointer(x: number, y: number, buttons: number): void
  /** Whole steps of the remote wheel; positive scrolls down or right. */
  wheel(dx: number, dy: number): void
  key(keysym: number, down: boolean): void
  /** The view drew frame `id` (or lost it): the screen may send more. */
  decoded(id: number): void
  /** The view's decoder failed and was reset: it needs a key frame. */
  decoderFailed(): void
  /** Stops for good; no `end` follows. */
  close(): void
}

/** Opens a bot's screen; it reports through `onEvent` until it ends or is closed. */
export type OpenScreen = (request: ScreenRequest, onEvent: (event: ScreenLinkEvent) => void) => ScreenLink

/** The part of a WebSocket a screen uses: React Native's, or a test's. */
export interface ScreenSocket {
  binaryType: string
  readonly readyState: number
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  send(data: Uint8Array): void
  close(): void
}

const OPEN = 1
const TICKET_PATH = /^\/v1\/screen\?ticket=[A-Za-z0-9_-]+$/

/**
 * A paired server's bot screens: a ticket from the gateway, then the WebSocket. React Native always sends an Origin
 * header, so the phone names it in the ticket request and sends it explicitly, as with the bridge.
 */
export function socketScreenOpener(options: {
  /** The server's address, such as `https://bots.example.dev`. */
  origin: string
  call: GatewayClient['call']
  createSocket: (url: string, origin: string) => ScreenSocket
}): OpenScreen {
  return (request, onEvent) => {
    let socket: ScreenSocket | null = null
    let ended = false
    const end = (value: ScreenEnd) => {
      if (ended) return
      ended = true
      detach()
      onEvent({ type: 'end', end: value })
    }
    const detach = () => {
      if (!socket) return
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
    }
    const send = (bytes: Uint8Array) => {
      if (ended || !socket || socket.readyState !== OPEN) return
      try {
        socket.send(bytes)
      } catch (error) {
        socket.close()
        end({ error })
      }
    }
    const core = new ScreenStreamCore(send, {
      hello: (hello) => {
        if (!ended) onEvent({ type: 'open', width: hello.width, height: hello.height })
      },
      decode: (frame) => {
        if (!ended) onEvent({ type: 'frame', ...frame })
      },
      cursor: () => undefined,
      pointer: (x, y) => {
        if (!ended) onEvent({ type: 'pointer', x, y })
      },
      clipboard: () => undefined,
      protocolError: (error) => {
        socket?.close()
        end({ error })
      },
    })
    const connect = async () => {
      const origin = fleetBridgeOrigin(options.origin)
      if (!origin) throw new Error('The server address cannot carry a screen')
      const ticket = await options.call('botScreenTicket', {
        params: { id: request.botId },
        body: { mode: request.mode, surface: request.surface, origin },
      })
      if (ended) return
      if (!TICKET_PATH.test(ticket.path)) throw new Error('Invalid screen ticket path')
      const opened = options.createSocket(options.origin.replace(/^http/, 'ws') + ticket.path, origin)
      socket = opened
      opened.binaryType = 'arraybuffer'
      opened.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer || event.data instanceof Uint8Array) core.receive(event.data)
      }
      // A close always follows an error, with the code that says why.
      opened.onerror = () => undefined
      opened.onclose = (event) => end({ code: event.code ?? null, reason: event.reason ?? '' })
    }
    connect().catch((error: unknown) => end({ error }))
    return {
      pointer: (x, y, buttons) => core.pointer(Math.round(x), Math.round(y), buttons),
      wheel: (dx, dy) => core.wheel(dx, dy),
      key: (keysym, down) => core.key(keysym, down),
      decoded: (id) => core.decoded(id),
      decoderFailed: () => core.decoderFailed(),
      close() {
        if (ended) return
        ended = true
        detach()
        socket?.close()
      },
    }
  }
}

/**
 * What an ended screen means for its view:
 * - `released`: control was given back, from here or elsewhere;
 * - `offline`: the bot stopped, or its screen went away;
 * - `conflict`: another session controls the display;
 * - `retry`: the ticket was refused on use, and a fresh one may work;
 * - `lost`: control needs a takeover this phone no longer holds;
 * - `restart`: the bot's environment runs an image from before video screens;
 * - `error`: the connection broke.
 */
export type ScreenOutcome = 'released' | 'offline' | 'conflict' | 'retry' | 'lost' | 'restart' | 'error'

/** The gateway's refusal of a screen ticket of an environment that must restart onto a newer image. */
const RESTART_TO_OPEN_SCREEN = 'Restart this environment to update it before opening this screen.'

export function screenOutcome(end: ScreenEnd, mode: ScreenMode): ScreenOutcome {
  if ('error' in end) {
    const error = end.error
    if (!(error instanceof GatewayError)) return 'error'
    if (error.code === 'BOT_NOT_RUNNING' || error.code === 'NOT_FOUND') return 'offline'
    if (error.code === 'FORBIDDEN') return mode === 'control' ? 'lost' : 'error'
    if (error.code === 'CONFLICT') return error.message === RESTART_TO_OPEN_SCREEN ? 'restart' : 'conflict'
    return 'error'
  }
  if (end.code === FLEET_SCREEN_CLOSE_CODES.released) return 'released'
  if (end.code === FLEET_SCREEN_CLOSE_CODES.botOffline) return 'offline'
  // The gateway accepts the WebSocket before it checks the ticket: a refused ticket arrives as a close.
  if (end.code === FLEET_SCREEN_CLOSE_CODES.ticketInvalid)
    return mode === 'control' && end.reason === 'limit' ? 'conflict' : 'retry'
  return 'error'
}
