import {
  FLEET_INSTANCE_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  buildPath,
  fleetInstanceEventSchema,
  type FleetInstanceInput,
  type FleetInstanceProfile,
  type FleetInteractionResolution,
  type FleetAddApiKeyAccountRequest,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'

type Routes = typeof FLEET_INSTANCE_ROUTES
export class InstanceClient {
  constructor(
    readonly botId: string,
    readonly controlToken: string,
    readonly origin = 'http://maestrly-bot-' + botId + ':7680',
    readonly timeoutMs = 15000
  ) {}
  private async call<K extends keyof Routes>(
    key: K,
    params: Record<string, string> = {},
    query?: Record<string, string | number | undefined>,
    body?: unknown
  ): Promise<any> {
    const route = FLEET_INSTANCE_ROUTES[key]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(this.origin + buildPath(route.path, params, query), {
        method: route.method,
        headers: {
          [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
          Authorization: 'Bearer ' + this.controlToken,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        let code = 'INSTANCE_UNAVAILABLE'
        try {
          const value = (await response.json()) as { code?: string }
          if (value.code) code = value.code
        } catch {}
        throw new GatewayError(
          code === 'CONFLICT'
            ? 'CONFLICT'
            : code === 'INVALID_REQUEST'
              ? 'INVALID_REQUEST'
              : code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : 'INSTANCE_UNAVAILABLE',
          'Bot instance request failed'
        )
      }
      if (response.status === 204) return undefined
      const value = await response.json()
      return route.response?.parse(value) ?? value
    } catch (error) {
      if (error instanceof GatewayError) throw error
      throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot instance unavailable')
    } finally {
      clearTimeout(timer)
    }
  }
  health() {
    return this.call('health')
  }
  status() {
    return this.call('status')
  }
  putProfile(body: FleetInstanceProfile) {
    return this.call('profile', {}, undefined, body)
  }
  selections() {
    return this.call('selections')
  }
  addApiKeyAccount(body: FleetAddApiKeyAccountRequest) {
    return this.call('apiKeyAccountAdd', {}, undefined, body)
  }
  removeAccount(providerId: string) {
    return this.call('accountRemove', { providerId })
  }
  transcript(before?: string, limit = 200) {
    return this.call('transcript', {}, { before, limit })
  }
  postInput(body: FleetInstanceInput) {
    return this.call('inputSend', {}, undefined, body)
  }
  deleteInput(inputId: string) {
    return this.call('inputDelete', { inputId })
  }
  cancelTurn() {
    return this.call('turnCancel')
  }
  resolveInteraction(id: string, body: FleetInteractionResolution) {
    return this.call('interactionResolve', { id }, undefined, body)
  }
  hold(body: { reason: 'takeover' | 'paused' }) {
    return this.call('hold', {}, undefined, body)
  }
  release(body: { note: string | null; durationMs: number | null; continue: boolean }) {
    return this.call('holdRelease', {}, undefined, body)
  }
  uiOpen(body: { target: 'accounts' | 'main' }) {
    return this.call('uiOpen', {}, undefined, body)
  }
  async *events(since = 0, signal?: AbortSignal) {
    let response: Response
    try {
      response = await fetch(this.origin + buildPath(FLEET_INSTANCE_ROUTES.events.path, {}, { since }), {
        headers: {
          [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
          Authorization: 'Bearer ' + this.controlToken,
        },
        signal,
      })
    } catch {
      if (signal?.aborted) return
      throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot instance event stream unavailable')
    }
    if (!response.ok || !response.body)
      throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot instance event stream unavailable')
    const reader = response.body.getReader(),
      decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        buffer = (buffer + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary).replace(/\r/g, '')
          buffer = buffer.slice(boundary + 2)
          const lines = frame.split('\n')
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          const id = lines
            .find((line) => line.startsWith('id:'))
            ?.slice(3)
            .trim()
          if (data) {
            const event = fleetInstanceEventSchema.parse(JSON.parse(data))
            if (id && Number(id) !== event.seq)
              throw new GatewayError('INSTANCE_UNAVAILABLE', 'Invalid instance event sequence')
            yield event
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (!signal?.aborted)
        throw error instanceof GatewayError
          ? error
          : new GatewayError('INSTANCE_UNAVAILABLE', 'Invalid bot instance event stream')
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
}
