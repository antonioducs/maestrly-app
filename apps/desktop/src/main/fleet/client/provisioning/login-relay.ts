import http from 'node:http'
import type { FleetLoginCallbackResponse } from '@maestrly/bot-fleet-protocol'

export interface LoginRelayOptions {
  port: number
  path: string
  ttlMs: number
  forward: (query: string) => Promise<FleetLoginCallbackResponse>
  page: (kind: 'done' | 'failed') => string
  /** The provider pages the browser may be sent to after the callback; anything else gets the Mac's own page. */
  redirectAllowed: (url: string) => boolean
}
/** Receives the provider redirect on the Mac and relays it to the bot that started sign-in. */
export class LoginRelay {
  private servers: http.Server[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private closing: Promise<void> | undefined
  private done = false
  private forwarding: Promise<FleetLoginCallbackResponse> | null = null
  private constructor(private readonly options: LoginRelayOptions) {}

  static async start(options: LoginRelayOptions): Promise<LoginRelay> {
    const relay = new LoginRelay(options)
    try {
      await relay.listen('127.0.0.1')
      try {
        await relay.listen('::1')
      } catch (error) {
        if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
      relay.timer = setTimeout(
        () => {
          void relay.close()
        },
        Math.max(0, options.ttlMs)
      )
      relay.timer.unref()
      return relay
    } catch (error) {
      await relay.close()
      throw error
    }
  }
  private async listen(host: string): Promise<void> {
    const server = http.createServer((request, response) => {
      void this.respond(request, response)
    })
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    this.servers.push(server)
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => {
        reject(error)
      }
      server.once('error', failed)
      server.listen({ host, port: this.options.port, exclusive: true }, () => {
        server.removeListener('error', failed)
        resolve()
      })
    })
  }
  private async respond(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const page = (status: number, kind: 'done' | 'failed'): void => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(this.options.page(kind))
    }
    let url: URL
    try {
      if (request.method !== 'GET') {
        response.writeHead(404).end()
        return
      }
      if (this.done) {
        page(200, 'done')
        return
      }
      url = new URL(request.url ?? '/', 'http://localhost')
      if (
        request.url?.split('?')[0] !== this.options.path ||
        url.pathname !== this.options.path ||
        (!url.searchParams.has('code') && !url.searchParams.has('error'))
      ) {
        response.writeHead(404).end()
        return
      }
    } catch {
      page(502, 'failed')
      return
    }
    const ownsForwarding = !this.forwarding
    try {
      // A browser can retry before forwarding finishes; consume its authorization code only once.
      if (!this.forwarding) this.forwarding = this.options.forward(url.search.slice(1))
      const reply = await this.forwarding
      this.done = reply.status < 400
      // Content from the bot never renders on this Mac's localhost origin, and redirects stay on the provider:
      // a compromised bot can neither run script here nor send the owner to a look-alike page.
      if (
        reply.status >= 300 &&
        reply.status < 400 &&
        reply.location?.startsWith('https://') &&
        this.options.redirectAllowed(reply.location)
      ) {
        response.writeHead(reply.status, { Location: reply.location, 'Cache-Control': 'no-store' }).end()
      } else page(this.done ? 200 : reply.status, this.done ? 'done' : 'failed')
    } catch {
      if (!response.headersSent) page(502, 'failed')
      else response.end()
    } finally {
      if (ownsForwarding) this.forwarding = null
    }
  }
  close(): Promise<void> {
    if (!this.closing) {
      clearTimeout(this.timer)
      this.closing = Promise.all(
        this.servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve())
              server.closeAllConnections()
            })
        )
      ).then(() => {})
    }
    return this.closing
  }
}
