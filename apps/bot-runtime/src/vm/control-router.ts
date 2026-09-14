import { createServer, type Server, type Socket } from 'node:net'
import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { RoutedStream } from '@maestrly/guest-transport'
import { sessionPaths } from './session-profile.js'
import { safeAncestors } from './systemd-driver.js'
import type { SessionRecord } from './catalog.js'

type Endpoint = { server: Server; socket?: Socket; route?: RoutedStream; joined?: Socket }
/** Root-owned per-UID directories are the authority for routing worker connections.
 * Worker bytes never select another session or reach supervisor management RPCs. */
export class ControlRouter {
  private endpoints = new Map<string, Endpoint>()
  constructor(private lane: 'control' | 'egress') {}
  async listen(record: SessionRecord) {
    if (this.endpoints.has(record.id)) return
    if (!record.uid || !record.gid) throw new Error('Session UID and GID required')
    const directory = sessionPaths(record).socketDirectory
    await safeAncestors(directory)
    await mkdir('/run/maestrly-vm', { recursive: true, mode: 0o711 })
    await chmod('/run/maestrly-vm', 0o711)
    await mkdir(directory, { recursive: true, mode: 0o710 })
    await chown(directory, 0, record.gid)
    await chmod(directory, 0o710)
    const path = join(directory, `${this.lane}.sock`)
    const old = await lstat(path).catch(e => { if (e.code !== 'ENOENT') throw e; return undefined })
    if (old) { if (!old.isSocket() || old.uid !== 0) throw new Error('Unsafe session endpoint'); await unlink(path) }
    const endpoint: Endpoint = { server: createServer(socket => {
      socket.on('error', () => socket.destroy())
      if (endpoint.socket && !endpoint.socket.destroyed) { socket.destroy(); return }
      endpoint.socket = socket
      socket.pause()
      socket.once('close', () => {
        if (endpoint.socket === socket) { endpoint.socket = undefined; endpoint.joined = undefined; endpoint.route?.destroy() }
      })
      this.join(endpoint)
    }) }
    this.endpoints.set(record.id, endpoint)
    await new Promise<void>((resolve, reject) => { endpoint.server.once('error', reject); endpoint.server.listen(path, resolve) })
    await chown(path, 0, record.gid)
    await chmod(path, 0o660)
  }
  attach(route: RoutedStream) {
    const endpoint = this.endpoints.get(route.identity.sessionId)
    if (!endpoint || endpoint.route && !endpoint.route.destroyed) { route.destroy(); return }
    endpoint.route = route
    route.once('close', () => {
      if (endpoint.route !== route) return
      endpoint.route = undefined
      endpoint.socket?.destroy()
      endpoint.socket = undefined
      endpoint.joined = undefined
    })
    this.join(endpoint)
  }
  private join(endpoint: Endpoint) {
    if (!endpoint.socket || !endpoint.route || endpoint.route.destroyed || endpoint.joined === endpoint.socket) return
    endpoint.joined = endpoint.socket
    endpoint.socket.pipe(endpoint.route).pipe(endpoint.socket)
    endpoint.socket.resume()
  }
  disconnect(sessionId: string) {
    const endpoint = this.endpoints.get(sessionId)
    endpoint?.route?.destroy()
    endpoint?.socket?.destroy()
  }
  async close() {
    for (const [id, endpoint] of this.endpoints) {
      this.disconnect(id)
      await new Promise<void>(resolve => endpoint.server.close(() => resolve()))
    }
    this.endpoints.clear()
  }
}
